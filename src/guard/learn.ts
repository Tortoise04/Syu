import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { log } from '../log.ts';

/**
 * 举报受理后的「拆词」补充（2026-11-02 用户拍板）：
 * 云端终审除了给档位，还回一段 `span` —— 导致判定的最短原话（例如「我弄死你」）。
 * 举报通道判到 1 档以上就把这句话收进 `data/learned-keywords.json`，
 * 只进 `hints`（低精度：只强制过本地粗筛，不直通云、不预设条款），然后热加载立刻生效。
 *
 * 为什么不写 config.json：config.json 是手写配置，程序回写会打散用户的排版；
 * 而 data/ 下的 learned-keywords.json 是「程序学来的」，分开存放，删掉文件就等于忘掉。
 */

export const LEARN_FILE = 'learned-keywords.json';
export const LEARN_AUDIT = 'learned-keywords.jsonl';
/** 一段「原话片段」最长留几个字：再长就不是词而是句子了 */
export const SPAN_MAX = 15;
/** 一天最多学几个词：防止被人刷举报刷爆词表 */
export const LEARN_DAILY_CAP = 20;

/** 能学词的条款：REDLINE/OTHER 不是群规条款号，不进词表 */
export const LEARN_RULES = ['R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11'] as const;
export type LearnedRule = (typeof LEARN_RULES)[number];

export type LearnedWords = Record<string, string[]>;

/** 词表档位：gated = 先本地确认（默认）；direct = 直通云（只有秒杀级硬词才该进） */
export type LearnedTier = 'gated' | 'direct';

export interface LearnedTiered {
  gated: LearnedWords;
  direct: LearnedWords;
}

export interface LearnOutcome {
  added: boolean;
  word: string;
  rule: string;
  tier: LearnedTier;
  reason: string;
}

export interface LearnInput {
  span: string;
  rule: string;
  groupId: number;
  userId: number;
  messageId: number;
  ts: string;
  /** 词表里已有的词，用来去重（含 redline/alarm/softAlarm/rules/hints/gated/recordOnly） */
  taken?: readonly string[];
  /** 学到哪个档：缺省 gated（先本地确认）；direct 只给极少数秒杀级硬词用 */
  tier?: LearnedTier;
}

export function isLearnedRule(rule: string): rule is LearnedRule {
  return (LEARN_RULES as readonly string[]).includes(rule);
}

export function learnedPath(dataDir: string): string {
  return path.join(dataDir, LEARN_FILE);
}

export function auditPath(dataDir: string): string {
  return path.join(dataDir, LEARN_AUDIT);
}

