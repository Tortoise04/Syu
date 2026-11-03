import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { log } from './log.ts';

/**
 * data/state.json 的唯一写入口。
 * 读盘 → 内存对象 → 改内存 → 200ms 防抖落盘（原子写：同目录 .tmp 再 rename）。
 * 跨日按本地日期字符串比较：预算与当日计数清零，冷却表按过期时间自然淘汰。
 */

export interface GuardStateSnapshot {
  date: string;
  budget: { total: number; perGroup: Record<string, number> };
  counters: Record<string, number>;
  cooldowns: Record<string, number>;
  lastActionMessageId?: number;
  screenDegraded: boolean;
}

export interface StateStoreOptions {
  file: string;
  budgetDaily: number;
  budgetPerGroup: number;
  /** 逐群覆盖单群上限（2026-11-02 用户拍板：活跃群 500、测试群仍走 perGroup） */
  groupDaily?: Record<string, number>;
  /** 注入时钟，让测试能模拟跨日；不传就用系统时间 */
  now?: () => Date;
}

const SAVE_DEBOUNCE_MS = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地日期字符串（不能用 toISOString，那是 UTC，服务器时区会错一天） */
function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function emptyState(date: string): GuardStateSnapshot {
  return { date, budget: { total: 0, perGroup: {} }, counters: {}, cooldowns: {}, screenDegraded: false };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readNumberRecord(v: unknown, where: string): Record<string, number> {
  if (!isPlainObject(v)) throw new Error(`${where} 不是对象`);
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Error(`${where} 的 ${k} 不是非负数字`);
    out[k] = n;
  }
  return out;
}

/** 校验读回来的内容；任何一条不合法都抛，由 init 统一走「备份 + 空态」 */
function parseState(raw: string): GuardStateSnapshot {
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) throw new Error('顶层不是对象');

  if (typeof parsed.date !== 'string' || !DATE_RE.test(parsed.date)) throw new Error('date 不是 YYYY-MM-DD');
  if (!isPlainObject(parsed.budget)) throw new Error('budget 不是对象');
  const total = parsed.budget.total;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) throw new Error('budget.total 不是非负整数');

  const snapshot: GuardStateSnapshot = {
    date: parsed.date,
    budget: { total, perGroup: readNumberRecord(parsed.budget.perGroup, 'budget.perGroup') },
    counters: readNumberRecord(parsed.counters, 'counters'),
    cooldowns: readNumberRecord(parsed.cooldowns, 'cooldowns'),
    screenDegraded: parsed.screenDegraded === true,
  };
  if (parsed.lastActionMessageId !== undefined) {
    const id = parsed.lastActionMessageId;
    if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error('lastActionMessageId 不是整数');
    snapshot.lastActionMessageId = id;
  }
  if (typeof parsed.screenDegraded !== 'boolean') throw new Error('screenDegraded 不是布尔值');
  return snapshot;
}

