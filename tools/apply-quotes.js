#!/usr/bin/env node
/**
 * apply-quotes.js —— 行情层确定性刷新工具
 *
 * 职责（只动行情层，绝不触碰 curated 年报层）：
 *   1. 读取 data/quotes.latest.json（由每日抓取流程用 Wind/同花顺数据更新）；
 *   2. 键校验：在交易公司齐全、私有化/被收购公司不得出现在行情表；
 *   3. 复算校验：PS 必须等于「最新市值 ÷ 最新完整财年营收」（同币种），误差超阈值即失败；
 *   4. 用校验通过的数据重建 index.html 中 __QUOTE_START__ / __QUOTE_END__ 之间的 QUOTE 区块；
 *   5. 对内联 <script> 做语法编译校验；任何一步失败都以非零码退出、且不写入文件。
 *
 * 用法：node tools/apply-quotes.js [--check]
 *   --check 仅校验、不写盘（CI 用）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const JSON_PATH = path.join(ROOT, 'data', 'quotes.latest.json');
const HTML_PATH = path.join(ROOT, 'index.html');
const PS_TOLERANCE = 0.02;
const checkOnly = process.argv.includes('--check');

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
const quotes = data.quotes || [];
const annuals = data.annuals || [];
const frozen = (data.frozen || []).map(f => f.name);

// ---- 1. 结构与基础约束 ----
if (!Array.isArray(quotes) || quotes.length === 0) fail('quotes 为空');
const annualMap = {};
annuals.forEach(a => { annualMap[a.name] = a; });
const seen = new Set();
for (const q of quotes) {
  ['name', 'ticker', 'region', 'unit', 'mktcap', 'ps', 'quoteDate'].forEach(k => {
    if (q[k] === undefined || q[k] === null) fail(q.name + ' 缺少字段 ' + k);
  });
  if (seen.has(q.name)) fail('公司重复：' + q.name);
  seen.add(q.name);
  if (!(q.mktcap > 0)) fail(q.name + ' 市值必须为正数');
  if (!(q.ps > 0)) fail(q.name + ' PS 必须为正数');
  if (frozen.includes(q.name)) fail('冻结/私有化公司不得进入行情刷新：' + q.name);
  if (!annualMap[q.name]) fail('缺少最新完整财年年报，无法复算 PS：' + q.name);
}
frozen.forEach(name => { if (seen.has(name)) fail('冻结公司误入行情表：' + name); });

// ---- 2. PS 复算（同币种，无量纲）----
function revenueForPs(q) {
  const a = annualMap[q.name];
  if (q.name === 'Trend Micro') {
    // 行情表市值以美元列示，但年报为日元原币；PS 用日元同币种复算
    if (!(q.mktcapJpyOku > 0) || !(a.revJpyOku > 0)) fail('Trend Micro 缺日元市值/营收，无法同币种复算 PS');
    return { ps: q.mktcapJpyOku / a.revJpyOku };
  }
  if (!(a.rev > 0)) fail(q.name + ' 年报营收非正，无法复算 PS');
  return { ps: q.mktcap / a.rev };
}
for (const q of quotes) {
  const calc = revenueForPs(q).ps;
  const diff = Math.abs(calc - q.ps);
  if (diff > PS_TOLERANCE) {
    fail(q.name + ' PS 校验失败：文件值 ' + q.ps + '，按市值/财年营收复算 ' + calc.toFixed(4) + '，误差 ' + diff.toFixed(4));
  }
}

// ---- 3. 生成 QUOTE 区块 ----
function group(names) {
  return names.map(n => {
    const q = quotes.find(x => x.name === n);
    if (!q) fail('行情缺失公司：' + n);
    return "'" + n + "':[" + q.mktcap.toFixed(2) + "," + q.ps.toFixed(2) + "]";
  }).join(', ');
}
const cnNames = quotes.filter(q => q.region === 'cn').map(q => q.name);
const usNames = quotes.filter(q => q.region === 'us').map(q => q.name);
const otherNames = quotes.filter(q => q.region === 'other').map(q => q.name);

const block =
"  // __QUOTE_START__（本区块由 tools/apply-quotes.js 根据 data/quotes.latest.json 自动生成，请勿手工编辑）\n" +
"  var QUOTE = {\n" +
"    asofCn: '" + data.meta.quoteAsof.cn + "', asofUs: '" + data.meta.quoteAsof.us + "', asofJp: '" + data.meta.quoteAsof.jp + "',\n" +
"    usdcny: " + data.meta.fx.usdcny + ", usdjpy: " + data.meta.fx.usdjpy + ",\n" +
"    quotes: {\n" +
"      " + group(cnNames) + ",\n" +
"      " + group(usNames) + ",\n" +
"      " + group(otherNames) + "\n" +
"    }\n" +
"  };\n" +
"  // __QUOTE_END__";

let html = fs.readFileSync(HTML_PATH, 'utf8');
const markerRe = /(  |\t)*\/\/ __QUOTE_START__[\s\S]*?\/\/ __QUOTE_END__/;
if (!markerRe.test(html)) fail('index.html 缺少 __QUOTE_START__/__QUOTE_END__ 标记');
const next = html.replace(markerRe, block);

// ---- 4. 内联脚本语法编译校验（不执行 DOM）----
const inlineMatches = [...next.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)];
if (inlineMatches.length !== 1) fail('内联脚本数量异常：' + inlineMatches.length);
try { new vm.Script(inlineMatches[0][1]); } catch (e) { fail('生成后内联脚本语法错误：' + e.message); }

if (checkOnly) {
  console.log('✓ --check 通过：' + quotes.length + ' 家在交易公司键齐全、PS 复算全部吻合、语法正确（未写盘）');
  process.exit(0);
}
fs.writeFileSync(HTML_PATH, next);
console.log('✓ 已刷新 index.html 行情层：' + quotes.length + ' 家公司，A股截至 ' + data.meta.quoteAsof.cn + '、美股 ' + data.meta.quoteAsof.us + '、日股 ' + data.meta.quoteAsof.jp + '；年报层与冻结公司未改动');