/** 去掉包装、占位符、首尾标点，压到 SPAN_MAX 个字 */
export function normalizeSpan(raw: string): string {
  let s = raw.trim();
  s = s.replace(/\[[^\]]*\]/g, ''); // [at:123] / [image] 这类占位符不是词
  s = s.replace(/^[「『“"'‘【（(]+/, '');
  s = s.replace(/[」』”"'’】）)，。、！!？?…~～·．.:；;]+$/, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > SPAN_MAX) s = s.slice(0, SPAN_MAX);
  return s;
}

function localDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function asWords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((w): w is string => typeof w === 'string' && w.trim().length > 0).map((w) => w.trim());
}

/** 同步读：loadConfig 是同步的，热加载时也要能同步把学到的词并进词表。旧格式（平铺）按 gated 读 */
export function readLearnedTieredSync(dataDir: string): LearnedTiered {
  let raw: string;
  try {
    raw = readFileSync(learnedPath(dataDir), 'utf8');
  } catch {
    return { gated: {}, direct: {} };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    log.error('[learn] learned-keywords.json 不是合法 JSON，当作没有学过（不删文件）', err);
    return { gated: {}, direct: {} };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { gated: {}, direct: {} };
  const rec = obj as Record<string, unknown>;
  const out: LearnedTiered = { gated: {}, direct: {} };
  const wrap = rec['gated'] !== undefined || rec['direct'] !== undefined;
  if (wrap) {
    for (const tier of ['gated', 'direct'] as const) {
      const part = rec[tier];
      if (part === null || typeof part !== 'object' || Array.isArray(part)) continue;
      for (const [key, value] of Object.entries(part as Record<string, unknown>)) {
        if (!isLearnedRule(key)) continue;
        const words = asWords(value);
        if (words.length > 0) out[tier][key] = words;
      }
    }
    return out;
  }
  // 旧格式：{ "R4": ["弄死你"] } → 全部当 gated
  for (const [key, value] of Object.entries(rec)) {
    if (!isLearnedRule(key)) continue;
    const words = asWords(value);
    if (words.length > 0) out.gated[key] = words;
  }
  return out;
}

/** 平铺视图（两个档合并），给「已有词」去重和审计用 */
export function readLearnedSync(dataDir: string): LearnedWords {
  const { gated, direct } = readLearnedTieredSync(dataDir);
  const out: LearnedWords = { ...gated };
  for (const [rule, words] of Object.entries(direct)) {
    out[rule] = [...(out[rule] ?? []), ...words];
  }
  return out;
}

export async function readLearned(dataDir: string): Promise<LearnedWords> {
  return readLearnedSync(dataDir);
}

/** 今天已经学了多少个（按审计文件里的日期数） */
async function learnedToday(dataDir: string, now: Date): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(auditPath(dataDir), 'utf8');
  } catch {
    return 0;
  }
  const today = localDate(now);
  let count = 0;
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const rec = JSON.parse(line) as { ts?: unknown };
      if (typeof rec.ts === 'string' && rec.ts.startsWith(today)) count += 1;
    } catch {
      // 半行/坏行不计
    }
  }
  return count;
}

/**
 * 收一个词：长度/规则/重复/当日上限都过，才写进 learned-keywords.json 并追加审计行。
 * 只写文件、不碰运行中的词表 —— 调用方拿到 added:true 后自己热加载。
 */
export async function recordLearned(
  dataDir: string,
  input: LearnInput,
  now: Date = new Date(),
): Promise<LearnOutcome> {
  const tier: LearnedTier = input.tier ?? 'gated';
  const word = normalizeSpan(input.span);
  if (word.length < 2) return { added: false, word, rule: input.rule, tier, reason: '片段太短，不像一个词' };
  if (/^\d+$/.test(word)) return { added: false, word, rule: input.rule, tier, reason: '全是数字，不进词表' };
  if (!isLearnedRule(input.rule)) {
    return { added: false, word, rule: input.rule, tier, reason: `条款 ${input.rule} 不是群规条款号（只学 R3–R11）` };
  }
  if ((input.taken ?? []).includes(word)) {
    return { added: false, word, rule: input.rule, tier, reason: '词表里已经有' };
  }

  const learned = readLearnedTieredSync(dataDir);
  const bucket = learned[tier][input.rule] ?? [];
  if (bucket.includes(word)) return { added: false, word, rule: input.rule, tier, reason: '上次已经学过' };

  const today = await learnedToday(dataDir, now);
  if (today >= LEARN_DAILY_CAP) {
    return { added: false, word, rule: input.rule, tier, reason: `今天已学满 ${LEARN_DAILY_CAP} 个` };
  }

  learned[tier][input.rule] = [...bucket, word];
  try {
    await mkdir(dataDir, { recursive: true });
    const file = learnedPath(dataDir);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(learned, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
    await appendFile(
      auditPath(dataDir),
      `${JSON.stringify({
        ts: input.ts,
        rule: input.rule,
        tier,
        word,
        span: input.span,
        groupId: input.groupId,
        userId: input.userId,
        messageId: input.messageId,
      })}\n`,
      'utf8',
    );
  } catch (err) {
    log.error('[learn] 写 learned-keywords 失败（这条不学，不影响判定）', err);
    return { added: false, word, rule: input.rule, tier, reason: '写文件失败' };
  }

  const where = tier === 'direct' ? 'direct：直通云' : 'gated：先本地确认';
  log.info(`[learn] 收词「${word}」→ ${input.rule}（${where}）`);
  return { added: true, word, rule: input.rule, tier, reason: '已收录' };
}
