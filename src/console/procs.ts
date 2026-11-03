import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import type { ConsoleConfig } from '../config.ts';

const execFileAsync = promisify(execFile);

/** 工作区根目录（src/console → 上两级）；子进程的 cwd 与日志都挂在这下面 */
export const ROOT = resolve(import.meta.dirname, '..', '..');
const LOG_DIR = join(ROOT, 'data', 'console');
const NAPCAT_LOG = join(LOG_DIR, 'napcat.log');
const BOT_LOG = join(LOG_DIR, 'bot.log');
const BOT_RECORD = join(LOG_DIR, 'bot.json');
const NAPCAT_RECORD = join(LOG_DIR, 'napcat.json');

/** ppid 用来按进程树认领自己的孩子：QQ 装在 C:\Program Files\Tencent\QQNT 时，光看路径会跟 Dyu 的 QQ 混在一起 */
export type ProcRow = { pid: number; name: string; path: string; ppid: number; cmd: string };

function ensureLogDir(): void {
  mkdirSync(LOG_DIR, { recursive: true });
}

async function powershell(script: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

/**
 * 只查 QQ.exe 与 NapCatWinBootMain.exe，路径在 JS 里按前缀过滤。
 * 绝不按映像名杀：本机还跑着参考工程 Dyu 的 C:\Program Files\Tencent\QQNT\QQ.exe。
 */
export async function listProcs(): Promise<ProcRow[]> {
  const script =
    'Get-CimInstance Win32_Process -Filter "Name=' + "'QQ.exe'" + ' OR Name=' + "'NapCatWinBootMain.exe'"
    + ' OR (Name=' + "'cmd.exe'" + ' AND CommandLine LIKE ' + "'%napcat-console.bat%'" + ')'
    + '" | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  let raw = '';
  try {
    raw = (await powershell(script)).trim();
  } catch {
    return [];
  }
  if (raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: ProcRow[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const pid = Number(row.ProcessId);
    const path = typeof row.ExecutablePath === 'string' ? row.ExecutablePath : '';
    const name = typeof row.Name === 'string' ? row.Name : '';
    const ppid = Number(row.ParentProcessId);
    const cmd = typeof row.CommandLine === 'string' ? row.CommandLine : '';
    if (Number.isInteger(pid) && pid > 0) out.push({ pid, name, path, ppid: Number.isInteger(ppid) ? ppid : 0, cmd });
  }
  return out;
}

type LaunchRecord = { pid: number; startedAt: number };

function readLaunchRecord(): LaunchRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(NAPCAT_RECORD, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const pid = Number((parsed as Record<string, unknown>).pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, startedAt: Number((parsed as Record<string, unknown>).startedAt) || 0 };
  } catch {
    return null;
  }
}

function writeLaunchRecord(rec: LaunchRecord | null): void {
  ensureLogDir();
  try {
    writeFileSync(NAPCAT_RECORD, JSON.stringify(rec) + '\n', 'utf8');
  } catch {
    /* 记账失败不影响启停 */
  }
}

/**
 * 本机器人自己的 NapCat 进程：按进程树认领，不按 QQ 的安装路径认。
 * 锚点有两个：napcatDir 下的 NapCatWinBootMain.exe，以及控制台自己 spawn 出来的 launcher pid（记在 data/console/napcat.json）。
 * 理由：QQ 换成系统安装版后（C:\Program Files\Tencent\QQNT），路径前缀会同时命中 Dyu 的 QQ，按路径杀会打错人。
 */
export async function findNapcatProcs(cfg: ConsoleConfig): Promise<ProcRow[]> {
  const rows = await listProcs();
  const dir = cfg.napcatDir.toLowerCase().replace(/[\\/]+$/, '');
  const own = new Set<number>();
  for (const r of rows) {
    const path = r.path.toLowerCase();
    if (r.name.toLowerCase() === 'napcatwinbootmain.exe' && path !== '' && path.startsWith(dir)) own.add(r.pid);
    // 启动壳：跑的是我们这份 napcat-console.bat 的 cmd.exe。`start` 会给 .bat 配一个
    // cmd /K，它自带控制台；以前 stopNapcat 只杀 QQ/NapCat，于是每次重启都留下一个
    // 空壳（2026-11-03 抓到 pid 27184，11-02 16:35 起一直挂着）。
    else if (r.name.toLowerCase() === 'cmd.exe' && r.cmd.toLowerCase().includes('napcat-console.bat')) own.add(r.pid);
  }
  const rec = readLaunchRecord();
  if (rec !== null && rows.some((r) => r.pid === rec.pid)) own.add(rec.pid);
  if (own.size === 0) return [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (own.has(r.pid) || r.ppid === 0) continue;
      if (own.has(r.ppid)) {
        own.add(r.pid);
        grew = true;
      }
    }
  }
  return rows.filter((r) => own.has(r.pid));
}