export class StateStore {
  private readonly file: string;
  private readonly budgetDaily: number;
  private readonly budgetPerGroup: number;
  private readonly groupDaily: Record<string, number>;
  private readonly clock: () => Date;
  private data: GuardStateSnapshot;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /** 串行化落盘，避免两次写交错出半截文件 */
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: StateStoreOptions) {
    this.file = opts.file;
    this.budgetDaily = opts.budgetDaily;
    this.budgetPerGroup = opts.budgetPerGroup;
    this.groupDaily = opts.groupDaily ?? {};
    this.clock = opts.now ?? (() => new Date());
    this.data = emptyState(localDate(this.clock()));
  }

  async init(): Promise<void> {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });

    let raw: string | null = null;
    try {
      raw = await fsp.readFile(this.file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.data = emptyState(localDate(this.clock()));
      if (code === 'ENOENT') {
        log.warn(`状态文件不存在，从空状态开始并新建：${this.file}`);
        await this.persist();
      } else {
        // 读不了也绝不崩：空态起，运行时会把文件重新写出来
        log.warn(`状态文件读取失败（${String(code)}），本次从空状态开始：${this.file}`);
      }
      return;
    }

    try {
      this.data = parseState(raw);
    } catch (err) {
      const backup = await this.quarantine();
      this.data = emptyState(localDate(this.clock()));
      log.warn(`状态文件损坏（${(err as Error).message}），已备份到 ${backup}，从空状态开始`);
      await this.persist();
      return;
    }

    if (this.rolloverIfNeeded()) await this.persist();
  }

  get snapshot(): GuardStateSnapshot {
    if (this.rolloverIfNeeded()) this.scheduleSave();
    const out: GuardStateSnapshot = {
      date: this.data.date,
      budget: { total: this.data.budget.total, perGroup: { ...this.data.budget.perGroup } },
      counters: { ...this.data.counters },
      cooldowns: { ...this.data.cooldowns },
      screenDegraded: this.data.screenDegraded,
    };
    if (this.data.lastActionMessageId !== undefined) out.lastActionMessageId = this.data.lastActionMessageId;
    return out;
  }

  /** 总预算与单群预算任一已满就 false，且两边都不加；成功则各 +1 */
  takeBudget(groupId: number): boolean {
    if (this.rolloverIfNeeded()) this.scheduleSave();
    const key = String(groupId);
    const used = this.data.budget.perGroup[key] ?? 0;
    const cap = this.groupDaily[key] ?? this.budgetPerGroup;
    if (this.data.budget.total >= this.budgetDaily) return false;
    if (used >= cap) return false;
    this.data.budget.total += 1;
    this.data.budget.perGroup[key] = used + 1;
    this.scheduleSave();
    return true;
  }

  isCooling(key: string): boolean {
    if (this.rolloverIfNeeded()) this.scheduleSave();
    const until = this.data.cooldowns[key];
    if (until === undefined) return false;
    if (until <= this.clock().getTime()) {
      delete this.data.cooldowns[key];
      this.scheduleSave();
      return false;
    }
    return true;
  }

  touchCooldown(key: string, ms: number): void {
    if (this.rolloverIfNeeded()) this.scheduleSave();
    this.data.cooldowns[key] = this.clock().getTime() + ms;
    this.scheduleSave();
  }

  bumpDailyCount(groupId: number, rule: string): number {
    if (this.rolloverIfNeeded()) this.scheduleSave();
    const key = `${groupId}:${rule}:${this.data.date}`;
    const next = (this.data.counters[key] ?? 0) + 1;
    this.data.counters[key] = next;
    this.scheduleSave();
    return next;
  }

  dailyCount(groupId: number, rule: string): number {
    if (this.rolloverIfNeeded()) this.scheduleSave();
    return this.data.counters[`${groupId}:${rule}:${this.data.date}`] ?? 0;
  }

  /** 举报通道不受预算与冷却限制，只按人按日计数 */
  bumpRejectReport(userId: number): number {
    if (this.rolloverIfNeeded()) this.scheduleSave();
    const key = `report:${userId}:${this.data.date}`;
    const next = (this.data.counters[key] ?? 0) + 1;
    this.data.counters[key] = next;
    this.scheduleSave();
    return next;
  }

  rejectReportCount(userId: number): number {
    if (this.rolloverIfNeeded()) this.scheduleSave();
    return this.data.counters[`report:${userId}:${this.data.date}`] ?? 0;
  }

  setLastActionMessageId(id: number | undefined): void {
    if (this.rolloverIfNeeded()) this.scheduleSave();
    if (id === undefined) delete this.data.lastActionMessageId;
    else this.data.lastActionMessageId = id;
    this.scheduleSave();
  }

  setScreenDegraded(v: boolean): void {
    if (this.rolloverIfNeeded()) this.scheduleSave();
    this.data.screenDegraded = v;
    this.scheduleSave();
  }

  /** 把防抖里攒下的改动立刻落盘；进程退出前必须 await 一次 */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.dirty) {
      await this.persist();
      return;
    }
    await this.chain.catch(() => undefined);
  }

  /** 返回 true 表示本次调用刚完成一次跨日重置 */
  private rolloverIfNeeded(): boolean {
    const today = localDate(this.clock());
    if (this.data.date === today) return false;
    const prev = this.data.date;
    this.data.date = today;
    this.data.budget.total = 0;
    this.data.budget.perGroup = {};
    this.data.counters = {};
    log.info(`状态跨日重置 ${prev} → ${today}：预算与当日计数清零，冷却表保留`);
    return true;
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.persist().catch((err: unknown) => log.error('状态落盘失败', err));
    }, SAVE_DEBOUNCE_MS);
  }

  private persist(): Promise<void> {
    const run = async (): Promise<void> => {
      this.dirty = false;
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      const body = `${JSON.stringify(this.data, null, 2)}\n`;
      await fsp.writeFile(tmp, body, 'utf8');
      await fsp.rename(tmp, this.file);
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  private async quarantine(): Promise<string> {
    const stamp = `${localDate(this.clock()).replace(/-/g, '')}-${this.clock().getTime()}`;
    const backup = `${this.file}.bad-${stamp}`;
    try {
      await fsp.rename(this.file, backup);
    } catch (err) {
      log.error(`损坏的状态文件备份失败（原文件保留在原处）：${this.file}`, err);
    }
    return backup;
  }
}
