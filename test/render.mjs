/**
 * 渲染逻辑真跑测试：把 lib/client.js 的 bundle 在可控的假 React + 假 fetch 下
 * 驱动起来，逐一核对三个组件的各展示状态——BranchHover（会话行 hover）、
 * MarketDock（空白会话市场行）、TurnBranch（每轮定格分支行）。
 *
 * 之所以要这一层：「不渲染」的分支（非仓库、空分支、认不出客户编码、非空白会话、
 * 宿主给不出历史时刻）与「渲染部分标记」的分支（只在 ahead/behind/dirty > 0 时
 * 出现的 ↑↓●、只在有 market 时才有的市场行、只在 at.exact === false 时才有的
 * 推断提示）都是条件逻辑，只读代码容易漏，必须在真实输入下核对输出。
 *
 * 运行：node build.mjs && node test/render.mjs
 *
 * @module dsh-branch-hover/test/render
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 造一个极简 React 替身。state 存在数组里，effect 收集起来由测试手动 flush，
 * 这样「effect 里 setState」这一异步环节可以被确定性地推进。
 */
function makeReact() {
  const store = { states: [], effects: [], cursor: 0, renders: 0 };
  const React = {
    createElement: (type, props, ...kids) => ({
      type,
      props: props ?? {},
      kids: kids.filter((k) => k !== null && k !== undefined && k !== false),
    }),
    useState: (init) => {
      const i = store.cursor++;
      if (store.states[i] === undefined) store.states[i] = init;
      return [store.states[i], (v) => {
        store.states[i] = typeof v === 'function' ? v(store.states[i]) : v;
      }];
    },
    useEffect: (fn) => { store.effects.push(fn); },
  };
  return { React, store };
}

/** 载入 bundle 并取回 exports。 */
function loadBundle(React) {
  let reg;
  const win = { __ModuleLoader__: { load: (s) => { reg = s; } } };
  const req = (m) => {
    if (m === 'react') return React;
    throw new Error(`浏览器半请求了非基线模块: ${m}`);
  };
  const code = readFileSync(resolve(here, '../lib/client.js'), 'utf8');
  new Function('window', 'require', code)(win, req);
  return reg.factory(req);
}

/** 收集元素树中的全部文本。 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && Array.isArray(node.kids)) return node.kids.map(textOf).join('');
  return '';
}

/** 收集元素树里所有的 title 提示（市场名全称只出现在这里，正文里看不到）。 */
function titlesOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const kid of node) titlesOf(kid, out);
    return out;
  }
  if (typeof node.props?.title === 'string') out.push(node.props.title);
  if (Array.isArray(node.kids)) for (const kid of node.kids) titlesOf(kid, out);
  return out;
}

/** 当前测试用例的假 git 响应。 */
let payload = { isRepo: false };

/** 当前测试用例的假历史回放响应；URL 里带 at= 的请求用它。 */
let atPayload = { isRepo: false };

/** 本次用例里每一次宿主请求的 URL，供 at 参数与缓存断言使用。 */
let fetchUrls = [];

/**
 * 渲染一次 BranchHover 并把 effect flush 到收敛。
 * @param {string} cwd - useSessions 将返回的工作区路径。
 * @returns {Promise<{node: any, text: string}>} 渲染结果与其中的文字。
 */
async function render(cwd) {
  globalThis.fetch = async () => ({ ok: true, json: async () => payload });

  const { React, store } = makeReact();
  const exports = loadBundle(React);

  // 模拟宿主传参：useSessions 是对「选择 cwd」的 hook 调用。
  const useSessions = (selector) => selector({ byId: { s1: { cwd } } });

  let node = exports.apply === undefined ? null : null;
  void node;

  // apply 会把组件注册进 slot；这里直接调组件本体。
  const Component = exports.__test_BranchHover;
  if (Component === undefined) throw new Error('bundle 没有导出 __test_BranchHover');

  const props = { sessionId: 's1', useSessions };

  // 首渲染
  store.cursor = 0; store.effects = [];
  let out = Component(props);

  // flush effect → 等微任务 → 再渲染一次，直到不再产生新 effect。
  for (let pass = 0; pass < 5; pass++) {
    const effects = store.effects;
    store.effects = [];
    if (effects.length === 0) break;
    for (const fn of effects) fn();
    await new Promise((r) => setImmediate(r));
    store.cursor = 0;
    out = Component(props);
  }

  return { node: out, text: textOf(out) };
}