export async function stopNapcat(cfg: ConsoleConfig): Promise<{ stopped: number[] }> {
  // 最多扫 3 轮、每轮隔 400ms：QQ 的子进程有可能在被杀的父进程之后才落地，
  // 单次快照会漏掉它们 —— 漏掉的那个就是屏幕上留着不关的窗口。
  const stopped = new Set<number>();
  for (let pass = 0; pass < 3; pass += 1) {
    const pids = (await findNapcatProcs(cfg)).map((p) => p.pid).filter((pid) => !stopped.has(pid));
    if (pids.length === 0) break;
    await powershell('Stop-Process -Id ' + pids.join(',') + ' -Force -ErrorAction SilentlyContinue');
    for (const pid of pids) stopped.add(pid);
    await new Promise((r) => setTimeout(r, 400));
  }
  writeLaunchRecord(null);
  return { stopped: [...stopped] };
}

export type StartResult = { started: boolean; pid?: number; reason?: string };

/**
 * 起 NapCat：环境变量照抄 D:\Syu\napcat\launch-syu.bat（那边是给双击用的，这里给控制台用）。
 * quickAccount 传了就设 NAPCAT_QUICK_ACCOUNT：NapCat 启动时用本地票据快速登录，不弹二维码（掉线看门狗用）。
 */
export async function startNapcat(cfg: ConsoleConfig, quickAccount?: number): Promise<StartResult> {
  const dir = cfg.napcatDir;
  const launcher = join(dir, 'NapCatWinBootMain.exe');
  const dll = join(dir, 'NapCatWinBootHook.dll');
  for (const p of [launcher, dll, cfg.qqPath, join(dir, 'qqnt.json'), join(dir, 'loadNapCat.js'), join(dir, 'napcat.mjs')]) {
    if (!existsSync(p)) throw new Error('找不到 ' + p);
  }
  const existing = await findNapcatProcs(cfg);
  if (existing.length > 0) {
    return { started: false, reason: 'NapCat 已在运行（pid ' + existing.map((p) => p.pid).join(', ') + '）' };
  }
  ensureLogDir();
  const consoleBat = resolve(ROOT, 'src', 'console', 'napcat-console.bat');
  // 实测三条（2026-11-03，逐条试过）：
  // 1) `start` 直接吃 .bat 会自动套 `cmd /K`，脚本结束也不退 —— 每次重启留一个空壳窗口，这就是多开窗口的来源；
  // 2) `start /b` 不套 /K，但子进程共用父进程的控制台：父进程没有可见控制台时 NapCat 起不来
  //    （napcat.log 只留一句「另一个程序正在使用此文件」，没有 argv/boot 输出）；
  // 3) 显式 `cmd.exe /c <bat>` 且不带 /b（自己的最小化控制台）能正常起，NapCat 退出后 cmd /c 跟着退，窗口不留。
  // 所以固定成：`start "" /min cmd.exe /c <bat> …`。日志由 bat 自己重定向（第 4 个参数），父进程 stdio 给 ignore。
  const child = spawn('cmd.exe', ['/c', 'start', '', '/min', 'cmd.exe', '/c', consoleBat, launcher, cfg.qqPath, dll, NAPCAT_LOG], {
    cwd: dir,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      NAPCAT_PATCH_PACKAGE: join(dir, 'qqnt.json'),
      NAPCAT_LOAD_PATH: join(dir, 'loadNapCat.js'),
      NAPCAT_INJECT_PATH: dll,
      NAPCAT_LAUNCHER_PATH: launcher,
      NAPCAT_MAIN_PATH: join(dir, 'napcat.mjs'),
      // 快速登录：NapCat 读它 + %APPDATA%\QQ\auth\login.enc 的票据，免扫码。
      // 账号没传就不设，行为跟以前完全一样。
      ...(quickAccount !== undefined && Number.isInteger(quickAccount) && quickAccount > 0
        ? { NAPCAT_QUICK_ACCOUNT: String(quickAccount) }
        : {}),
    },
  });
  child.unref();
  if (child.pid !== undefined) writeLaunchRecord({ pid: child.pid, startedAt: Date.now() });
  return { started: true, pid: child.pid };
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type BotRecord = { pid: number; startedAt: number };

function readBotRecord(): BotRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(BOT_RECORD, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const pid = Number((parsed as Record<string, unknown>).pid);
    const startedAt = Number((parsed as Record<string, unknown>).startedAt);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, startedAt: Number.isFinite(startedAt) ? startedAt : 0 };
  } catch {
    return null;
  }
}

function writeBotRecord(rec: BotRecord | null): void {
  ensureLogDir();
  writeFileSync(BOT_RECORD, JSON.stringify(rec) + '\n', 'utf8');
}

