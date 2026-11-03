/**
 * 仓库根 .env 的读改写：只服务控制台「配置」卡片。
 *
 * 只认 GUARD_GROUP_IDS / OWNER_QQ / GUARD_GROUP_OWNERS 三行，其余行按字节原样带过（注释、空行、
 * 别的键、行的换行风格、文件末尾有没有换行都不动）；写盘先写 .env.tmp 再 rename 覆盖，
 * 中途失败原文件保持原样。
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

/** 群号 / 接收人 QQ 各自的上限 */
export const MAX_IDS = 50;

export interface GuardTargets {
  groupIds: number[];
  ownerQqs: number[];
  /** 按群绑定的 3 级接收人（方案 §14.1）：键是群号，值是该群绑定的 QQ 列表。空对象 = 全部回退全局 */
  groupOwners: Record<number, number[]>;
}

export type IdListResult = { ok: true; ids: number[] } | { ok: false; error: string };

/** 匹配一行赋值：允许前置空白、export 前缀、键两侧空白；值原样留在第 2 个捕获里 */
const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

const EMPTY = Buffer.alloc(0);
const LF = Buffer.from('\n');

/**
 * 把 JSON 里拿到的数组收敛成「去重后的正整数列表」。
 * 也接受纯数字字符串（界面里手抄的群号/QQ 常是字符串），负数、0、小数、别的类型一律非法。
 */
export function parseIdList(input: unknown, label: string): IdListResult {
  if (!Array.isArray(input)) return { ok: false, error: label + '必须是数组' };
  if (input.length === 0) return { ok: false, error: label + '不能为空，至少要填一个' };
  if (input.length > MAX_IDS) {
    return { ok: false, error: label + '最多 ' + MAX_IDS + ' 个，收到 ' + input.length + ' 个' };
  }
  const ids: number[] = [];
  for (const item of input) {
    let value = 0;
    if (typeof item === 'number' && Number.isInteger(item)) {
      value = item;
    } else if (typeof item === 'string' && /^\d+$/.test(item.trim())) {
      value = Number(item.trim());
    } else {
      return { ok: false, error: label + '里每项都得是正整数，收到：' + String(item) };
    }
    if (value <= 0) return { ok: false, error: label + '必须是正整数，收到：' + String(item) };
    if (!ids.includes(value)) ids.push(value);
  }
  return { ok: true, ids };
}

/** 逗号或空白分隔 → 正整数列表（守卫生成的那份配置就是这口径） */
function splitIds(raw: string): number[] {
  const out: number[] = [];
  for (const piece of raw.split(/[,\s]+/)) {
    if (!/^\d+$/.test(piece)) continue;
    const value = Number(piece);
    if (value > 0 && !out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * 解析 GUARD_GROUP_OWNERS 的值（方案 §14.1）：`20001:111,222;20002:333`。
 * 坏条目只跳过该条并继续——读 .env 永不抛错（与 readGuardTargets 同口径）。
 */
function parseGroupOwnersValue(raw: string): Record<number, number[]> {
  const map: Record<number, number[]> = {};
  const text = raw.trim();
  if (text === '') return map;
  for (const entryRaw of text.split(';')) {
    const entry = entryRaw.trim();
    if (entry === '') continue;
    const colon = entry.indexOf(':');
    if (colon <= 0) continue;
    const groupPart = entry.slice(0, colon).trim();
    if (!/^\d+$/.test(groupPart) || Number(groupPart) <= 0) continue;
    const qqs = splitIds(entry.slice(colon + 1));
    if (qqs.length > 0) map[Number(groupPart)] = qqs;
  }
  return map;
}

/** 序列化 GUARD_GROUP_OWNERS 的值：群号升序，`群号:QQ,QQ` 用分号连接；空映射 → 空串 */
function serializeGroupOwners(map: Record<number, number[]>): string {
  const groups = Object.keys(map)
    .map(Number)
    .filter((g) => Number.isFinite(g) && g > 0 && Array.isArray(map[g]) && (map[g] as number[]).length > 0)
    .sort((a, b) => a - b);
  return groups.map((g) => g + ':' + Array.from(new Set(map[g])).join(',')).join(';');
}

export type GroupOwnersResult = { ok: true; map: Record<number, number[]> } | { ok: false; error: string };

/**
 * 校验控制台 POST 上来的按群绑定（方案 §14.4）：
 * 键必须是数字字符串且在 knownGroups（守卫列表）里；值必须是正整数数组（空数组=取消绑定，直接跳过）。
 */
export function parseGroupOwnersInput(input: unknown, knownGroups: number[]): GroupOwnersResult {
  if (input === undefined || input === null) return { ok: true, map: {} };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'groupOwners 必须是对象，形如 { "20001": [111, 222] }' };
  }
  const map: Record<number, number[]> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!/^\d+$/.test(key) || Number(key) <= 0) {
      return { ok: false, error: 'groupOwners 的键必须是正整数群号，收到：' + key };
    }
    const gid = Number(key);
    if (!knownGroups.includes(gid)) {
      return { ok: false, error: '群 ' + gid + ' 还不在守卫列表里，先把它加进 GUARD_GROUP_IDS 再绑定接收人' };
    }
    if (!Array.isArray(value)) {
      return { ok: false, error: '群 ' + gid + ' 的接收人必须是数组（QQ 号列表）' };
    }
    // 空数组 = 取消该群绑定：不进映射，写回时自然消失
    if (value.length === 0) continue;
    const parsed = parseIdList(value, '群 ' + gid + ' 的接收人');
    if (!parsed.ok) return { ok: false, error: parsed.error };
    map[gid] = parsed.ids;
  }
  return { ok: true, map };
}

