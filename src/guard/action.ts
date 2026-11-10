import { log } from '../log.ts';
import type { MessageSegment } from '../onebot/types.ts';
import type { ActionsConfig } from '../config.ts';
import type { Decision, RuleId } from './types.ts';
import { appendSent, localIso } from './sent.ts';

/**
 * M2b 动作链路：群内/私聊消息的唯一出口。
 * 所有 send 调用点都只在这里，且只经由 client.sendGroup / client.sendPrivate。
 * 用户拍板的边界：一条消息最多 1 条群内动作消息；3 级额外私聊接收人名单（每人一条）；
 * 零撤回、零禁言；dryRun 默认只打日志不发送；发送失败不重试（上限 0 次），预算不退。
 * 真实发出去的消息逐条落 data/sent.jsonl（dryRun 不算发送，不写）。
 */

/** 动作计划里的一条待发消息 */
export interface ActionSend {
  /** group = client.sendGroup；private = client.sendPrivate */
  scope: 'group' | 'private';
  /** 群号（group）或 QQ 号（private） */
  to: number;
  /** 真正交给 client 的段数组：@ 必须是 at 段，塞进 text 段会被当成正文 */
  segments: MessageSegment[];
  /** 纯文本渲染：dryRun 日志与断言看的都是这一行 */
  text: string;
}

/** 被判定那条消息的最小画像：ContextItem 与 ViolationRecord 都满足这个形状 */
export interface ActionTarget {
  messageId: number;
  userId: number;
  nickname: string;
  text: string;
}

/** 只声明用得到的两个方法，免得把整个 OneBotClient 拖进来 */
export interface ActionClientPort {
  sendGroup(groupId: number | string, message: string | MessageSegment[]): Promise<number>;
  sendPrivate(userId: number | string, message: string | MessageSegment[]): Promise<number>;
}

export interface ActionStatePort {
  readonly snapshot: { lastActionMessageId?: number };
  setLastActionMessageId(id: number | undefined): void;
}

export interface ActionDeps {
  client: ActionClientPort;
  store: ActionStatePort;
  actions: ActionsConfig;
  /** 接收人名单：名单里每个人都收 3 级证据私聊；空名单 = 不猜收件人 */
  ownerQqs?: number[];
  /** 旧单值字段：等价于 ownerQqs=[ownerQq]，仅为兼容既有调用点，新代码用 ownerQqs */
  ownerQq?: number;
  /** 额外收件人（群主等，方案 §7 决定）：只多收 3 级证据私聊，不参与「主人说话豁免」 */
  adminQqs?: number[];
  /**
   * 通知人（2026-11-04 用户拍板）：与主人/群主同批收提醒（通知类 + 3 级证据），
   * 但零权限——不进 operators、不豁免、不收私聊收件箱。
   */
  recipients?: number[];
  /**
   * 按群绑定的通知人（2026-11-04 追加）：配了某群就只给该群发，不再并全局 recipients。
   * 键是群号字符串（JSON 对象键只能是字符串）。
   */
  groupRecipients?: Record<string, number[]>;
  /** 按群绑定的接收人（方案 §14.2）：绑定群 3 级只发绑定者（adminQqs 仍恒收）；绑定者仅本群豁免 */
  groupOwners?: Record<number, number[]>;
  /** sent.jsonl 的落位；不传就不记发送流水（测试里的假 client 用） */
  dataDir?: string;
  /** 注入时钟，测试用 */
  now?: () => Date;
}

export interface BuildOptions {
  /** 接收人名单：每个都发一条私聊证据 */
  ownerQqs?: number[];
  /** 旧单值字段：并入 ownerQqs，仅为兼容 */
  ownerQq?: number;
  /** 额外收件人（群主等）：并进 3 级证据私聊名单 */
  adminQqs?: number[];
  /** 通知人：与主人/群主同批收提醒，零权限 */
  recipients?: number[];
  /** 按群绑定的通知人：该群只给它发，不再并全局 recipients */
  groupRecipients?: Record<string, number[]>;
  /** 举报人 QQ：只用于日志排查，不再对他发回执（2026-11-04 用户拍板） */
  reporterId?: number;
  /** 证据私聊里的「时间」行用哪个时刻（传 deps 注入的时钟，保证测试可复现） */
  now?: Date;
}