/** 断言助手。 */
const failures = [];
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures.push(`${name}\n    期望: ${JSON.stringify(expected)}\n    实际: ${JSON.stringify(actual)}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}`);
}

console.log('BranchHover 渲染分支核对：\n');

// 1. 非 git 工作区：整块不渲染。
payload = { isRepo: false };
check('非仓库 → 返回 null', (await render('/not/a/repo')).node, null);

// 2. 正常分支、与上游一致、干净：只有图标 + 分支名，无 ↑↓●。
payload = { isRepo: true, branch: 'main', detached: false, dirty: 0, ahead: 0, behind: 0 };
check('干净同上游 → 仅分支名', (await render('/repo')).text, '⎇main');

// 3. 领先 + 未提交改动：出现 ↑N 与 ●N，顺序为 ↑↓●。
payload = { isRepo: true, branch: 'feat/x', detached: false, dirty: 121, ahead: 2, behind: 0 };
check('领先+脏 → ⎇feat/x ↑2 ●121', (await render('/repo')).text, '⎇feat/x↑2 ●121');

// 4. 落后：出现 ↓N。
payload = { isRepo: true, branch: 'dev', detached: false, dirty: 0, ahead: 0, behind: 5 };
check('落后 → ⎇dev ↓5', (await render('/repo')).text, '⎇dev↓5');

// 5. 中文 + 括号 + 下划线分支名必须原样渲染（真实 space1 分支名）。
payload = {
  isRepo: true, branch: 'KH000115-无纸化信创(2.3_20160627)',
  detached: false, dirty: 0, ahead: 2, behind: 0,
};
check('中文分支名原样渲染', (await render('/repo')).text, '⎇KH000115-无纸化信创(2.3_20160627)↑2');

// 6. detached HEAD：图标换成 ⑂。
payload = { isRepo: true, branch: 'c106520', detached: true, dirty: 0, ahead: 0, behind: 0 };
check('detached → ⑂', (await render('/repo')).text, '⑂c106520');

// 7. 没有 cwd（会话未绑定工作区）：不渲染，也不该发请求。
payload = { isRepo: true, branch: 'main', detached: false, dirty: 0, ahead: 0, behind: 0 };
check('无 cwd → 返回 null', (await render(undefined)).node, null);

// 8. 认得出客户编码：市场名另起一行，全称进 title 提示。
payload = {
  isRepo: true, branch: 'KH000115-无纸化信创(2.3_20160627)', detached: false, dirty: 0, ahead: 2, behind: 0,
  market: { code: 'KH000115', name: '宁夏银行股份有限公司', short: '宁夏银行' },
};
{
  const out = await render('/repo');
  check('市场名单独一行', out.text, '⎇KH000115-无纸化信创(2.3_20160627)↑2市场：宁夏银行');
  check('分支与市场是两个元素', out.node.kids.length, 2);
  check('全称进 title 提示', titlesOf(out.node).includes('KH000115 宁夏银行股份有限公司'), true);
}

// 9. 认不出编码（响应里没有 market 字段）：只有分支行，不留空位。
payload = { isRepo: true, branch: 'master', detached: false, dirty: 0, ahead: 0, behind: 0 };
{
  const out = await render('/repo');
  check('无 market → 只有分支行', out.text, '⎇master');
  check('无 market → 单元素', out.node.kids.length, 1);
}

// 10. market 在但简称为空：不渲染市场行（宁可少一行，也不留个光秃秃的「市场：」）。
payload = {
  isRepo: true, branch: 'KH003001-x', detached: false, dirty: 0, ahead: 0, behind: 0,
  market: { code: 'KH003001', name: '新加坡华侨银行', short: '' },
};
check('简称为空 → 不渲染市场行', (await render('/repo')).text, '⎇KH003001-x');

// ── 新组件的驱动 harness ──────────────────────────────────────────────────
// MarketDock / TurnBranch 的缓存是模块级的，而 render() 每次都重新执行一遍 bundle
// （拿到全新的模块作用域），所以「只打一次网络」必须在同一份 bundle 内渲染两次
// 才看得出来——不能借用 render()。

