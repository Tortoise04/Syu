import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { loadConsoleConfig } from '../config.ts';
import { log, setLogLevel } from '../log.ts';
import { parseGroupOwnersInput, parseIdList, readGuardTargets, writeGuardTargets } from './envFile.ts';
import {
  botInfo,
  findNapcatProcs,
  logPaths,
  probeLogin,
  qrInfo,
  startBot,
  startNapcat,
  stopBot,
  stopNapcat,
  tailLog,
} from './procs.ts';
import { startQrArchive } from './qrArchive.ts';
import { detectQuickAccount, startWatchdog } from './watchdog.ts';

setLogLevel('info');

const cfg = loadConsoleConfig();
if (!cfg.enabled) {
  log.info('console.enabled = false：控制台不启动');
  process.exit(0);
}

// 3002 是本机器人的 NapCat；3001 是服务器上 Dyu 的 NapCat，只探 3002
const wsUrl = (process.env.ONEBOT_WS_URL ?? 'ws://127.0.0.1:3002').trim();
const tokenRaw = (process.env.ONEBOT_TOKEN ?? '').trim();
const token = tokenRaw === '' ? undefined : tokenRaw;
/** 仓库根：config.json / .env / data 都以它为准，跟守卫进程的工作目录一致 */
const repoRoot = join(import.meta.dirname, '..', '..');

/** config.json 路径：默认仓库根；GUARD_CONFIG_PATH 只给验证时指向临时副本 */
const configPath = (process.env.GUARD_CONFIG_PATH ?? '').trim() || join(repoRoot, 'config.json');

/** 读 config.json 原始内容：读不到/解析不了就按空对象走，控制台不能因此起不来 */
function readRawConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    log.warn('[console] 读配置失败（' + configPath + '）：' + (err as Error).message + '，按默认值继续');
    return {};
  }
}

const rawConfig = readRawConfig();
let liveConfig = rawConfig;
const rawActions = rawConfig.actions as Record<string, unknown> | undefined;
const dryRun = rawActions?.dryRun !== false;

/** 判定/发出记录的目录：config.json 的 dataDir，相对路径按仓库根解析 */
const dataDir = (() => {
  const raw = typeof rawConfig.dataDir === 'string' ? rawConfig.dataDir.trim() : '';
  const dir = raw === '' ? './data' : raw;
  return isAbsolute(dir) ? dir : resolve(repoRoot, dir);
})();

/** .env 路径：默认就是仓库根的 .env；SYU_ENV_PATH 只给验证时指向临时副本 */
const envPath = (process.env.SYU_ENV_PATH ?? '').trim() || join(repoRoot, '.env');

const uiHtml = readFileSync(join(import.meta.dirname, 'ui.html'), 'utf8');
const startedAt = Date.now();

/** 掉线看门狗：server.listen 回调里启动；buildState 只读它的状态 */
let watchdog: ReturnType<typeof startWatchdog> | null = null;

