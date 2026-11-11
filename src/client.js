/**
 * dsh-branch-hover —— 浏览器半。
 *
 * 注册三处界面，都是「会话 → 其工作区 cwd → git 概况」的同一个投影：
 *
 *  1. ui-workspace 的 `sidebar.session.row.hover`：鼠标停在工作区下的会话行上
 *     时，行卡片里多出一行 git 分支信息，并在能认出分支名前段的客户编码时再
 *     补一行市场名（映射由宿主半查快照给出）。
 *  2. ui-conversation 的 `conversation.input.dock`：空白会话里显示当前市场，
 *     并在运行时量出上一行高度把自己提到 hero 工作区行上，与分支 chip 同一行。
 *  3. ui-chat 的 `conversation.chat.assistant-actions`：每一轮回答的统计行里，
 *     用 CSS `order` 排到「用量/时间」右边，显示该轮开始时定格的 git 分支与市场。
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

/** 每轮定格分支行的内联样式：与 hover 区块同款排版，但整行更淡。 */
const tailStyles = {
  // order 让本元素在「复制 / 评价 / 用量·时间」那一行里排到最后一个：
  // 该行的条目容器是 display:contents，注册进 assistant-actions 的元素就是这一行的
  // flex 子项，所以 order 能把它排到 用量/时间 的右边。
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    // 与同一行「用量/时间」实测一致：12px / 400（行高取 20 与按钮高度对齐）。
    fontSize: '12px',
    fontWeight: 400,
    lineHeight: '20px',
    opacity: 0.55,
    minWidth: 0,
    order: 9,
    whiteSpace: 'nowrap',
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
  // 占位提示：与正常分支行同版式，但更淡——它只解释「为什么这里没有分支」。
  muted: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '12px',
    fontWeight: 400,
    lineHeight: '20px',
    opacity: 0.4,
    minWidth: 0,
    order: 9,
    whiteSpace: 'nowrap',
  },
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
  const market = summary.market;  let marketRow = null;
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
/**
 * 把市场标签直接插进 hero 行（模式胶囊之后），交给浏览器的 flex 布局去排。
 *
 * 为什么不再做像素测量：hero 行的内容会随窗口宽度、分支 chip 是否已挂上、
 * 右侧 heroOptions 是否出现而不断变化，任何"量一次再贴上去"的做法都会过期
 * （前几版正是在这里反复错位）。插进那一行后，位置、间距、换行全部由布局引擎负责，
 * 天然自适应，代码里也不再有一个魔数。
 */

/** 注入节点的 id（React 不渲染它，避免与 React 的调和互相抢节点）。 */
const INLINE_DOCK_ID = 'dsh-branch-hover-market';

/** 注入节点的内联样式：与 hero 行那组 chip 同一套字号字重。 */
const dockStyles = {
  entry: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '13px',
    fontWeight: 500,
    lineHeight: '20px',
    whiteSpace: 'nowrap',
    flex: '0 0 auto',
    color: 'inherit',
    opacity: 1,
  },
  // 占位提示：同版式，压低不透明度——它只解释「为什么这里是空的」。
  muted: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '13px',
    fontWeight: 500,
    lineHeight: '20px',
    whiteSpace: 'nowrap',
    flex: '0 0 auto',
    color: 'inherit',
    opacity: 0.45,
  },
};

/**
 * 由取数结果算出要显示的文字与提示（纯函数，便于测试与复用）。
 * @param {object | null} summary - 宿主 `/branch-hover/api` 的实时概况。
 * @returns {{text: string, title: string, muted: boolean}} 展示内容。
 */
function marketDockView(summary) {
  if (summary === null || summary === undefined) return null;
  const branch = typeof summary.branch === 'string' ? summary.branch.trim() : '';
  const detached = summary.detached === true;
  const market = summary.market;
  const hasMarket = market !== undefined && market !== null
    && typeof market.short === 'string' && market.short !== '';

  // 非 git 工作区：没有分支可言，只解释一次（不要"市场：—（非 git 工作区） · 分支：—（非 git 工作区）"）。
  if (branch === '') {
    const why = summary.isRepo === true ? '拿不到当前分支' : '非 git 工作区';
    return { branch: null, glyph: '⎇', market: `市场：—（${why}）`, title: why, muted: true };
  }

  const title = [detached ? `${branch} (detached HEAD)` : branch];
  if (hasMarket) title.push(`${market.code} ${market.name}`);
  return {
    branch,
    glyph: detached ? '⑂' : '⎇',
    // 分支名可达 40 个字符，市场名短而关键：两段分开渲染，压缩时先截分支、保住市场。
    market: hasMarket ? `市场：${market.short}` : '市场：—（分支名无客户编码）',
    title: title.join(' · '),
    muted: false,
  };
}

