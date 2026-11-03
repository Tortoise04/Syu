import type {
  ActionTaken,
  Channel,
  ContextItem,
  Decision,
  JudgeInput,
  JudgeResult,
  KeywordHit,
  RuleId,
  ScreenResult,
  Severity,
  ViolationRecord,
} from './types.ts';
import type { KeywordTable, RingBuffer } from './rules.ts';
import {
  extractMessage,
  isExempt,
  isGameContextOnly,
  isOnlyExemptPhrase,
  isCasualCaoTalk,
  scan,
} from './rules.ts';
import type { SampleDraw, SampleKind, SampleRates } from './sample.ts';
import { DEFAULT_SAMPLE_RATES, describeDraw, drawSample, rateFor } from './sample.ts';
import type { MessageEvent } from '../onebot/types.ts';
import type { StateStore } from '../state.ts';
import type { SilentSexConfig } from './silentSex.ts';
import { extremeSexGroups, isSilentSexRule, looksSexual } from './silentSex.ts';

/**
 * M2a-D 判定链路：豁免 → 关键词/链接必判 → @举报 → 本地粗筛 → 云终审 → 档位与置信度 → 记录。
 * 本模块只产出 Decision 与 ViolationRecord，一次群消息 API 都不调（动作链路是 M2b）。
 * 顺序原则：事件到达即入环，判定只读快照；冷却只压动作不压送审；预算压一切，举报除外。
 */

export interface PipelineDeps {
  store: StateStore;
  rules: { table: KeywordTable; linkWhitelist: string[] };
  screener: {
    screen(
      text: string,
      context: string[],
      opts?: { think?: boolean; timeoutMs?: number },
    ): Promise<ScreenResult>;
  };
  judge: { judge(input: JudgeInput): Promise<JudgeResult> };
  rulesText: string;
  thresholds: { redline: number; normal: number; remind?: number };
  now?: () => Date;
  /** 抽检用，测试注入 */
  random?: () => number;
  /**
   * 契约外补的两个可选口：豁免需要 selfId 与接收人名单，而它们只在上层知道。
   * 不传时 selfId 取事件的 self_id，名单视为空（没有人豁免），豁免判断其余项照常。
   */
  selfId?: number;
  /** 接收人名单：名单里的人说话不判定 */
  ownerQqs?: number[];
  /** 旧单值字段：仅为兼容既有调用点，新代码用 ownerQqs */
  ownerQq?: number;
  /** 按群绑定的接收人（方案 §14.2）：绑定者只在绑定的群豁免 */
  groupOwners?: Record<number, number[]>;
  /** 不检测名单（guard.whitelist）：名单里的人说话不判定，但不是管理员 */
  whitelist?: number[];
  /** 玩笑白名单（guard.exemptPhrases）：整条只剩这些短语时不判不记、不花预算 */
  exemptPhrases?: string[];
  /** 送云抽检率（方案 §3.1）；不传真就是「维持改动前行为」的缺省口径 */
  sample?: SampleRates;
  /** 条款封顶（guard.caps）：只压档位，不压送云 */
  caps?: Record<string, number>;
  /** 色情静默闸门（guard.silentSex）：不传用内置默认（R7 + REDLINE） */
  silentSex?: SilentSexConfig;
}

export interface PipeContext {
  ring: RingBuffer;
}

export interface PipeResult {
  decision: Decision | null;
  record?: ViolationRecord;
}

