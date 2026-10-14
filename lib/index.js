/**
 * dsh-branch-hover —— 宿主半。
 *
 * 职责只有两件：
 *  1. 提供一条 GET `/branch-hover/api?cwd=<绝对路径>` 路由，返回该目录的 git 概况，
 *     并把分支名前段的客户编码换成市场名一并返回；
 *  2. 对结果做短 TTL 缓存 + 在途请求合并，把「N 个可见会话行同时 hover」压成
 *     每个工作区最多一次 git 查询。
 *
 * 为什么必须有宿主半：浏览器半跑在页面沙箱里，没有 child_process，读不到 git。
 * 工作区路径也只存在于宿主侧。所以取数一律走这条路由，客户端只做渲染。
 *
 * @module dsh-branch-hover
 */
import { readBranchAt, readGitSummary } from './git.js';
import { marketFor } from './market.js';

/** 结果缓存时长；hover 卡片的时效性要求不高，够短即好。 */
const CACHE_TTL_MS = 4000;
/** 缓存条目上限，防止长时间运行下按目录无限增长。 */
const CACHE_MAX = 200;

/** cwd → { at, value }。value 为 undefined 表示「查过了，不是 git 仓库」。 */
const cache = new Map();
/** cwd → 在途 Promise，用于合并同一目录的并发请求。 */
const inflight = new Map();

/**
 * 读一次 git 概况，带缓存与在途合并。
 * @param {string} cwd - 工作区绝对路径。
 * @returns {Promise<object | undefined>} 概况对象或 undefined（非仓库）。
 */
function summaryFor(cwd) {
  const hit = cache.get(cwd);
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.value);

  const pending = inflight.get(cwd);
  if (pending !== undefined) return pending;

  const task = readGitSummary(cwd)
    // 市场名在宿主半拼接，不进 git.js：git.js 只认 git，映射来自构建期快照。
    // 认不出编码时 market 为 undefined，JSON 里直接没有这个字段。
    .then((value) => (value === undefined ? undefined : { ...value, market: marketFor(value.branch) }))
    .then((value) => {
      // 重新插入以刷新 LRU 次序。
      cache.delete(cwd);
      cache.set(cwd, { at: Date.now(), value });
      while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next();
        if (oldest.done === true) break;
        cache.delete(oldest.value);
      }
      return value;
    })
    .catch(() => undefined)
    .finally(() => { inflight.delete(cwd); });

  inflight.set(cwd, task);
  return task;
}

/** 写一个 JSON 响应。 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // 同源页面直接调，无需 CORS；显式声明避免被中间层改写。
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** 所需服务：宿主 HTTP 路由注册表。 */
export const inject = ['webServer'];

/**
 * 挂载本体。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 */
export function apply(ctx) {
  // register 返回 disposer，正是 ctx.effect 需要的形态：插件卸载即摘掉路由。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/branch-hover/api',
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }

      // 用 WHATWG URL 以 localhost 为基址解析，保证相对路径也能拿到 query。
      let params;
      try {
        params = new URL(req.url ?? '/', 'http://localhost').searchParams;
      } catch {
        params = new URLSearchParams();
      }

      // `at` 是「回放某个历史时刻」的开关。给了就必须是合法数字：静默忽略会让
      // 调用方以为拿到的是历史值，而实际拿到的是当前值——错得看不出来。
      const rawAt = params.get('at');
      let atMs;
      if (rawAt !== null) {
        const parsed = Number(rawAt);
        // 空串会被 Number 转成 0（合法数字），所以额外挡掉空串。
        if (rawAt.trim() === '' || !Number.isFinite(parsed) || parsed < 0) {
          sendJson(res, 400, { error: 'at-invalid' });
          return;
        }
        atMs = parsed;
      }

      const cwd = params.get('cwd') ?? '';
      if (cwd === '') {
        sendJson(res, 400, { error: 'cwd-required' });
        return;
      }
      // 必须是绝对路径：相对路径在宿主进程里无意义，且会随进程 cwd 漂移。
      if (!cwd.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(cwd)) {
        sendJson(res, 400, { error: 'cwd-must-be-absolute' });
        return;
      }

      const summary = await summaryFor(cwd);
      if (summary === undefined) {
        // 不是 git 仓库（或目录不存在）——不是错误，是「没有可显示的分支」。
        sendJson(res, 200, { isRepo: false });
        return;
      }

      const body = { isRepo: true, ...summary };
      if (atMs !== undefined) {
        // 历史回放刻意不进 4s 概况缓存：同一个 cwd 的不同 at 共用一条缓存条目
        // 会互相污染（先到的 at 决定后来者看到的历史）。解析本身是内存操作。
        const at = await readBranchAt(cwd, atMs);
        if (at !== undefined) {
          const market = marketFor(at.branch);
          // JSON.stringify 会丢掉 undefined，所以查不到市场名时字段自然消失。
          body.at = market === undefined ? at : { ...at, market };
        }
        // at 判不出来就整个省略——宁可没有，也不给一个编出来的分支名。
      }
      sendJson(res, 200, body);
    },
  }), 'dsh-branch-hover: git summary route');
}
