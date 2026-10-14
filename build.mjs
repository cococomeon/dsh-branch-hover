/**
 * 构建 dsh-branch-hover。
 *
 * 这个插件是「双面包」（dual-face）：宿主半是普通 ESM，浏览器半必须包进
 * `window.__ModuleLoader__.load({ id, factory })` 才能被客户端模块系统接住。
 * 所以构建做两件事：
 *
 *  1. 宿主半：src/index.js、src/git.js、src/market.js 原样搬进 lib/（保持一模块一文件，
 *     相对导入 `./git.js` 必须真实存在），并在搬运前 import 一次以暴露语法错误；
 *     顺带把构建期烘焙好的 src/customers.json 搬进去（运行时只读它，不读 xlsx）。
 *  2. 浏览器半：把 src/client.js 包一层 load 外壳写成 lib/client.js，
 *     `react` 通过 factory 的 require 走平台基线，不打进产物。
 *
 * @module dsh-branch-hover/build
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, 'src');
const lib = resolve(here, 'lib');
const PKG = 'dsh-branch-hover';

await rm(lib, { recursive: true, force: true });
await mkdir(lib, { recursive: true });

// ── 宿主半 ────────────────────────────────────────────────────────────────
// 只有宿主半可以 import 校验：浏览器半用的是 factory 的 require（CJS 风格），
// 不是 ESM，import 它必然报 "Unexpected identifier"。
for (const name of ['git.js', 'market.js', 'index.js']) {
  const from = join(src, name);
  // 先 import：语法错误与相对导入写错都在构建期暴露，而不是等 DSH 启动。
  await import(pathToFileURL(from).href);
  await cp(from, join(lib, name));
}

// ── 客户快照 ──────────────────────────────────────────────────────────────
// 快照由 tools/generate-customers.mjs 从 afa 文档库的《客户信息.xlsx》烘焙；
// 这里只搬进 lib/ 并核对它不是空壳——空快照在界面上表现为「市场名整块消失」，
// 看不出是构建漏了还是分支认不出。
const snapshot = JSON.parse(await readFile(join(src, 'customers.json'), 'utf8'));
const codes = Object.keys(snapshot.customers ?? {});
if (codes.length === 0) {
  throw new Error('build: src/customers.json 里没有任何客户编码（先跑 node tools/generate-customers.mjs）');
}
await cp(join(src, 'customers.json'), join(lib, 'customers.json'));

// ── 浏览器半 ──────────────────────────────────────────────────────────────
// 只做外壳包装，不转译：源码保持可读的 ESM，模块体的副作用（含任何 CSS 注入，
// 本插件没有）落在 factory 内部，符合客户端的懒物化约定。
const clientSource = await readFile(join(src, 'client.js'), 'utf8');

const bundle = [
  `window.__ModuleLoader__.load({`,
  `\tid: ${JSON.stringify(PKG)},`,
  `\tfactory: (require) => {`,
  `\t\tvar module = { exports: {} };`,
  `\t\tvar exports = module.exports;`,
  `\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
  clientSource,
  `\t\texports.apply = apply;`,
  `\t\texports.inject = inject;`,
  // 测试钩子：让 test/render.mjs 能直接驱动组件，而 DSH 本体只认 apply/inject。
  `\t\texports.__test_BranchHover = BranchHover;`,
  `\t\texports.__test_MarketDock = MarketDock;`,
  `\t\texports.__test_TurnBranch = TurnBranch;`,
  `\t\treturn module.exports;`,
  `\t}`,
  `});`,
  '',
].join('\n');

await writeFile(join(lib, 'client.js'), bundle);

// ── 契约自检 ──────────────────────────────────────────────────────────────
// 这几条是「插件能否被 DSH 加载」的硬门槛，且都不会在单纯 import 时暴露。
const pkg = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));

if (pkg.dsh?.client?.platform !== 'web') {
  throw new Error('build: package.json 缺少 dsh.client.platform === "web"');
}
// client-modules 只认 exports["./client"]，靠它定位 bundle；漏了会直接抛
// 「declares dsh.client but exports no "./client" bundle」。
if (pkg.exports?.['./client'] === undefined) {
  throw new Error('build: package.json 缺少 exports["./client"]（客户端 bundle 靠它定位）');
}
if (pkg.dsh?.bundle?.patch === undefined) {
  throw new Error('build: package.json 缺少 dsh.bundle.patch');
}

// 宿主半必须真有导出；浏览器半由外壳统一挂 exports，源码里不该出现 export。
{
  const hostBody = await readFile(join(lib, 'index.js'), 'utf8');
  if (!hostBody.includes('export')) throw new Error('build: lib/index.js 没有任何导出');
  const clientRaw = await readFile(join(lib, 'client.js'), 'utf8');
  if (/^\s*(export|import)\s/m.test(clientRaw)) {
    throw new Error('build: 浏览器半混进了 ESM 语句（factory 是 CJS 外壳，只能用 require）');
  }
}

// 浏览器半的语法与注册契约自检：用一个假的 window.__ModuleLoader__ 把 bundle
// 跑一遍。这能抓出「factory 里混进 import 语句」「id 写错」「没导出 apply」——
// 这几种错在浏览器里只表现为插件静默不激活，很难定位。
{
  const clientBody = await readFile(join(lib, 'client.js'), 'utf8');
  let registered;
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) { registered = spec; },
    },
  };
  const fakeRequire = (spec) => {
    if (spec === 'react') {
      return {
        createElement: () => null,
        useState: () => [null, () => {}],
        useEffect: () => {},
      };
    }
    throw new Error(`build: 浏览器半请求了非基线模块 "${spec}"`);
  };
  const run = new Function('window', 'require', clientBody);
  run(fakeWindow, fakeRequire);

  if (registered === undefined) throw new Error('build: 浏览器半没有调用 __ModuleLoader__.load');
  if (registered.id !== PKG) {
    throw new Error(`build: 浏览器半注册的 id 是 "${registered.id}"，应为 "${PKG}"`);
  }
  const clientExports = registered.factory(fakeRequire);
  if (typeof clientExports.apply !== 'function') throw new Error('build: 浏览器半没有导出 apply');
  if (!Array.isArray(clientExports.inject)) throw new Error('build: 浏览器半没有导出 inject 数组');
}

const hostHalf = await import(pathToFileURL(join(lib, 'index.js')).href);
if (typeof hostHalf.apply !== 'function') throw new Error('build: 宿主半没有导出 apply');
if (!Array.isArray(hostHalf.inject)) throw new Error('build: 宿主半没有导出 inject 数组');

// 快照与分支命名的对表检查：拿一个真实分支名走一遍解析，确认编码形态与快照键
// 是一套东西（换过 xlsx、换过列、编码规则变了，都在这里暴露）。
{
  const { marketFor } = await import(pathToFileURL(join(lib, 'market.js')).href);
  const sample = marketFor('KH000115-无纸化信创(2.3_20160627)');
  if (sample === undefined) {
    throw new Error('build: 快照里查不到样例分支的客户编码 KH000115，快照来源可疑');
  }
}

process.stdout.write(
  `${PKG}/build: 已产出 lib/{index.js,market.js,customers.json,client.js}（客户快照 ${codes.length} 条）\n`,
);
