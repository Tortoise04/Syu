import WebSocket from 'ws';
import { log } from '../log.ts';
import type {
  ApiResponse,
  GroupInfo,
  LoginInfo,
  MessageEvent,
  MessageSegment,
  OneBotEvent,
  SendResult,
} from './types.ts';

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export type ClientOptions = {
  wsUrl: string;
  token?: string;
  /** 连上后拉一次登录信息，拿到 selfId */
  onReady?: (info: LoginInfo) => void;
  onEvent?: (ev: OneBotEvent) => void;
};

/** 去重窗口：断线重连时协议端会重放事件，同一条消息只该算一次 */
const DEDUP_CAP = 2000;
const DEDUP_TTL_MS = 10 * 60_000;
/** 指数退避上限，别让重连把日志刷满也把对端打醒 */
const BACKOFF_MAX_MS = 30_000;

function toSegments(message: string | MessageSegment[]): MessageSegment[] {
  return typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : message;
}

/**
 * OneBot v11 正向 WebSocket 客户端。
 * NapCat 那边开「WebSocket 服务器」，我们主动连过去，断了自动重连。
 */
export class OneBotClient {
  #opts: ClientOptions;
  #ws: WebSocket | null = null;
  #pending = new Map<string, Pending>();
  #seq = 0;
  #closed = false;
  #retry = 0;
  #ready = false;
  #selfId = 0;
  /** message_id → 过期时间戳；Map 的插入顺序就是淘汰顺序 */
  #seen = new Map<number, number>();

  constructor(opts: ClientOptions) {
    this.#opts = opts;
  }

  get selfId(): number {
    return this.#selfId;
  }

  get online(): boolean {
    return this.#ready && this.#ws?.readyState === WebSocket.OPEN;
  }

  get dedupSize(): number {
    return this.#seen.size;
  }

  connect(): void {
    this.#closed = false;
    const sep = this.#opts.wsUrl.includes('?') ? '&' : '?';
    const url = this.#opts.token
      ? `${this.#opts.wsUrl}${sep}access_token=${encodeURIComponent(this.#opts.token)}`
      : this.#opts.wsUrl;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    } catch (err) {
      log.error(`WebSocket 地址不合法：${url}`, err);
      return;
    }
    this.#ws = ws;

    ws.on('open', () => {
      this.#retry = 0;
      log.ok(`已连上协议端 ${this.#opts.wsUrl}`);
      void this.#hello();
    });