export function botInfo(): { running: boolean; pid?: number; logPath: string } {
  const rec = readBotRecord();
  if (rec === null || !alive(rec.pid)) return { running: false, logPath: BOT_LOG };
  return { running: true, pid: rec.pid, logPath: BOT_LOG };
}

/** 起守卫：用当前 node 可执行文件（控制台自己就是被 bat 用便携版 node 起来的） */
export function startBot(): StartResult {
  const cur = botInfo();
  if (cur.running) return { started: false, pid: cur.pid, reason: '守卫已在运行（pid ' + cur.pid + '）' };
  ensureLogDir();
  const fd = openSync(BOT_LOG, 'a');
  const child = spawn(process.execPath, ['src/index.ts'], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  child.unref();
  writeBotRecord({ pid: child.pid ?? 0, startedAt: Date.now() });
  return { started: true, pid: child.pid };
}

/**
 * 停守卫：Windows 上 process.kill 就是 TerminateProcess，SIGTERM 不会跑 shutdown()，
 * 所以 data/state.json 里最后一次预算计数可能丢一拍（下一次 flush 会补）。
 */
export async function stopBot(): Promise<{ stopped: boolean; pid?: number; reason?: string }> {
  const cur = botInfo();
  if (!cur.running || cur.pid === undefined) {
    writeBotRecord(null);
    return { stopped: false, reason: '守卫没在运行' };
  }
  try {
    process.kill(cur.pid);
  } catch {
    /* 已经没了 */
  }
  for (let i = 0; i < 30; i += 1) {
    if (!alive(cur.pid)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (alive(cur.pid)) {
    try {
      process.kill(cur.pid, 'SIGKILL');
    } catch {
      /* 放弃 */
    }
  }
  writeBotRecord(null);
  return { stopped: true, pid: cur.pid };
}

export type QrInfo = { exists: boolean; path: string; mtime: number; ageSec: number; size: number };

export function qrInfo(cfg: ConsoleConfig): QrInfo {
  const path = join(cfg.napcatDir, 'cache', 'qrcode.png');
  try {
    const st = statSync(path);
    return { exists: true, path, mtime: Math.round(st.mtimeMs), ageSec: Math.round((Date.now() - st.mtimeMs) / 1000), size: st.size };
  } catch {
    return { exists: false, path, mtime: 0, ageSec: 0, size: 0 };
  }
}

/** 只读最后 256KB，避免把整份日志读进内存 */
export function tailLog(file: string, lines: number): string[] {
  const cap = Math.max(1, Math.min(500, Math.floor(lines) || 100));
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return [];
  }
  const start = Math.max(0, size - 256 * 1024);
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    const all = text.split(/\r?\n/).filter((l) => l.length > 0);
    return all.slice(Math.max(0, all.length - cap));
  } finally {
    closeSync(fd);
  }
}

export function logPaths(): { napcat: string; bot: string } {
  return { napcat: NAPCAT_LOG, bot: BOT_LOG };
}

export type LoginProbe = { online: boolean; selfId?: number; nickname?: string; error?: string };

/**
 * 短连接探活：开一条 WS 打 get_login_info，拿到就关（3 秒超时）。
 * 不依赖守卫进程，也不跟它抢连接——OneBot 正向 WS 允许并存多个客户端。
 */
export function probeLogin(wsUrl: string, token: string | undefined, timeoutMs = 3000): Promise<LoginProbe> {
  return new Promise<LoginProbe>((finish) => {
    let settled = false;
    const timer = setTimeout(() => done({ online: false, error: '探活超时 ' + timeoutMs + 'ms' }), timeoutMs);
    timer.unref();
    const url = token === undefined || token === ''
      ? wsUrl
      : wsUrl + (wsUrl.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    } catch (err) {
      done({ online: false, error: '连接失败：' + (err as Error).message });
      return;
    }
    function done(result: LoginProbe): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* 已经关了 */
      }
      finish(result);
    }
    ws.on('open', () => {
      ws.send(JSON.stringify({ action: 'get_login_info', echo: 'console-probe' }));
    });
    ws.on('message', (raw) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (data.echo !== 'console-probe') return;
      if (data.status !== 'ok') {
        done({ online: false, error: '协议端返回 ' + String(data.status) + '：' + String(data.message ?? '') });
        return;
      }
      const payload = (data.data ?? {}) as Record<string, unknown>;
      done({
        online: true,
        selfId: Number(payload.user_id) || undefined,
        nickname: typeof payload.nickname === 'string' ? payload.nickname : undefined,
      });
    });
    ws.on('error', (err) => done({ online: false, error: '连不上协议端：' + err.message }));
    ws.on('close', () => done({ online: false, error: '协议端关闭了连接（NapCat 没在跑或没登录）' }));
  });
}
