/**
 * 送云抽签（采集与自检方案 §3.2）。
 *
 * 只用确定性哈希，不碰 Math.random：同一条消息在任何机器、任何时刻算出的
 * roll 完全一样，事后能用 (groupId, messageId) 复算「为什么这条没送云」。
 * 规则必须保持纯函数，才能被 scripts/test-sample.mjs 直接单测。
 */

import { createHash } from 'node:crypto';

/** 抽检来源：本地粗筛的三种结论 */
export type SampleKind = 'suspicious' | 'clean' | 'unknown' | 'gated';

export interface SampleRates {
  suspicious: number;
  clean: number;
  /** 不写就退回改动前的按时间分档（白天 0.05、凌晨 0.01） */
  unknown?: number;
}

/**
 * 缺省口径：config.json 不写 judge.sample 时维持改动前的行为——
 * suspicious 全送、clean 一条不送、unknown 按时间分档。
 * 漏配只会让抽样变回旧行为，不会把生产变成静默只记录。
 */
export const DEFAULT_SAMPLE_RATES: SampleRates = { suspicious: 1, clean: 0 };

/** unknown 的旧口径：凌晨 0–8 点更省 */
export const SAMPLE_RATE_DAY = 0.05;
export const SAMPLE_RATE_NIGHT = 0.01;
export const NIGHT_END_HOUR = 8;

/** 改了它等于换一套抽签结果，历史记录就不能复算了 */
export const SAMPLE_SALT = 'syu-sample-v1';

export interface SampleKey {
  groupId: number;
  messageId: number;
  userId: number;
  time: number;
  text: string;
}

export interface SampleDraw {
  kind: SampleKind;
  /** true = 送云端终审 */
  sampled: boolean;
  roll: number;
  rate: number;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** unknown 的抽检率：沿用改动前的 0–8 点更省 */
export function unknownRateAt(d: Date): number {
  const hour = d.getHours();
  return hour >= 0 && hour < NIGHT_END_HOUR ? SAMPLE_RATE_NIGHT : SAMPLE_RATE_DAY;
}

export function rateFor(kind: SampleKind, rates: SampleRates, now: Date): number {
  if (kind === 'suspicious') return clamp01(rates.suspicious);
  if (kind === 'clean') return clamp01(rates.clean);
  const fixed = rates.unknown;
  return fixed === undefined ? unknownRateAt(now) : clamp01(fixed);
}

/** 方案原文的抽签：sha1 前 8 位十六进制 / 0x100000000，落在 [0,1) */
export function sampleRoll(key: SampleKey): number {
  const seed =
    Number.isFinite(key.messageId) && key.messageId > 0
      ? `${key.groupId}:${key.messageId}:${SAMPLE_SALT}`
      : // message_id 缺失（或 #test 造的负数）时退化，仍然确定性
        `${key.groupId}:${key.userId}:${key.time}:${key.text}:${SAMPLE_SALT}`;
  const hex = createHash('sha1').update(seed).digest('hex').slice(0, 8);
  return parseInt(hex, 16) / 0x100000000;
}

/**
 * 抽一次签。override 存在时用注入的随机数（测试用的 random seam），
 * 保证老用例「unknown + random 0.99/0.01」的语义不变。
 */
export function drawSample(
  kind: SampleKind,
  key: SampleKey,
  rate: number,
  override?: () => number,
): SampleDraw {
  const r = clamp01(rate);
  let roll: number;
  if (override === undefined) {
    roll = sampleRoll(key);
  } else {
    const v = override();
    roll = Number.isFinite(v) && v >= 0 && v < 1 ? v : 1;
  }
  return { kind, sampled: roll < r, roll, rate: r };
}

/** 写进 reason / #test 回复的一行说明，方便对着 jsonl 复算 */
export function describeDraw(d: SampleDraw): string {
  const cmp = d.sampled ? '<' : '≥';
  return `抽样 roll=${d.roll.toFixed(4)} ${cmp} rate=${d.rate}，${
    d.sampled ? '已抽中送云' : '未抽中'
  }`;
}
