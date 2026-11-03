/**
 * 本地粗筛实测：把 群聊违规案例样本-20261028.md 的 59 条原文喂给 config.json 里配的本地模型，
 * 对照人工分级统计召回/误报。只打本机 Ollama（127.0.0.1:11434），一次云调用都不发。
 *
 * 用法：node scripts/test-screen-samples.mjs [--arm=A|B|both] [--limit=N] [--timeout=ms] [--out=path]
 *   A = 单条无上下文   B = 带最近 10 条上下文（管线的真实口径）
 *
 * 判读口径：粗筛输出 suspicious 就算「捞到」，clean 算「放过」，unknown 算「没筛成」（超时/非 JSON），
 * unknown 与被捞到分开统计 —— 混在一起会把超时说成"模型判断差"。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Screener } from '../src/guard/screen.ts';
import { normalize, scan } from '../src/guard/rules.ts';

const ROOT = new URL('../', import.meta.url);
const SAMPLE_DOC = new URL('群聊违规案例样本-20261028.md', ROOT);
const CONFIG = new URL('config.json', ROOT);

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + name + '='));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const ARM = arg('arm', 'both');
const LIMIT = Number(arg('limit', '0')) || 0;
const TIMEOUT = Number(arg('timeout', '0')) || 0;
// 产物含样本原文，按 AGENTS.md §3 落 D 盘本地，不进共享目录
const OUT = arg('out', 'D:/Syu/samples/screen-samples-20261028.json');

// ---------------------------------------------------------------- 解析样本表
function stripEmphasis(s) {
  return s.trim().replace(/^\*\*|\*\*$/g, '').replace(/\`/g, '').trim();
}

function parseSamples(md) {
  const out = [];
  for (const line of md.split(/\r?\n/)) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1);
    if (cells.length < 6) continue;
    const idx = Number(stripEmphasis(cells[0]));
    const sevRaw = stripEmphasis(cells[4]);
    const sev = Number(sevRaw);
    if (!Number.isInteger(idx) || !Number.isInteger(sev)) continue;
    out.push({
      idx,
      time: stripEmphasis(cells[1]),
      nick: stripEmphasis(cells[2]),
      text: stripEmphasis(cells[3]),
      severity: sev,
      rule: stripEmphasis(cells[5]),
      note: stripEmphasis(cells[6] ?? ''),
    });
  }
  return out;
}

const samples = parseSamples(readFileSync(SAMPLE_DOC, 'utf8'));
if (samples.length !== 59) {
  console.error('解析样本表得到 ' + samples.length + ' 条，预期 59 条 —— 表格格式变了，停止');
  process.exit(2);
}

// ---------------------------------------------------------------- 现管线里会不会走到粗筛
const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
const table = cfg.guard.keywords;
const linkWhitelist = cfg.guard.linkWhitelist ?? [];

for (const s of samples) {
  const found = scan(normalize(s.text), table, { linkWhitelist });
  s.keywordHits = found.hits.map((h) => h.word);
  s.pipelinePath = found.mustJudge
    ? 'keyword'
    : found.hits.length > 0
      ? 'recordOnly'
      : 'screen';
}

// ---------------------------------------------------------------- 抓请求/响应原文（不改 screen.ts）
const origFetch = globalThis.fetch;
let tap = null;
globalThis.fetch = async (url, init) => {
  const res = await origFetch(url, init);
  if (tap !== null && String(url).includes('/api/chat')) {
    tap.requestBody = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
    try {
      tap.rawResponse = await res.clone().text();
    } catch {
      tap.rawResponse = '';
    }
  }
  return res;
};

function modelDetail(rawResponse) {
  const empty = { content: null, thinking: null, doneReason: null };
  try {
    const body = JSON.parse(rawResponse);
    return {
      content: body?.message?.content ?? null,
      thinking: body?.message?.thinking ?? null,
      doneReason: body?.done_reason ?? null,
    };
  } catch {
    return empty;
  }
}

const screenCfg = cfg.screen;
const timeoutMs = TIMEOUT > 0 ? TIMEOUT : screenCfg.timeoutMs;

function makeScreener() {
  return new Screener({
    baseUrl: screenCfg.baseUrl,
    model: screenCfg.model,
    enabled: screenCfg.enabled,
    timeoutMs,
  });
}

async function runOne(screener, sample, contextTexts) {
  tap = {};
  const t0 = performance.now();
  const result = await screener.screen(sample.text, contextTexts);
  const ms = Math.round(performance.now() - t0);
  const det = modelDetail(tap.rawResponse ?? '');
  const rec = {
    idx: sample.idx,
    text: sample.text,
    severity: sample.severity,
    humanRule: sample.rule,
    pipelinePath: sample.pipelinePath,
    keywordHits: sample.keywordHits,
    verdict: result.verdict,
    rule: result.rule ?? null,
    score: result.score ?? null,
    detail: result.detail ?? null,
    degraded: result.degraded,
    ms,
    rawContent: det.content,
    thinkingChars: det.thinking === null ? 0 : det.thinking.length,
    doneReason: det.doneReason,
  };
  tap = null;
  return rec;
}

function contextFor(samples, i) {
  const from = Math.max(0, i - 10);
  return samples.slice(from, i).map((s) => s.text);
}

// ---------------------------------------------------------------- 跑
const armDefs = [
  { id: 'A', label: '单条无上下文', ctx: () => [] },
  { id: 'B', label: '带最近 10 条上下文', ctx: (i) => contextFor(samples, i) },
].filter((a) => ARM === 'both' || ARM === a.id);

const startedAt = new Date();
const report = {
  startedAt: startedAt.toISOString(),
  model: screenCfg.model,
  baseUrl: screenCfg.baseUrl,
  timeoutMs,
  temperature: 0,
  format: 'json',
  promptSource: 'src/guard/screen.ts SYSTEM_PROMPT（未改）',
  screensPath: 'src/guard/screen.ts Screener.screen',
  sampleDoc: '群聊违规案例样本-20261028.md',
  sampleCount: samples.length,
  arms: {},
};

// 预热不计入实测：Ollama 冷启动要几十秒，否则第一条必然是超时噪声
const warm = new Screener({
  baseUrl: screenCfg.baseUrl,
  model: screenCfg.model,
  enabled: screenCfg.enabled,
  timeoutMs: Math.max(timeoutMs, 120000),
});
const w0 = performance.now();
const wres = await warm.screen('今天天气不错', []);
const warmMs = Math.round(performance.now() - w0);
console.log('预热：' + warmMs + 'ms  verdict=' + wres.verdict + (wres.detail ? '  ' + wres.detail : ''));

for (const arm of armDefs) {
  const screener = makeScreener();
  const rows = [];
  const only = LIMIT > 0 ? samples.slice(0, LIMIT) : samples;
  let done = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    if (LIMIT > 0 && s.idx > LIMIT) break;
    rows.push(await runOne(screener, s, arm.ctx(i)));
    done += 1;
    if (done % 10 === 0) process.stdout.write('  ' + arm.id + ' ' + done + '/' + only.length + '\n');
  }
  report.arms[arm.id] = { label: arm.label, rows };
  console.log('臂 ' + arm.id + '（' + arm.label + '）跑完 ' + rows.length + ' 条');
}

globalThis.fetch = origFetch;
report.finishedAt = new Date().toISOString();
report.warmupMs = warmMs;

// ---------------------------------------------------------------- 统计
/** 把耗时超过 limitMs 的行按「被超时打断」重算：等价于把该条从 suspicious/clean 改成 unknown */
function statsAt(rows, limitMs) {
  const mapped = rows.map((r) => (r.ms > limitMs ? { ...r, verdict: 'unknown', rule: null, score: null, detail: '超时推算' } : r));
  return stats(mapped);
}