/** 把 view 拼成单行文本（无 DOM 环境与 title 用）。 */
function marketDockText(view) {
  if (view === null) return '';
  return view.branch === null ? view.market : `${view.glyph} ${view.branch} · ${view.market}`;
}

/**
 * 把 view 变成两个 span（分支 / 市场），分支那段可收缩并省略。
 * @param {Document} doc - 文档对象。
 * @param {{branch: string | null, glyph: string, market: string}} view - 展示内容。
 * @returns {Element[]} 待插入的子节点。
 */
function dockChildNodes(doc, view) {
  const marketSpan = doc.createElement('span');
  marketSpan.textContent = view.market;
  marketSpan.style.cssText = 'flex:0 0 auto';
  if (view.branch === null) return [marketSpan];

  const branchSpan = doc.createElement('span');
  branchSpan.textContent = `${view.glyph} ${view.branch}`;
  branchSpan.style.cssText = 'flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  const sep = doc.createElement('span');
  sep.textContent = '·';
  sep.style.cssText = 'flex:0 0 auto;opacity:.6';
  return [branchSpan, sep, marketSpan];
}

/**
 * 空白会话里的市场名：只在「刚新建、还没发第一条消息」的会话里出现。
 *
 * 为什么只认 blank：普通会话里信息已经够密，再挂一条市场名只是噪音；而新建
 * 会话时用户看不到任何提示，市场名正好补上「我现在在哪个市场开工」这一格。
 *
 * @param {object} props - 插槽标准件 + owner props。
 * @param {string} props.sessionId - 本会话 id（标准件）。
 * @param {Function} props.useSessions - 全局会话目录选择器 hook（标准件）。
 * @param {{blank: boolean}} props.session - InputZone 的会话快照（owner）。
 * @returns {import('react').JSX.Element | null} 无 DOM 环境下的纯文本回退；浏览器里返回 null（节点自行注入）。
 */
function MarketDock({ sessionId, useSessions, session }) {
  const cwd = useSessions((list) => list.byId[sessionId]?.cwd);
  const blank = session?.blank === true;
  const doc = globalThis.document;

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

  // 浏览器：把节点插进 hero 行里「模式」之后，位置交给 flex。
  React.useEffect(() => {
    if (doc === undefined || doc === null || summary === null) return undefined;
    const seat = doc.querySelector('[data-slot="conversation.hero.agentPreset"]');
    const host = seat === null ? null : seat.parentElement;
    if (host === null) return undefined;

    const view = marketDockView(summary);
    if (view === null) return undefined;
    let node = doc.getElementById(INLINE_DOCK_ID);
    if (node === null) {
      node = doc.createElement('span');
      node.id = INLINE_DOCK_ID;
    }
    node.style.cssText = '';
    Object.assign(node.style, view.muted ? dockStyles.muted : dockStyles.entry);
    node.title = view.title;
    node.setAttribute('data-bh-source', 'inline');
    // 两段分开渲染：分支名可能很长（含括号版本号），压缩时先截它，市场名保持完整。
    node.replaceChildren(...dockChildNodes(doc, view));

    // 那一行右侧的 heroOptions 带 `margin-left: auto`，会把分支 chip 顶到行尾，
    // 于是「工作区 · 模式 · 市场 · 分支」凑不到一起。把它改成 0，四个元素就自然靠左紧挨。
    const options = host.querySelector('[class*="heroOptions"]')
      ?? [...host.children].find((child) => /heroOptions/.test(String(child.className)));

    // 幂等摆放：已经紧随「模式」就不动（重复插入会触发 observer 自己）。
    const place = () => {
      if (options !== null && options !== undefined && options.style.marginLeft !== '0px') {
        options.style.marginLeft = '0px';
      }
      if (node.previousSibling !== seat) seat.after(node);
    };
    place();
    // React 重渲染那一行时可能把我们挤掉、或覆盖掉 heroOptions 的内联样式：补回去。
    const observer = typeof globalThis.MutationObserver === 'function'
      ? new globalThis.MutationObserver(place)
      : null;
    if (observer !== null) {
      observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    }
    return () => {
      if (observer !== null) observer.disconnect();
      node.remove();
      if (options !== null && options !== undefined) options.style.marginLeft = '';
    };
  }, [doc, summary]);

  if (doc !== undefined && doc !== null) return null;

  // 无 DOM（测试/SSR）：退回纯文本渲染，让取数逻辑仍可被断言。
  if (!blank || summary === null) return null;
  const view = marketDockView(summary);
  if (view === null) return null;
  return React.createElement(
    'div',
    { style: view.muted ? dockStyles.muted : dockStyles.entry, title: view.title },
    marketDockText(view),
  );
}

