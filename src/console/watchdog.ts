/**
 * Syu 掉线看门狗（2026-11-02）
 *
 * 为什么要有它：NapCat 自己只会「重启 Worker」（同进程）——13:36:13 的日志写着「正在重启 Worker 以重新创建
 * QQ 登录服务」，可新进程直到 13:50:20 才出现。6 次踢线里最长一次 8 小时 13 分没回来。卡住的不是票据，
 * 是没人把 NapCat 整进程拉起来：13:50 那次 login.enc 没变也能上线，说明快速登录本来就能过。
 *
 * 做的事：每 intervalMs 探活一次（短连接 get_login_info，不跟守卫抢连接）。
 *   - NapCat 在跑、登录不在线（连续 offlineThreshold 次）→ 整进程重启，带 NAPCAT_QUICK_ACCOUNT；
 *   - NapCat 进程没了、而它之前跑过 → 同样重启（用户手动 stop 会 setArmed(false)，不会被打扰）；
 *   - 重启前后给 owner 私聊告警，走 Dyu 的 OneBot 正向 WS（本机 3001，无鉴权），附最新二维码。
 *
 * 不做的：不替用户启动一个从没起过的 NapCat；1 小时最多重启 maxRestartsPerHour 次，超了只告警（熔断）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { ConsoleConfig } from '../config.ts';
import { log } from '../log.ts';
import { findNapcatProcs, probeLogin, qrInfo, startNapcat, stopNapcat } from './procs.ts';

export type WatchdogEvent = { ts: number; kind: string; message: string };

export interface WatchdogStatus {
  /** 是否允许自动重启（用户手动 stop 会置 false） */
  armed: boolean;
  /** 当前是否正在重启流程里 */
  restarting: boolean;
  intervalMs: number;
  consecutiveOffline: number;
  lastCheckAt: number;
  lastOnlineAt: number;
  lastRestartAt: number;
  /** 最近一小时内的重启次数 */
  restartCount1h: number;
  /** 快速登录用的 QQ 号；识别不到就是 null（只能扫码） */
  quickAccount: number | null;
  /** 最近 20 条看门狗事件，新的在后 */
  events: WatchdogEvent[];
}

export interface WatchdogOptions {
  cfg: ConsoleConfig;
  /** 探活地址，跟控制台同一个（默认 ws://127.0.0.1:3002） */
  wsUrl: string;
  token?: string;
  /** 告警发件口：Dyu 的 OneBot 正向 WS */
  alertWsUrl?: string;
  /** 告警收件人：每次现取，页面改了 .env / config.json 能立刻生效 */
  alertTargets: () => number[];
  /** data/console 目录（watchdog.json 落这里） */
  consoleDir: string;
  intervalMs?: number;
  offlineThreshold?: number;
  recoveryMs?: number;
  maxRestartsPerHour?: number;
}

export interface WatchdogHandle {
  status: () => WatchdogStatus;
  /** 手动启停 NapCat 时同步：stop 之后不该被看门狗再拉起来 */
  setArmed: (on: boolean) => void;
  stop: () => void;
}

type Persisted = {
  armed: boolean;
  everSawRunning: boolean;
  lastOnlineAt: number;
  lastRestartAt: number;
  restarts: number[];
  events: WatchdogEvent[];
};

const MAX_EVENTS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * NapCat 的 config 目录里，账号相关的文件名带 QQ 号：napcat_<uin>.json。
 *
 * 2026-11-02 修正：换号后旧账号的 `napcat_<旧uin>.json` 会留在目录里，原来「目录里第一个命中就算」
 * 会一直拿旧号去快速登录（16:36 换到 777777777 之后，666666666 的文件还在，先命中它）。
 * 改成按文件 mtime 取最新的一份——当前登录的账号每登录一次就重写自己的配置，mtime 天然是最新的。
 * 找不到就返回 null（重启后只能等扫码）。
 */