function stats(rows) {
  const bucket = (pred) => rows.filter(pred);
  const susp = (r) => r.verdict === 'suspicious';
  const clean = (r) => r.verdict === 'clean';
  const unknown = (r) => r.verdict === 'unknown';
  const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (a, b) => (b === 0 ? null : Math.round((a / b) * 1000) / 10);
  const out = {
    total: rows.length,
    suspicious: bucket(susp).length,
    clean: bucket(clean).length,
    unknown: bucket(unknown).length,
    latency: {
      min: lat[0] ?? null,
      p50: lat[Math.floor(lat.length / 2)] ?? null,
      p90: lat[Math.floor(lat.length * 0.9)] ?? null,
      max: lat[lat.length - 1] ?? null,
      sumMs: lat.reduce((a, b) => a + b, 0),
    },
    bySeverity: {},
  };
  for (const sev of [0, 1, 2, 3]) {
    const g = bucket((r) => r.severity === sev);
    out.bySeverity['sev' + sev] = {
      n: g.length,
      suspicious: g.filter(susp).length,
      clean: g.filter(clean).length,
      unknown: g.filter(unknown).length,
      recallPct: sev === 0 ? null : pct(g.filter(susp).length, g.length),
      falseFlagPct: sev === 0 ? pct(g.filter(susp).length, g.length) : null,
    };
  }
  const graded = bucket((r) => r.severity >= 1);
  const level0 = bucket((r) => r.severity === 0);
  const lv23 = bucket((r) => r.severity >= 2);
  out.recall = {
    graded: pct(graded.filter(susp).length, graded.length),
    level2and3: pct(lv23.filter(susp).length, lv23.length),
    level3: pct(bucket((r) => r.severity === 3).filter(susp).length, bucket((r) => r.severity === 3).length),
  };
  out.falseFlagOnLevel0 = pct(level0.filter(susp).length, level0.length);
  out.reachScreen = rows.filter((r) => r.pipelinePath === 'screen').length;
  return out;
}