/**
 * 在一份聊天快照里按消息 id 找到该轮的锚点时刻（优先 turn/start，退到消息自身时间）。
 *
 * 为什么需要这层：这个席位（`conversation.chat.assistant-actions`）只下发 messageId，
 * 不下发时间；而聊天气泡快照里每个 assistant 节点都带 `turn` 与 `time`，时间线里
 * `turns.get(turn).start.time` 就是该轮开始时刻——和原来从 TurnLocation 拿的是同一个值，
 * 只是换了个取法，不动任何既有元素的数据来源。
 *
 * @param {object | null} snapshot - ChatSnapshot。
 * @param {string} messageId - 本条 assistant 消息 id。
 * @returns {number | undefined} Unix epoch 毫秒；找不到时 undefined。
 */
function anchorForMessage(snapshot, messageId) {
  if (snapshot === null || snapshot === undefined || typeof messageId !== 'string') return undefined;
  const order = Array.isArray(snapshot.order) ? snapshot.order : [];
  for (const key of order) {
    const node = typeof snapshot.nodes?.get === 'function' ? snapshot.nodes.get(key) : undefined;
    const data = node === undefined || node === null ? undefined : node.data;
    if (data === undefined || data === null || data.turn === undefined) continue;
    const id = data.finalNode?.messageId ?? data.messageId;
    if (id !== messageId) continue;
    const start = snapshot.timeline?.turns?.get?.(data.turn)?.start?.time;
    return Number.isFinite(start) ? start : data.time;
  }
  return undefined;
}

/**
 * 订阅当前会话的聊天快照。
 *
 * 返回值区分「还没就绪」与「查过了没有」：component 首帧不该因为快照尚未到达就去
 * 打实时接口（那会让每一轮多一次无用请求，也会让「定格优先」失效一瞬）。
 *
 * @param {Function | undefined} getChat - 由 apply 注入的取服务函数（可能尚未就绪）。
 * @param {string} sessionId - 当前会话 id。
 * @returns {{status: 'pending' | 'none' | 'ready', snapshot: object | null}} 订阅状态。
 */
function useChatSnapshot(getChat, sessionId) {
  const [state, setState] = React.useState({ status: 'pending', snapshot: null });

  React.useEffect(() => {
    if (typeof getChat !== 'function' || typeof sessionId !== 'string' || sessionId === '') {
      setState({ status: 'none', snapshot: null });
      return undefined;
    }
    let source;
    try {
      source = getChat()?.binding(sessionId)?.target('chat');
    } catch {
      // 会话不在控制器里（例如刚归档）：当作没有快照，落到实时兜底。
      source = undefined;
    }
    if (source === undefined || source === null) {
      setState({ status: 'none', snapshot: null });
      return undefined;
    }
    const publish = () => setState({ status: 'ready', snapshot: source.getSnapshot() ?? null });
    publish();
    return source.subscribe(publish);
  }, [getChat, sessionId]);

  return state;
}

/**
 * 一轮回答下发的「当时定格」分支行。
 *
 * 为什么必须是 at 而不是实时分支：一轮可能跨多次分支切换，实时值会让历史回合
 * 的标注随当前工作区改口；这个席位要的是「这一轮开始时是什么分支」。
 *
 * @param {object} props - 插槽标准件 + owner props + 本插件的注入面。
 * @param {string} props.sessionId - 本会话 id（标准件）。
 * @param {Function} props.useSessions - 全局会话目录选择器 hook（标准件）。
 * @param {string} props.messageId - 本条 assistant 消息 id（owner）。
 * @param {Function} [props.getChat] - 取 `uiConversation` 服务的函数（apply 注入）。
 * @returns {import('react').JSX.Element | null} 定格分支行。
 */
/**
 * 渲染一行「⎇ 分支 · 市场」。
 * @param {object} spec - 渲染参数。
 * @param {'chat' | 'live'} spec.source - 数据来源（写进 `data-bh-source`，便于在 DOM 里核对）。
 * @param {boolean} spec.detached - 是否游离头指针。
 * @param {string} spec.branch - 分支名。
 * @param {{short?: string, code?: string, name?: string} | undefined} spec.market - 市场。
 * @param {string} [spec.suffix] - 附在后面的说明，例如「（当前）」。
 * @param {string[]} spec.title - 提示里的段落。
 * @returns {object} 元素。
 */
function tailLine({ source, detached, branch, market, suffix = '', title }) {
  const hasMarket = market !== undefined && market !== null
    && typeof market.short === 'string' && market.short !== '';
  const tail = hasMarket ? ` · ${market.short}${suffix}` : suffix;
  return React.createElement(
    'div',
    { style: tailStyles.row, title: title.filter(Boolean).join(' · '), 'data-bh-source': source },
    React.createElement('span', { style: tailStyles.icon, 'aria-hidden': 'true' }, detached ? '⑂' : '⎇'),
    React.createElement('span', { style: tailStyles.branch }, branch),
    tail === '' ? null : React.createElement('span', { style: tailStyles.market }, tail),
  );
}

