/**
 * Git 取数：从工作目录读当前分支与新近提交。
 *
 * 只做只读查询（`rev-parse` / `status` / `log`），绝不改仓库状态——这个插件的
 * 职责是「显示」，任何写操作都属于别的工具的领地。
 *
 * 所有 git 调用都带超时与 `-C <dir>`，不依赖进程 cwd（宿主可能有多个工作区
 * 并发请求，共享 cwd 会串味）。
 *
 * @module dsh-branch-hover/git
 */
import { execFile } from 'node:child_process';

/** 一次 git 查询的墙钟上限：hover 卡片是交互路径，宁可缺数据也不能挂住。 */
const GIT_TIMEOUT_MS = 3000;

/**
 * 跑一条 git 子命令，失败即视为「没有答案」。
 * @param {string} dir - 仓库目录（工作区 cwd）。
 * @param {readonly string[]} args - git 参数（不含 `git` 本身）。
 * @returns {Promise<string | undefined>} 去尾空白的 stdout；非零退出或超时返回 undefined。
 */
function git(dir, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1 << 20,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) return resolve(undefined);
      resolve(String(stdout).replace(/\s+$/, ''));
    });
  });
}

/**
 * 读一个工作目录的 git 概况。
 *
 * 分支名走 `symbolic-ref` 而非 `rev-parse --abbrev-ref HEAD`：后者在 detached
 * HEAD 下会返回字面量 `HEAD`（无信息量），而前者会失败——我们就用这个失败来
 * 区分「游离头指针」和「真分支」，再退回读短 SHA。
 *
 * `rev-parse` 同时承担「这是不是一个 git 仓库」的判定：非仓库时它非零退出，
 * 我们返回 undefined，卡片据此不渲染。
 *
 * @param {string} dir - 工作区目录的绝对路径。
 * @returns {Promise<{branch: string, detached: boolean, shortSha: string, dirty: number, ahead: number, behind: number} | undefined>}
 *   概况对象；非 git 仓库或目录不可读时返回 undefined。
 */
export async function readGitSummary(dir) {
  if (typeof dir !== 'string' || dir === '') return undefined;

  // 一次调用同时确认「是仓库」并拿到仓库根，后续调用才有意义。
  const root = await git(dir, ['rev-parse', '--show-toplevel']);
  if (root === undefined || root === '') return undefined;

  // 分支与短 SHA 并行；dirty / ahead-behind 依赖分支存在与否，放在后面。
  const [branchRef, shortSha] = await Promise.all([
    git(root, ['symbolic-ref', '--short', '-q', 'HEAD']),
    git(root, ['rev-parse', '--short', 'HEAD']),
  ]);

  const detached = branchRef === undefined;
  // detached 时没有分支名，用短 SHA 顶上，卡片会以「游离」形态呈现。
  const branch = detached ? (shortSha ?? '') : branchRef;
  if (branch === '') return undefined;

  const [statusOut, counts] = await Promise.all([
    git(root, ['status', '--porcelain']),
    // 无上游时该命令非零退出 → undefined → 计为 0/0，不显示领先落后。
    git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
  ]);

  const dirty = statusOut === undefined || statusOut === ''
    ? 0
    : statusOut.split('\n').filter((line) => line.trim() !== '').length;

  let ahead = 0;
  let behind = 0;
  if (counts !== undefined) {
    // 形如 `3\t1`：左为 ahead（HEAD 独有），右为 behind（上游独有）。
    const [a, b] = counts.split(/\s+/);
    ahead = Number.parseInt(a ?? '0', 10) || 0;
    behind = Number.parseInt(b ?? '0', 10) || 0;
  }

  return { branch, detached, shortSha: shortSha ?? '', dirty, ahead, behind };
}