export interface ActionReport {
  status: 'none' | 'dry-run' | 'duplicate' | 'capped' | 'sent';
  /** 实际尝试发出的清单（含 3 级私聊失败后的群内兜底那条） */
  attempts: ActionSend[];
  sent: number;
  failures: number;
  /** 是否用上了「私聊主人失败 → 群内 @主人」的兜底 */
  fallback: boolean;
}

/** 条款短名：config 里只有条款号与群规原文，群内文案要用「哪类规定」又不能引用原文 */
export const RULE_TITLES: Record<RuleId, string> = {
  REDLINE: '红线违禁内容',
  R3: '敏感话题',
  R4: '人身攻击／引战／广告',
  R5: '无意义论战',
  R6: '营销号转发',
  R7: '露点（涉黄）图片',
  R8: '盘问家产',
  R9: '重复旧梗刷屏',
  R10: '见证类话题',
  R11: 'esu 相关内容',
  OTHER: '群规',
};

/** 3 级群内警示：不 @ 当事人，也不声称「已通知成功」（私聊可能失败，兜底那条会说实话） */
const PUBLIC_ALERT_TAIL = '，已记录；请当事人立刻停止，大家也请遵守群规。';
/** 3 级私聊失败后的群内兜底：必须是实话 */
const OWNER_FALLBACK_TEXT = '私聊通知失败，请查看日志';
const OWNER_EVIDENCE_TITLE = '【群守卫·3 级证据】';
/** 通知类私聊的标题（炸群报警词 / 条款 9 记录），与 3 级证据区分开 */
const NOTIFY_TITLE = '【群守卫·通知】';

/** 幂等集合上限：重连重放只可能在几分钟内重复，不需要无限留着 */
const FIRED_CAP = 1000;

