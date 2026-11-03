import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log.ts';

/** 只保留最近这么多张登录图，更旧的自动删掉 */
export const KEEP = 20;
/** 轮询间隔：NapCat 约 121 秒换一张码（实测 19:46:18 → 19:48:19），5 秒足够跟上 */
export const POLL_MS = 5000;

/** 上一次存档的那张码（按 mtime + size 判重，同一张码不会重复落盘） */
let last: { mtimeMs: number; size: number } | null = null;

/** 本地时间文件名：2026-11-01_20-52-13 */
export function stampName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' + p(d.getMonth() + 1) +
    '-' + p(d.getDate()) +
    '_' + p(d.getHours()) +
    '-' + p(d.getMinutes()) +
    '-' + p(d.getSeconds())
  );
}

/** 删掉最旧的，只留 keep 张（文件名按时间排序 = 按时间先后） */
export function prune(dir: string, keep = KEEP): string[] {
  if (keep <= 0) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.png')).sort();
  } catch {
    return [];
  }
  const extra = names.slice(0, Math.max(0, names.length - keep));
  const removed: string[] = [];
  for (const n of extra) {
    try {
      unlinkSync(join(dir, n));
      removed.push(n);
    } catch (err) {
      log.warn('删除旧登录图失败：' + n + '：' + String(err));
    }
  }
  return removed;
}

/**
 * 把 NapCat 的登录二维码复制一份到 destDir，按本地时间命名。
 * 返回新文件名；没有新码（文件不在 / 还是上次那张）返回 null。
 */
export function archiveQrOnce(src: string, destDir: string, now = new Date(), keep = KEEP): string | null {
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(src);
  } catch {
    return null;
  }
  if (last !== null && last.mtimeMs === st.mtimeMs && last.size === st.size) return null;

  try {
    mkdirSync(destDir, { recursive: true });
  } catch (err) {
    log.error('建登录图目录失败：' + destDir + '：' + String(err));
    return null;
  }

  const base = stampName(now);
  let name = base + '.png';
  let dest = join(destDir, name);
  for (let i = 1; existsSync(dest) && i <= 99; i += 1) {
    name = base + '-' + i + '.png';
    dest = join(destDir, name);
  }

  try {
    copyFileSync(src, dest);
  } catch (err) {
    log.error('存登录图失败：' + dest + '：' + String(err));
    return null;
  }
  last = { mtimeMs: st.mtimeMs, size: st.size };
  log.info('登录图已存：' + dest);
  const removed = prune(destDir, keep);
  if (removed.length > 0) log.info('登录图超上限，删掉最旧 ' + removed.length + ' 张（只留 ' + keep + ' 张）');
  return name;
}

/** 起定时轮询；返回停止函数（控制台退出时进程结束，定时器已 unref 不会拦住退出） */
export function startQrArchive(opts: { src: string; destDir: string; keep?: number; intervalMs?: number }): () => void {
  const keep = opts.keep ?? KEEP;
  const intervalMs = opts.intervalMs ?? POLL_MS;
  const tick = () => {
    try {
      archiveQrOnce(opts.src, opts.destDir, new Date(), keep);
    } catch (err) {
      log.error('登录图轮询出错：' + String(err));
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  log.info('登录图会自动存到：' + opts.destDir + '（每 ' + Math.round(intervalMs / 1000) + ' 秒看一次，只留最近 ' + keep + ' 张）');
  return () => clearInterval(timer);
}
