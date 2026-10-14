/**
 * 市场名解析的真跑测试：拿**真实分支名**驱动 lib/market.js，核对编码提取与快照查询。
 *
 * 为什么值得测：这个解析有三处容易写错又不易在界面上察觉——编码不一定在开头
 * （`江苏KH000296-…`、`AFA4J_1.7_20150401(KH000210)`）、有第二种编码形态
 * （`3000-00000015`）、以及「认不出」必须安静地返回 undefined 而不是抛错或猜。
 *
 * 运行：node build.mjs && node test/market.mjs
 *
 * @module dsh-branch-hover/test/market
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { marketFor } = await import(pathToFileURL(resolve(here, '../lib/market.js')).href);
const snapshot = JSON.parse(readFileSync(resolve(here, '../src/customers.json'), 'utf8'));

/** 断言助手。 */
const failures = [];
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures.push(`${name}\n    期望: ${JSON.stringify(expected)}\n    实际: ${JSON.stringify(actual)}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}`);
}

/** 只取比对的字段，避免把整条记录打进失败信息。 */
const shape = (m) => (m === undefined ? undefined : `${m.code}/${m.short}`);
const codeOf = (m) => m?.code;

console.log('marketFor 解析核对：\n');

// 端到端锚点：真实分支名 → 已知银行简称。这条会跟着 xlsx 内容走，只留一条。
check('KH000115 → 编码+简称', shape(marketFor('KH000115-无纸化信创(2.3_20160627)')), 'KH000115/宁夏银行');

// 其余只核对「编码取得对不对」——解析逻辑是要测的东西，具体行名随文档更新会变。
check('编码不在开头 → 仍可解析', codeOf(marketFor('江苏KH000296-支付平台(侯江_2.5_20161216)')), 'KH000296');
check('编码在括号里 → 仍可解析', codeOf(marketFor('AFA4J_1.7_20150401(KH000210)')), 'KH000210');
check('内部编码形态 3000-XXXXXXXX', codeOf(marketFor('3000-00000015-统一支付平台(5.3.4_20191127)')), '3000-00000015');
check('小写编码 → 归一为大写', codeOf(marketFor('kh000115-x')), 'KH000115');
check('命中时简称非空', (marketFor('KH000456-odd平台升级')?.short ?? '') !== '', true);
check('命中时全称非空', (marketFor('KH000456-odd平台升级')?.name ?? '') !== '', true);

check('无编码分支 master → undefined', marketFor('master'), undefined);
check('无编码分支 others(2.7) → undefined', marketFor('others(2.7)'), undefined);
check('人名分支 → undefined', marketFor('范菲菲(2.6_20170324)-定时任务公共补丁版'), undefined);
check('detached 短 SHA → undefined', marketFor('c106520'), undefined);
check('形态对但表里没有 → undefined', marketFor('KH999999-不存在'), undefined);
check('空串 → undefined', marketFor(''), undefined);
check('非字符串 → undefined', marketFor(undefined), undefined);

// 快照本身的形态：键只有两种编码形态，且名称非空——生成器写歪了在这里就能看出来。
const codes = Object.keys(snapshot.customers);
check('快照规模 > 800 条', codes.length > 800, true);
check('键全部是两种编码形态', codes.every((c) => /^(KH\d{6}|3000-\d{8})$/.test(c)), true);
check('每条都有非空全称', codes.every((c) => snapshot.customers[c][0] !== ''), true);

const resolved = marketFor('KH000115-无纸化信创(2.3_20160627)');
check('全称随简称一起返回', resolved.name, snapshot.customers.KH000115[0]);

// 简称缺失的兜底：快照里真有这种记录（简称列为空），直接拿它测，不写死编码。
const noShort = Object.entries(snapshot.customers).find(([, pair]) => pair[1] === '');
if (noShort === undefined) {
  console.log('  skip  简称缺失 → 退回全称（当前快照没有这种记录）');
} else {
  check('简称缺失 → 退回全称', marketFor(`${noShort[0]}-x`)?.short, noShort[1][0]);
}

console.log(`\n${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}`);
for (const f of failures) console.log(`\n  ✗ ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