/** 冷却窗口：同群同人同条款 5 分钟内只动一次手 */
const COOLDOWN_MS = 5 * 60_000;
/** 1 档提醒的兜底门槛：配置没给 thresholds.remind 时用它（与 config 内置默认一致） */
const DEFAULT_REMIND_THRESHOLD = 0.6;
/** 粗筛可见的上下文条数 */
const RECENT_N = 10;
/** 记录里的原文摘要上限 */
const TEXT_MAX = 200;
/** 引用原文：只取被引用那一条 */
const REPLY_BEFORE = 0;
const REPLY_AFTER = 0;
/** 举报通道：被回复那条 + 前后各 5 条 */
const REPORT_BEFORE = 5;
const REPORT_AFTER = 5;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地 ISO 时间（不是 UTC）：写进 jsonl 给人看，必须和群里的时间对得上 */
function localIso(d: Date): string {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}` +
    `${sign}${pad2(Math.trunc(abs / 60))}:${pad2(abs % 60)}`
  );
}

function actionOf(severity: Severity): ActionTaken {
  if (severity >= 3) return 'escalate';
  if (severity === 2) return 'warn';
  if (severity === 1) return 'remind';
  return 'none';
}

function clockOf(deps: PipelineDeps): Date {
  const now = deps.now;
  const d = now === undefined ? new Date() : now();
  return d instanceof Date ? d : new Date();
}

/** 没配 judge.sample 就用缺省口径：suspicious 全送、clean 不送、unknown 按时间 */
function ratesOf(deps: PipelineDeps): SampleRates {
  return deps.sample ?? DEFAULT_SAMPLE_RATES;
}

/** 对一条消息在某个来源上抽一次签；键是 (群号, 消息号)，保证可复算 */
function drawFor(
  kind: SampleKind,
  ev: MessageEvent,
  target: ContextItem,
  deps: PipelineDeps,
): SampleDraw {
  const rate = rateFor(kind, ratesOf(deps), clockOf(deps));
  return drawSample(
    kind,
    {
      groupId: groupIdOf(ev),
      messageId: target.messageId,
      userId: target.userId,
      time: Number(ev.time),
      text: target.text,
    },
    rate,
    deps.random,
  );
}

function groupIdOf(ev: MessageEvent): number {
  return Number(ev.group_id ?? 0);
}

function nicknameOf(ev: MessageEvent): string {
  const card = ev.sender?.card;
  if (typeof card === 'string' && card.trim().length > 0) return card.trim();
  const nick = ev.sender?.nickname;
  if (typeof nick === 'string' && nick.trim().length > 0) return nick.trim();
  return String(ev.user_id);
}

interface Extracted {
  item: ContextItem;
  replyId?: number;
}

function extractFor(ev: MessageEvent): Extracted {
  const parsed = extractMessage(ev.message, ev.raw_message);
  const item: ContextItem = {
    messageId: Number(ev.message_id),
    userId: Number(ev.user_id),
    nickname: nicknameOf(ev),
    time: Number(ev.time),
    text: parsed.text,
    images: parsed.images,
    isTarget: false,
  };
  const out: Extracted = { item };
  if (parsed.replyId !== undefined) out.replyId = parsed.replyId;
  return out;
}

function exempted(ev: MessageEvent, deps: PipelineDeps): boolean {
  const selfId = deps.selfId === undefined ? Number(ev.self_id) : deps.selfId;
  // 没配名单就是空名单：谁都不在名单里，其余豁免项照常生效
  return isExempt(ev, {
    selfId,
    ownerQqs: deps.ownerQqs ?? [],
    ownerQq: deps.ownerQq,
    groupOwners: deps.groupOwners,
    whitelist: deps.whitelist ?? [],
  });
}

/**
 * 送审文本 = 本条正文 + 引用原文。
 * 不拼引用就会漏掉「引用一句违禁话 + 一个表情」这种消息。
 */
function scanTextFor(extracted: Extracted, ring: RingBuffer): string {
  const replyId = extracted.replyId;
  if (replyId === undefined) return extracted.item.text;
  const quoted = ring.around(replyId, REPLY_BEFORE, REPLY_AFTER);
  if (quoted.length === 0) return extracted.item.text;
  const parts: string[] = [];
  if (extracted.item.text.length > 0) parts.push(extracted.item.text);
  for (const q of quoted) {
    if (q.text.length > 0) parts.push(q.text);
  }
  return parts.join(' ');
}

/** 判定只读快照：最近 10 条，目标那条打 isTarget；目标已被挤出环就补上 */
function judgeContextFor(ring: RingBuffer, target: ContextItem): ContextItem[] {
  const items: ContextItem[] = ring
    .recent(RECENT_N)
    .map((it) => ({ ...it, isTarget: it.messageId === target.messageId }));
  if (!items.some((it) => it.isTarget)) items.push({ ...target });
  return items.sort((a, b) => a.time - b.time);
}

interface RecordMeta {
  groupId: number;
  userId: number;
  nickname: string;
  messageId: number;
  channel: Channel;
  text: string;
  keywords: string[];
  /** 只有走了送云抽签的通道才有；必判/举报/只记录词不写 */
  sample?: SampleDraw;
  /** 云端拆出的最短原话（只有举报通道的终审会带；用来补词表） */
  span?: string;
}

function recordOf(meta: RecordMeta, decision: Decision, extraRules: RuleId[], now: Date): ViolationRecord {
  const rec: ViolationRecord = {
    ts: localIso(now),
    groupId: meta.groupId,
    userId: meta.userId,
    nickname: meta.nickname,
    messageId: meta.messageId,
    channel: meta.channel,
    text: truncate(meta.text, TEXT_MAX),
    rule: decision.rule,
    extraRules,
    severity: decision.severity,
    confidence: decision.confidence,
    reason: decision.reason,
    keywords: meta.keywords,
    action: decision.action,
    cooledDown: decision.cooledDown,
    degraded: decision.degraded,
  };
  if (meta.sample !== undefined) {
    rec.sampled = meta.sample.sampled;
    rec.sampleRoll = meta.sample.roll;
    rec.sampleRate = meta.sample.rate;
  }
  if (meta.span !== undefined) rec.span = meta.span;
  return rec;
}

interface FlatArgs {
  ev: MessageEvent;
  deps: PipelineDeps;
  channel: Channel;
  target: ContextItem;
  hits: KeywordHit[];
  text: string;
  rule: RuleId;
  confidence: number;
  reason: string;
  degraded: boolean;
  /** 走过抽签却没送云的，把 roll/rate 一起落进记录（方案 §3.2） */
  sample?: SampleDraw;
  /** 粗筛猜的条款与可疑度：只进记录当线索，不进判定结论（2026-11-02） */
  hintRule?: RuleId;
  screenScore?: number;
  /** A 举证式提示词给出的逐字证据与理由（只进记录，供事后看「为什么可疑」） */
  screenEvidence?: string;
  screenReason?: string;
}

/** 没走终审的那些结论（只记录/clean/降级/预算耗尽）：一律 0 级、不动手、照常写记录 */
function flatResult(args: FlatArgs): PipeResult {
  const decision: Decision = {
    channel: args.channel,
    rule: args.rule,
    severity: 0,
    confidence: clamp01(args.confidence),
    action: 'none',
    reason: args.reason,
    hits: args.hits,
    degraded: args.degraded,
    cooledDown: false,
  };
  const meta: RecordMeta = {
    groupId: groupIdOf(args.ev),
    userId: args.target.userId,
    nickname: args.target.nickname,
    messageId: args.target.messageId,
    channel: args.channel,
    text: truncate(args.text, TEXT_MAX),
    keywords: args.hits.map((h) => h.word),
  };
  if (args.sample !== undefined) meta.sample = args.sample;
  const rec = recordOf(meta, decision, [], clockOf(args.deps));
  // 线索字段：粗筛猜的条款/可疑度，供事后看「为什么这条被标可疑」，不参与判定与文案
  if (args.hintRule !== undefined) rec.hintRule = args.hintRule;
  if (args.screenScore !== undefined) rec.screenScore = args.screenScore;
  if (args.screenEvidence !== undefined && args.screenEvidence !== '') rec.screenEvidence = args.screenEvidence;
  if (args.screenReason !== undefined && args.screenReason !== '') rec.screenReason = args.screenReason;
  return { decision, record: rec };
}

function budgetOut(
  ev: MessageEvent,
  deps: PipelineDeps,
  channel: Channel,
  target: ContextItem,
  hits: KeywordHit[],
  text: string,
  sample?: SampleDraw,
  screen?: { rule?: RuleId; score?: number; evidence?: string; reason?: string },
): PipeResult {
  return flatResult({
    ev,
    deps,
    channel,
    target,
    hits,
    text,
    rule: 'OTHER',
    confidence: 0,
    reason: '预算耗尽（每日/单群上限已满），本条不送审，只记录',
    degraded: true,
    ...(sample === undefined ? {} : { sample }),
    ...(screen?.rule === undefined ? {} : { hintRule: screen.rule }),
    ...(screen?.score === undefined ? {} : { screenScore: screen.score }),
    ...(screen?.evidence === undefined ? {} : { screenEvidence: screen.evidence }),
    ...(screen?.reason === undefined ? {} : { screenReason: screen.reason }),
  });
}

interface JudgeRunArgs {
  ev: MessageEvent;
  deps: PipelineDeps;
  channel: Channel;
  target: ContextItem;
  context: ContextItem[];
  hits: KeywordHit[];
  text: string;
  /** 抽中才送云的那几档把签号带进来，写进记录 */
  sample?: SampleDraw;
}

/**
 * 条款封顶（guard.caps）：只压档位，不压送云。
 * 用户 2026-11-01 拍板「r9 还是只记录，但是我要查得查得到」——所以命中照常进云端终审，
 * 结论封在 0 档、不再出手，记录照写（channel/rule/置信度都在，方便事后查）。
 */
function capFor(rule: RuleId, severity: Severity, deps: PipelineDeps): { severity: Severity; capped: boolean } {
  const raw = deps.caps?.[rule];
  if (raw === undefined) return { severity, capped: false };
  const limit = Math.max(0, Math.min(3, Math.trunc(raw))) as Severity;
  if (severity <= limit) return { severity, capped: false };
  return { severity: limit, capped: true };
}

/**
 * 置信度门槛按档位取（2026-11-01 晚用户拍板，默认 0.6 / 0.75）：
 * 红线固定用 redline；1 档（只是群里提醒）用 remind；2/3 档（警告/升级）用 normal。
 * `#test judge` 与 `runJudge` 共用这一个函数，避免两处口径漂移。
 */
