/**
 * 宿主半真跑测试：用假 ctx 把 lib/index.js 挂起来，直接调它注册的路由 handler，
 * 核对返回体（含市场名）、三种错误码，以及 `?at=` 的历史回放。
 *
 * 为什么要这一层：市场名是在宿主半拼进响应里的，浏览器半拿到的只是一个字段。
 * 这条拼接在界面上无法与「分支认不出」区分——都表现成少一行，所以必须在服务端
 * 这一侧核对；顺便把「非仓库 / 缺 cwd / 相对路径 / 方法不对」四条边界一起钉住。
 *
 * 历史回放一律在**同一进程内**断言：切完分支马上回放「刚才那一刻」正是用户的实际
 * 用法，靠冷进程绕过缓存就会把「缓存让近时刻回放读到旧时间线」这个缺陷放过去。
 * 只有一条必须冷进程：reflog 时间线缓存是进程级的，「重启后仍定格」只能靠新进程证明。
 *
 * 测试自带一个临时 git 仓库，不依赖本机任何真实工程。
 *
 * 运行：node build.mjs && node test/host.mjs
 *
 * @module dsh-branch-hover/test/host
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { apply } = await import(pathToFileURL(resolve(here, '../lib/index.js')).href);

/** 走一次 `git -C <dir> …`；身份参数显式给，不吃用户全局配置。 */
function git(dir, args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=test@example.com', '-c', 'user.name=test', ...args], { stdio: 'pipe', encoding: 'utf8' });
}

/** reflog 里所有 checkout 条目（新 → 旧），供测试自己独立判读。 */
function checkoutLines(dir) {
  return git(dir, ['reflog', '--date=unix', '--format=%gD|%gs'])
    .split('\n')
    .filter((l) => l.includes('checkout:'));
}

/**
 * 取该仓库 reflog 里最后一次 checkout 的时刻（epoch 毫秒）。
 *
 * reflog 的时间戳只有秒，而 `Date.now()` 是毫秒：切换恰好落在秒边界之后时，
 * `Date.now()` 会比 reflog 记下的整秒小，回放会取到上一条 checkout——测试必须
 * 读 reflog 自身的时间，才是在断言插件而不是在断言时钟。
 *
 * @param {string} dir - 仓库目录。
 * @returns {number} epoch 毫秒。
 */
function lastCheckoutMs(dir) {
  const line = checkoutLines(dir)[0];
  const time = /@\{(\d+)\}/.exec(line ?? '');
  if (time === null) throw new Error(`临时仓库里找不到 checkout 条目：${line}`);
  return Number.parseInt(time[1], 10) * 1000;
}

/**
 * 取**时间上最早**那条 checkout 的 from —— 独立判据，测试自己解析 raw reflog，
 * 不复用被测代码的解析逻辑（否则测试只是把实现的错误抄了一遍）。
 * @param {string} dir - 仓库目录。
 * @returns {string} 最早那条 checkout 的 from。
 */
function earliestCheckoutFrom(dir) {
  const lines = checkoutLines(dir);
  if (lines.length === 0) throw new Error('临时仓库里没有 checkout 条目');
  const move = /^checkout: moving from (.*) to (.*)$/.exec(lines[lines.length - 1].split('|')[1]);
  if (move === null) throw new Error(`解析不了 checkout 条目：${lines[lines.length - 1]}`);
  return move[1];
}

/** 等到下一个整秒：让两次分支切换落在不同的 reflog 时间戳上。 */
function sleepUntilNextSecond() {
  return new Promise((r) => setTimeout(r, 1000 - (Date.now() % 1000) + 20));
}

/** 造一个已提交的空仓库并切到指定分支。 */
function makeRepo(dir, branch) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
  git(dir, ['checkout', '-q', '-b', branch]);
  return dir;
}

// ── 挂载宿主半 ────────────────────────────────────────────────────────────
const route = await new Promise((ready) => {
  const ctx = {
    // 真 cordis 的 effect 收 disposer；这里直接执行注册函数即可。
    effect: (fn) => fn(),
    webServer: { register: (r) => { ready(r); return () => {}; } },
  };
  apply(ctx);
});
if (route === undefined) throw new Error('apply 没有向 webServer 注册路由');

