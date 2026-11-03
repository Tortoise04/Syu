// 召回对照：拿带人工分级的样本 md，用当前提示词跑一遍本地粗筛，算「该抓的抓没抓到」。
// 用途：换提示词后确认召回没掉（A+B 只证明了误报从 84.8% 降到 5.2%，没证明召回）。
// 用法（在服务器上跑，那台机器才有 Ollama）：
//   node scripts/recall-check.mjs --md 群聊违规案例样本-20261028.md --out "D:/Syu/samples/recall-20261102.jsonl"
// 只读 md、只写 out，不动 data/state.json、不调云端、不碰群。
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Screener } from '../src/guard/screen.ts';
import { loadConfig } from '../src/config.ts';

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  return fallback;
}

const mdPath = argOf('md', '群聊违规案例样本-20261028.md');
const outPath = argOf('out', './recall-check.jsonl');
const timeoutMs = Number(argOf('timeout', '0'));

/** 解析 md 里的逐条表：| # | 时间 | 昵称 | 原文 | 分级 | 条款 | 备注 | */
function parseSamples(md) {
  // 只取「## 3. 逐条清单」这一节，避免把文末其它数字开头的表格也算进来
  const start = md.indexOf('## 3. 逐条清单');
  const body = start >= 0 ? md.slice(start) : md;
  const end = body.indexOf('\n## ', 10);
  const section = end > 0 ? body.slice(0, end) : body;
  const rows = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 6) continue;
    if (!/^\d+$/.test(cells[0])) continue; // 跳过表头与分隔行
    const level = Number(cells[4].replaceAll('*', '').trim());
    if (!Number.isInteger(level) || level < 0 || level > 3) continue;
    // 原文列：去掉 markdown 粗体/引用标记，保留正文
    const text = cells[3]
      .replaceAll('**', '')
      .replace(/^（引用）/, '[引用] ')
      .trim();
    rows.push({
      index: Number(cells[0]),
      time: cells[1],
      nick: cells[2].replaceAll('`', ''),
      text,
      level,
      rule: cells[5],
      note: cells[6] ?? '',
    });
  }
  return rows;
}

const config = loadConfig();
const screener = new Screener({
  baseUrl: config.screen.baseUrl,
  model: config.screen.model,
  enabled: config.screen.enabled,
  timeoutMs: timeoutMs > 0 ? timeoutMs : config.screen.timeoutMs,
});

const rows = parseSamples(await fsp.readFile(mdPath, 'utf8'));
if (rows.length === 0) {
  console.error('没从 md 里解析出样本，检查表格格式');
  process.exit(1);
}

const out = [];
const started = Date.now();
for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  // 上下文取同一段里的前 10 条（与线上 RingBuffer 口径一致：昵称＋正文）
  const context = rows.slice(Math.max(0, i - 10), i).map((r) => `${r.nick}：${r.text}`);
  const t0 = Date.now();
  const result = await screener.screen(row.text, context);
  const elapsed = Date.now() - t0;
  out.push({
    index: row.index,
    level: row.level,
    verdict: result.verdict,
    rule: result.rule ?? null,
    score: result.score ?? null,
    evidence: result.evidence ?? null,
    reason: result.reason ?? null,
    degraded: result.degraded === true,
    elapsedMs: elapsed,
    text: row.text,
  });
  process.stdout.write(`\r${i + 1}/${rows.length}  ${row.index}级${row.level} ${result.verdict}   `);
}
console.log(`\n用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
await fsp.mkdir(path.dirname(path.resolve(outPath)), { recursive: true }).catch(() => {});
await fsp.writeFile(outPath, out.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

// 汇总：按人工档位看粗筛有没有放行（suspicious = 会进判定链，clean = 被放过）
const levels = [0, 1, 2, 3];
const stat = {};
for (const lv of levels) {
  const list = out.filter((r) => r.level === lv);
  stat[lv] = {
    n: list.length,
    suspicious: list.filter((r) => r.verdict === 'suspicious').length,
    clean: list.filter((r) => r.verdict === 'clean').length,
    unknown: list.filter((r) => r.verdict === 'unknown').length,
  };
}
console.log('\n| 人工档位 | 条数 | 进判定链(suspicious) | 被放行(clean) | unknown |');
console.log('| --- | --- | --- | --- | --- |');
for (const lv of levels) {
  const s = stat[lv];
  console.log(`| ${lv} 级 | ${s.n} | ${s.suspicious} | ${s.clean} | ${s.unknown} |`);
}
for (const [label, minLv] of [
  ['≥1 级召回', 1],
  ['≥2 级召回', 2],
  ['3 级召回', 3],
]) {
  const pool = out.filter((r) => r.level >= minLv);
  const hit = pool.filter((r) => r.verdict === 'suspicious').length;
  console.log(`${label}：${hit}/${pool.length} = ${pool.length ? ((hit / pool.length) * 100).toFixed(1) : '—'}%`);
}
const misses = out.filter((r) => r.level >= 2 && r.verdict !== 'suspicious');
console.log(`\n漏掉的 ≥2 级样本（${misses.length} 条）：`);
for (const m of misses) console.log(`  #${m.index} ${m.level}级 [${m.text.slice(0, 40)}] -> ${m.verdict}`);
console.log(`\n结果写进 ${outPath}`);