export function thresholdFor(
  rule: RuleId,
  severity: Severity,
  thresholds: { redline: number; normal: number; remind?: number },
): number {
  if (rule === 'REDLINE') return thresholds.redline;
  if (severity <= 1) return thresholds.remind ?? DEFAULT_REMIND_THRESHOLD;
  return thresholds.normal;
}

async function runJudge(args: JudgeRunArgs): Promise<PipeResult> {
  const { ev, deps, channel, target, context, hits } = args;
  const groupId = groupIdOf(ev);
  const now = clockOf(deps);

  let judged: JudgeResult;
  try {
    judged = await deps.judge.judge({
      channel,
      target,
      context,
      rulesText: deps.rulesText,
      keywordHits: hits,
    });
  } catch (err) {
    // 终审客户端承诺不抛；真抛了也只当降级，不能让一条消息带崩进程
    judged = {
      severity: 0,
      confidence: 0,
      reason: `终审抛出异常：${errText(err)}`,
      rule: 'OTHER',
      degraded: true,
    };
  }

  const meta: RecordMeta = {
    groupId,
    userId: target.userId,
    nickname: target.nickname,
    messageId: target.messageId,
    channel,
    text: truncate(args.text, TEXT_MAX),
    keywords: hits.map((h) => h.word),
  };
  if (args.sample !== undefined) meta.sample = args.sample;
  // 拆词（2026-11-02）：云端指回的那段原话跟着记录走，举报受理后据此补词表
  if (!judged.degraded && typeof judged.span === 'string' && judged.span.trim().length > 0) {
    meta.span = judged.span.trim();
  }

  // 降级：只记录不动手，不计数也不碰冷却（否则「没结论」会变成「第 2 次升级」）
  if (judged.degraded) {
    const decision: Decision = {
      channel,
      rule: 'OTHER',
      severity: 0,
      confidence: clamp01(judged.confidence),
      action: 'none',
      reason: judged.reason.length > 0 ? judged.reason : '终审降级，只记录不动手',
      hits,
      degraded: true,
      cooledDown: false,
    };
    return { decision, record: recordOf(meta, decision, [], now) };
  }

  const rule: RuleId = judged.rule;
  const confidence = clamp01(judged.confidence);
  /** OTHER 不参与「当日第 2 次升 3」计数 */
  const countsForEscalation = rule !== 'OTHER';
  /**
   * 色情静默命中（2026-11-02 用户拍板）：条款在静默名单里，且本条确实在说色情。
   * REDLINE 里还有毒品/军火，那些不在这里——它们第 2 次照样升 3 档。
   */
  const silentSexRule = isSilentSexRule(rule, deps.silentSex) && looksSexual(args.text, deps.silentSex);

  let severity: Severity = judged.severity;
  let action: ActionTaken = 'none';
  let reason = judged.reason.length > 0 ? judged.reason : '终审未给出理由';
  let cooledDown = false;
  /** 当天同条款第 2 次被升到 3：这一次必须出手，冷却不许吞（用户拍板的例外） */
  let escalatedToThree = false;

  // R11 语境判别（2026-11-03 用户拍板 C 方案）：「box发来」「申请会诊」说的是角色池，不是开盒。
  // 只在「含游戏语境词且不含任何开盒要素词」时生效；出现真名/户籍/社工库/挂人/恶俗 等字样一律照判。
  if (rule === 'R11' && isGameContextOnly(args.text)) {
    severity = 0;
    reason = `${reason}（游戏语境：box/会诊 等说法，未见身份信息要素，按误判降为 0 级）`;
  }

  // 封顶先落一次：门槛没过时档位不再变，记录里也应该是封顶后的档
  const seeded = capFor(rule, severity, deps);
  if (seeded.capped) {
    severity = seeded.severity;
    reason = `${reason}（条款 ${rule} 封顶 ${severity} 档，只记录）`;
  }

  /**
   * 门槛按「会出手的档位」取（2026-11-01 晚用户拍板）：1 档只是群里轻提醒，用 remind（默认 0.6）；
   * 2/3 档是真警告/升级，用 normal（0.75）；红线始终用 redline（0.6）。
   * 起因：模型给轻微违规的置信度普遍落在 0.55–0.70，用 0.75 卡它 = 判到了也不提醒。
   */
  const threshold = thresholdFor(rule, severity, deps.thresholds);
  const passed = confidence >= threshold;

  if (!passed) {
    // 门槛没过：照常记录、照常计数，但不动手
    if (countsForEscalation) deps.store.bumpDailyCount(groupId, rule);
    reason = `${reason}（置信度 ${confidence.toFixed(2)} < 门槛 ${threshold}）`;
  } else if (severity >= 1) {
    const count = countsForEscalation ? deps.store.bumpDailyCount(groupId, rule) : 0;
    if (countsForEscalation && !silentSexRule && count > 1) {
      severity = Math.max(severity, 3) as Severity;
      escalatedToThree = true;
    }
    // 升 3 之后再过一次封顶：被封顶的条款连「升 3 必须出手」这条例外也不许突破
    const capped = capFor(rule, severity, deps);
    if (capped.capped) {
      severity = capped.severity;
      reason = `${reason}（条款 ${rule} 封顶 ${severity} 档，只记录）`;
      escalatedToThree = false;
    }
    action = actionOf(severity);
  }

  if (channel !== 'report') {
    // 冷却只压动作不压送审：判定已经走完，这里只决定动不动手
    const key = `${groupId}:${meta.userId}:${rule}`;
    if (deps.store.isCooling(key) && !escalatedToThree) {
      action = 'none';
      cooledDown = true;
    } else if (escalatedToThree) {
      // 绕过冷却但要刷新窗口，免得窗口一直停在第一次动手那一刻
      deps.store.touchCooldown(key, COOLDOWN_MS);
    } else if (passed && severity >= 1) {
      deps.store.touchCooldown(key, COOLDOWN_MS);
    }
  }

  // 色情静默闸门（2026-11-02 用户拍板）：R7/REDLINE 没命中极端文字时，群里一个字不出，只私聊
  if (silentSexRule && action !== 'none' && action !== 'notify') {
    const groups = extremeSexGroups(args.text, deps.silentSex);
    if (groups.length === 0) {
      action = 'notify';
      reason = `${reason}（色情静默：未命中极端词表，群里不出声，只私聊收件人）`;
    } else {
      reason = `${reason}（色情极端：命中 ${groups.join('/')}，照常在群里出声）`;
    }
  }

  const decision: Decision = {
    channel,
    rule,
    severity,
    confidence,
    action,
    reason,
    hits,
    degraded: false,
    cooledDown,
  };
  return { decision, record: recordOf(meta, decision, judged.extraRules ?? [], now) };
}

