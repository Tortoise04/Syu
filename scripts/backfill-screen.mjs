// 粗筛补录：把「当时标了 suspicious / 被预算拦下」但没送云的消息，重跑一遍本地粗筛，
// 补出 8B 当时猜的条款与可疑度（violations.jsonl 里没存，见方案 §16.6/16.7）。
// 用法（在服务器上跑，那台机器才有 Ollama）：
//   node scripts/backfill-screen.mjs --from 2026-11-01T21:00 --out data/screen-backfill-20261102.jsonl
// 可中断：已写进 out 的 messageId 会跳过，重跑接着补。
// 只读 violations.jsonl，只写 out，不动 data/state.json、不调云端、不碰群。
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Screener } from '../src/guard/screen.ts';
import { loadConfig } from '../src/config.ts';
import { log } from '../src/log.ts';

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  return fallback;
}

const from = argOf('from', '2026-11-01T21:00');
const dataDir = argOf('data', './data');
const outPath = argOf('out', path.join(dataDir, 'screen-backfill.jsonl'));
const limit = Number(argOf('limit', '0'));
const timeoutMs = Number(argOf('timeout', '0'));

const config = loadConfig();
const screener = new Screener({
  baseUrl: config.screen.baseUrl,
  model: config.screen.model,
  enabled: config.screen.enabled,
  timeoutMs: timeoutMs > 0 ? timeoutMs : config.screen.timeoutMs,
});

function textOf(r) {
  return typeof r.text === 'string' ? r.text : '';
}

function isPureImage(r) {
  return textOf(r).replaceAll('[image]', '').replace(/\[at:[^\]]*\]/g, '').trim().length === 0;
}

function wanted(r) {
  const reason = typeof r.reason === 'string' ? r.reason : '';
  if (typeof r.ts !== 'string' || r.ts < from) return false;
  if (r.channel !== 'screen') return false;
  if (!(reason.startsWith('粗筛 suspicious') || reason.startsWith('预算耗尽'))) return false;
  return !isPureImage(r);
}

async function readDone() {
  const done = new Set();
  try {
    const text = await fsp.readFile(outPath, 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const rec = JSON.parse(line);
        if (typeof rec.messageId === 'number') done.add(rec.messageId);
      } catch {
        // 半行（上次被 kill）忽略，重跑会再写一遍
      }
    }
  } catch {
    // 没有 out 文件就是从头开始
  }
  return done;
}

const raw = await fsp.readFile(path.join(dataDir, 'violations.jsonl'), 'utf8');
const all = raw
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l));
const targets = all.filter(wanted);
const done = await readDone();
const todo = targets.filter((r) => !done.has(r.messageId));
const list = limit > 0 ? todo.slice(0, limit) : todo;

log.info(
  `粗筛补录：候选 ${targets.length} 条，已完成 ${done.size} 条，本次补 ${list.length} 条（from=${from} model=${config.screen.model} timeout=${timeoutMs > 0 ? timeoutMs : config.screen.timeoutMs}ms）`,
);

let okCount = 0;
let badCount = 0;
const start = Date.now();
const handle = await fsp.open(outPath, 'a');
try {
  for (let i = 0; i < list.length; i += 1) {
    const r = list[i];
    const t0 = Date.now();
    let result;
    try {
      // 上下文已丢失：只能按单条重筛，理由是「这条单独看为什么可疑」，写进 note 里
      result = await screener.screen(textOf(r), []);
    } catch (err) {
      result = { verdict: 'unknown', degraded: true, detail: `重筛异常：${String(err)}` };
    }
    const ms = Date.now() - t0;
    // 不写原文/昵称/QQ：这份补录要落在同步目录里，只回填「哪条、猜了什么」，原文留在 violations.jsonl
    const rec = {
      messageId: r.messageId,
      ts: r.ts,
      verdict: result.verdict,
      rule: result.rule ?? null,
      score: result.score ?? null,
      evidence: result.evidence ?? null,
      reason: result.reason ?? null,
      degraded: result.degraded === true,
      detail: result.detail ?? null,
      why: typeof r.reason === 'string' && r.reason.startsWith('预算耗尽') ? '预算拦下' : '抽样未中',
      elapsedMs: ms,
      note: '无上下文重筛',
      at: new Date().toISOString(),
    };
    await handle.write(`${JSON.stringify(rec)}\n`);
    if (result.degraded === true) badCount += 1;
    else okCount += 1;
    if ((i + 1) % 25 === 0 || i + 1 === list.length) {
      const per = (Date.now() - start) / 1000 / (i + 1);
      const left = Math.round((per * (list.length - i - 1)) / 60);
      log.info(
        `粗筛补录 ${i + 1}/${list.length}（${per.toFixed(1)}s/条，预计还要 ${left} 分钟；ok=${okCount} unknown=${badCount}）`,
      );
    }
  }
} finally {
  await handle.close();
}

log.info(`粗筛补录结束：ok=${okCount} unknown=${badCount}，输出 ${outPath}`);
