import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { log } from '../log.ts';

/**
 * sent.jsonl 的唯一写入口：每次真实发送（成功或失败）追加一行。
 * violations.jsonl 是 append-only 且动作在记录之后执行，回填不了字段，
 * 所以「真正发出去的文本」单独成行，页面按 messageId 与判定记录并排显示。
 * 目录不存在先建；追加失败只打日志，绝不抛给调用方 —— 记不下来不能拖垮发送。
 */

const TEXT_MAX = 200;
const FILE_NAME = 'sent.jsonl';

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/** 一条真实发送记录 */
export interface SentRecord {
  /** 本地 ISO 时间，与 violations.jsonl 同风格 */
  ts: string;
  groupId: number;
  messageId: number;
  /** group = client.sendGroup；private = client.sendPrivate */
  scope: 'group' | 'private';
  /** 群号（group）或 QQ 号（private） */
  to: number;
  /** 动作类型：warn / remind / escalate / mute */
  kind: string;
  /** 发出去的文本，最长 200 字 */
  text: string;
  ok: boolean;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地 ISO 时间（不是 UTC）：和群里的时间对得上，口径与 violations.jsonl 一致 */
export function localIso(d: Date): string {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}` +
    `${sign}${pad2(Math.trunc(abs / 60))}:${pad2(abs % 60)}`
  );
}

export function sentFile(dataDir: string): string {
  return path.join(dataDir, FILE_NAME);
}

export async function appendSent(dataDir: string, rec: SentRecord): Promise<void> {
  const target = sentFile(dataDir);
  try {
    const text = typeof rec.text === 'string' ? truncate(rec.text, TEXT_MAX) : '';
    // 字段顺序与方案文档 §13.2 的样例一致，方便肉眼比对
    const line = JSON.stringify({
      ts: rec.ts,
      groupId: rec.groupId,
      messageId: rec.messageId,
      scope: rec.scope,
      to: rec.to,
      kind: rec.kind,
      text,
      ok: rec.ok,
    });
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.appendFile(target, `${line}\n`, 'utf8');
  } catch (err) {
    log.error(`发送记录追加失败（${target}），本条丢弃`, err);
  }
}