export function detectQuickAccount(napcatDir: string): number | null {
  try {
    const dir = join(napcatDir, 'config');
    let best: { uin: number; mtimeMs: number } | null = null;
    for (const name of readdirSync(dir)) {
      const m = /^napcat_(\d{5,12})\.json$/i.exec(name);
      if (m === null) continue;
      const uin = Number(m[1]);
      if (!Number.isInteger(uin) || uin <= 0) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(join(dir, name)).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      if (best === null || mtimeMs > best.mtimeMs) best = { uin, mtimeMs };
    }
    return best === null ? null : best.uin;
  } catch {
    /* 目录不在或没权限：按没有账号处理 */
  }
  return null;
}

/**
 * 给 owner 发一条私聊。失败只 warn，不影响看门狗主流程。
 * 走 Dyu 的 OneBot：本机 3001，token 为空；连不上（Dyu 没跑）就只写日志。
 */
async function sendAlert(
  wsUrl: string,
  userId: number,
  text: string,
  imagePath?: string,
): Promise<boolean> {
  return new Promise<boolean>((finish) => {
    let settled = false;
    let ws: WebSocket;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* 已经关了 */
      }
      finish(ok);
    };
    try {
      ws = new WebSocket(wsUrl, { handshakeTimeout: 3000 });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => done(false), 6000);
    timer.unref();

    type Segment = { type: string; data: Record<string, unknown> };
    const message: Segment[] = [{ type: 'text', data: { text } }];
    if (imagePath !== undefined) {
      try {
        const b64 = readFileSync(imagePath).toString('base64');
        if (b64.length > 0) message.push({ type: 'image', data: { file: 'base64://' + b64 } });
      } catch {
        /* 图片读不到就只发文字 */
      }
    }
    ws.on('open', () => {
      ws.send(JSON.stringify({ action: 'send_private_msg', params: { user_id: userId, message }, echo: 'syu-watchdog-alert' }));
    });
    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(String(raw)) as Record<string, unknown>;
        if (data.echo === 'syu-watchdog-alert') done(data.status === 'ok');
      } catch {
        /* 不是我们的回包 */
      }
    });
    ws.on('error', () => done(false));
    ws.on('close', () => done(false));
  });
}

