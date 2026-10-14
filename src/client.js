/**
 * dsh-branch-hover —— 浏览器半。
 *
 * 注册三处界面，都是「会话 → 其工作区 cwd → git 概况」的同一个投影：
 *
 *  1. ui-workspace 的 `sidebar.session.row.hover`：鼠标停在工作区下的会话行上
 *     时，行卡片里多出一行 git 分支信息，并在能认出分支名前段的客户编码时再
 *     补一行市场名（映射由宿主半查快照给出）。
 *  2. ui-conversation 的 `conversation.input.dock`：空白会话里显示当前市场，
 *     让「新建会话」这一步就能看出选的是哪个市场。
 *  3. ui-chat 的 `conversation.chat.turnTail`：每一轮回答下方显示该轮开始时
 *     定格的 git 分支与市场。
 *
 * 这些席位的契约都只给行/轮的 owner props（见各自 slots.d.ts），加上全局标准件
 * `sessionId` 与 `useSessions`。工作区路径一律自己从 `useSessions().byId[sessionId].cwd`
 * 取。
 *
 * 取数一律走宿主路由 `/branch-hover/api`：浏览器里没有 child_process。
 *
 * 注意本文件被包进 `factory: (require) => {...}` 的 CJS 外壳：这里**不能用
 * `import` 语句**，平台基线模块一律通过 factory 的 `require` 取（`react`
 * 是基线 seed 词，构建时不打包）。
 *
 * @module dsh-branch-hover/client
 */
const React = require('react');

/** 命中缓存的存活时长，与宿主侧 TTL 同量级；避免同一行反复 hover 时重复打网络。 */
const CLIENT_TTL_MS = 4000;

/** cwd → { at, value }，模块级即可：插件重载会重建整个模块。 */
const memo = new Map();
/** cwd → 在途 Promise，合并同一工作区的并发 hover。 */
const pending = new Map();

/**
 * 取一个工作区的 git 概况（带客户端缓存）。
 * @param {string} cwd - 工作区绝对路径。
 * @returns {Promise<{isRepo: boolean, branch?: string, detached?: boolean, shortSha?: string, dirty?: number, ahead?: number, behind?: number, market?: {code: string, name: string, short: string}}>}
 */
function fetchSummary(cwd) {
  const hit = memo.get(cwd);
  if (hit !== undefined && Date.now() - hit.at < CLIENT_TTL_MS) return Promise.resolve(hit.value);

  const running = pending.get(cwd);
  if (running !== undefined) return running;

  const task = fetch(`/branch-hover/api?cwd=${encodeURIComponent(cwd)}`, {
    headers: { accept: 'application/json' },
  })
    .then((res) => (res.ok ? res.json() : { isRepo: false }))
    // 网络失败按「没有分支」处理：hover 卡片不该因为取数失败而报错或空转。
    .catch(() => ({ isRepo: false }))
    .then((value) => {
      memo.set(cwd, { at: Date.now(), value });
      return value;
    })
    .finally(() => { pending.delete(cwd); });

  pending.set(cwd, task);
  return task;
}

/** 历史回放缓存容量上限：键里带时间锚点，回合攒多了会按 (cwd, at) 无限增长。 */
const AT_CACHE_MAX = 500;
/**
 * `${cwd}\n${at}` → 响应。历史值一旦定下来就不会再变，所以**不设 TTL**：
 * 同一轮反复重渲染、同一会话多轮回看，都只打一次网络。
 */
const atMemo = new Map();
/** 同一键的在途 Promise，合并同键并发（同一轮的两个入口同时挂载时会发生）。 */
const atPending = new Map();

/**
 * 取某个工作区在某个历史时刻的分支概况（带长期缓存）。
 *
 * 必须走 `at=` 而不是复用实时结果：一轮对话可能跨多次分支切换，用实时分支会让
 * 历史回合的标注随当前工作区改口——这个席位要的是「当时定格」。
 *
 * @param {string} cwd - 工作区绝对路径。
 * @param {number} at - Unix epoch 毫秒；宿主半按 reflog 反推该时刻的分支。
 * @returns {Promise<object | null>} 响应体；网络失败为 null（不入缓存，留给下次重试）。
 */
function fetchAt(cwd, at) {
  const key = `${cwd}\n${at}`;
  const hit = atMemo.get(key);
  if (hit !== undefined) return Promise.resolve(hit);

  const running = atPending.get(key);
  if (running !== undefined) return running;

  const task = fetch(`/branch-hover/api?cwd=${encodeURIComponent(cwd)}&at=${at}`, {
    headers: { accept: 'application/json' },
  })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null)
    .then((value) => {
      // 只缓存真拿到的响应：网络失败是暂时的，缓存住会让这一轮永远空着。
      if (value !== null) {
        atMemo.set(key, value);
        while (atMemo.size > AT_CACHE_MAX) {
          const oldest = atMemo.keys().next();
          if (oldest.done === true) break;
          atMemo.delete(oldest.value);
        }
      }
      return value;
    })
    .finally(() => { atPending.delete(key); });

  atPending.set(key, task);
  return task;
}