/** 读 .env：文件不在、键没写，都算空，绝不抛错 */
export function readGuardTargets(envPath: string): GuardTargets {
  let text = '';
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    return { groupIds: [], ownerQqs: [], groupOwners: {} };
  }
  let groupIds: number[] = [];
  let ownerQqs: number[] = [];
  let groupOwnersRaw = '';
  for (const line of text.replace(/^\uFEFF/, '').split('\n')) {
    const matched = KEY_LINE.exec(line.endsWith('\r') ? line.slice(0, -1) : line);
    if (matched === null) continue;
    const value = (matched[2] ?? '').trim();
    if (matched[1] === 'GUARD_GROUP_IDS') groupIds = splitIds(value);
    else if (matched[1] === 'OWNER_QQ') ownerQqs = splitIds(value);
    else if (matched[1] === 'GUARD_GROUP_OWNERS') groupOwnersRaw = value;
  }
  return { groupIds, ownerQqs, groupOwners: parseGroupOwnersValue(groupOwnersRaw) };
}

/** 按 \n 切成段，段里保留原有的 \r；各段用 \n 拼回去和原文件逐字节一致 */
function splitSegments(buf: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0a) {
      parts.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  parts.push(buf.subarray(start));
  return parts;
}

/**
 * 只改 GUARD_GROUP_IDS / OWNER_QQ / GUARD_GROUP_OWNERS 三行，其它行逐字节保留；键不存在就追加在末尾。
 * 非法输入或写盘失败都直接抛错，此时 .env 没被碰过。
 */
export function writeGuardTargets(envPath: string, targets: GuardTargets): void {
  const groups = parseIdList(targets.groupIds, '群号');
  if (!groups.ok) throw new Error(groups.error);
  const owners = parseIdList(targets.ownerQqs, '接收人 QQ');
  if (!owners.ok) throw new Error(owners.error);
  // 绑定的群必须在守卫列表里：控制台校验过，这里再兜一道（手写调用方也能撞上）
  const unknownGroups = Object.keys(targets.groupOwners ?? {})
    .map(Number)
    .filter((g) => Number.isFinite(g) && !groups.ids.includes(g));
  if (unknownGroups.length > 0) {
    throw new Error('GUARD_GROUP_OWNERS 绑定了不在守卫列表里的群：' + unknownGroups.join(', '));
  }

  let original = EMPTY;
  try {
    original = readFileSync(envPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const endNewline = original.length === 0 ? true : original[original.length - 1] === 0x0a;
  const crlf = original.length >= 2 && original[original.length - 1] === 0x0a && original[original.length - 2] === 0x0d;

  const wanted = new Map<string, string>([
    ['GUARD_GROUP_IDS', groups.ids.join(',')],
    ['OWNER_QQ', owners.ids.join(',')],
    // 无绑定时也写空值行：键恒在，其余行保持逐字节不动（方案 §14.1）
    ['GUARD_GROUP_OWNERS', serializeGroupOwners(targets.groupOwners ?? {})],
  ]);
  const segments = original.length === 0 ? [] : splitSegments(original);
  const replaced = new Set<string>();
  for (let i = 0; i < segments.length; i += 1) {
    const line = (segments[i] ?? EMPTY).toString('latin1');
    const hasCr = line.endsWith('\r');
    const matched = KEY_LINE.exec(hasCr ? line.slice(0, -1) : line);
    if (matched === null) continue;
    const key = matched[1] ?? '';
    const value = wanted.get(key);
    if (value === undefined) continue;
    segments[i] = Buffer.from(key + '=' + value + (hasCr ? '\r' : ''), 'utf8');
    replaced.add(key);
  }

  // 缺的键追加到末尾，跟着原文件的换行风格走
  const missing: Buffer[] = [];
  for (const [key, value] of wanted) {
    if (!replaced.has(key)) missing.push(Buffer.from(key + '=' + value + (crlf ? '\r' : ''), 'utf8'));
  }
  if (missing.length > 0) {
    if (segments.length === 0) segments.push(...missing, EMPTY);
    else if (endNewline) segments.splice(segments.length - 1, 0, ...missing);
    else segments.push(...missing);
  }

  const pieces: Buffer[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    if (i > 0) pieces.push(LF);
    pieces.push(segments[i] ?? EMPTY);
  }

  const tmpPath = envPath + '.tmp';
  try {
    writeFileSync(tmpPath, Buffer.concat(pieces));
    renameSync(tmpPath, envPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* tmp 可能根本没建出来 */
    }
    throw err;
  }
}