/** 现配置的超时口径：config.json screen.timeoutMs */
const productionTimeoutMs = screenCfg.timeoutMs;
for (const id of Object.keys(report.arms)) {
  report.arms[id].stats = stats(report.arms[id].rows);
  report.arms[id].statsAtProductionTimeout = statsAt(report.arms[id].rows, productionTimeoutMs);
  report.productionTimeoutMs = productionTimeoutMs;
}

writeFileSync(new URL(OUT, ROOT), JSON.stringify(report, null, 2) + '\n');

for (const id of Object.keys(report.arms)) {
  const s = report.arms[id].stats;
  console.log('');
  console.log('== 臂 ' + id + '（' + report.arms[id].label + '） ==');
  console.log('  suspicious/clean/unknown = ' + s.suspicious + '/' + s.clean + '/' + s.unknown + '   （共 ' + s.total + '）');
  console.log('  召回：≥1级 ' + s.recall.graded + '%   ≥2级 ' + s.recall.level2and3 + '%   3级 ' + s.recall.level3 + '%');
  console.log('  0级误报率 = ' + s.falseFlagOnLevel0 + '%');
  console.log('  延迟 ms  min/p50/p90/max = ' + s.latency.min + '/' + s.latency.p50 + '/' + s.latency.p90 + '/' + s.latency.max + '  总 ' + (s.latency.sumMs / 1000).toFixed(1) + 's');
  for (const sev of ['sev0', 'sev1', 'sev2', 'sev3']) {
    const b = s.bySeverity[sev];
    console.log('  ' + sev + ' n=' + b.n + ' suspicious=' + b.suspicious + ' clean=' + b.clean + ' unknown=' + b.unknown);
  }
  console.log('  现管线会走到粗筛的条数 = ' + s.reachScreen);

  const p = report.arms[id].statsAtProductionTimeout;
  console.log('  —— 按现配置 ' + productionTimeoutMs + 'ms 超时推算 ——');
  console.log('  suspicious/clean/unknown = ' + p.suspicious + '/' + p.clean + '/' + p.unknown);
  console.log('  召回：≥1级 ' + p.recall.graded + '%   ≥2级 ' + p.recall.level2and3 + '%   3级 ' + p.recall.level3 + '%');
  console.log('  0级误报率 = ' + p.falseFlagOnLevel0 + '%');
}
console.log('');
console.log('结果已写：' + OUT);
