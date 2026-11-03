import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ViolationRecord } from './types.ts';
import { log } from '../log.ts';

/**
 * violations.jsonl 的唯一写入口。
 * 一行一条 JSON（不换行美化），目录不存在先建；追加失败只打日志，绝不抛给调用方 ——
 * 一条记录写不进去不能拖垮机器人。
 */

const TEXT_MAX = 200;
const FILE_NAME = 'violations.jsonl';

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

export function violationsFile(dataDir: string): string {
  return path.join(dataDir, FILE_NAME);
}

export async function appendViolation(dataDir: string, rec: ViolationRecord): Promise<void> {
  const target = violationsFile(dataDir);
  try {
    const text = typeof rec.text === 'string' ? truncate(rec.text, TEXT_MAX) : '';
    const line = JSON.stringify({ ...rec, text });
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.appendFile(target, `${line}\n`, 'utf8');
  } catch (err) {
    log.error(`违规记录追加失败（${target}），本条丢弃`, err);
  }
}
