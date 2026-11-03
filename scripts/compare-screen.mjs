// 粗筛前后对比：node scripts/compare-screen.mjs <旧.jsonl> <新.jsonl>
// 两组都来自 backfill-screen.mjs 的输出（同一批 messageId、同一条原文、无上下文重筛）。
// 输出：总体占比、条款分布、逐条翻转矩阵、以及「新结果里 clean 但仍被旧结果标可疑」的比例。
import { promises as fsp } from 'node:fs';

const [oldPath, newPath] = process.argv.slice(2);
if (oldPath === undefined || newPath === undefined) {
  console.error('用法：node scripts/compare-screen.mjs data/screen-backfill.jsonl data/screen-backfill-ab.jsonl');
  process.exit(2);
}

async function load(p) {
  const map = new Map();
  const text = await fsp.readFile(p, 'utf8');
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const r = JSON.parse(line);
    map.set(r.messageId, r);
  }
  return map;
}

const before = await load(oldPath);
const after = await load(newPath);
const ids = [...before.keys()].filter((id) => after.has(id));

const tally = (m) => {
  let sus = 0;
  let clean = 0;
  let unknown = 0;
  const rules = new Map();
  for (const id of ids) {
    const r = m.get(id);
    if (r.verdict === 'suspicious') sus += 1;
    else if (r.verdict === 'clean') clean += 1;
    else unknown += 1;
    if (r.verdict === 'suspicious') rules.set(r.rule ?? 'null', (rules.get(r.rule ?? 'null') ?? 0) + 1);
  }
  return { sus, clean, unknown, rules };
};

const b = tally(before);
const a = tally(after);
const pct = (n) => ((n / ids.length) * 100).toFixed(1) + '%';
const rows = [];
rows.push(`| 指标 | 改前 | 改后 |`, `| --- | --- | --- |`);
rows.push(`| 样本 | ${ids.length} | ${ids.length} |`);
rows.push(`| suspicious | ${b.sus}（${pct(b.sus)}） | ${a.sus}（${pct(a.sus)}） |`);
rows.push(`| clean | ${b.clean}（${pct(b.clean)}） | ${a.clean}（${pct(a.clean)}） |`);
rows.push(`| unknown | ${b.unknown} | ${a.unknown} |`);

const ruleLine = (m) =>
  [...m.rules.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(' / ');
rows.push(`| 条款分布（仅 suspicious） | ${ruleLine(b)} | ${ruleLine(a)} |`);

// 翻转矩阵
let s2s = 0;
let s2c = 0;
let s2u = 0;
let c2s = 0;
let c2c = 0;
let c2u = 0;
for (const id of ids) {
  const x = before.get(id).verdict;
  const y = after.get(id).verdict;
  if (x === 'suspicious') {
    if (y === 'suspicious') s2s += 1;
    else if (y === 'clean') s2c += 1;
    else s2u += 1;
  } else if (x === 'clean') {
    if (y === 'suspicious') c2s += 1;
    else if (y === 'clean') c2c += 1;
    else c2u += 1;
  }
}
rows.push('', `翻转矩阵（行=改前，列=改后）：`, '');
rows.push('| | 改后 suspicious | 改后 clean | 改后 unknown |', '| --- | --- | --- | --- |');
rows.push(`| 改前 suspicious | ${s2s} | ${s2c} | ${s2u} |`);
rows.push(`| 改前 clean | ${c2s} | ${c2c} | ${c2u} |`);

// 条款迁移（旧 R4 → 新 X，取 top）
const mig = new Map();
for (const id of ids) {
  const x = before.get(id);
  const y = after.get(id);
  if (x.verdict !== 'suspicious') continue;
  const key = `${x.rule ?? 'null'} → ${y.verdict === 'suspicious' ? (y.rule ?? 'null') : y.verdict}`;
  mig.set(key, (mig.get(key) ?? 0) + 1);
}
rows.push('', '条款迁移 top10：', '');
for (const [k, v] of [...mig.entries()].sort((p, q) => q[1] - p[1]).slice(0, 10)) rows.push(`- ${k}：${v}`);

// 证据质量：新结果 suspicious 里有 evidence 的比例
let withEv = 0;
for (const id of ids) {
  const y = after.get(id);
  if (y.verdict === 'suspicious' && typeof y.evidence === 'string' && y.evidence.trim() !== '') withEv += 1;
}
rows.push('', `新结果 suspicious 中带逐字证据的：${withEv}/${a.sus}`);

console.log(rows.join('\n'));