export async function handleMessage(
  ev: MessageEvent,
  ctx: PipeContext,
  deps: PipelineDeps,
): Promise<PipeResult> {
  const extracted = extractFor(ev);
  // 1) 事件到达即入环，判定只读快照
  ctx.ring.push(extracted.item);
  // 2) 豁免：自己人、主人、管理员，一律不判不记
  if (exempted(ev, deps)) return { decision: null };
  // 2b) 玩笑白名单：整条只剩白名单短语（可带 @/标点/表情）时不判不记、不花预算
  if (isOnlyExemptPhrase(extracted.item.text, deps.exemptPhrases)) return { decision: null };
  // 2c) 「艹」类口头语（2026-11-03 用户拍板）：我艹死你 / 来艹我 / 所有人来艹我 都是玩笑互怼，
  // 不判不记也就不参与「当天第 2 次升 3」的计数；只有「艹你妈」这类家庭辱骂照判。
  if (isCasualCaoTalk(extracted.item.text)) return { decision: null };

  const target: ContextItem = { ...extracted.item, isTarget: true };
  const text = scanTextFor(extracted, ctx.ring);
  const found = scan(text, deps.rules.table, { linkWhitelist: deps.rules.linkWhitelist });
  const hits = found.hits;
  const groupId = groupIdOf(ev);
  const context = judgeContextFor(ctx.ring, target);

  // 3) 关键词/链接必判：多词已在规则层合并，一条消息只调一次 judge
  if (found.mustJudge) {
    const channel: Channel = hits.some((h) => h.mustJudge && h.kind !== 'link') ? 'keyword' : 'link';
    if (!deps.store.takeBudget(groupId)) return budgetOut(ev, deps, channel, target, hits, text);
    return runJudge({ ev, deps, channel, target, context, hits, text });
  }

  // 3b) 只有 gated 命中（731/垃圾/见证 这类语境词）：先跑带思考链的本地确认，
  //     确认可疑才送云；确认干净或没确认成，都只落 0 级记录（2026-11-02 分档）
  if (found.hasGated && !found.mustJudge) {
    let gated: ScreenResult;
    try {
      gated = await deps.screener.screen(
        text,
        ctx.ring.recent(RECENT_N).map((it) => it.text),
        { think: true },
      );
    } catch (err) {
      gated = { verdict: 'unknown', degraded: true, detail: `本地确认抛出异常：${errText(err)}` };
    }
    if (gated.verdict === 'suspicious') {
      const draw: SampleDraw = { kind: 'gated', sampled: true, roll: 0, rate: 1 };
      if (!deps.store.takeBudget(groupId))
        return budgetOut(ev, deps, 'gated', target, hits, text, draw, {
          rule: gated.rule,
          score: gated.score,
          evidence: gated.evidence,
          reason: gated.reason,
        });
      return runJudge({ ev, deps, channel: 'gated', target, context, hits, text, sample: draw });
    }
    const why =
      gated.verdict === 'clean'
        ? `本地确认 clean${gated.reason === undefined ? '' : `（${gated.reason}）`}，只记录`
        : `本地确认降级（unknown）${gated.detail === undefined ? '' : `：${gated.detail}`}，只记录`;
    return flatResult({
      ev,
      deps,
      channel: 'gated',
      target,
      hits,
      text,
      rule: 'OTHER',
      confidence: gated.score === undefined ? 0 : gated.score,
      reason: why,
      degraded: gated.degraded,
      ...(gated.rule === undefined ? {} : { hintRule: gated.rule }),
      ...(gated.score === undefined ? {} : { screenScore: gated.score }),
      ...(gated.evidence === undefined ? {} : { screenEvidence: gated.evidence }),
      ...(gated.reason === undefined ? {} : { screenReason: gated.reason }),
    });
  }

  // 4) 只有 recordOnly 命中：不送审、不吃预算，仍然落一条 0 级记录
  //    低精度词（hints/softAlarm）不走这里：它们必须继续走本地粗筛（2026-11-01 分档）
  if (hits.length > 0 && !found.hasHint) {
    return flatResult({
      ev,
      deps,
      channel: 'keyword',
      target,
      hits,
      text,
      rule: hits[0].rule,
      confidence: 0,
      reason: '允许的群内交易词，只记录',
      degraded: false,
    });
  }

  // 4b) 纯图片消息：文本层只剩 [image] / [at:…] 占位符，没有可判内容。
  //     不跑本地粗筛（模型只能对占位符瞎猜条款），也不识图（非必要不识图），只落 0 级记录。
  if (text.replaceAll('[image]', '').replace(/\[at:[^\]]*\]/g, '').trim().length === 0) {
    return flatResult({
      ev,
      deps,
      channel: 'screen',
      target,
      hits,
      text,
      rule: 'OTHER',
      confidence: 0,
      reason: '纯图片消息，文本层无可判内容，只记录',
      degraded: false,
    });
  }

  // 5) 无必判命中 → 本地粗筛；粗筛结论只决定「送云概率」，不决定「记不记」
  let screenResult: ScreenResult;
  try {
    screenResult = await deps.screener.screen(
      text,
      ctx.ring.recent(RECENT_N).map((it) => it.text),
    );
  } catch (err) {
    screenResult = { verdict: 'unknown', degraded: true, detail: `粗筛抛出异常：${errText(err)}` };
  }

  // 5a) suspicious：按 judge.sample.suspicious 抽签送云（方案 §3.1）
  if (screenResult.verdict === 'suspicious') {
    const draw = drawFor('suspicious', ev, target, deps);
    if (!draw.sampled) {
      return flatResult({
        ev,
        deps,
        channel: 'screen',
        target,
        hits,
        text,
        // 粗筛的 rule 字段是模型猜的（实测漂移严重、纯图时纯属瞎猜），
        // 不进记录：未终审的记录条款一律落 OTHER，避免控制台显示成真判定。
        rule: 'OTHER',
        confidence: screenResult.score === undefined ? 0 : screenResult.score,
        reason: `粗筛 suspicious，未抽中终审（${describeDraw(draw)}），按只记录处理`,
        degraded: false,
        sample: draw,
        ...(screenResult.rule === undefined ? {} : { hintRule: screenResult.rule }),
        ...(screenResult.score === undefined ? {} : { screenScore: screenResult.score }),
        ...(screenResult.evidence === undefined ? {} : { screenEvidence: screenResult.evidence }),
        ...(screenResult.reason === undefined ? {} : { screenReason: screenResult.reason }),
      });
    }
    if (!deps.store.takeBudget(groupId))
      return budgetOut(ev, deps, 'screen', target, hits, text, draw, { rule: screenResult.rule, score: screenResult.score, evidence: screenResult.evidence, reason: screenResult.reason });
    return runJudge({ ev, deps, channel: 'screen', target, context, hits, text, sample: draw });
  }

  // 5b) clean：判 0 级也要记（clean 是「粗筛说没问题」，不是「不记录」），但留极小概率送云复核
  if (screenResult.verdict === 'clean') {
    const draw = drawFor('clean', ev, target, deps);
    if (!draw.sampled) {
      return flatResult({
        ev,
        deps,
        channel: 'screen',
        target,
        hits,
        text,
        // 同 suspicious 分支：未终审不写粗筛猜的条款
        rule: 'OTHER',
        confidence: screenResult.score === undefined ? 0 : screenResult.score,
        reason: `粗筛 clean，未抽中终审（${describeDraw(draw)}），按只记录处理`,
        degraded: false,
        sample: draw,
        ...(screenResult.rule === undefined ? {} : { hintRule: screenResult.rule }),
        ...(screenResult.score === undefined ? {} : { screenScore: screenResult.score }),
        ...(screenResult.evidence === undefined ? {} : { screenEvidence: screenResult.evidence }),
        ...(screenResult.reason === undefined ? {} : { screenReason: screenResult.reason }),
      });
    }
    if (!deps.store.takeBudget(groupId))
      return budgetOut(ev, deps, 'screen', target, hits, text, draw, { rule: screenResult.rule, score: screenResult.score, evidence: screenResult.evidence, reason: screenResult.reason });
    return runJudge({ ev, deps, channel: 'screen', target, context, hits, text, sample: draw });
  }

  // 5c) unknown = 没筛成，既不当 clean 放行，也不当成「无违规」的结论：按低概率抽检
  const draw = drawFor('unknown', ev, target, deps);
  if (draw.sampled) {
    if (!deps.store.takeBudget(groupId))
      return budgetOut(ev, deps, 'sample', target, hits, text, draw, { rule: screenResult.rule, score: screenResult.score, evidence: screenResult.evidence, reason: screenResult.reason });
    return runJudge({ ev, deps, channel: 'sample', target, context, hits, text, sample: draw });
  }
  const detail = screenResult.detail === undefined ? '' : `：${screenResult.detail}`;
  return flatResult({
    ev,
    deps,
    channel: 'screen',
    target,
    hits,
    text,
    rule: 'OTHER',
    confidence: 0,
    reason: `本地粗筛降级（unknown）且未抽中复检（${describeDraw(draw)}）${detail}，按只记录处理`,
    degraded: true,
    sample: draw,
  });
}

