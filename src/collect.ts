/**
 * 原始群消息落盘（采集与自检方案 §3.3）。
 *
 * 只做一件事：把守卫群收到的每条消息追加进 `<dir>\YYYYMMDD.jsonl`。
 * 落盘失败只打日志，绝不把异常抛回判定链路——采数据不能拖垮守卫。
 * 目录必须放服务器 D 盘（含群号/昵称/原文），不能进 Syncthing 共享目录。
 */

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { localIso } from './guard/sent.ts';
import { log } from './log.ts';

/** 一行原始消息；字段口径见方案 §3.3，改字段先改方案 */
export interface CollectRecord {
  ts: string;
  groupId: number;
  userId: number;
  nickname: string;
  messageId: number;
  /** OneBot 的 sender.role：member / admin / owner */
  role: string;
  text: string;
  segTypes: string[];
  raw: string;
}

/** 与方案一致：text 只留前 500 字，raw 原样 */
const TEXT_MAX = 500;

function dayOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface CollectorOptions {
  enabled: boolean;
  dir: string;
  /** 注入时钟，测试时能钉住日期 */
  now?: () => Date;
}

export class Collector {
  readonly #enabled: boolean;
  readonly #dir: string;
  readonly #now: () => Date;
  #queue: Promise<void> = Promise.resolve();
  #failures = 0;
  #date = '';
  #lines = 0;

  constructor(opts: CollectorOptions) {
    this.#enabled = opts.enabled;
    this.#dir = opts.dir;
    this.#now = opts.now ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** 今天（进程内计数）已落盘行数；跨日自动归零 */
  get lines(): number {
    return this.#date === dayOf(this.#now()) ? this.#lines : 0;
  }

  get dir(): string {
    return this.#dir;
  }

  /** 把当前写队列排干；关闭进程前调一次 */
  async flush(): Promise<void> {
    await this.#queue;
  }

  /** 非阻塞追加：内部串行写，失败只记日志 */
  append(rec: CollectRecord): void {
    if (!this.#enabled) return;
    const day = dayOf(this.#now());
    const file = path.join(this.#dir, `${day}.jsonl`);
    const text = rec.text.length > TEXT_MAX ? rec.text.slice(0, TEXT_MAX) : rec.text;
    const line = `${JSON.stringify({ ...rec, text })}\n`;

    this.#queue = this.#queue
      .then(async () => {
        if (this.#date !== day) {
          this.#date = day;
          this.#lines = 0;
        }
        await mkdir(this.#dir, { recursive: true });
        await appendFile(file, line, 'utf8');
        this.#lines += 1;
      })
      .catch((err: unknown) => {
        this.#failures += 1;
        // 只在前几次和每 100 次报一次，避免磁盘满时刷屏
        if (this.#failures <= 3 || this.#failures % 100 === 0) {
          log.error(`[collect] 落盘失败（第 ${this.#failures} 次，只记日志不阻塞判定）：${errText(err)}`);
        }
      });
  }

  /** 方便给 #test status 用 */
  tsNow(): string {
    return localIso(this.#now());
  }
}