/**
 * 渲染一行占位说明（不留白）。
 * @param {'chat' | 'live'} source - 数据来源。
 * @param {string} text - 正文。
 * @param {string} why - title 提示里写清原因。
 * @returns {object} 元素。
 */
function tailPlaceholder(source, text, why) {
  return React.createElement(
    'div',
    { style: tailStyles.muted, title: why, 'data-bh-source': source },
    React.createElement('span', { style: tailStyles.icon, 'aria-hidden': 'true' }, '⎇'),
    React.createElement('span', { style: tailStyles.branch }, text),
  );
}

function TurnBranch({ sessionId, useSessions, messageId, getChat }) {
  const cwd = useSessions((list) => list.byId[sessionId]?.cwd);
  const chat = useChatSnapshot(getChat, sessionId);

  // 轮开始时刻就是这一轮的定格锚点。
  const anchor = anchorForMessage(chat.snapshot, messageId);
  const frozen = Number.isFinite(anchor);
  const cacheKey = typeof cwd === 'string' && cwd !== '' && frozen ? `${cwd}\n${anchor}` : null;

  const [record, setRecord] = React.useState(null);
  const [live, setLive] = React.useState(null);

  React.useEffect(() => {
    if (cacheKey === null) {
      setRecord(null);
      return undefined;
    }
    let alive = true;
    fetchAt(cwd, anchor).then((value) => { if (alive) setRecord(value); });
    return () => { alive = false; };
  }, [cacheKey]);

  // 拿不到锚点（快照已就绪但没这条消息 / 服务不可用）时不留白：用**实时**概况顶上，
  // 并在正文与 title 里标明是「当前」而不是该轮定格。等快照/订阅到位会自动切回定格。
  // pending 阶段什么都发：否则首帧会先打一次实时接口，定格值到了一闪才换上。
  const liveKey = !frozen && chat.status !== 'pending' && typeof cwd === 'string' && cwd !== '' ? cwd : null;
  React.useEffect(() => {
    if (liveKey === null) {
      setLive(null);
      return undefined;
    }
    let alive = true;
    fetchSummary(cwd).then((value) => { if (alive) setLive(value); });
    return () => { alive = false; };
  }, [liveKey]);

  const reason = chat.status === 'none' ? '会话快照不可用' : '快照里查不到这条消息';

  // 定格优先：有 at 就按当时的回放渲染。
  if (record !== null) {
    const at = record.at;
    if (at !== undefined && at !== null && typeof at.branch === 'string' && at.branch !== '') {
      return tailLine({
        source: 'chat',
        detached: at.detached === true,
        branch: at.branch,
        market: at.market,
        title: [
          at.detached === true ? `${at.branch} (detached HEAD)` : at.branch,
          ...(at.market !== undefined && at.market !== null ? [`${at.market.code} ${at.market.name}`] : []),
          // exact 为 false 表示只能按 reflog 反推，标题里必须说明。
          ...(at.exact === false ? ['按 reflog 推断'] : []),
        ],
      });
    }
    // 锚点拿到了但回放不出分支：说明原因（非仓库 / 该时刻查不到）。
    const why = record.isRepo === true ? '该时刻查不到分支' : '非 git 工作区';
    return tailPlaceholder('chat', `—（${why}）`, why);
  }

  // 兜底：实时值 + 明确标注「当前」，title 里写清为什么没有定格值。
  if (live !== null) {
    if (live.isRepo !== true) return tailPlaceholder('live', '—（非 git 工作区）', `实时值；${reason}`);
    if (typeof live.branch === 'string' && live.branch !== '') {
      return tailLine({
        source: 'live',
        detached: live.detached === true,
        branch: live.branch,
        market: live.market,
        suffix: '（当前）',
        title: [`${live.branch}（当前分支，非该轮定格）`, reason],
      });
    }
    return tailPlaceholder('live', '—（当前分支认不出）', `实时值；${reason}`);
  }

  return null;
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

  // 每轮的分支+市场：注册到「回复动作行」那一席位，并靠 CSS order 排到
  // 「用量 / 时间」的右边。该席位的条目容器是 display:contents，所以本元素会成为
  // 那一行的直接 flex 子项——这才有「加一个元素」而不是「另起一行」。
  // getChat 用函数延迟取服务：apply 时 uiConversation 可能还没就绪，渲染时再读。
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'branch-hover-turn',
    order: 30,
    inject: () => ({ getChat: () => ctx.uiConversation }),
  }, TurnBranch));
}