export function startWatchdog(opts: WatchdogOptions): WatchdogHandle {
  const intervalMs = opts.intervalMs ?? 30_000;
  const offlineThreshold = Math.max(1, opts.offlineThreshold ?? 3);
  const recoveryMs = opts.recoveryMs ?? 60_000;
  const maxRestartsPerHour = Math.max(1, opts.maxRestartsPerHour ?? 6);
  const statePath = join(opts.consoleDir, 'watchdog.json');

  const persisted: Persisted = (() => {
    try {
      const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
      return {
        armed: raw.armed !== false,
        everSawRunning: raw.everSawRunning === true,
        lastOnlineAt: Number(raw.lastOnlineAt) || 0,
        lastRestartAt: Number(raw.lastRestartAt) || 0,
        restarts: Array.isArray(raw.restarts) ? raw.restarts.filter((n) => typeof n === 'number') : [],
        events: Array.isArray(raw.events) ? (raw.events as WatchdogEvent[]).slice(-MAX_EVENTS) : [],
      };
    } catch {
      return { armed: true, everSawRunning: false, lastOnlineAt: 0, lastRestartAt: 0, restarts: [], events: [] };
    }
  })();

  const quickAccount = detectQuickAccount(opts.cfg.napcatDir);
  let consecutiveOffline = 0;
  let restarting = false;
  let wasOnline = false;
  let graceUntil = 0;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let lastCheckAt = 0;

  function save(): void {
    try {
      mkdirSync(opts.consoleDir, { recursive: true });
      const now = Date.now();
      persisted.restarts = persisted.restarts.filter((t) => now - t < 3_600_000);
      writeFileSync(statePath, JSON.stringify({ ...persisted, consecutiveOffline, updatedAt: now }) + '\n', 'utf8');
    } catch {
      /* 记账失败不影响重启 */
    }
  }

  function record(kind: string, message: string): void {
    persisted.events.push({ ts: Date.now(), kind, message });
    if (persisted.events.length > MAX_EVENTS) persisted.events.splice(0, persisted.events.length - MAX_EVENTS);
    save();
  }

  function restartsInLastHour(): number {
    const now = Date.now();
    persisted.restarts = persisted.restarts.filter((t) => now - t < 3_600_000);
    return persisted.restarts.length;
  }

  function status(): WatchdogStatus {
    return {
      armed: persisted.armed,
      restarting,
      intervalMs,
      consecutiveOffline,
      lastCheckAt: lastCheckAt,
      lastOnlineAt: persisted.lastOnlineAt,
      lastRestartAt: persisted.lastRestartAt,
      restartCount1h: restartsInLastHour(),
      quickAccount,
      events: persisted.events.slice(-MAX_EVENTS),
    };
  }

  async function alertAll(text: string, imagePath?: string): Promise<void> {
    const targets = opts.alertTargets().filter((qq) => Number.isInteger(qq) && qq > 0);
    if (targets.length === 0) {
      log.warn('[watchdog] 没有告警收件人（.env 的 OWNER_QQ / config.json 的 notify.adminQqs 都是空），只写日志');
      return;
    }
    const wsUrl = opts.alertWsUrl ?? 'ws://127.0.0.1:3001';
    for (const qq of targets) {
      const ok = await sendAlert(wsUrl, qq, text, imagePath);
      if (!ok) log.warn('[watchdog] 告警没发出去（Dyu 的 OneBot ' + wsUrl + ' 连不上？）：' + qq);
    }
  }

  /** 二维码只在 15 分钟内算新鲜，太旧的就是上一次登录留下的 */
  function freshQrPath(): string | undefined {
    const qr = qrInfo(opts.cfg);
    if (!qr.exists || qr.ageSec > 15 * 60) return undefined;
    return qr.path;
  }

  async function restart(reason: string): Promise<void> {
    restarting = true;
    const now = Date.now();
    persisted.lastRestartAt = now;
    persisted.restarts.push(now);
    record('restart', reason);
    log.warn('[watchdog] 判定需要重启：' + reason + '（本小时第 ' + restartsInLastHour() + ' 次）');
    await alertAll('【Syu】NapCat 掉线，看门狗正在重启。\n原因：' + reason + '\n重启后会在 60 秒内自动快速登录；若收到二维码说明票据失效，需要扫码。');

    try {
      const stopped = await stopNapcat(opts.cfg);
      log.info('[watchdog] 已停 NapCat 进程：' + (stopped.stopped.join(',') || '（本来就不在）'));
      for (let i = 0; i < 30; i += 1) {
        if ((await findNapcatProcs(opts.cfg)).length === 0) break;
        await sleep(200);
      }

      const started = await startNapcat(opts.cfg, quickAccount ?? undefined);
      if (!started.started) {
        log.warn('[watchdog] 重启没起来：' + (started.reason ?? '未知原因'));
        record('restart-failed', started.reason ?? '未知原因');
        await alertAll('【Syu】重启 NapCat 失败：' + (started.reason ?? '未知原因') + '\n需要在控制台手动处理。');
        graceUntil = Date.now() + 60_000;
        return;
      }
      log.info('[watchdog] 已重新拉起 NapCat pid=' + String(started.pid) + (quickAccount === null
        ? '（没识别到账号，只能扫码）'
        : '（快速登录 ' + quickAccount + '）'));
      record('restart-started', 'pid=' + String(started.pid) + (quickAccount === null ? ' 无快速登录账号' : ''));

      const deadline = Date.now() + recoveryMs;
      let lastError = '';
      while (Date.now() < deadline) {
        await sleep(3000);
        const probe = await probeLogin(opts.wsUrl, opts.token);
        if (probe.online) {
          consecutiveOffline = 0;
          wasOnline = true;
          persisted.lastOnlineAt = Date.now();
          graceUntil = 0;
          log.ok('[watchdog] 已自动回线 selfId=' + String(probe.selfId) + ' 昵称=' + (probe.nickname ?? '?'));
          record('online', 'selfId=' + String(probe.selfId));
          await alertAll('【Syu】已自动回线（快速登录成功），无需扫码。');
          return;
        }
        lastError = probe.error ?? '';
      }

      const qr = freshQrPath();
      log.warn('[watchdog] 重启后 ' + Math.round(recoveryMs / 1000) + ' 秒仍未上线：' + lastError);
      record('recovery-timeout', lastError);
      await alertAll(
        '【Syu】NapCat 已重启，但 ' + Math.round(recoveryMs / 1000) + ' 秒内没登录上：' + lastError
          + '\n大概率是登录票据失效，需要扫码登录（控制台 http://127.0.0.1:8789/ 的二维码页，或附件里的码）。',
        qr,
      );
      graceUntil = Date.now() + 5 * 60_000;
    } catch (err) {
      const msg = (err as Error).message;
      log.error('[watchdog] 重启流程出错：' + msg);
      record('restart-error', msg);
      await alertAll('【Syu】重启 NapCat 出错：' + msg);
      graceUntil = Date.now() + 2 * 60_000;
    } finally {
      restarting = false;
      save();
    }
  }

  async function tick(): Promise<void> {
    if (stopped || restarting) return;
    lastCheckAt = Date.now();
    const procs = await findNapcatProcs(opts.cfg).catch(() => []);
    const napcatRunning = procs.length > 0;
    if (napcatRunning) persisted.everSawRunning = true;

    const probe = napcatRunning
      ? await probeLogin(opts.wsUrl, opts.token)
      : { online: false as const, error: 'NapCat 进程不在' };

    if (probe.online) {
      if (!wasOnline) {
        log.ok('[watchdog] 登录在线 selfId=' + String(probe.selfId) + '（昵称 ' + (probe.nickname ?? '?') + '）');
        record('online', 'selfId=' + String(probe.selfId));
      }
      wasOnline = true;
      consecutiveOffline = 0;
      persisted.lastOnlineAt = Date.now();
      return;
    }

    wasOnline = false;
    consecutiveOffline += 1;

    if (!persisted.armed) {
      if (consecutiveOffline === offlineThreshold) log.info('[watchdog] 离线中，但看门狗处于 armed=false（手动停止或未启用），不重启');
      return;
    }
    if (!persisted.everSawRunning) {
      // 控制台刚起来、NapCat 从没跑过：不替用户做决定
      return;
    }
    if (Date.now() < graceUntil) return;
    if (napcatRunning && consecutiveOffline < offlineThreshold) return;
    if (!napcatRunning && consecutiveOffline < 1) return;

    if (restartsInLastHour() >= maxRestartsPerHour) {
      if (consecutiveOffline === offlineThreshold + 1) {
        log.error('[watchdog] 一小时内已重启 ' + maxRestartsPerHour + ' 次，熔断：不再自动重启，请人工处理');
        record('circuit-open', '超过每小时重启上限');
        await alertAll('【Syu】看门狗熔断：一小时内已重启 ' + maxRestartsPerHour + ' 次仍未稳定，停止自动重启，需要人工介入。');
      }
      return;
    }

    const human = napcatRunning
      ? '登录离线 ' + consecutiveOffline + ' 个周期（约 ' + Math.round((consecutiveOffline * intervalMs) / 1000) + ' 秒）：' + (probe.error ?? '')
      : 'NapCat 进程不在了（之前跑过）';
    await restart(human);
  }

  log.info('[watchdog] 已启用：每 ' + Math.round(intervalMs / 1000) + ' 秒探活 ' + opts.wsUrl
    + '；连续 ' + offlineThreshold + ' 次离线才重启；快速登录账号 ' + (quickAccount === null ? '未识别' : String(quickAccount))
    + '；armed=' + String(persisted.armed));

  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();
  void tick();

  return {
    status,
    setArmed(on: boolean): void {
      if (persisted.armed === on) return;
      persisted.armed = on;
      log.info('[watchdog] armed → ' + String(on));
      record('armed', on ? '开启自动重启' : '关闭自动重启（手动停止 NapCat）');
      if (!on) consecutiveOffline = 0;
    },
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
