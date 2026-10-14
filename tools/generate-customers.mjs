/**
 * 从 afa 文档库的《客户信息.xlsx》烘焙「客户编码 → 客户名称」快照。
 *
 * 分支名的前段是客户编码（`KH000115-无纸化信创(2.3_20160627)` 的 `KH000115`），
 * 编码本身看不出是哪家银行，所以把 xlsx 里的编码→名称映射落成
 * `src/customers.json`，由 build.mjs 搬进 lib/。运行时**不读 xlsx**：
 * 解析 xlsx 需要解 zip + 解析共享字符串表，属于构建期工作，不该挂在 hover 热路径上。
 *
 * 用法：
 *   node tools/generate-customers.mjs [xlsx路径]
 *   或 AFA_CUSTOMER_XLSX=/path/to/客户信息.xlsx node tools/generate-customers.mjs
 *
 * 列不按字母位置取，而是**按表头文字定位**（客户编码 / 客户名称 / 客户简称）——
 * 表头顺序变了不该让快照悄悄错位。
 *
 * @module dsh-branch-hover/tools/generate-customers
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../src/customers.json');

/** 默认取 afa 文档库（master 空间）里的那份；路径写死是刻意的——它就是文档库的固定位置。 */
const DEFAULT_XLSX = '/Users/lee/workspace/agree/afa4j/master/afa4j/afa-parent/doc/客户信息.xlsx';

const xlsxPath = process.argv[2] ?? process.env.AFA_CUSTOMER_XLSX ?? DEFAULT_XLSX;

/** 三个必需列的表头文字。 */
const COLUMNS = {
  code: '客户编码',
  name: '客户名称',
  short: '客户简称',
};

/** 解 XML 实体。xlsx 里的名称会带 `&amp;` 之类，不解会原样进快照。 */
function unescapeXml(text) {
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (whole, dec, hex, named) => {
    if (dec !== undefined) return String.fromCodePoint(Number(dec));
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named];
  });
}

/**
 * 读 zip 的中央目录，得到「条目名 → 条目元数据」。
 * @param {Buffer} buf - 整个 xlsx 文件。
 * @returns {Map<string, {method: number, compSize: number, localOffset: number}>}
 */
function readCentralDirectory(buf) {
  // EOCD 在文件尾部，注释最长 64KB，从后往前找签名。
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('xlsx: 找不到 zip 中央目录（不是 xlsx/zip 文件？）');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('xlsx: 中央目录项签名异常');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 取出一个 zip 条目的文本内容。
 *
 * 数据起点必须用**本地头**的 nameLen/extraLen 计算：中央目录里的 extra 字段
 * 常与本地头不一致（zip 允许），用中央目录的长度会读偏。
 * @param {Buffer} buf - 整个 xlsx 文件。
 * @param {{method: number, compSize: number, localOffset: number}} entry - 中央目录项。
 * @returns {string} 条目文本（UTF-8）。
 */
function readEntry(buf, entry) {
  const p = entry.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('xlsx: 本地文件头签名异常');
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw.toString('utf8');
  if (entry.method === 8) return inflateRawSync(raw).toString('utf8');
  throw new Error(`xlsx: 不支持的压缩方式 ${entry.method}`);
}

/**
 * 解析共享字符串表：一个 `<si>` 可能由多个 `<t>` 片段组成（富文本分片），要拼接。
 * @param {string} xml - xl/sharedStrings.xml 内容。
 * @returns {string[]} 下标即单元格 `t="s"` 里引用的序号。
 */
function parseSharedStrings(xml) {
  const out = [];
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const t of si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(t[1]);
    out.push(text);
  }
  return out;
}