/** reflog 时间线缓存时长：reflog 只在人切换分支时才变，30s 足够新。 */
const REFLOG_TTL_MS = 30_000;
/**
 * 「近时刻」绕过缓存的窗口，必须 **不窄于** REFLOG_TTL_MS。
 *
 * 为什么不能只靠 TTL：切完分支立刻问「刚刚那一刻」时，缓存条目写在这次切换之前，
 * 却仍在 TTL 内，于是回放给出切换前的分支——正是用户诉求的反面。
 *
 * 为什么这条规则能彻底关掉这类错误：查询 T 走缓存时，该条目的写入时刻 W 满足
 * W > now - REFLOG_TTL_MS。若 T < now - REFLOG_FRESH_WINDOW_MS，且窗口 ≥ TTL，
 * 则 T < W；而任何时间 ≥ W 的切换都晚于 T、不可能影响 T 的答案。也就是说
 * 「TTL 还在、但写在相关切换之前」的条目，对窗口以外的查询不可能成立。
 * 别把窗口调得比 TTL 小，也别把它当冗余优化掉。
 */
const REFLOG_FRESH_WINDOW_MS = 60_000;
/** 缓存条目上限：同一宿主可能被上百个工作区轮着 hover，不设上限就是内存泄漏。 */
const REFLOG_MAX = 200;

/** cwd → { at, value }。value 为 undefined 表示「查过了，这个目录没有 reflog」。 */
const reflogCache = new Map();

/** `%gD` 给的是 `HEAD@{1791787115}`，这里只要花括号里的秒。 */
const REFLOG_TIME_PATTERN = /@\{(\d+)\}/;
/** 只认真正的切换条目；`reset:` / `commit:` / `merge` 不改变所在分支。 */
const CHECKOUT_PATTERN = /^checkout: moving from (.*) to (.*)$/;
/** 这个长度区间的十六进制串只可能是提交对象，不可能是分支名。 */
const SHA_PATTERN = /^[0-9a-f]{16,40}$/i;

/**
 * 拉一个目录的 reflog 时间线（秒级时间戳 + checkout 条目），按 cwd 短缓存。
 *
 * 为什么按 cwd 而不是按仓库根：宿主侧只有工作区 cwd，而且同一 cwd 的请求
 * 天然是同一份答案；`git -C <子目录> reflog` 的输出与在仓库根执行一致。
 * 缓存只压「多久跑一次子进程」，`branch_at` 的解析仍逐次在内存里做。
 *
 * @param {string} dir - 工作区目录（绝对路径）。
 * @param {boolean} [fresh] - true 表示绕过缓存直接重读 reflog（仍写回缓存）。
 * @returns {Promise<{time: number, from: string, to: string}[] | undefined>}
 *   按 reflog 原序（新 → 旧）的 checkout 条目；非仓库 / 无 reflog 时 undefined。
 */
function reflogTimeline(dir, fresh) {
  if (fresh !== true) {
    const hit = reflogCache.get(dir);
    if (hit !== undefined && Date.now() - hit.at < REFLOG_TTL_MS) return Promise.resolve(hit.value);
  }

  const task = git(dir, ['reflog', '--date=unix', '--format=%gD|%gs'])
    .then((out) => {
      if (out === undefined || out === '') return undefined;

      const entries = [];
      for (const line of out.split('\n')) {
        // 形态 `HEAD@{1791884272}|checkout: moving from A to B`；时间戳不含 `|`，
        // 所以按第一个 `|` 切分对任何分支名都安全（第二个 `|` 留在消息里）。
        const sep = line.indexOf('|');
        if (sep < 0) continue;

        const time = REFLOG_TIME_PATTERN.exec(line.slice(0, sep));
        if (time === null) continue;
        const message = line.slice(sep + 1);

        const move = CHECKOUT_PATTERN.exec(message);
        // 认不出 `from … to …` 的条目（畸形消息、被截断的 reflog）直接丢掉：
        // 少一条切换记录只会退化成推断值，而误读一条会给出错误的分支名。
        if (move === null) continue;

        const from = move[1].trim();
        const to = move[2].trim();
        if (from === '' || to === '') continue;

        entries.push({ time: Number.parseInt(time[1], 10), from, to });
      }

      return entries.length === 0 ? undefined : entries;
    })
    .catch(() => undefined);

  // 只在任务落地后写缓存：先塞一个占位条目会让 30s 内的后续请求直接读到 undefined，
  // 表现为「第一次 hover 有分支名，之后半分钟全没有」。
  task.then((value) => {
    // 重新插入以刷新 LRU 次序。
    reflogCache.delete(dir);
    reflogCache.set(dir, { at: Date.now(), value });
    while (reflogCache.size > REFLOG_MAX) {
      const oldest = reflogCache.keys().next();
      if (oldest.done === true) break;
      reflogCache.delete(oldest.value);
    }
  });

  return task;
}