/** 按 URL 分流：带 at= 的走历史响应，其余走实时响应；顺带记下每次请求。 */
function installFetch() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    fetchUrls.push(u);
    return { ok: true, json: async () => (u.includes('at=') ? atPayload : payload) };
  };
}

/** 载入一份 bundle；返回的 exports 与 store 可反复渲染（同一模块实例）。 */
function makeDriver() {
  installFetch();
  fetchUrls = [];
  const { React, store } = makeReact();
  return { exports: loadBundle(React), store };
}

/** 渲染一次组件并把 effect flush 到收敛，返回最后一次渲染的元素树。 */
async function drive(exports, name, props, store) {
  const Component = exports[name];
  if (Component === undefined) throw new Error(`bundle 没有导出 ${name}`);

  store.cursor = 0; store.effects = [];
  let out = Component(props);
  for (let pass = 0; pass < 5; pass++) {
    const effects = store.effects;
    store.effects = [];
    if (effects.length === 0) break;
    for (const fn of effects) fn();
    await new Promise((r) => setImmediate(r));
    store.cursor = 0;
    out = Component(props);
  }
  return out;
}

console.log('\nMarketDock 渲染分支核对：\n');

/** MarketDock 入参：owner 给 InputZone.session 快照，标准件给 sessionId 与 useSessions。 */
function dockProps(cwd, blank) {
  return {
    sessionId: 's1',
    useSessions: (selector) => selector({ byId: { s1: { cwd } } }),
    session: { blank },
  };
}

const MARKET_115 = { code: 'KH000115', name: '宁夏银行股份有限公司', short: '宁夏银行' };

// 1. 空白会话 + 认得出市场：分支名与市场名同一行，市场全称进 title。
{
  atPayload = { isRepo: false };
  payload = { isRepo: true, branch: 'KH000115-无纸化信创(2.3_20160627)', detached: false, market: MARKET_115 };
  const { exports, store } = makeDriver();
  const out = await drive(exports, '__test_MarketDock', dockProps('/repo', true), store);
  check('分支 + 市场同一行', textOf(out), '⎇ KH000115-无纸化信创(2.3_20160627) · 市场：宁夏银行');
  check('市场全称进 title 提示', titlesOf(out).some((t) => t.includes('KH000115 宁夏银行股份有限公司')), true);
  check('有分支时不做淡化', out?.props?.style?.opacity, 1);
}

// 1b. 游离头指针：分支前用 ⑂，title 标注 detached HEAD。
{
  payload = { isRepo: true, branch: 'c106520', detached: true };
  const { exports, store } = makeDriver();
  const out = await drive(exports, '__test_MarketDock', dockProps('/repo', true), store);
  check('detached → ⑂ 前缀', textOf(out), '⑂ c106520 · 市场：—（分支名无客户编码）');
  check('detached → title 标注', titlesOf(out).some((t) => t.includes('detached HEAD')), true);
}

// 2. 非空白会话：普通会话里不出现这一行，连取数都不该发生。
{
  const { exports, store } = makeDriver();
  const out = await drive(exports, '__test_MarketDock', dockProps('/repo', false), store);
  check('非空白会话 → 返回 null', out, null);
  check('非空白会话 → 不发请求', fetchUrls.length, 0);
}

// 3a. 是仓库但分支认不出客户编码：不留白，明确写出原因（空白与「插件没生效」无法区分）。
{
  payload = { isRepo: true, branch: 'master', detached: false };
  const { exports, store } = makeDriver();
  const out = await drive(exports, '__test_MarketDock', dockProps('/repo', true), store);
  check('认不出编码 → 分支照显、市场解释原因', textOf(out), '⎇ master · 市场：—（分支名无客户编码）');
}

// 3b. 非 git 工作区（用户报过的场景）：同样给占位，而不是静默空白。
{
  payload = { isRepo: false };
  const { exports, store } = makeDriver();
  const out = await drive(exports, '__test_MarketDock', dockProps('/not-a-repo', true), store);
  check('非仓库 → 占位写「非 git 工作区」', textOf(out), '市场：—（非 git 工作区）');
}

// 4. 没有 cwd（会话未绑定工作区）：不渲染，也不该发请求。
{
  payload = { isRepo: true, branch: 'main', detached: false, market: MARKET_115 };
  const { exports, store } = makeDriver();
  const out = await drive(exports, '__test_MarketDock', dockProps(undefined, true), store);
  check('无 cwd → 返回 null', out, null);
  check('无 cwd → 不发请求', fetchUrls.length, 0);
}