/** 把列字母（A、Y、AA…）换算成 0 起的序号。 */
function columnIndex(letter) {
  let n = 0;
  for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * 解析工作表为「行 → 列字母 → 文本」。
 *
 * 单元格有两种形态：`<c .../>`（自闭合，空值）与 `<c ...>…</c>`。必须分别匹配——
 * 用一个要求 `</c>` 的正则去吃自闭合格，会把后面那个格的值一起吞掉。
 * @param {string} xml - xl/worksheets/sheetN.xml 内容。
 * @param {string[]} shared - 共享字符串表。
 * @returns {Array<Record<string, string>>} 每行的列字母→文本。
 */
function parseSheet(xml, shared) {
  const rows = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1];
      const inner = cell[2];
      if (inner === undefined) continue; // 自闭合：空值，不记账。

      const ref = /\br="([A-Z]+)\d+"/.exec(attrs);
      if (ref === null) continue;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';

      let value = '';
      if (type === 'inlineStr') {
        for (const t of inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) value += unescapeXml(t[1]);
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        if (v !== null) value = type === 's' ? (shared[Number(v[1])] ?? '') : unescapeXml(v[1]);
      }
      cells[ref[1]] = value.trim();
    }
    rows.push(cells);
  }
  return rows;
}

/** 找出表头所在列字母。 */
function locateColumns(header) {
  const letters = Object.keys(header);
  const found = {};
  for (const [key, title] of Object.entries(COLUMNS)) {
    const letter = letters.find((l) => header[l] === title);
    if (letter === undefined) throw new Error(`xlsx: 表头里找不到「${title}」列，表头=${JSON.stringify(header)}`);
    found[key] = letter;
  }
  return found;
}

const buf = readFileSync(xlsxPath);
const entries = readCentralDirectory(buf);

const take = (name) => {
  const entry = entries.get(name);
  if (entry === undefined) throw new Error(`xlsx: 缺少 ${name}`);
  return readEntry(buf, entry);
};

const shared = parseSharedStrings(take('xl/sharedStrings.xml'));

// 只读第一张表：workbook.xml 的第一个 <sheet>，再经 rels 换成真实路径。
const workbook = take('xl/workbook.xml');
const relId = /<sheet\b[^>]*r:id="([^"]+)"/.exec(workbook)?.[1];
if (relId === undefined) throw new Error('xlsx: workbook.xml 里没有工作表声明');
const rels = take('xl/_rels/workbook.xml.rels');
const target = new RegExp(`<Relationship\\b[^>]*Id="${relId}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
if (target === undefined) throw new Error(`xlsx: rels 里找不到 ${relId}`);

const rows = parseSheet(take(`xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}`), shared);
if (rows.length < 2) throw new Error(`xlsx: 工作表只有 ${rows.length} 行，取不到数据`);

const cols = locateColumns(rows[0]);

const customers = {};
const conflicts = [];
for (const row of rows.slice(1)) {
  const code = (row[cols.code] ?? '').trim();
  if (code === '') continue;
  const name = (row[cols.name] ?? '').trim();
  const short = (row[cols.short] ?? '').trim();
  if (name === '' && short === '') continue;

  const previous = customers[code];
  if (previous !== undefined && previous[0] !== name) conflicts.push(`${code}: ${previous[0]} → ${name}`);
  customers[code] = [name, short];
}

// 排序输出：同一份 xlsx 重跑必须产出逐字节相同的文件，diff 才有意义。
const sorted = {};
for (const code of Object.keys(customers).sort()) sorted[code] = customers[code];

const snapshot = {
  source: xlsxPath,
  sourceMtimeMs: statSync(xlsxPath).mtimeMs,
  columns: cols,
  count: Object.keys(sorted).length,
  conflicts,
  customers: sorted,
};

writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);

const bytes = statSync(OUT).size;
process.stdout.write(
  `generate-customers: ${Object.keys(sorted).length} 条 → ${OUT}（${(bytes / 1024).toFixed(1)} KB）\n`,
);
if (conflicts.length > 0) {
  process.stdout.write(`  注意：${conflicts.length} 个编码在同表内有重名，已取最后一条：\n`);
  for (const c of conflicts.slice(0, 5)) process.stdout.write(`    ${c}\n`);
}