/** 告警收件人现取：.env 的 OWNER_QQ ∪ config.json 的 notify.adminQqs（页面改了立刻生效，不用重启） */
function alertTargets(): number[] {
  const out: number[] = [];
  try {
    for (const qq of readGuardTargets(envPath).ownerQqs) if (!out.includes(qq)) out.push(qq);
  } catch {
    /* .env 读不到就只靠 config.json */
  }
  try {
    const notify = readRawConfig().notify as Record<string, unknown> | undefined;
    const admins = notify?.adminQqs;
    if (Array.isArray(admins)) {
      for (const raw of admins) {
        const qq = typeof raw === 'number' ? raw : Number(raw);
        if (Number.isInteger(qq) && qq > 0 && !out.includes(qq)) out.push(qq);
      }
    }
  } catch {
    /* config.json 读不到就只靠 .env */
  }
  return out.slice(0, 5);
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function sendText(res: ServerResponse, code: number, text: string): void {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

async function buildState(): Promise<Record<string, unknown>> {
  const procs = await findNapcatProcs(cfg).catch(() => []);
  const login = procs.length === 0
    ? { online: false, error: 'NapCat 进程不在（先点「启动 NapCat」）' }
    : await probeLogin(wsUrl, token);
  const bot = botInfo();
  return {
    now: Date.now(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    console: { pid: process.pid, host: cfg.host, port: cfg.port },
    napcat: { running: procs.length > 0, pids: procs.map((p) => p.pid), logPath: logPaths().napcat },
    bot: { running: bot.running, pid: bot.pid, logPath: bot.logPath, dryRun },
    login: { online: login.online, selfId: login.selfId, nickname: login.nickname, probeError: login.error, wsUrl },
    qr: qrInfo(cfg),
    onebot: { wsUrl },
    watchdog: watchdog === null ? null : watchdog.status(),
  };
}

/** sent.jsonl 一行：守卫实际发出去的每条消息（群里 @ 一次、私聊一次就各算一条） */
interface SentItem {
  to: number;
  scope: string;
  text: string;
  ok: boolean;
}

/** 控制台「消息」视图的一行：判定记录 + 它实际发出去的内容；sent.jsonl 单独成行时 mine=true */
interface MessageItem {
  ts: string;
  groupId: number;
  userId: number | null;
  nickname: string;
  messageId: number;
  text: string;
  rule: string | null;
  /** 粗筛当时猜的条款（只在没进终审的记录里写），见 src/guard/types.ts:147 */
  hintRule: string | null;
  severity: number;
  confidence: number | null;
  /** 终审理由全文（行展开时显示） */
  reason: string | null;
  /** 送审通道：keyword/link/screen/report/sample；机器人气泡为 private/self */
  channel: string;
  /** 命中的关键词 */
  keywords: string[];
  action: string;
  sent: SentItem[];
  /** 是否机器人自己发出的（sent.jsonl 单独成行） */
  mine: boolean;
  /** 是否已送云端终审（推导依据见 isCloudRecord） */
  cloud: boolean;
  /** groupId=0 的私聊项额外带收件人与类型 */
  to?: string;
  kind?: string;
}

/** 读 jsonl：文件不在、某行坏了都只跳过，不抛错 */
function readJsonl(file: string): unknown[] {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      out.push(JSON.parse(trimmed) as unknown);
    } catch {
      /* 断电写了半行之类：跳过这行，别让整页挂掉 */
    }
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** 本地日期字符串（与 state.json 的 date 同口径），用于「当天」过滤 */
function todayLocalDate(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/**
 * 「已送云端终审」的推导（证据见 src/guard/pipeline.ts）：
 * - runJudge 是唯一会调云端 judge 的路径：keyword/link 必判（542）、report 必判（757）、
 *   抽中送云的 gated/screen/sample（567/662/690/698）。
 * - budgetOut 的 reason 一律以「预算耗尽」开头（pipeline.ts:339），flatResult 的 recordOnly
 *   分支 reason 固定是「允许的群内交易词，只记录」（pipeline.ts:603），这两类都没进云端。
 * - 抽签通道进云端的记录 sampled 必为 true（runJudge 只在 draw.sampled 为 true 时被调用）。
 */
function isCloudRecord(rec: Record<string, unknown>): boolean {
  const reason = str(rec.reason, '');
  if (reason.startsWith('预算耗尽')) return false;
  if (reason === '允许的群内交易词，只记录') return false;
  const channel = str(rec.channel, '');
  if (channel === 'report') return true;
  if (rec.sampled === true) return true;
  return channel === 'keyword' || channel === 'link';
}

/** 每群今日已用预算：口径与 #test status 一致（src/guard/selftest.ts:143-151，src/state.ts:153-164） */
function readGroupUsedToday(): Record<string, number> {
  const out: Record<string, number> = {};
  let groups: number[] = [];
  try {
    groups = readGuardTargets(envPath).groupIds;
  } catch {
    groups = [];
  }
  for (const gid of groups) out[String(gid)] = 0;
  let text = '';
  try {
    text = readFileSync(join(dataDir, 'state.json'), 'utf8');
  } catch {
    return out;
  }
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return out;
  }
  if (str(state.date, '') !== todayLocalDate()) return out;
  const budget = asRecord(state.budget) ?? {};
  const perGroup = asRecord(budget.perGroup) ?? {};
  for (const gid of groups) {
    const value = perGroup[String(gid)];
    out[String(gid)] = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  }
  return out;
}

/** sent.jsonl → 按 messageId 归并的发送明细（全量口径，向后兼容用） */
function sentByMessageMap(): Map<number, SentItem[]> {
  const sentByMessage = new Map<number, SentItem[]>();
  for (const raw of readJsonl(join(dataDir, 'sent.jsonl'))) {
    const rec = asRecord(raw);
    if (rec === undefined || typeof rec.messageId !== 'number') continue;
    const list = sentByMessage.get(rec.messageId) ?? [];
    list.push({ to: num(rec.to, 0), scope: str(rec.scope, ''), text: str(rec.text, ''), ok: rec.ok === true });
    sentByMessage.set(rec.messageId, list);
  }
  return sentByMessage;
}

/** violations.jsonl 一行 → 消息项 */
function violationToItem(rec: Record<string, unknown>, sentByMessage: Map<number, SentItem[]>): MessageItem {
  const messageId = num(rec.messageId, 0);
  const keywordsRaw = rec.keywords;
  return {
    ts: str(rec.ts, ''),
    groupId: num(rec.groupId, 0),
    userId: num(rec.userId, 0),
    nickname: str(rec.nickname, ''),
    messageId,
    text: str(rec.text, ''),
    rule: str(rec.rule, 'OTHER'),
    hintRule: typeof rec.hintRule === 'string' ? rec.hintRule : null,
    severity: num(rec.severity, 0),
    confidence: num(rec.confidence, 0),
    reason: str(rec.reason, ''),
    channel: str(rec.channel, ''),
    keywords: Array.isArray(keywordsRaw) ? keywordsRaw.filter((k) => typeof k === 'string') : [],
    action: str(rec.action, 'none'),
    sent: sentByMessage.get(messageId) ?? [],
    mine: false,
    cloud: isCloudRecord(rec),
  };
}

/** sent.jsonl 一行 → 机器人气泡：mine=true，不进判定流 */
function sentToItem(rec: Record<string, unknown>): MessageItem {
  const groupId = num(rec.groupId, 0);
  const to = num(rec.to, 0);
  const scope = str(rec.scope, '');
  const item: MessageItem = {
    ts: str(rec.ts, ''),
    groupId,
    userId: null,
    nickname: '机器人',
    messageId: num(rec.messageId, 0),
    text: str(rec.text, ''),
    rule: null,
    hintRule: null,
    severity: 0,
    confidence: null,
    reason: null,
    channel: groupId === 0 ? 'private' : 'self',
    keywords: [],
    action: str(rec.kind, ''),
    sent: [{ to, scope, text: str(rec.text, ''), ok: rec.ok === true }],
    mine: true,
    cloud: false,
  };
  if (groupId === 0) {
    item.to = String(to);
    item.kind = str(rec.kind, '');
  }
  return item;
}

/**
 * 收发出记录：violations.jsonl 的判定 + sent.jsonl 里实际发出的内容，按 messageId 合并。
 * 字段口径见 src/guard/types.ts 的 ViolationRecord；sent.jsonl 还没有就一律空数组。
 * 不传 groupId 时保持全量倒序（向后兼容）。
 */
function buildMessages(limit: number): MessageItem[] {
  const sentByMessage = sentByMessageMap();
  const records: Record<string, unknown>[] = [];
  for (const raw of readJsonl(join(dataDir, 'violations.jsonl'))) {
    const rec = asRecord(raw);
    if (rec === undefined || typeof rec.messageId !== 'number') continue;
    records.push(rec);
  }
  return records.slice(-limit).reverse().map((rec) => violationToItem(rec, sentByMessage));
}

/** groupId=N>0：当天该群 violations + sent(scope=group)，合并后按 ts 倒序，limit 在合并后应用 */
function buildGroupMessages(groupId: number, limit: number): MessageItem[] {
  const today = todayLocalDate();
  const sentByMessage = sentByMessageMap();
  const items: MessageItem[] = [];
  for (const raw of readJsonl(join(dataDir, 'violations.jsonl'))) {
    const rec = asRecord(raw);
    if (rec === undefined || typeof rec.messageId !== 'number') continue;
    if (num(rec.groupId, 0) !== groupId || !str(rec.ts, '').startsWith(today)) continue;
    items.push(violationToItem(rec, sentByMessage));
  }
  for (const raw of readJsonl(join(dataDir, 'sent.jsonl'))) {
    const rec = asRecord(raw);
    if (rec === undefined) continue;
    if (num(rec.groupId, 0) !== groupId || str(rec.scope, '') !== 'group') continue;
    if (!str(rec.ts, '').startsWith(today)) continue;
    items.push(sentToItem(rec));
  }
  items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return items.slice(0, limit);
}

/** groupId=0：私聊会话，只取 sent.jsonl 里 groupId=0 的项（#test 回执 / 收件箱回执 / 通知） */
function buildPrivateMessages(limit: number): MessageItem[] {
  const items: MessageItem[] = [];
  for (const raw of readJsonl(join(dataDir, 'sent.jsonl'))) {
    const rec = asRecord(raw);
    if (rec === undefined) continue;
    if (num(rec.groupId, 0) !== 0) continue;
    items.push(sentToItem(rec));
  }
  items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return items.slice(0, limit);
}

/**
 * 统一收发流（控制台单页化）：收到（violations）+ 发出（sent.jsonl 全部，含私聊）按 ts 升序取最近 limit 条。
 * type 区分方向：recv 走左侧气泡，sent 走右侧气泡。旧 /api/messages 的按会话口径保持不变。
 */
/** 会话键：群 = group:<群号>；私聊 = dm:<QQ>。收到的消息归群，发出的私聊归 dm。 */
function convKeyOf(item: Record<string, unknown>): string {
  if (String(item.type) === 'recv') {
    const gid = num(item.groupId, 0);
    return gid > 0 ? 'group:' + gid : 'dm:' + num(item.userId, 0);
  }
  const isPrivate = String(item.scope) === 'private' || num(item.groupId, 0) === 0;
  return isPrivate ? 'dm:' + (str(item.to, '') || '0') : 'group:' + num(item.groupId, 0);
}

/** 收（violations）+ 发（sent.jsonl 全部）合并成一条时间流，按 ts 升序。 */
function collectFeedItems(): Record<string, unknown>[] {
  const sentByMessage = sentByMessageMap();
  const items: Record<string, unknown>[] = [];
  for (const raw of readJsonl(join(dataDir, 'violations.jsonl'))) {
    const rec = asRecord(raw);
    if (rec === undefined || typeof rec.messageId !== 'number') continue;
    items.push({ type: 'recv', ...violationToItem(rec, sentByMessage) });
  }
  for (const raw of readJsonl(join(dataDir, 'sent.jsonl'))) {
    const rec = asRecord(raw);
    if (rec === undefined) continue;
    items.push({ type: 'sent', ...sentToItem(rec) });
  }
  items.sort((a, b) => (String(a.ts) < String(b.ts) ? -1 : String(a.ts) > String(b.ts) ? 1 : 0));
  return items;
}

/** conv = all 取全量；group:<id> / dm:<qq> 取单个会话。先过滤再取最近 limit 条。 */
function buildFeed(limit: number, conv = 'all'): Record<string, unknown>[] {
  const items = collectFeedItems();
  const picked = conv === 'all' ? items : items.filter((it) => convKeyOf(it) === conv);
  return picked.slice(-limit);
}

const CONV_RE = /^(group|dm):\d+$/;

/** 会话列表：每个群 / 每个私聊对象一条，带条数与最后一条时间，按最后时间倒序。 */
function buildConversations(): Record<string, unknown>[] {
  const map = new Map<string, { key: string; count: number; lastTs: string; lastText: string }>();
  for (const it of collectFeedItems()) {
    const key = convKeyOf(it);
    const ts = str(it.ts, '');
    const text = (String(it.type) === 'recv' ? '收到：' : '发出：') + str(it.text, '');
    const hit = map.get(key);
    if (hit === undefined) {
      map.set(key, { key, count: 1, lastTs: ts, lastText: text });
    } else {
      hit.count += 1;
      if (ts >= hit.lastTs) { hit.lastTs = ts; hit.lastText = text; }
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const { key, count, lastTs, lastText } of map.values()) {
    const [kind, rawId] = key.split(':');
    const id = Number(rawId);
    out.push({
      key, kind, id, count, lastTs, lastText,
      title: kind === 'group' ? '群 ' + id : '私聊 QQ ' + id,
    });
  }
  out.sort((a, b) => (String(a.lastTs) < String(b.lastTs) ? 1 : String(a.lastTs) > String(b.lastTs) ? -1 : 0));
  return out;
}

/**
 * 参数概览（方案 §14.3）：config.json 的只读摘要，分组返回给「参数」页签。
 * 铁律：不出任何密钥（.env 的值一概不碰）；config.json 本来就没有密钥，这里再白名单式挑字段。
 */
function buildParamsSummary(): Record<string, unknown> {
  const guard = asRecord(liveConfig.guard) ?? {};
  const keywords = asRecord(guard.keywords) ?? {};
  const rules = asRecord(keywords.rules) ?? {};
  const ruleCounts: Record<string, number> = {};
  for (const [ruleId, words] of Object.entries(rules)) {
    ruleCounts[ruleId] = Array.isArray(words) ? words.length : 0;
  }
  const recordOnly = keywords.recordOnly;
  const thresholds = asRecord(guard.thresholds) ?? {};
  const budget = asRecord(guard.budget) ?? {};
  const linkWhitelist = guard.linkWhitelist;
  const whitelist = guard.whitelist;
  return {
    thresholds: {
      redline: num(thresholds.redline, 0.6),
      normal: num(thresholds.normal, 0.75),
      remind: num(thresholds.remind, 0.6),
    },
    budget: {
      daily: num(budget.daily, 500),
      perGroup: num(budget.perGroup, 100),
      groupDaily: ((): Record<string, number> => {
        const out: Record<string, number> = {};
        const gd = asRecord(budget.groupDaily) ?? {};
        for (const [key, value] of Object.entries(gd)) {
          if (typeof value === 'number' && Number.isInteger(value) && value > 0) out[key] = value;
        }
        return out;
      })(),
      groupUsedToday: readGroupUsedToday(),
    },
    keywords: {
      redlineCount: Array.isArray(keywords.redline) ? keywords.redline.length : 0,
      ruleCounts,
      recordOnlyCount: Array.isArray(recordOnly) ? recordOnly.length : 0,
    },
    linkWhitelist: Array.isArray(linkWhitelist) ? linkWhitelist.filter((d) => typeof d === 'string') : [],
    whitelist: Array.isArray(whitelist)
      ? [...new Set(whitelist.filter((q) => typeof q === 'number' && Number.isInteger(q) && q > 0))]
      : [],
    screen: ((): Record<string, unknown> => {
      const s = asRecord(liveConfig.screen) ?? {};
      return {
        model: str(s.model, '（未配置）'),
        enabled: s.enabled === true,
        timeoutMs: num(s.timeoutMs, 8000),
      };
    })(),
    judge: ((): Record<string, unknown> => {
      const j = asRecord(liveConfig.judge) ?? {};
      const sample = asRecord(j.sample);
      return {
        model: str(j.model, '（未配置）'),
        maxTokens: num(j.maxTokens, 512),
        timeoutMs: num(j.timeoutMs, 20000),
        sample: sample === undefined ? null : {
          suspicious: num(sample.suspicious, 0),
          clean: num(sample.clean, 0),
          unknown: num(sample.unknown, 0),
        },
      };
    })(),
    actions: ((): Record<string, unknown> => {
      const a = asRecord(liveConfig.actions) ?? {};
      return {
        dryRun: a.dryRun !== false,
        groupSilent: a.groupSilent === true,
        muteEnabled: a.muteEnabled === true,
        cooldownMs: num(a.cooldownMs, 300000),
        actionDailyCap: num(a.actionDailyCap, 40),
      };
    })(),
    collect: ((): Record<string, unknown> => {
      const c = asRecord(liveConfig.collect) ?? {};
      return { enabled: c.enabled === true };
    })(),
    notify: ((): Record<string, unknown> => {
      const n = asRecord(liveConfig.notify) ?? {};
      const groupRecipients = asRecord(n.groupRecipients) ?? {};
      const cleanedGroup: Record<string, number[]> = {};
      for (const [gid, list] of Object.entries(groupRecipients)) {
        if (!Array.isArray(list)) continue;
        cleanedGroup[gid] = list.filter((q): q is number => typeof q === 'number' && q > 0);
      }
      return {
        enabled: n.enabled !== false,
        adminQqs: Array.isArray(n.adminQqs) ? n.adminQqs.filter((q) => typeof q === 'number') : [],
        recipients: Array.isArray(n.recipients) ? n.recipients.filter((q) => typeof q === 'number') : [],
        groupRecipients: cleanedGroup,
      };
    })(),
  };
}

/**
 * 写回 config.json 的可调参数（白名单式）：只覆盖 thresholds / actions（dryRun、groupSilent、
 * muteEnabled、cooldownMs、actionDailyCap）/ notify.enabled / notify.adminQqs / notify.recipients /
 * notify.groupRecipients（整段替换）/ budget（daily、perGroup、groupDaily）/ whitelist / linkWhitelist
 * 这几个字段，其余字段（keywords / rulesText / screen / judge / console / dataDir / collect / inbox / caps）原样保留。
 * budget.groupDaily 合并语义：以现有 groupDaily 为底，只应用请求里出现的键；值为正整数则写入，
 * 为 null 则删除该键；非法条目跳过并记入 skipped。
 * whitelist / linkWhitelist 都是整表替换：先过滤非法项（记入 skipped），空数组 = 清空名单。
 * 原子写：先写 .tmp 再 rename；中途失败 config.json 不被碰。
 */
function writeConfigParams(updates: Record<string, unknown>): { ok: true; skipped: string[] } | { ok: false; error: string } {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    return { ok: false, error: '读 config.json 失败：' + (err as Error).message };
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'config.json 不是合法 JSON，无法写回' };
  }

  const skipped: string[] = [];
  const guard = asRecord(obj.guard) ?? {};
  const ut = asRecord(updates.thresholds);
  if (ut !== undefined) {
    const cur = asRecord(guard.thresholds) ?? {};
    if (typeof ut.redline === 'number' && ut.redline >= 0 && ut.redline <= 1) cur.redline = ut.redline;
    if (typeof ut.normal === 'number' && ut.normal >= 0 && ut.normal <= 1) cur.normal = ut.normal;
    if (typeof ut.remind === 'number' && ut.remind >= 0 && ut.remind <= 1) cur.remind = ut.remind;
    guard.thresholds = cur;
  }
  const uw = updates.whitelist;
  if (Array.isArray(uw)) {
    const out: number[] = [];
    for (const rawItem of uw) {
      if (typeof rawItem !== 'number' || !Number.isInteger(rawItem) || rawItem <= 0) {
        skipped.push('whitelist 里有不是 QQ 号的项：' + JSON.stringify(rawItem) + '，已跳过');
        continue;
      }
      if (!out.includes(rawItem)) out.push(rawItem);
    }
    guard.whitelist = out;
  }
  const ul = updates.linkWhitelist;
  if (Array.isArray(ul)) {
    const out: string[] = [];
    for (const rawItem of ul) {
      if (typeof rawItem !== 'string' || rawItem.trim() === '') {
        skipped.push('linkWhitelist 里有非空字符串以外的项：' + JSON.stringify(rawItem) + '，已跳过');
        continue;
      }
      const domain = rawItem.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!domain.includes('.')) {
        skipped.push('linkWhitelist 里的「' + rawItem + '」不像域名，已跳过');
        continue;
      }
      if (!out.includes(domain)) out.push(domain);
    }
    guard.linkWhitelist = out;
  }
  const ub = asRecord(updates.budget);
  if (ub !== undefined) {
    const cur = asRecord(guard.budget) ?? {};
    if (typeof ub.daily === 'number' && Number.isInteger(ub.daily) && ub.daily > 0) cur.daily = ub.daily;
    if (typeof ub.perGroup === 'number' && Number.isInteger(ub.perGroup) && ub.perGroup > 0) cur.perGroup = ub.perGroup;
    const ugd = ub.groupDaily;
    if (ugd !== undefined) {
      const curGd = asRecord(cur.groupDaily) ?? {};
      if (ugd !== null && typeof ugd === 'object' && !Array.isArray(ugd)) {
        for (const [key, value] of Object.entries(ugd as Record<string, unknown>)) {
          if (!/^\d+$/.test(key)) {
            skipped.push('budget.groupDaily.' + key + ' 键不是数字群号，已跳过');
            continue;
          }
          if (value === null) {
            delete curGd[key];
            continue;
          }
          if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
            curGd[key] = value;
            continue;
          }
          skipped.push('budget.groupDaily.' + key + ' 值必须是正整数或 null，已跳过');
        }
        cur.groupDaily = curGd;
      } else {
        skipped.push('budget.groupDaily 必须是对象（群号 → 正整数或 null），已跳过');
      }
    }
    guard.budget = cur;
  }
  obj.guard = guard;

  const ua = asRecord(updates.actions);
  if (ua !== undefined) {
    const cur = asRecord(obj.actions) ?? {};
    if (typeof ua.dryRun === 'boolean') cur.dryRun = ua.dryRun;
    if (typeof ua.groupSilent === 'boolean') cur.groupSilent = ua.groupSilent;
    if (typeof ua.muteEnabled === 'boolean') cur.muteEnabled = ua.muteEnabled;
    if (typeof ua.cooldownMs === 'number' && Number.isInteger(ua.cooldownMs) && ua.cooldownMs >= 1000) cur.cooldownMs = ua.cooldownMs;
    if (typeof ua.actionDailyCap === 'number' && Number.isInteger(ua.actionDailyCap) && ua.actionDailyCap > 0) cur.actionDailyCap = ua.actionDailyCap;
    obj.actions = cur;
  }

  const un = asRecord(updates.notify);
  if (un !== undefined) {
    const cur = asRecord(obj.notify) ?? {};
    if (typeof un.enabled === 'boolean') cur.enabled = un.enabled;
    if (Array.isArray(un.adminQqs) && un.adminQqs.every((q) => typeof q === 'number' && q > 0)) cur.adminQqs = un.adminQqs;
    if (Array.isArray(un.recipients) && un.recipients.every((q) => typeof q === 'number' && q > 0)) cur.recipients = un.recipients;
    const ug = asRecord(un.groupRecipients);
    if (ug !== undefined) {
      const cleaned: Record<string, number[]> = {};
      for (const [gid, list] of Object.entries(ug)) {
        if (!/^\d+$/.test(gid) || Number(gid) <= 0) {
          skipped.push(`notify.groupRecipients 的群号「${gid}」不是正整数，已跳过`);
          continue;
        }
        if (!Array.isArray(list) || !list.every((q) => typeof q === 'number' && Number.isInteger(q) && q > 0)) {
          skipped.push(`notify.groupRecipients["${gid}"] 必须是正整数数组，已跳过`);
          continue;
        }
        if (list.length > 0) cleaned[gid] = list;
      }
      cur.groupRecipients = cleaned;
    }
    obj.notify = cur;
  }

  const tmp = configPath + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    renameSync(tmp, configPath);
  } catch (err) {
    return { ok: false, error: '写 config.json 失败：' + (err as Error).message };
  }
  // 写成功后刷新内存副本，让后续 buildParamsSummary 返回新值
  liveConfig = obj;
  return { ok: true, skipped };
}