console.log('\nTurnBranch 渲染分支核对：\n');

/** 历史回放锚点（Unix epoch 毫秒）。 */
const AT_MS = 1791884393000;
const AT_BRANCH = 'KH000456-柜面升级改造项目(2.7.1_20171207)';
const AT_MARKET = { code: 'KH000456', name: '北京农村商业银行股份有限公司', short: '北农商' };

/**
 * TurnBranch 入参：owner 给 messageId，标准件给 sessionId 与 useSessions，
 * 本插件注入的 getChat 提供聊天快照（时间锚点从快照里按 messageId 查出来）。
 * @param {number | undefined} anchorMs - 该轮 turn/start 时刻；undefined 表示时间线里没有。
 * @param {string} [cwd] - 工作区路径。
 * @param {boolean} [withStart] - 时间线里是否带 start；false 表示退到消息自身的 time。
 * @returns {object} 组件入参。
 */
function tailProps(anchorMs, cwd = '/repo', withStart = true) {
  const messageId = 'msg-1';
  const node = { kind: 'assistant', data: { turn: 1, time: anchorMs ?? 0, finalNode: { messageId } } };
  const snapshot = {
    order: ['node-1'],
    nodes: new Map([['node-1', node]]),
    timeline: { turns: new Map([[1, withStart && anchorMs !== undefined ? { start: { time: anchorMs } } : {}]]) },
  };
  const source = { getSnapshot: () => snapshot, subscribe: () => () => {} };
  return {
    sessionId: 's1',
    useSessions: (selector) => selector({ byId: { s1: { cwd } } }),
    messageId,
    getChat: () => ({ binding: () => ({ target: () => source }) }),
  };
}

// 1. at 块存在且有市场：一行定格分支 + 市场简称。
{
  payload = { isRepo: true, branch: 'master' };
  atPayload = {
    isRepo: true, branch: 'master',
    at: { time: AT_MS, branch: AT_BRANCH, detached: false, exact: true, market: AT_MARKET },
  };
  const { exports, store } = makeDriver();
  const out = await drive(exports, '__test_TurnBranch', tailProps(AT_MS), store);
  check('at 有市场 → ⎇分支 · 简称', textOf(out), `⎇${AT_BRANCH} · 北农商`);
  // titlesOf 返回的是 title 数组，这里 title 由分支名与市场全称拼成，故用 substring 判。
  check('市场全称进 title 提示', titlesOf(out).some((t) => t.includes('KH000456 北京农村商业银行股份有限公司')), true);
}

// 2. at.exact === false：正文不变，但 title 必须声明这是按 reflog 推断的。
{
  atPayload = {
    isRepo: true, branch: 'master',
    at: { time: AT_MS, branch: AT_BRANCH, detached: false, exact: false, market: AT_MARKET },
  };
  const { exports, store } = makeDriver();
  const out = await drive(exports, '__test_TurnBranch', tailProps(AT_MS), store);
  check('exact=false → title 含「推断」', titlesOf(out).some((t) => t.includes('推断')), true);
  check('exact=false → 正文不变', textOf(out), `⎇${AT_BRANCH} · 北农商`);
}

// 3a. 是仓库但该时刻的分支查不到：不留白，写明是哪一种情况。
{
  atPayload = { isRepo: true, branch: 'master' };
  const { exports, store } = makeDriver();
  const out = await drive(exports, '__test_TurnBranch', tailProps(AT_MS), store);
  check('无 at 块（仓库）→ 占位写查不到分支', textOf(out), '⎇—（该时刻查不到分支）');
  check('无 at 块 → 占位更淡', out?.props?.style?.opacity, 0.4);
}

// 3b. 非 git 工作区（用户报过的场景）：同样给占位。
{
  atPayload = { isRepo: false };
  const { exports, store } = makeDriver();
  const out = await drive(exports, '__test_TurnBranch', tailProps(AT_MS), store);
  check('非仓库 → 占位写「非 git 工作区」', textOf(out), '⎇—（非 git 工作区）');
}