const fired = new Map<number, true>();
let capDate = '';
let capCount = 0;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地日期（不能用 toISOString，那是 UTC，服务器会错一天） */
function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地时间戳：私聊证据要带「时间」（用户 2026-11-01 要求），同样不能用 UTC */
function localStamp(d: Date): string {
  return `${localDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function clockOf(deps: ActionDeps): Date {
  const now = deps.now;
  const d = now === undefined ? new Date() : now();
  return d instanceof Date ? d : new Date();
}

function ruleTitle(rule: RuleId): string {
  return RULE_TITLES[rule] ?? RULE_TITLES.OTHER;
}

/**
 * 群规条款标签（2026-11-01 用户要求「通告别固定一句话，写清违反了什么」）：
 * 群内文案点明违反哪一条，但只用群规条号，不暴露内部代号 R4 这种。
 */
export function ruleLabel(rule: RuleId): string {
  if (rule === 'REDLINE') return '红线条款（违禁内容）';
  if (rule === 'OTHER') return '群规通用条款';
  return `群规第${rule.slice(1)}条「${ruleTitle(rule)}」`;
}

/** 1 级群内提醒：点条款，不引原文 */
function remindText(rule: RuleId): string {
  return `注意${ruleLabel(rule)}：这类内容别在群里发，谢谢配合。`;
}

/** 3 级群内公共警示：不 @ 当事人，但要点明违反哪条 */
function publicAlertText(rule: RuleId): string {
  return `本群有消息违反${ruleLabel(rule)}${PUBLIC_ALERT_TAIL}`;
}

function textSeg(text: string): MessageSegment {
  return { type: 'text', data: { text } };
}

function atSeg(qq: number): MessageSegment {
  return { type: 'at', data: { qq: String(qq) } };
}

function groupSend(to: number, segments: MessageSegment[], text: string): ActionSend {
  return { scope: 'group', to, segments, text };
}

function privateSend(to: number, body: string): ActionSend {
  return { scope: 'private', to, segments: [textSeg(body)], text: body };
}

/** @当事人 + 正文：一条群内动作消息 */
function groupAtSend(groupId: number, userId: number, body: string): ActionSend {
  return groupSend(groupId, [atSeg(userId), textSeg(` ${body}`)], `@${userId} ${body}`);
}

/** 3 级私聊失败后的群内兜底：一条消息 @ 所有失败的接收人（必须是实话，不谎称通知成功） */
function ownerFallbackSend(groupId: number, owners: number[], body: string): ActionSend {
  const segments: MessageSegment[] = owners.map((qq) => atSeg(qq));
  segments.push(textSeg(` ${body}`));
  const atText = owners.map((qq) => `@${qq}`).join(' ');
  return groupSend(groupId, segments, `${atText} ${body}`);
}

/** 接收人名单归一：ownerQqs 为准，旧单值 ownerQq、额外收件人 adminQqs、通知人 recipients 并入；只留正数并去重 */
function ownerListOf(
  src: { ownerQqs?: number[]; ownerQq?: number; adminQqs?: number[]; recipients?: number[] },
  recipientOverride?: number[],
): number[] {
  const out: number[] = [];
  const add = (v: unknown): void => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return;
    if (!out.includes(v)) out.push(v);
  };
  if (Array.isArray(src.ownerQqs)) for (const qq of src.ownerQqs) add(qq);
  if (Array.isArray(src.adminQqs)) for (const qq of src.adminQqs) add(qq);
  const recips = recipientOverride === undefined ? src.recipients : recipientOverride;
  if (Array.isArray(recips)) for (const qq of recips) add(qq);
  add(src.ownerQq);
  return out;
}

/**
 * 3 级收件人按事发群解析（方案 §14.2）：事发群有绑定 → 只发绑定者 + adminQqs；
 * 无绑定 → 回退全局名单（ownerQqs + adminQqs，v2 行为）。返回的名单就是本轮私聊与兜底 @ 的全部对象。
 * 通知人按群解析（2026-11-04）：该群配了 groupRecipients 就只用它（不再并全局 recipients）。
 */
function recipientListOf(
  src: {
    ownerQqs?: number[];
    ownerQq?: number;
    adminQqs?: number[];
    recipients?: number[];
    groupRecipients?: Record<string, number[]>;
    groupOwners?: Record<number, number[]>;
  },
  groupId: number,
): number[] {
  const scoped =
    src.groupRecipients === undefined ? undefined : src.groupRecipients[String(groupId)];
  const recips = Array.isArray(scoped) && scoped.length > 0 ? scoped : src.recipients;

  const bound = src.groupOwners === undefined ? undefined : src.groupOwners[groupId];
  if (Array.isArray(bound) && bound.length > 0) {
    const out: number[] = [];
    const add = (v: number): void => {
      if (Number.isFinite(v) && v > 0 && !out.includes(v)) out.push(v);
    };
    for (const qq of bound) add(qq);
    if (Array.isArray(src.adminQqs)) for (const qq of src.adminQqs) add(qq);
    if (Array.isArray(recips)) for (const qq of recips) add(qq);
    return out;
  }
  return ownerListOf(src, recips);
}

function warnText(rule: RuleId): string {
  return `明确警告：你这条消息违反${ruleLabel(rule)}，请立刻停止，再犯将升级处理。`;
}

/**
 * 证据私聊正文。2026-11-01 用户要求：加「时间」行、去掉「通道」行——
 * 通道（keyword/screen/report/sample）是内部概念，收件人看条款、原话、置信度就够。
 */
function ownerEvidenceText(decision: Decision, target: ActionTarget, groupId: number, now?: Date): string {
  const quote = target.text.trim() === '' ? '（本条没有文本，可能是图片/表情）' : target.text;
  const at = now === undefined ? new Date() : now;
  return [
    OWNER_EVIDENCE_TITLE,
    `时间：${localStamp(at)}`,
    `群：${groupId}`,
    `用户：${target.nickname}（${target.userId}）`,
    `消息ID：${target.messageId}`,
    `原话：${quote}`,
    `条款：${decision.rule}｜${ruleTitle(decision.rule)}`,
    `置信度：${decision.confidence.toFixed(2)}`,
    `理由：${decision.reason}`,
    ...(decision.action === 'notify' ? ['状态：本条未在群里提醒（只私聊收件人）'] : []),
  ].join('\n');
}

/** 动作本体：1/2 级 @ 当事人，3 级群内警示 + 私聊证据。文案从不提「举报」 */
function actionFor(
  decision: Decision,
  target: ActionTarget,
  groupId: number,
  opts: BuildOptions,
): ActionSend[] {
  // 本轮禁止禁言：mute 恒不产出，3 级只走 escalate
  if (decision.action === 'mute') {
    log.warn(`[action] 群${groupId} 消息${target.messageId} 收到 mute 档，本轮不实现禁言，按不出手处理`);
    return [];
  }

  // 色情静默（2026-11-02）：群里一个字不发，私聊由 notifyOwners 负责
  if (decision.action === 'notify') return [];

  if (decision.action === 'remind') return [groupAtSend(groupId, target.userId, remindText(decision.rule))];

  if (decision.action === 'warn') return [groupAtSend(groupId, target.userId, warnText(decision.rule))];

  if (decision.action === 'escalate') {
    const alert = publicAlertText(decision.rule);
    const plan: ActionSend[] = [groupSend(groupId, [textSeg(alert)], alert)];
    const owners = ownerListOf(opts);
    if (owners.length > 0) {
      const evidence = ownerEvidenceText(decision, target, groupId, opts.now);
      for (const owner of owners) plan.push(privateSend(owner, evidence));
    } else {
      // 配置层已经强制要求 OWNER_QQ，走到这里说明上层没传：只留群内警示，不猜收件人
      log.error(`[action] 群${groupId} 3 级要私聊接收人，但名单为空（${JSON.stringify(opts.ownerQqs)}），只发群内警示`);
    }
    return plan;
  }

  return [];
}

/**
 * 判定 → 发送计划。纯函数：不碰网络、不碰状态，dryRun 与否都不影响它。
 * 一条消息最多 1 条群内动作消息；3 级 = 1 条群内警示（不 @ 当事人）+ 1 条私聊主人证据。
 */
export function buildActionMessages(
  decision: Decision,
  target: ActionTarget,
  groupId: number,
  opts: BuildOptions,
): ActionSend[] {
  if (decision.action === 'none') return [];

  /**
   * 举报通道：
   * 举报人是在群里 @ 机器人举报的，身份本身已经公开，「群里一声不吭」保护不了他，
   * 只是把违规放过。所以判到档位就照常对当事人动作，文案一个字不提举报。
   * 2026-11-04 用户拍板：收到举报不再私聊举报人（原来那条「已收到你的举报」回执已删），
   * 只留日志与记录。真正的匿名举报只能走私聊通道（尚未做判定）。
   */
  if (decision.channel === 'report') {
    const reporter = opts.reporterId;
    const who =
      reporter === undefined || !Number.isFinite(reporter) || reporter <= 0 ? '（事件里没有 user_id）' : String(reporter);
    log.info(`[action] 群${groupId} 举报消息${target.messageId} 举报人${who}：按判定档位处理，不回执`);
    return actionFor(decision, target, groupId, opts);
  }

  return actionFor(decision, target, groupId, opts);
}

function describeSend(item: ActionSend): string {
  const who = item.scope === 'group' ? `群${item.to}` : `私聊${item.to}`;
  return `${who}｜${item.text.replace(/\n/g, ' ⏎ ')}`;
}

function alreadyFired(store: ActionStatePort, messageId: number): boolean {
  if (fired.has(messageId)) return true;
  return store.snapshot.lastActionMessageId === messageId;
}

function markFired(store: ActionStatePort, messageId: number): void {
  fired.set(messageId, true);
  while (fired.size > FIRED_CAP) {
    const oldest = fired.keys().next();
    if (oldest.done === true) break;
    fired.delete(oldest.value);
  }
  store.setLastActionMessageId(messageId);
}

/** 测试用：清空进程内幂等集合与当日动作计数（跨日与进程重启本来就会清零） */
export function resetActionState(): void {
  fired.clear();
  capDate = '';
  capCount = 0;
}

function rollCapDate(now: Date): void {
  const today = localDate(now);
  if (capDate === today) return;
  capDate = today;
  capCount = 0;
}

/** 一条发送记录要带上的上下文：往哪个群、哪条消息、什么动作、写不写流水 */
interface SendLog {
  dataDir?: string;
  groupId: number;
  messageId: number;
  kind: string;
  ts: string;
}

/** 一次发送：失败只记日志，不重试；成与不成都落一把 sent.jsonl（写失败只打日志） */
async function sendOne(client: ActionClientPort, item: ActionSend, rec: SendLog): Promise<boolean> {
  let ok = true;
  try {
    if (item.scope === 'group') await client.sendGroup(item.to, item.segments);
    else await client.sendPrivate(item.to, item.segments);
  } catch (err) {
    ok = false;
    log.error(`[action] 发送失败（不重试）：${describeSend(item)}`, err);
  }
  if (rec.dataDir !== undefined) {
    await appendSent(rec.dataDir, {
      ts: rec.ts,
      groupId: rec.groupId,
      messageId: rec.messageId,
      scope: item.scope,
      to: item.to,
      kind: rec.kind,
      text: item.text,
      ok,
    });
  }
  return ok;
}

/**
 * 执行计划：dryRun → 幂等 → 当日额度 → 逐条发送（失败不重试）。
 * 3 级私聊接收人失败时补一条群内 @失败者 的实话提示（一轮最多补一条）；
 * 举报通道不再发回执，失败兜底与它无关。
 */
export async function executeAction(
  deps: ActionDeps,
  decision: Decision,
  target: ActionTarget,
  groupId: number,
  reporterId?: number,
): Promise<ActionReport> {
  const owners = recipientListOf(deps, groupId);
  const nowForBuild = clockOf(deps);
  const buildOpts: BuildOptions =
    reporterId === undefined
      ? { ownerQqs: owners, now: nowForBuild }
      : { ownerQqs: owners, reporterId, now: nowForBuild };
  const planned = buildActionMessages(decision, target, groupId, buildOpts);
  /**
   * 群内静默（2026-11-02 用户拍板）：groupSilent=true 时群内一条都不发，私聊全留。
   * 只滤计划里的 group 条目——3 级证据私聊、通知类私聊都不是群内消息。
   */
  const plan = deps.actions.groupSilent ? planned.filter((item) => item.scope === 'private') : planned;
  if (plan.length !== planned.length) {
    log.info(
      `[action] 群${groupId} 消息${target.messageId} groupSilent=true：群内 ${planned.length - plan.length} 条不发，私聊 ${plan.length} 条照发`,
    );
  }
  const empty: ActionReport = { status: 'none', attempts: [], sent: 0, failures: 0, fallback: false };
  if (plan.length === 0) return empty;

  if (alreadyFired(deps.store, target.messageId)) {
    log.info(`[action] 群${groupId} 消息${target.messageId} 已经动作过，跳过（幂等）`);
    return { status: 'duplicate', attempts: [], sent: 0, failures: 0, fallback: false };
  }

  const now = clockOf(deps);
  rollCapDate(now);
  if (capCount >= deps.actions.actionDailyCap) {
    log.warn(
      `[action] 当日动作已达上限 ${deps.actions.actionDailyCap}，群${groupId} 消息${target.messageId} 只记录不发送（重启才清零）`,
    );
    return { status: 'capped', attempts: [], sent: 0, failures: 0, fallback: false };
  }

  if (deps.actions.dryRun) {
    for (const item of plan) log.info(`[action][dryRun] 将发送 ${describeSend(item)}`);
    log.info(`[action][dryRun] 群${groupId} 消息${target.messageId} 计划 ${plan.length} 条，dryRun=true 一条都没发`);
    // dryRun 不算发送：这里直接返回，一条 sent.jsonl 都不写
    return { status: 'dry-run', attempts: plan, sent: 0, failures: 0, fallback: false };
  }

  if (deps.actions.muteEnabled) {
    // 开关只占位：本轮没有任何禁言实现，打开它也不会改变动作
    log.warn('[action] actions.muteEnabled=true，但本轮没有禁言实现，动作与关闭时一致');
  }

  capCount += 1;
  const attempts: ActionSend[] = [];
  const rec: SendLog = { dataDir: deps.dataDir, groupId, messageId: target.messageId, kind: decision.action, ts: localIso(now) };
  let sent = 0;
  let failures = 0;
  let fallback = false;
  /** 私聊失败的接收人：名单里每个人独立成败，全部跑完再决定兜底 */
  const failedOwners: number[] = [];

  for (const item of plan) {
    attempts.push(item);
    if (await sendOne(deps.client, item, rec)) {
      sent += 1;
      continue;
    }
    failures += 1;
    // 3 级私聊接收人失败 → 记下来，循环结束后群内补一条；举报通道绝不群发
    const isOwnerPrivate = item.scope === 'private' && decision.channel !== 'report' && owners.includes(item.to);
    if (!isOwnerPrivate || failedOwners.includes(item.to)) continue;
    failedOwners.push(item.to);
  }

  if (failedOwners.length > 0 && deps.actions.groupSilent) {
    log.warn(
      `[action] 群${groupId} 消息${target.messageId} 私聊 ${failedOwners.length} 个收件人没发出去，groupSilent=true 不群内兜底`,
    );
  } else if (failedOwners.length > 0) {
    // 一轮只补一条群内提醒（不按人数刷屏）：把失败的接收人一起 @ 上
    const fbItem = ownerFallbackSend(groupId, failedOwners, OWNER_FALLBACK_TEXT);
    attempts.push(fbItem);
    fallback = true;
    if (await sendOne(deps.client, fbItem, rec)) sent += 1;
    else failures += 1;
  }

  if (sent > 0) markFired(deps.store, target.messageId);
  log.info(
    `[action] 群${groupId} 消息${target.messageId} 动作${decision.action} 成功${sent} 失败${failures}${fallback ? '（含群内兜底）' : ''}`,
  );
  return { status: 'sent', attempts, sent, failures, fallback };
}

/**
 * 运维通道回复（方案 §4 `#test`）：只私聊、只回给发起人，绝不进群。
 * 刻意绕过 executeAction 的 dryRun / 幂等 / 当日动作额度——它不是群内动作，
 * 是问机器人自己要状态，dryRun 时更该能问。发送成败照常落一把 sent.jsonl。
 */
export async function replyToOperator(deps: ActionDeps, userId: number, text: string): Promise<boolean> {
  const item = privateSend(userId, text);
  const now = clockOf(deps);
  // 私聊诊断（2026-11-02）：私聊回复只许发给发起人，把「发给谁」写进日志
  log.info(`[action] 私聊回复 → ${item.to}（${item.text.length} 字）`);
  let ok = true;
  try {
    await deps.client.sendPrivate(item.to, item.segments);
  } catch (err) {
    ok = false;
    log.error(`[action] 运维回复发送失败（不重试）：${describeSend(item)}`, err);
  }
  if (deps.dataDir !== undefined) {
    await appendSent(deps.dataDir, {
      ts: localIso(now),
      groupId: 0,
      messageId: 0,
      scope: item.scope,
      to: item.to,
      kind: 'selftest',
      text: item.text,
      ok,
    });
  }
  return ok;
}

/**
 * 通知类私聊（2026-11-01 用户拍板）：
 * 炸群报警词、条款 9（bhhs 等）命中后，把证据私聊发给主人 + 群主（ownerListOf 的名单）。
 * 不进群、不动群内动作额度、不受冷却影响；dryRun 时只打日志，一条都不发。
 */
export interface NotifyReport {
  status: 'sent' | 'dry-run' | 'no-recipient';
  to: number[];
  sent: number;
  failures: number;
}

export async function notifyOwners(
  deps: ActionDeps,
  opts: {
    why: string;
    decision: Decision;
    target: ActionTarget;
    groupId: number;
    /** true = 通知类私聊不受 dryRun 拦截（config.json 的 notify.enabled）；群里动作仍归 dryRun 管 */
    live?: boolean;
  },
): Promise<NotifyReport> {
  // 与 3 级证据同一套收件人解析（方案 §14.2）：绑定群只发绑定者 + adminQqs，未绑定回退全局
  const owners = recipientListOf(deps, opts.groupId);
  if (owners.length === 0) return { status: 'no-recipient', to: [], sent: 0, failures: 0 };

  const now = clockOf(deps);
  const text = `${NOTIFY_TITLE}${opts.why}\n${ownerEvidenceText(opts.decision, opts.target, opts.groupId, now)}`;
  if (deps.actions.dryRun && opts.live !== true) {
    for (const to of owners) {
      log.info(
        `[action][dryRun] 将私聊通知 ${to}（${opts.why}）：群${opts.groupId} 消息${opts.target.messageId}`,
      );
    }
    return { status: 'dry-run', to: owners, sent: 0, failures: 0 };
  }

  const rec: SendLog = {
    dataDir: deps.dataDir,
    groupId: opts.groupId,
    messageId: opts.target.messageId,
    kind: 'notify',
    ts: localIso(now),
  };
  let sent = 0;
  let failures = 0;
  for (const to of owners) {
    if (await sendOne(deps.client, privateSend(to, text), rec)) sent += 1;
    else failures += 1;
  }
  log.info(
    `[action] 群${opts.groupId} 消息${opts.target.messageId} 通知${opts.why} 成功${sent} 失败${failures}`,
  );
  return { status: 'sent', to: owners, sent, failures };
}