/** 键排序后的稳定 JSON，用来判断某段配置是否真的变了（键顺序不同不算变化） */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map((x) => stableJson(x)).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableJson(o[k])).join(',') + '}';
  }
  return JSON.stringify(v) ?? 'null';
}

/** 读请求体，超上限直接断开：配置只可能是一小段 JSON */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise<string>((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        fail(new Error('请求体超过 ' + maxBytes + ' 字节'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err: Error) => fail(err));
  });
}

let busy = '';

async function runAction(name: string, fn: () => Promise<unknown> | unknown): Promise<{ code: number; body: unknown }> {
  if (busy !== '') return { code: 409, body: { ok: false, error: '上一个动作还没做完：' + busy } };
  busy = name;
  const t0 = Date.now();
  try {
    const result = await fn();
    log.info('[console] ' + name + ' 完成（' + (Date.now() - t0) + 'ms）');
    return { code: 200, body: { ok: true, action: name, result } };
  } catch (err) {
    log.error('[console] ' + name + ' 失败：' + (err as Error).message);
    return { code: 500, body: { ok: false, action: name, error: (err as Error).message } };
  } finally {
    busy = '';
  }
}

const server = createServer((req, res) => {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;

  if (!isLoopback(req)) {
    sendText(res, 403, '只允许本机访问');
    return;
  }

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(uiHtml);
    return;
  }

  if (method === 'GET' && path === '/api/state') {
    buildState().then(
      (state) => sendJson(res, 200, state),
      (err: Error) => sendJson(res, 500, { ok: false, error: err.message }),
    );
    return;
  }

  if (method === 'GET' && path === '/api/groups') {
    try {
      const targets = readGuardTargets(envPath);
      const today = todayLocalDate();
      const buckets: Record<string, { total: number; suspicious: number }> = {};
      for (const gid of targets.groupIds) buckets[String(gid)] = { total: 0, suspicious: 0 };
      for (const raw of readJsonl(join(dataDir, 'violations.jsonl'))) {
        const rec = asRecord(raw);
        if (rec === undefined || !str(rec.ts, '').startsWith(today)) continue;
        const bucket = buckets[String(num(rec.groupId, -1))];
        if (bucket === undefined) continue;
        bucket.total += 1;
        if (num(rec.severity, 0) >= 1) bucket.suspicious += 1;
      }
      sendJson(res, 200, {
        ok: true,
        groups: targets.groupIds.map((groupId) => ({
          groupId,
          todayCount: buckets[String(groupId)]?.total ?? 0,
          suspiciousCount: buckets[String(groupId)]?.suspicious ?? 0,
          hasNotifyBinding: Object.prototype.hasOwnProperty.call(targets.groupOwners, groupId),
        })),
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: '读群列表失败：' + (err as Error).message });
    }
    return;
  }

  if (method === 'GET' && path === '/api/config') {
    const targets = readGuardTargets(envPath);
    // 只回这几个字段：.env 里别的值（DEEPSEEK_API_KEY 之类）一律不出这个门
    sendJson(res, 200, {
      ok: true,
      config: { groupIds: targets.groupIds, ownerQqs: targets.ownerQqs, groupOwners: targets.groupOwners, dryRun },
    });
    return;
  }

  if (method === 'GET' && path === '/api/params') {
    // config.json 的只读概览（方案 §14.3）：白名单式挑字段，无密钥；读不到就按默认值口径给摘要
    sendJson(res, 200, { ok: true, params: buildParamsSummary() });
    return;
  }

  if (method === 'POST' && path === '/api/params') {
    if (req.headers['x-syu-console'] !== '1') {
      sendJson(res, 403, { ok: false, error: '缺少 x-syu-console 头' });
      return;
    }
    readBody(req, 8192).then(
      (text) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
          return;
        }
        const body = asRecord(parsed) ?? {};
        const budgetBefore = stableJson(asRecord((asRecord(liveConfig.guard) ?? {}).budget) ?? null);
        const result = writeConfigParams(body);
        if (!result.ok) {
          log.error('[console] 写 config.json 失败：' + result.error);
          sendJson(res, 400, { ok: false, error: result.error });
          return;
        }
        // 写成功后重新读一次，让前端拿到最新值
        const fresh = buildParamsSummary();
        if (result.skipped.length > 0) {
          log.warn('[console] 参数写回有 ' + result.skipped.length + ' 项被跳过：' + result.skipped.join('；'));
        }
        // 预算（daily/perGroup/groupDaily）在 StateStore 启动时一次性绑定（src/index.ts:44-49），
        // reloadConfig 不重建也不更新 store 预算，所以预算改动必须重启守卫进程才生效；
        // 其余字段（阈值/动作/通知/白名单）走 reloadConfig 热更。
        const needsRestart = stableJson(asRecord((asRecord(liveConfig.guard) ?? {}).budget) ?? null) !== budgetBefore;
        log.info('[console] 参数已写回 config.json' + (needsRestart ? '（预算改动需重启守卫生效）' : '（热更字段，无需重启）'));
        sendJson(res, 200, { ok: true, needsRestart, skipped: result.skipped, params: fresh });
      },
      (err) => sendJson(res, 400, { ok: false, error: (err as Error).message }),
    );
    return;
  }

  if (method === 'GET' && path === '/api/messages') {
    const asked = Number(url.searchParams.get('limit') ?? '100');
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 300) : 100;
    try {
      const groupParam = url.searchParams.get('groupId');
      if (groupParam === null || groupParam.trim() === '') {
        sendJson(res, 200, { ok: true, items: buildMessages(limit) });
      } else {
        const rawGroup = groupParam.trim();
        if (!/^\d+$/.test(rawGroup)) {
          sendJson(res, 400, { ok: false, error: 'groupId 只能是 0 或正整数' });
          return;
        }
        const groupId = Number(rawGroup);
        const items = groupId === 0 ? buildPrivateMessages(limit) : buildGroupMessages(groupId, limit);
        sendJson(res, 200, { ok: true, items });
      }
    } catch (err) {
      sendJson(res, 500, { ok: false, error: '读收发记录失败：' + (err as Error).message });
    }
    return;
  }

  if (method === 'GET' && path === '/api/conversations') {
    try {
      sendJson(res, 200, { ok: true, items: buildConversations() });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: '读会话列表失败：' + (err as Error).message });
    }
    return;
  }

  if (method === 'GET' && path === '/api/feed') {
    const asked = Number(url.searchParams.get('limit') ?? '200');
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 500) : 200;
    const conv = ((url.searchParams.get('conv') ?? 'all').trim()) || 'all';
    if (conv !== 'all' && !CONV_RE.test(conv)) {
      sendJson(res, 400, { ok: false, error: 'conv 只能是 all、group:<群号> 或 dm:<QQ>' });
      return;
    }
    try {
      sendJson(res, 200, { ok: true, items: buildFeed(limit, conv) });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: '读收发流失败：' + (err as Error).message });
    }
    return;
  }

  if (method === 'GET' && path === '/api/qrcode') {
    const info = qrInfo(cfg);
    if (!info.exists) {
      sendText(res, 404, '还没有二维码：' + info.path);
      return;
    }
    try {
      const png = readFileSync(info.path);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-qr-mtime': String(info.mtime) });
      res.end(png);
    } catch (err) {
      sendText(res, 500, '读二维码失败：' + (err as Error).message);
    }
    return;
  }

  if (method === 'GET' && path === '/api/logs') {
    const which = url.searchParams.get('which') ?? 'bot';
    if (which !== 'bot' && which !== 'napcat') {
      sendJson(res, 400, { ok: false, error: 'which 只能是 bot 或 napcat' });
      return;
    }
    const lines = Number(url.searchParams.get('lines') ?? '100');
    const paths = logPaths();
    sendJson(res, 200, { ok: true, which, lines: tailLog(which === 'bot' ? paths.bot : paths.napcat, Number.isFinite(lines) ? lines : 100) });
    return;
  }

  if (method === 'POST' && path === '/api/config') {
    if (req.headers['x-syu-console'] !== '1') {
      sendJson(res, 403, { ok: false, error: '缺少 x-syu-console 头' });
      return;
    }
    readBody(req, 8192).then(
      (text) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
          return;
        }
        const body = asRecord(parsed) ?? {};
        const groups = parseIdList(body.groupIds, '群号');
        if (!groups.ok) {
          sendJson(res, 400, { ok: false, error: groups.error });
          return;
        }
        const owners = parseIdList(body.ownerQqs, '接收人 QQ');
        if (!owners.ok) {
          sendJson(res, 400, { ok: false, error: owners.error });
          return;
        }
        // 按群绑定（方案 §14.4）：键必须已经在 groupIds 里；没传这个键 = 维持现状，传了（含空对象）= 全量覆盖
        const ownersInput = 'groupOwners' in body ? body.groupOwners : undefined;
        const current = readGuardTargets(envPath);
        const groupOwnersResult = parseGroupOwnersInput(
          ownersInput === undefined ? current.groupOwners : ownersInput,
          groups.ids,
        );
        if (!groupOwnersResult.ok) {
          sendJson(res, 400, { ok: false, error: groupOwnersResult.error });
          return;
        }
        try {
          writeGuardTargets(envPath, { groupIds: groups.ids, ownerQqs: owners.ids, groupOwners: groupOwnersResult.map });
        } catch (err) {
          log.error('[console] 写 .env 失败：' + (err as Error).message);
          sendJson(res, 500, { ok: false, error: '写 .env 失败：' + (err as Error).message });
          return;
        }
        const boundCount = Object.keys(groupOwnersResult.map).length;
        log.info(
          '[console] 群号与接收人已写回 .env：群 ' + groups.ids.join(',') + '；接收人 ' + owners.ids.join(',')
            + '；' + boundCount + ' 个群有定向接收人',
        );
        // GUARD_GROUP_IDS / OWNER_QQ / GUARD_GROUP_OWNERS 都走热加载（src/index.ts:187-194,218），无需重启
        sendJson(res, 200, { ok: true, needsRestart: false });
      },
      (err: Error) => sendJson(res, 400, { ok: false, error: '读请求体失败：' + err.message }),
    );
    return;
  }

  if (method === 'POST' && path.startsWith('/api/')) {
    if (req.headers['x-syu-console'] !== '1') {
      sendJson(res, 403, { ok: false, error: '缺少 x-syu-console 头' });
      return;
    }
    const action = path.slice('/api/'.length);
    const jobs: Record<string, () => Promise<unknown> | unknown> = {
      // 手动启动也带快速登录账号：票据在就直接回线，票据没了才弹二维码（跟以前一样）
      'napcat/start': () => {
        watchdog?.setArmed(true);
        return startNapcat(cfg, detectQuickAccount(cfg.napcatDir) ?? undefined);
      },
      // 手动停止 = 告诉看门狗「别管」，否则它会在 90 秒后把刚停的又拉起来
      'napcat/stop': async () => {
        watchdog?.setArmed(false);
        return stopNapcat(cfg);
      },
      'napcat/restart': async () => {
        watchdog?.setArmed(true);
        const stopped = await stopNapcat(cfg);
        for (let i = 0; i < 30; i += 1) {
          if ((await findNapcatProcs(cfg)).length === 0) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        return { stopped: stopped.stopped, started: await startNapcat(cfg, detectQuickAccount(cfg.napcatDir) ?? undefined) };
      },
      'bot/start': () => startBot(),
      'bot/stop': () => stopBot(),
      'bot/restart': async () => {
        const stopped = await stopBot();
        return { stopped, started: startBot() };
      },
      'watchdog/arm': () => {
        watchdog?.setArmed(true);
        return { ok: true, watchdog: watchdog?.status() ?? null };
      },
      'watchdog/disarm': () => {
        watchdog?.setArmed(false);
        return { ok: true, watchdog: watchdog?.status() ?? null };
      },
    };
    const job = jobs[action];
    if (job === undefined) {
      sendJson(res, 404, { ok: false, error: '没有这个动作：' + action });
      return;
    }
    runAction(action.replace('/', ':'), job).then(({ code, body }) => sendJson(res, code, body));
    return;
  }

  sendText(res, 404, '没有这个路径：' + method + ' ' + path);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log.error('端口 ' + cfg.port + ' 已被占用：控制台没启动（改 config.json 的 console.port，或关掉占用的进程）');
  } else {
    log.error('控制台启动失败：' + err.message);
  }
  process.exit(1);
});

server.listen(cfg.port, cfg.host, () => {
  log.ok('控制台已启动：http://' + cfg.host + ':' + cfg.port + '/');
  log.info('NapCat 目录：' + cfg.napcatDir);
  log.info('探活地址：' + wsUrl + '；dryRun=' + String(dryRun));
  startQrArchive({ src: join(cfg.napcatDir, 'cache', 'qrcode.png'), destDir: join(repoRoot, 'qr') });
  // 掉线看门狗（2026-11-02）：NapCat 自己救不回登录态，这里每 30 秒探活、离线就整进程重启 + 快速登录
  watchdog = startWatchdog({
    cfg,
    wsUrl,
    token,
    // 告警走 Dyu 的 OneBot（本机 3001，无鉴权）；连不上只写日志，不影响重启
    alertWsUrl: (process.env.DYU_ONEBOT_WS_URL ?? 'ws://127.0.0.1:3001').trim(),
    alertTargets,
    consoleDir: join(repoRoot, 'data', 'console'),
  });
});

function shutdown(signal: string): void {
  log.info('收到 ' + signal + '，控制台退出（NapCat 与守卫进程不受影响）');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
