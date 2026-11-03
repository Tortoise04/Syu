/**
 * 私聊收件箱（2026-11-01 用户拍板：私聊只收不判）。
 *
 * 只做一件事：把主人私聊发来的原文追加进 `<dir>\YYYYMMDD.jsonl`。
 * 用户原话：「我一般发的都是聊天记录，不做功能只是方便收聊天记录」——
 * 所以这里不判定、不进 collect、不写 violations、不花云预算，纯入库。
 * 目录必须放 D 盘（含 QQ 号/昵称/原文），不能进 Syncthing 共享目录。
 */

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { localIso } from './guard/sent.ts';
import { log } from './log.ts';

/** 一行私聊原文；字段口径改动要先改方案文档 */
export interface InboxRecord {
  ts: string;
  userId: number;
  nickname: string;
  messageId: number;
  segTypes: string[];
  /** plainText 的结果（合并转发只有 [forward]，内容在 forward 字段里） */
  text: string;
  /** 原始 raw_message（CQ 码形式），拿不到时退化成 text */
  raw: string;
  /** 原始 message 段数组，一个字节都不改：合转/卡片全靠它还原 */
  message: unknown;
  /** 合并转发展开的结果（get_forward_msg 成功才有）；失败就不写这个键 */
  forward?: unknown;
}

function dayOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface PrivateInboxOptions {
  enabled: boolean;
  dir: string;
  /** 注入时钟，测试时能钉住日期 */
  now?: () => Date;
}

export class PrivateInbox {
  readonly #enabled: boolean;
  readonly #dir: string;
  readonly #now: () => Date;
  #queue: Promise<void> = Promise.resolve();
  #failures = 0;
  #date = '';
  #lines = 0;
  /** 今日已收（含还在队列里没落盘的），回执里的「第 N 条」用它 */
  #seq = 0;

  constructor(opts: PrivateInboxOptions) {
    this.#enabled = opts.enabled;
    this.#dir = opts.dir;
    this.#now = opts.now ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** 今天（进程内计数）已收条数；跨日自动归零 */
  get lines(): number {
    return this.#date === dayOf(this.#now()) ? this.#lines : 0;
  }

  get dir(): string {
    return this.#dir;
  }

  /** 今天会写进哪个文件（回执里给主人看路径） */
  todayFile(): string {
    return path.join(this.#dir, `${dayOf(this.#now())}.jsonl`);
  }

  /** 排干写队列；关闭进程前调一次 */
  async flush(): Promise<void> {
    await this.#queue;
  }

  /**
   * 非阻塞追加：内部串行写，失败只记日志。
   * 返回落盘后的「今天第几条」，给回执用；没启用返回 0。
   */
  append(rec: InboxRecord): number {
    if (!this.#enabled) return 0;
    const day = dayOf(this.#now());
    const file = path.join(this.#dir, `${day}.jsonl`);
    const line = `${JSON.stringify(rec)}\n`;
    if (this.#date !== day) {
      this.#date = day;
      this.#lines = 0;
      this.#seq = 0;
    }
    // 序号同步自增：连发两条时不能都回「第 1 条」
    this.#seq += 1;
    const seq = this.#seq;

    this.#queue = this.#queue
      .then(async () => {
        await mkdir(this.#dir, { recursive: true });
        await appendFile(file, line, 'utf8');
        this.#lines += 1;
      })
      .catch((err: unknown) => {
        this.#failures += 1;
        if (this.#failures <= 3 || this.#failures % 100 === 0) {
          log.error(`[inbox] 落盘失败（第 ${this.#failures} 次，只记日志）：${errText(err)}`);
        }
      });

    return seq;
  }

  tsNow(): string {
    return localIso(this.#now());
  }
}