    ws.on('message', (raw) => this.#onMessage(raw.toString()));

    ws.on('close', (code) => {
      this.#ready = false;
      for (const [echo, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(new Error('连接已断开'));
        this.#pending.delete(echo);
      }
      if (this.#closed) return;
      const wait = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** Math.min(this.#retry++, 5));
      log.warn(`协议端断开（code ${code}），${Math.round(wait / 1000)}s 后重连`);
      setTimeout(() => this.connect(), wait);
    });

    ws.on('error', (err) => {
      const msg = (err as Error).message || String(err);
      // 首次连不上很正常（NapCat 还没起），降噪
      if (this.#retry <= 1) log.warn(`协议端连接失败：${msg}`);
    });
  }

  async #hello(): Promise<void> {
    try {
      const info = await this.getLoginInfo();
      this.#selfId = Number(info.user_id) || 0;
      this.#ready = true;
      this.#opts.onReady?.(info);
    } catch (err) {
      this.#ready = true;
      log.warn(`get_login_info 失败，继续跑：${(err as Error).message}`);
    }
  }

  close(): void {
    this.#closed = true;
    this.#ws?.close();
  }

  /**
   * 按 message_id 去重：已见过返回 true。
   * 容量 2000 + 10 分钟过期，两者取先到；Map 插入顺序即 LRU 顺序。
   */
  isDuplicate(messageId: number): boolean {
    if (!Number.isFinite(messageId) || messageId <= 0) return false;
    const now = Date.now();
    const exp = this.#seen.get(messageId);
    if (exp !== undefined && exp > now) {
      // 命中：移到队尾，让热点 id 不被先淘汰
      this.#seen.delete(messageId);
      this.#seen.set(messageId, exp);
      return true;
    }
    this.#seen.delete(messageId);
    this.#seen.set(messageId, now + DEDUP_TTL_MS);
    this.#evict(now);
    return false;
  }

  #evict(now: number): void {
    for (const [id, exp] of this.#seen) {
      if (exp > now && this.#seen.size <= DEDUP_CAP) return;
      this.#seen.delete(id);
    }
  }

  #onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const data = parsed as ApiResponse<unknown>;

    if (data.echo && this.#pending.has(data.echo)) {
      const p = this.#pending.get(data.echo);
      this.#pending.delete(data.echo);
      if (!p) return;
      clearTimeout(p.timer);
      if (data.status === 'failed' || (data.retcode ?? 0) !== 0) {
        p.reject(new Error(`API 失败 retcode=${data.retcode}`));
      } else {
        p.resolve(parsed);
      }
      return;
    }

    const ev = parsed as { post_type?: string };
    if (ev.post_type) this.#opts.onEvent?.(parsed as OneBotEvent);
  }

  /** 调 OneBot API，返回 data 字段本身 */
  call<T = unknown>(action: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`未连接到协议端，无法调用 ${action}`));
        return;
      }
      const echo = `s${++this.#seq}`;
      const timer = setTimeout(() => {
        this.#pending.delete(echo);
        reject(new Error(`${action} 超时（${timeoutMs}ms）`));
      }, timeoutMs);

      this.#pending.set(echo, {
        resolve: (v) => resolve((v as ApiResponse<T>).data as T),
        reject,
        timer,
      });
      this.#ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  getLoginInfo(): Promise<LoginInfo> {
    return this.call<LoginInfo>('get_login_info', {}, 8000);
  }

  getGroupList(): Promise<GroupInfo[]> {
    return this.call<GroupInfo[]>('get_group_list', {}, 15_000);
  }

  async sendGroup(groupId: number | string, message: string | MessageSegment[]): Promise<number> {
    const r = await this.call<SendResult>('send_group_msg', {
      group_id: Number(groupId),
      message: toSegments(message),
    });
    return Number(r?.message_id ?? 0);
  }

  async sendPrivate(userId: number | string, message: string | MessageSegment[]): Promise<number> {
    const r = await this.call<SendResult>('send_private_msg', {
      user_id: Number(userId),
      message: toSegments(message),
    });
    return Number(r?.message_id ?? 0);
  }

  /** 取一条历史消息：M2 的举报通道要拿被回复的那条 */
  async getMsg(messageId: number): Promise<MessageEvent | null> {
    try {
      return await this.call<MessageEvent>('get_msg', { message_id: messageId }, 8000);
    } catch {
      return null;
    }
  }

  /**
   * 展开一条合并转发（私聊收件箱用）：forward 段的 data.id 就是它的 id。
   * NapCat 与 OneBot v11 用的参数名不一样（id / message_id），两个都试，失败就返回 null
   * ——收不到内容也不能丢原文，调用方会把原始段数组照写。
   */
  async getForwardMsg(forwardId: string): Promise<Record<string, unknown> | null> {
    for (const params of [{ id: forwardId }, { message_id: forwardId }]) {
      try {
        return await this.call<Record<string, unknown>>('get_forward_msg', params, 10_000);
      } catch {
        // 换下一个参数名
      }
    }
    return null;
  }

  /** 撤回：处置动作的后路，M2 用；撤不掉不能当崩溃 */
  async deleteMsg(messageId: number): Promise<boolean> {
    try {
      await this.call('delete_msg', { message_id: messageId }, 8000);
      return true;
    } catch {
      return false;
    }
  }
}