/**
 * 打一次路由，返回状态码与解析后的响应体。子进程里调用 `at=` 那一组检查。
 * @param {string} url - 请求 URL（含 query）。
 * @param {string} [method] - HTTP 方法。
 * @returns {Promise<{status: number, body: any}>} 结果。
 */
function request(url, method = 'GET') {
  return new Promise((resolvePromise, reject) => {
    const res = {
      status: 0,
      writeHead(status) { this.status = status; },
      end(payload) { resolvePromise({ status: this.status, body: JSON.parse(payload) }); },
    };
    Promise.resolve(route.handler({ method, url }, res)).catch(reject);
  });
}

/** 断言助手。 */
const failures = [];
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures.push(`${name}\n    期望: ${JSON.stringify(expected)}\n    实际: ${JSON.stringify(actual)}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}`);
}

/** 本进程结束后按失败数退出（子进程模式用）。 */
function finish() {
  console.log(`\n${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}`);
  for (const f of failures) console.log(`\n  ✗ ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

const atUrl = (repo, at) => `/branch-hover/api?cwd=${encodeURIComponent(repo)}&at=${at}`;

// ── 子进程：唯一必须冷进程的一条 ──────────────────────────────────────────
// reflog 时间线缓存是进程级的，所以「进程重启（或翻旧会话）之后仍给出当时的分支」
// 只能由新进程证明：主进程此刻已把缓存预热成「切换之后」的状态，同进程无法自证重启行为。
if (process.env.DSH_BH_RESTART === '1') {
  const repo = process.env.DSH_BH_REPO ?? '';
  const t1 = Number(process.env.DSH_BH_T1);
  const { status, body } = await request(atUrl(repo, t1));
  check('重启后回放 T1 → 200', status, 200);
  check('重启后回放 T1 → 仍是当时的分支', body.at?.branch, 'KH000115-无纸化信创');
  check('重启后回放 T1 → 市场名仍在', body.at?.market?.code, 'KH000115');
  finish();
}

const root = mkdtempSync(join(tmpdir(), 'dsh-branch-hover-'));
console.log('宿主路由核对：\n');

try {
  // 两个仓库：同一个 cwd 会在 4s 内命中缓存，所以「换分支」用另一个目录表达。
  const onCode = makeRepo(join(root, 'code'), 'KH000115-无纸化信创');
  const onMaster = makeRepo(join(root, 'master'), 'master');
  const plain = join(root, 'plain');
  mkdirSync(plain, { recursive: true });

  const query = (cwd) => `?cwd=${encodeURIComponent(cwd)}`;

  {
    const { status, body } = await request(`/branch-hover/api${query(onCode)}`);
    check('KH 分支 → 200', status, 200);
    check('KH 分支 → isRepo', body.isRepo, true);
    check('KH 分支 → 带回市场编码', body.market?.code, 'KH000115');
    check('KH 分支 → 市场简称非空', (body.market?.short ?? '') !== '', true);
    check('KH 分支 → 市场全称非空', (body.market?.name ?? '') !== '', true);
    check('KH 分支 → 分支名原样', body.branch, 'KH000115-无纸化信创');
  }

  {
    const { body } = await request(`/branch-hover/api${query(onMaster)}`);
    check('master 分支 → 无 market 字段', body.market, undefined);
  }

  {
    const { status, body } = await request(`/branch-hover/api${query(plain)}`);
    check('非仓库 → 200 且 isRepo=false', `${status}/${body.isRepo}`, '200/false');
  }

  check('缺 cwd → 400', (await request('/branch-hover/api')).body.error, 'cwd-required');
  check('相对路径 → 400', (await request('/branch-hover/api?cwd=relative/dir')).body.error, 'cwd-must-be-absolute');
  check('POST → 405', (await request('/branch-hover/api?cwd=/tmp', 'POST')).status, 405);

  // ── 历史回放（at=）────────────────────────────────────────────────────
  // 同一个仓库里真的切两次分支再回放：这是本任务的核心——「那一刻在哪个分支」
  // 必须定格，之后切走、重启都不能改。所以这里刻意用「切换之后再问旧时刻」。
  // 全部在**同一进程内**断言：切完分支立刻回放正是用户的实际用法，靠冷进程绕过
  // 缓存就会把「近时刻回放读到旧时间线」这个缺陷放过去。
  console.log('\n历史回放核对（at=）：\n');
  {
    const repo = join(root, 'replay');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
    git(repo, ['checkout', '-q', '-b', 'KH000115-无纸化信创']);

    // T1 取「此刻」：reflog 只记到整秒，所以取该条 checkout 自身的时间戳，
    // 保证它既不早于那条记录，也仍早于下一次切换。
    const t1 = lastCheckoutMs(repo);

    // 两次切换必须落在不同的整秒里：否则 reflog 里两条 checkout 时间戳相同，
    // 「T2 时刻在哪个分支」在数据上本身就是歧义的，测不出对错。
    await sleepUntilNextSecond();

    git(repo, ['checkout', '-q', '-b', 'master']);
    const t2 = lastCheckoutMs(repo);

    {
      const { status, body } = await request(atUrl(repo, t1));
      check('回放 T1 → 200', status, 200);
      check('回放 T1 → 当时的分支', body.at?.branch, 'KH000115-无纸化信创');
      check('回放 T1 → exact', body.at?.exact, true);
      check('回放 T1 → 不是游离', body.at?.detached, false);
      check('回放 T1 → time 原样回显', body.at?.time, t1);
      check('回放 T1 → 市场编码', body.at?.market?.code, 'KH000115');
      check('回放 T1 → market.short 非空', (body.at?.market?.short ?? '') !== '', true);
    }

    {
      const { status, body } = await request(atUrl(repo, t2));
      check('回放 T2 → 200', status, 200);
      check('回放 T2 → 已是 master', body.at?.branch, 'master');
      check('回放 T2 → exact', body.at?.exact, true);
      check('回放 T2 → master 查不到市场名', body.at?.market, undefined);
    }

    {
      // 定格断言：此刻工作区已在 master 上，回放 T1 仍必须给出当时那个分支。
      const { body } = await request(atUrl(repo, t1));
      check('定格：切到 master 后回放 T1 不变', body.at?.branch, 'KH000115-无纸化信创');
      check('定格：市场名也仍是当时那个', body.at?.market?.code, 'KH000115');
    }

    {
      const { body } = await request(`/branch-hover/api?cwd=${encodeURIComponent(repo)}`);
      check('不带 at → 没有 at 字段', body.at, undefined);
      check('不带 at → 仍是当前分支', body.branch, 'master');
    }

    {
      // 唯一必须冷进程的一条：reflog 缓存是进程级的，重启后仍定格只能由新进程证明。
      const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        encoding: 'utf8',
        env: { ...process.env, DSH_BH_RESTART: '1', DSH_BH_REPO: repo, DSH_BH_T1: String(t1) },
      });
      process.stdout.write(run.stdout ?? '');
      process.stderr.write(run.stderr ?? '');
      if (run.status !== 0) failures.push(`子进程（重启）阶段未通过（exit ${run.status}）`);
    }

    check('at=abc → 400 at-invalid', (await request(atUrl(repo, 'abc'))).body.error, 'at-invalid');
    check('at=-1 → 400 at-invalid', (await request(atUrl(repo, '-1'))).body.error, 'at-invalid');
    check('at=NaN 字面量 → 400 at-invalid', (await request(atUrl(repo, 'NaN'))).body.error, 'at-invalid');
    check('at= 空串 → 400 at-invalid', (await request(atUrl(repo, ''))).body.error, 'at-invalid');
  }

  // ── 两条缺陷的回归用例 ────────────────────────────────────────────────
  console.log('\n缺陷回归：\n');
  {
    // 缺陷 1：T 早于全部 checkout 时，必须取**时间上最早**那条的 from，不是最新那条。
    const repo = join(root, 'earliest');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
    await sleepUntilNextSecond();
    git(repo, ['checkout', '-q', '-b', 'KH000115-alpha']);   // from = 默认初始分支
    await sleepUntilNextSecond();
    git(repo, ['checkout', '-q', '-b', 'KH000456-beta']);    // from = KH000115-alpha

    // 独立判据：测试自己解析 raw reflog 的最后一条 checkout（最新那条是 beta 的 from）。
    const expected = earliestCheckoutFrom(repo);
    const { body } = await request(atUrl(repo, Date.now() - 24 * 3600 * 1000));
    check('T 早于全部 checkout → 取最早那条的 from', body.at?.branch, expected);
    check('T 早于全部 checkout → 不是最新那条的 from', body.at?.branch === 'KH000115-alpha', false);
    check('T 早于全部 checkout → exact=false', body.at?.exact, false);
  }

  {
    // 缺陷 2：同一进程内预热时间线缓存 → 切分支 → 回放「切换之后的最新时刻」。
    // 期望拿到新分支：近时刻必须绕过缓存重读 reflog。
    const repo = join(root, 'prewarm');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
    git(repo, ['checkout', '-q', '-b', 'KH000115-alpha']);

    const warmed = await request(atUrl(repo, Date.now()));
    check('预热：切换前回放 → alpha', warmed.body.at?.branch, 'KH000115-alpha');

    await sleepUntilNextSecond();
    git(repo, ['checkout', '-q', '-b', 'KH000456-beta']);

    const { body } = await request(atUrl(repo, Date.now() + 1000));
    check('预热后切分支 → 回放最新时刻拿到新分支', body.at?.branch, 'KH000456-beta');
    check('预热后切分支 → 不再返回旧分支', body.at?.branch === 'KH000115-alpha', false);
  }

  {
    // 非仓库：即便给了合法 at，也保持 isRepo=false 的旧形态，不带 at 字段。
    const { status, body } = await request(`/branch-hover/api${query(plain)}&at=${Date.now()}`);
    check('非仓库 + at → 200 且 isRepo=false', `${status}/${body.isRepo}`, '200/false');
    check('非仓库 + at → 无 at 字段', body.at, undefined);
  }

  // ── 回放的边角规则 ────────────────────────────────────────────────────
  console.log('\n历史回放边角：\n');
  {
    // 游离头指针：`to` 是提交 SHA，必须给短 SHA 并标 detached。
    const repo = join(root, 'detached');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'a']);
    const full = git(repo, ['rev-parse', 'HEAD']).trim();
    await sleepUntilNextSecond();
    git(repo, ['checkout', '-q', full]);

    const { body } = await request(atUrl(repo, Date.now()));
    check('游离 HEAD → 短 SHA', body.at?.branch, full.slice(0, 12));
    check('游离 HEAD → detached', body.at?.detached, true);
    check('游离 HEAD → exact', body.at?.exact, true);
  }

  {
    // `reset:` 不改变所在分支，不能被当成切换。
    const repo = join(root, 'reset');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
    await sleepUntilNextSecond();
    git(repo, ['checkout', '-q', '-b', 'KH000115-无纸化信创']);
    await sleepUntilNextSecond();
    git(repo, ['reset', '-q', '--hard', 'HEAD']);

    const { body } = await request(atUrl(repo, Date.now()));
    check('跨过 reset 回放 → 仍是切换后的分支', body.at?.branch, 'KH000115-无纸化信创');
    check('跨过 reset 回放 → exact', body.at?.exact, true);
  }

  {
    // reflog 里一条 checkout 都没有：只能用当前分支，且必须标 exact=false。
    // （「T 早于全部 checkout」那一支由上面的缺陷回归用例按最早条目精确断言。）
    const repo = join(root, 'nocheckout');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
    const current = git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']).trim();
    const { body } = await request(atUrl(repo, Date.now() - 3600_000));
    check('无 checkout 条目 → 当前分支', body.at?.branch, current);
    check('无 checkout 条目 → exact=false', body.at?.exact, false);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}`);
for (const f of failures) console.log(`\n  ✗ ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