// 4. 拿不到聊天快照（服务不可用）：不留白——用实时概况顶上，并明确标注「（当前）」。
{
  payload = { isRepo: true, branch: 'KH000115-无纸化信创(2.3_20160627)', detached: false, market: MARKET_115 };
  atPayload = { isRepo: false };
  const { exports, store } = makeDriver();
  const props = { ...tailProps(AT_MS), getChat: () => undefined };
  const out = await drive(exports, '__test_TurnBranch', props, store);
  check('无聊天快照 → 实时兜底并标「（当前）」', textOf(out), '⎇KH000115-无纸化信创(2.3_20160627) · 宁夏银行（当前）');
  check('兜底来源写进 data-bh-source', out?.props?.['data-bh-source'], 'live');
  check('兜底走实时概况（不带 at=）', fetchUrls[0]?.includes('at='), false);
  check('兜底 title 说明为什么没有定格值', titlesOf(out).some((t) => t.includes('会话快照不可用')), true);
}

// 4b. 快照就绪但里面没有这条消息（例如流式中/被裁剪）：同样退到实时兜底。
{
  payload = { isRepo: true, branch: 'master', detached: false };
  atPayload = { isRepo: false };
  const { exports, store } = makeDriver();
  const props = { ...tailProps(AT_MS), messageId: 'msg-other' };
  const out = await drive(exports, '__test_TurnBranch', props, store);
  check('消息不在快照里 → 退到实时兜底', out?.props?.['data-bh-source'], 'live');
  check('消息不在快照里 → title 说明原因', titlesOf(out).some((t) => t.includes('快照里查不到这条消息')), true);
}

// 5. 时间线里没有 turn/start：退到该消息自身的 time 作锚点。
{
  atPayload = { isRepo: true, branch: 'master', at: { time: AT_MS, branch: 'main', detached: false, exact: true } };
  const { exports, store } = makeDriver();
  const out = await drive(exports, '__test_TurnBranch', tailProps(AT_MS, '/repo', false), store);
  check('无 turn/start → 用消息自身 time 作锚点', textOf(out), '⎇main');
  check('锚点值等于消息 time', fetchUrls[0]?.includes(`at=${AT_MS}`), true);
}

// 5b. 位置：本元素必须带 CSS order，才能排到「用量/时间」右边。
{
  atPayload = { isRepo: true, branch: 'master', at: { time: AT_MS, branch: 'main', detached: false, exact: true } };
  const { exports, store } = makeDriver();
  const out = await drive(exports, '__test_TurnBranch', tailProps(AT_MS), store);
  check('行内 order 排在统计之后', out?.props?.style?.order, 9);
}

// 6. 游离头指针：图标换成 ⑂；没有市场时不出现分隔符。
{
  atPayload = { isRepo: true, branch: 'master', at: { time: AT_MS, branch: 'c106520', detached: true, exact: true } };
  const { exports, store } = makeDriver();
  const out = await drive(exports, '__test_TurnBranch', tailProps(AT_MS), store);
  check('detached 且无市场 → ⑂c106520', textOf(out), '⑂c106520');
}

// 7. 缓存：同一 (cwd, at) 渲染两次，宿主只被请求一次。
{
  atPayload = {
    isRepo: true, branch: 'master',
    at: { time: AT_MS, branch: AT_BRANCH, detached: false, exact: true, market: AT_MARKET },
  };
  const { exports, store } = makeDriver();
  const props = tailProps(AT_MS);
  const first = await drive(exports, '__test_TurnBranch', props, store);
  const second = await drive(exports, '__test_TurnBranch', props, store);
  check('同一 (cwd, at) 渲染两次 → 只请求一次', fetchUrls.length, 1);
  check('两次渲染结果一致', textOf(second), textOf(first));
}

// 8. 请求 URL：必须带 cwd= 与 at=，且 at 与 turn.start.time 一致。
{
  atPayload = {
    isRepo: true, branch: 'master',
    at: { time: AT_MS, branch: AT_BRANCH, detached: false, exact: true, market: AT_MARKET },
  };
  const { exports, store } = makeDriver();
  await drive(exports, '__test_TurnBranch', tailProps(AT_MS), store);
  check('URL 带 at= 且等于 start.time', fetchUrls[0]?.includes(`at=${AT_MS}`), true);
  check('URL 带 cwd=', fetchUrls[0]?.includes(`cwd=${encodeURIComponent('/repo')}`), true);
}

console.log(`\n${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}`);
for (const f of failures) console.log(`\n  ✗ ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
