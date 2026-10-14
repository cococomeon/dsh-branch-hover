/**
 * 分支名 → 市场（客户）名。
 *
 * 分支名的前段是客户编码：`KH000115-无纸化信创(2.3_20160627)` → `KH000115`。
 * 编码对不出银行名，所以查一份**构建期烘焙**的快照 `customers.json`
 * （由 tools/generate-customers.mjs 从 afa 文档库的《客户信息.xlsx》生成）。
 * 运行时只读快照，不碰 xlsx。
 *
 * 编码不一定在开头：`江苏KH000296-支付平台(侯江_2.5_20161216)`、
 * `AFA4J_1.7_20150401(KH000210)` 都真实存在，所以按「全名里第一处编码」匹配，
 * 而不是只认前缀。认不出的分支（master / others / 范菲菲(…)）返回 undefined，
 * 卡片据此少渲染一行，不做任何猜测。
 *
 * @module dsh-branch-hover/market
 */
import { readFileSync } from 'node:fs';

/** 文档库里的两种编码形态：`KH` + 6 位数字，或内部编码 `3000-` + 8 位数字。 */
const CODE_PATTERN = /(KH\d{6}|3000-\d{8})/i;

/** 快照的加载结果：编码 → [全称, 简称]。加载失败时为空表。 */
let table;
let warned = false;

/**
 * 懒加载快照（只读一次，进程内复用）。
 * 快照缺失或损坏时降级为空表：少一行市场名，好过整个插件起不来。
 * @returns {Record<string, [string, string]>} 编码 → [全称, 简称]。
 */
function loadTable() {
  if (table !== undefined) return table;
  try {
    const raw = readFileSync(new URL('./customers.json', import.meta.url), 'utf8');
    table = JSON.parse(raw).customers ?? {};
  } catch (error) {
    table = {};
    if (!warned) {
      warned = true;
      console.warn(`[dsh-branch-hover] 读不到客户快照，市场名将不显示：${error.message}`);
    }
  }
  return table;
}

/**
 * 查一个分支名对应的市场。
 * @param {string} branch - 分支名（detached HEAD 时是短 SHA，自然查不到）。
 * @returns {{code: string, name: string, short: string} | undefined} 市场信息；查不到时为 undefined。
 */
export function marketFor(branch) {
  if (typeof branch !== 'string' || branch === '') return undefined;

  const hit = CODE_PATTERN.exec(branch);
  if (hit === null) return undefined;

  const code = hit[1].toUpperCase();
  const entry = loadTable()[code];
  if (entry === undefined) return undefined;

  const [name, short] = entry;
  if (name === '' && short === '') return undefined;
  // 简称缺失时退回全称：宁可显示长一点，也不留空白。
  return { code, name, short: short === '' ? name : short };
}