/**
 * 举报的上下文：有被回复消息就取它 + 前后各 5 条；没有就最近 10 条。
 * 目标那条打 isTarget，其余 false。
 */
export function collectReportContext(ev: MessageEvent, ring: RingBuffer): ContextItem[] {
  const replyId = extractMessage(ev.message, ev.raw_message).replyId;
  if (replyId !== undefined) {
    const around = ring.around(replyId, REPORT_BEFORE, REPORT_AFTER);
    if (around.length > 0) {
      return around
        .map((it) => ({ ...it, isTarget: it.messageId === replyId }))
        .sort((a, b) => a.time - b.time);
    }
  }
  const selfMessageId = Number(ev.message_id);
  return ring.recent(RECENT_N).map((it) => ({ ...it, isTarget: it.messageId === selfMessageId }));
}

export async function handleReport(
  ev: MessageEvent,
  ctx: PipeContext,
  deps: PipelineDeps,
): Promise<PipeResult> {
  const extracted = extractFor(ev);
  ctx.ring.push(extracted.item);
  // 举报通道不按「举报人」豁免：主人/群主自己 @机器人 或发 /举报 也要判，
  // 因为判的是被举报的那条，不是举报人。只挡机器人自己发的消息，避免自循环。
  const selfId = deps.selfId === undefined ? Number(ev.self_id) : deps.selfId;
  if (Number(ev.user_id) === selfId) return { decision: null };

  const context = collectReportContext(ev, ctx.ring);
  let target = context.find((it) => it.isTarget);
  if (target === undefined) {
    target = { ...extracted.item, isTarget: true };
    context.push(target);
    context.sort((a, b) => a.time - b.time);
  }

  // 只扫被举报的那条：举报人自己的话（「我来举报广告」）不该算到被举报人头上
  const found = scan(target.text, deps.rules.table, { linkWhitelist: deps.rules.linkWhitelist });
  // 举报通道绝不 takeBudget：预算耗尽时举报仍要能工作
  return runJudge({ ev, deps, channel: 'report', target, context, hits: found.hits, text: target.text });
}