/** 分支区块的内联样式；hover 卡片是紧凑窄栏，字号与行距都要收着。 */
const styles = {
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginTop: '4px',
    fontSize: '11px',
    lineHeight: '16px',
    minWidth: 0,
  },
  icon: { flex: '0 0 auto', opacity: 0.75, fontFamily: 'monospace' },
  branch: {
    flex: '0 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    opacity: 0.9,
  },
  meta: { flex: '0 0 auto', opacity: 0.6, fontVariantNumeric: 'tabular-nums' },
  // 市场名另起一行：分支名本身已经很长，挤在同一行会把市场名挤没。
  market: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginTop: '2px',
    fontSize: '11px',
    lineHeight: '16px',
    minWidth: 0,
  },
  marketLabel: { flex: '0 0 auto', opacity: 0.55 },
  marketName: {
    flex: '0 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    opacity: 0.9,
  },
};

/**
 * 空白会话市场行的内联样式：宿主给的是全宽一条，所以只要居中与克制的字色。
 * 不透明度整体压低——这是环境提示，不是要在输入前抢注意力的东西。
 */
const dockStyles = {
  row: {
    width: '100%',
    textAlign: 'center',
    fontSize: '11px',
    lineHeight: '16px',
    opacity: 0.55,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
};

/** 每轮定格分支行的内联样式：与 hover 区块同款排版，但整行更淡。 */
const tailStyles = {
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '11px',
    lineHeight: '16px',
    opacity: 0.55,
    minWidth: 0,
  },
  icon: { flex: '0 0 auto', fontFamily: 'monospace' },
  branch: {
    flex: '0 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  market: { flex: '0 0 auto' },
};

/**
 * 会话行 hover 卡片里的 git 分支区块：一行分支，认得出客户编码时再跟一行市场名。
 * @param {object} props - 插槽标准件。
 * @param {string} props.sessionId - 本行显示的会话 id（owner 传入）。
 * @param {Function} props.useSessions - 全局会话目录选择器 hook。
 * @returns {import('react').JSX.Element | null} 分支区块；非 git 工作区时不渲染。
 */
function BranchHover({ sessionId, useSessions }) {
  // 只选 cwd：会话目录任何其他字段变化都不该让本组件重渲染。
  const cwd = useSessions((list) => list.byId[sessionId]?.cwd);

  const [summary, setSummary] = React.useState(null);

  React.useEffect(() => {
    if (typeof cwd !== 'string' || cwd === '') {
      setSummary(null);
      return undefined;
    }
    // hover 卡片是长悬停预览，卸载即放弃——用标志位避免卸载后 setState。
    let alive = true;
    fetchSummary(cwd).then((value) => { if (alive) setSummary(value); });
    return () => { alive = false; };
  }, [cwd]);

  if (summary === null || summary.isRepo !== true) return null;

  const branch = summary.branch ?? '';
  if (branch === '') return null;

  // 有上游分叉时才显示 ↑↓；全 0 表示与上游一致，不占位置。
  const meta = [];
  if (summary.ahead > 0) meta.push(`↑${summary.ahead}`);
  if (summary.behind > 0) meta.push(`↓${summary.behind}`);
  if (summary.dirty > 0) meta.push(`●${summary.dirty}`);

  const branchRow = React.createElement(
    'div',
    { style: styles.row, title: summary.detached === true ? `${branch} (detached HEAD)` : branch },
    React.createElement('span', { style: styles.icon, 'aria-hidden': 'true' }, summary.detached === true ? '⑂' : '⎇'),
    React.createElement('span', { style: styles.branch }, branch),
    meta.length > 0 ? React.createElement('span', { style: styles.meta }, meta.join(' ')) : null,
  );

  // 市场名（宿主半按分支名前段的客户编码查快照得到）；查不到就只显示分支行。
  const market = summary.market;
  let marketRow = null;
  if (market !== undefined && market !== null && typeof market.short === 'string' && market.short !== '') {
    marketRow = React.createElement(
      'div',
      { style: styles.market, title: `${market.code} ${market.name}` },
      React.createElement('span', { style: styles.marketLabel }, '市场：'),
      React.createElement('span', { style: styles.marketName }, market.short),
    );
  }

  return React.createElement(React.Fragment, null, branchRow, marketRow);
}

/**
 * 空白会话里的市场行：只在「刚新建、还没发第一条消息」的会话里出现。
 *
 * 为什么只认 blank：普通会话里信息已经够密，再挂一条市场名只是噪音；而新建
 * 会话时用户看不到任何提示，市场名正好补上「我现在在哪个市场开工」这一格。
 *
 * @param {object} props - 插槽标准件 + owner props。
 * @param {string} props.sessionId - 本会话 id（标准件）。
 * @param {Function} props.useSessions - 全局会话目录选择器 hook（标准件）。
 * @param {{blank: boolean}} props.session - InputZone 的会话快照（owner）。
 * @returns {import('react').JSX.Element | null} 市场行；非空白会话或查不到市场名时不渲染。
 */
function MarketDock({ sessionId, useSessions, session }) {
  const cwd = useSessions((list) => list.byId[sessionId]?.cwd);
  const blank = session?.blank === true;

  const [summary, setSummary] = React.useState(null);

  React.useEffect(() => {
    // 非空白会话连取数都省掉：普通会话的每一次挂载都不该产生额外请求。
    if (!blank || typeof cwd !== 'string' || cwd === '') {
      setSummary(null);
      return undefined;
    }
    let alive = true;
    fetchSummary(cwd).then((value) => { if (alive) setSummary(value); });
    return () => { alive = false; };
  }, [blank, cwd]);

  if (!blank || summary === null) return null;

  // 市场名是这一行存在的唯一理由：查不到就整行不渲染，而不是留个空行。
  const market = summary.market;
  if (market === undefined || market === null) return null;
  if (typeof market.short !== 'string' || market.short === '') return null;

  return React.createElement(
    'div',
    { style: dockStyles.row, title: `${market.code} ${market.name}` },
    `市场：${market.short}`,
  );
}

/**
 * 一轮回答下方的「当时定格」分支行。
 *
 * 为什么必须是 at 而不是实时分支：一轮可能跨多次分支切换，实时值会让历史回合
 * 的标注随当前工作区改口；这个席位要的是「这一轮开始时是什么分支」。
 * 宿主半给不出 at（非仓库、reflog 里找不到该时刻）时整条不渲染——宁可没有，
 * 也不给一个编出来的分支名。
 *
 * @param {object} props - 插槽标准件 + owner props。
 * @param {string} props.sessionId - 本会话 id（标准件）。
 * @param {Function} props.useSessions - 全局会话目录选择器 hook（标准件）。
 * @param {{start?: {time: number}, end?: {time: number}}} props.turn - owner 传入的 TurnLocation。
 * @returns {import('react').JSX.Element | null} 定格分支行；无锚点或宿主给不出历史值时返回 null。
 */
function TurnBranch({ sessionId, useSessions, turn }) {
  const cwd = useSessions((list) => list.byId[sessionId]?.cwd);

  // 轮开始时刻就是这一轮的定格锚点；残缺轮（没有 start）退到结束时刻。
  const anchor = turn?.start?.time ?? turn?.end?.time;
  const cacheKey = typeof cwd === 'string' && cwd !== '' && Number.isFinite(anchor)
    ? `${cwd}\n${anchor}`
    : null;

  const [record, setRecord] = React.useState(null);

  React.useEffect(() => {
    if (cacheKey === null) {
      setRecord(null);
      return undefined;
    }
    let alive = true;
    fetchAt(cwd, anchor).then((value) => { if (alive) setRecord(value); });
    return () => { alive = false; };
  }, [cacheKey]);

  if (cacheKey === null || record === null) return null;

  const at = record.at;
  if (at === undefined || at === null) return null;

  const branch = at.branch;
  if (typeof branch !== 'string' || branch === '') return null;

  const market = at.market;
  const hasMarket = market !== undefined && market !== null
    && typeof market.short === 'string' && market.short !== '';

  const title = [at.detached === true ? `${branch} (detached HEAD)` : branch];
  if (hasMarket) title.push(`${market.code} ${market.name}`);
  // exact 为 false 表示精确提交取不到、只能按 reflog 反推，标题里必须说明，
  // 否则用户会把一个推断出来的分支名当成当时的真实状态。
  if (at.exact === false) title.push('按 reflog 推断');

  return React.createElement(
    'div',
    { style: tailStyles.row, title: title.join(' · ') },
    React.createElement('span', { style: tailStyles.icon, 'aria-hidden': 'true' }, at.detached === true ? '⑂' : '⎇'),
    React.createElement('span', { style: tailStyles.branch }, branch),
    hasMarket ? React.createElement('span', { style: tailStyles.market }, ` · ${market.short}`) : null,
  );
}

/** 所需客户端服务：插槽注册表。 */
const inject = ['slots'];

/**
 * 客户端半的挂载点。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 浏览器插件上下文。
 */
function apply(ctx) {
  // 席位必须走 inject 而不是裸 register：register 对未声明的席位会抛错，而
  // inject 的回调在席位被声明（其宿主插件加载）时才运行——本插件可以比
  // ui-workspace / ui-conversation / ui-chat 先加载。
  ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({
    name: 'sidebar.session.row.hover',
    id: 'branch-hover',
    // 排在排期任务区块（order 10）之后，分支信息作为最后一行补充。
    order: 20,
  }, BranchHover));

  // 空白会话市场行：排在 ui-conversation 的 todo（order 0）、ui-goal（10）、
  // 输入队列（20）之后，作为输入框正上方的最后一条环境信息。
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'branch-hover-market',
    order: 30,
  }, MarketDock));

  // 每轮定格分支行：ui-deliverables 与 ui-plan 都用默认 order 0、ui-schedule 用
  // 20，取 30 让分支信息排在该轮所有补充内容之后（收尾信息）。
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: 'branch-hover-turn',
    order: 30,
  }, TurnBranch));
}