/**
 * 把一个 reflog 里的「目标」翻译成分支形态。
 *
 * SHA 与字面量 `HEAD` 都不是分支名，而是游离头指针的表现——判定必须在这里
 * 做，而不是在路由里：游离与否是 git 语义，路由只负责拼字段。
 *
 * @param {string} name - checkout 条目的 to/from。
 * @param {string} root - 仓库根，用于把完整 SHA 缩成短 SHA 兜底。
 * @returns {Promise<{branch: string, detached: boolean} | undefined>} 给不出分支名时 undefined。
 */
async function resolveTarget(name, root) {
  if (SHA_PATTERN.test(name)) return { branch: name.slice(0, 12), detached: true };
  if (name === 'HEAD') {
    // reflog 里的 `HEAD` 只表示「当时就在游离状态」，具体是哪个提交已不可考。
    const sha = await git(root, ['rev-parse', '--short', 'HEAD']);
    return sha === undefined || sha === '' ? undefined : { branch: sha, detached: true };
  }
  return { branch: name, detached: false };
}

/**
 * 读某个工作区在某个历史时刻 HEAD 所在的分支。
 *
 * 依据是 reflog 里切换条目自身的墙钟时间（`%gD` 的花括号，单位秒），不是提交
 * 时间 `%cd`——后者在 checkout 一个老提交时会把时间倒退到 2017 年，判出来的
 * 分支完全错位。
 *
 * 判定规则：
 *  1. 时间 ≤ atMs 的最后一条 `checkout:` 条目 → 它的 `to`，`exact: true`；
 *  2. atMs 早于所有 checkout → 最早那条 checkout 的 `from`，`exact: false`；
 *  3. reflog 里没有 checkout → 当前分支，`exact: false`。
 *
 * @param {string} dir - 工作区目录的绝对路径。
 * @param {number} atMs - 目标时刻，epoch 毫秒（调用方已校验为有限非负数）。
 * @returns {Promise<{time: number, branch: string, detached: boolean, exact: boolean} | undefined>}
 *   该时刻的分支；判不出时 undefined（路由据此整个省略 at 字段）。
 */
export async function readBranchAt(dir, atMs) {
  if (typeof dir !== 'string' || dir === '') return undefined;

  const root = await git(dir, ['rev-parse', '--show-toplevel']);
  if (root === undefined || root === '') return undefined;

  // 近时刻一律重读 reflog：切完分支马上问「刚才那一刻」时缓存必然过时（见常量注释）。
  const entries = await reflogTimeline(dir, atMs >= Date.now() - REFLOG_FRESH_WINDOW_MS);

  let branch;
  let detached = false;
  let exact = false;

  if (entries !== undefined) {
    const atSec = Math.floor(atMs / 1000);

    // reflog 是新 → 旧：从最新往回走，第一条 ≤ T 的切换就是「T 时刻所在的那次切换」。
    // 注意不能倒着从末尾往前扫——那会停在**最早**一条满足条件的记录上。
    let chosen;
    for (const entry of entries) {
      if (entry.time <= atSec) { chosen = entry; break; }
    }

    const resolved = chosen === undefined
      // 没有 ≤ T 的切换：用**时间上最早**那条 checkout 的 from——那才是这段历史
      // 开始之前所在的分支（entries 是 reflog 原序「新 → 旧」，最早的在末尾）。
      ? await resolveTarget(entries[entries.length - 1].from, root)
      : await resolveTarget(chosen.to, root);
    if (resolved === undefined) return undefined;

    branch = resolved.branch;
    detached = resolved.detached;
    exact = chosen !== undefined;
  } else {
    // 没有 reflog（全新 clone、reflog 被关掉）：只能拿当前分支顶，且不是 exact。
    const ref = await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
    if (ref === undefined || ref === '') {
      const sha = await git(root, ['rev-parse', '--short', 'HEAD']);
      if (sha === undefined || sha === '') return undefined;
      branch = sha;
      detached = true;
    } else {
      branch = ref;
    }
  }

  return { time: atMs, branch, detached, exact };
}
