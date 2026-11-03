import path from 'node:path';
import { watch } from 'node:fs';
import { loadConfig } from './config.ts';
import { log, setLogLevel } from './log.ts';
import { OneBotClient } from './onebot/client.ts';
import { StateStore } from './state.ts';
import { RingBuffer } from './guard/rules.ts';
import { Screener } from './guard/screen.ts';
import { Judge } from './guard/judge.ts';
import { handleMessage, handleReport } from './guard/pipeline.ts';
import { appendViolation } from './guard/record.ts';
import { executeAction, notifyOwners, replyToOperator, RULE_TITLES } from './guard/action.ts';
import type { ActionDeps } from './guard/action.ts';
import { isSelfTestCommand, runSelfTest } from './guard/selftest.ts';
import type { SelfTestContext } from './guard/selftest.ts';
import { localIso } from './guard/sent.ts';
import { Collector } from './collect.ts';
import { PrivateInbox } from './inbox.ts';
import { recordLearned, LEARN_FILE } from './guard/learn.ts';
import type { InboxRecord } from './inbox.ts';
import type { PipeContext, PipeResult, PipelineDeps } from './guard/pipeline.ts';
import type { MessageEvent, MessageSegment, OneBotEvent } from './onebot/types.ts';
import type { ViolationRecord } from './guard/types.ts';

/**
 * M2b：判定链路 + 动作链路接线（豁免 → 关键词/链接 → @举报 → 粗筛 → 终审 → 档位 → 记录 → 动作）。
 * 先落 data/violations.jsonl，再动手；发送的唯一出口是 src/guard/action.ts（这里不直接调 send_*）。
 * dryRun 默认 true：不显式关掉就只打日志，一条消息都不发。
 */

const RING_CAP = 30;

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (err) {
  console.error('配置加载失败：', err instanceof Error ? err.message : err);
  process.exit(1);
}

setLogLevel(config.logLevel);
let guardGroups = new Set(config.onebot.groupIds);

const store = new StateStore({
  file: path.join(config.dataDir, 'state.json'),
  budgetDaily: config.guard.budget.daily,
  budgetPerGroup: config.guard.budget.perGroup,
  groupDaily: config.guard.budget.groupDaily,
});
try {
  await store.init();
} catch (err) {
  // 状态起不来也要继续跑：判定照常，只是预算与冷却只在内存里
  log.error('状态初始化失败（继续运行，预算与冷却不落盘）', err);
}

let screener = new Screener({
  baseUrl: config.screen.baseUrl,
  model: config.screen.model,
  enabled: config.screen.enabled,
  timeoutMs: config.screen.timeoutMs,
  gatedTimeoutMs: config.screen.gatedTimeoutMs,
});

let judge = new Judge({
  baseUrl: config.judge.baseUrl,
  apiKey: config.judge.apiKey,
  model: config.judge.model,
  maxTokens: config.judge.maxTokens,
  timeoutMs: config.judge.timeoutMs,
});

const deps: PipelineDeps = {
  store,
  rules: { table: config.guard.keywords, linkWhitelist: config.guard.linkWhitelist },
  screener,
  judge,
  rulesText: config.guard.rulesText,
  thresholds: config.guard.thresholds,
  // 接收人名单只在配置里；自己号由事件自带的 self_id 提供
  ownerQqs: config.onebot.ownerQqs,
  // 按群定向接收人（方案 §14.2）：绑定群 3 级只发绑定者；绑定者仅本群豁免
  groupOwners: config.onebot.groupOwners,
  // 不配 judge.sample 就是 undefined：抽样模块按缺省口径（suspicious 全送、clean 不抽）走
  sample: config.judge.sample,
  // 条款封顶（2026-11-01）：只压档位，不压送云
  caps: config.guard.caps,
  // 不检测名单（2026-11-02）：名单里的人说话不判定，但不是管理员
  whitelist: config.guard.whitelist,
  // 玩笑白名单（2026-11-02 夜间）：整条只剩这些短语时不判不记、不花预算
  exemptPhrases: config.guard.exemptPhrases,
  // 色情静默闸门（2026-11-02）：R7/REDLINE 未命中极端词表时只在私聊出声
  silentSex: config.guard.silentSex,
};

/** 原始群消息落盘（方案 §3.3）：默认关；开了就每条都写，失败只打日志 */
let collector = new Collector({ enabled: config.collect.enabled, dir: config.collect.dir });

/** 私聊收件箱（2026-11-01 拍板）：只收主人私聊原文，不判定、不花预算 */
let inbox = new PrivateInbox({ enabled: config.inbox.enabled, dir: config.inbox.dir });

/** 运维通道名单：主人 + 群主等额外收件人（方案 §4 的 #test 权限） */
let operators = Array.from(
  new Set([...config.onebot.ownerQqs, ...config.notify.adminQqs].filter((qq) => Number.isFinite(qq) && qq > 0)),
);
const startedAt = Date.now();

/** 每群一个环：上下文不能跨群串味 */
const rings = new Map<number, RingBuffer>();
function pipeCtx(groupId: number): PipeContext {
  let ring = rings.get(groupId);
  if (ring === undefined) {
    ring = new RingBuffer(RING_CAP);
    rings.set(groupId, ring);
  }
  return { ring };
}

const client = new OneBotClient({
  wsUrl: config.onebot.wsUrl,
  token: config.onebot.token,
  onReady: (info) => {
    log.ok(`已连上协议端，登录为 ${info.nickname}（${info.user_id}），守 ${guardGroups.size} 个群`);
    log.info(
      `M2b：动作链路已接线，dryRun=${String(config.actions.dryRun)}` +
        (config.actions.dryRun ? '（只打日志不发消息）' : '（会真的发消息）') +
        `，群内静默=${config.actions.groupSilent ? '开（群里一条都不发，只私聊）' : '关（群里会发言）'}` +
        `，每日动作上限 ${config.actions.actionDailyCap}`,
    );
  },
  onEvent: (ev) => {
    try {
      handle(ev);
    } catch (err) {
      log.error('事件处理出错（已吞掉，不退出进程）', err);
    }
  },
});

/** 动作链路的依赖：发送出口、状态、开关、接收人名单、发送流水落位；index 不自己发消息 */
const actionDeps: ActionDeps = {
  client,
  store,
  actions: config.actions,
  ownerQqs: config.onebot.ownerQqs,
  adminQqs: config.notify.adminQqs,
  recipients: config.notify.recipients,
  groupRecipients: config.notify.groupRecipients,
  groupOwners: config.onebot.groupOwners,
  dataDir: config.dataDir,
};

/**
 * 配置热加载（2026-11-02 用户拍板「热重启」）：改 config.json / .env 不用停进程。
 * 能热更的：词表、阈值、条款封顶、抽检率、群规原文、链接白名单、接收人、动作开关、
 * 通知开关、采集与私聊收件箱、粗筛/终审参数、监听群名单、日志级别。
 * 必须重启进程的：ws 地址、token、dataDir（连接与落盘路径已经绑死在启动时）。
 */
let reloading = false;

function keywordCount(guard: ReturnType<typeof loadConfig>['guard']): number {
  const table = guard.keywords;
  return (
    table.redline.length +
    table.alarm.length +
    table.softAlarm.length +
    table.recordOnly.length +
    Object.values(table.rules).reduce((n, list) => n + list.length, 0) +
    Object.values(table.hints).reduce((n, list) => n + list.length, 0)
  );
}

async function reloadConfig(reason: string): Promise<string> {
  if (reloading) return '热加载正在进行，稍后再试';
  reloading = true;
  try {
    let next: ReturnType<typeof loadConfig>;
    try {
      next = loadConfig();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[reload] ${reason}：新配置没过校验，继续用旧配置 —— ${msg}`);
      return `配置有问题，没切换（继续用旧的）：\n${msg}`;
    }

    const needRestart: string[] = [];
    if (next.onebot.wsUrl !== config.onebot.wsUrl) needRestart.push('ONEBOT_WS_URL');
    if (next.onebot.token !== config.onebot.token) needRestart.push('ONEBOT_TOKEN');
    if (next.dataDir !== config.dataDir) needRestart.push('dataDir');

    deps.rules.table = next.guard.keywords;
    deps.rules.linkWhitelist = next.guard.linkWhitelist;
    deps.thresholds = next.guard.thresholds;
    deps.caps = next.guard.caps;
    deps.rulesText = next.guard.rulesText;
    deps.ownerQqs = next.onebot.ownerQqs;
    deps.sample = next.judge.sample;
    deps.groupOwners = next.onebot.groupOwners;
    deps.whitelist = next.guard.whitelist;
    deps.exemptPhrases = next.guard.exemptPhrases;

    actionDeps.actions = next.actions;
    actionDeps.ownerQqs = next.onebot.ownerQqs;
    actionDeps.adminQqs = next.notify.adminQqs;
    actionDeps.recipients = next.notify.recipients;
    actionDeps.groupRecipients = next.notify.groupRecipients;
    actionDeps.groupOwners = next.onebot.groupOwners;

    screener = new Screener({
      baseUrl: next.screen.baseUrl,
      model: next.screen.model,
      enabled: next.screen.enabled,
      timeoutMs: next.screen.timeoutMs,
      gatedTimeoutMs: next.screen.gatedTimeoutMs,
    });
    judge = new Judge({
      baseUrl: next.judge.baseUrl,
      apiKey: next.judge.apiKey,
      model: next.judge.model,
      maxTokens: next.judge.maxTokens,
      timeoutMs: next.judge.timeoutMs,
    });
    deps.screener = screener;
    deps.judge = judge;

    collector = new Collector({ enabled: next.collect.enabled, dir: next.collect.dir });
    inbox = new PrivateInbox({ enabled: next.inbox.enabled, dir: next.inbox.dir });
    operators = Array.from(
      new Set([...next.onebot.ownerQqs, ...next.notify.adminQqs].filter((qq) => Number.isFinite(qq) && qq > 0)),
    );
    guardGroups = new Set(next.onebot.groupIds);
    setLogLevel(next.logLevel);
    config = next;

    log.ok(
      `[reload] ${reason}：配置已生效（词表 ${keywordCount(next.guard)} 词，阈值 redline ${next.guard.thresholds.redline} / remind ${next.guard.thresholds.remind ?? 0.6} / normal ${next.guard.thresholds.normal}，dryRun=${String(next.actions.dryRun)}，守 ${guardGroups.size} 个群）`,
    );
    let text =
      `热加载成功（${reason}）：\n` +
      `词表 ${keywordCount(next.guard)} 词、阈值 redline ${next.guard.thresholds.redline} / remind ${next.guard.thresholds.remind ?? 0.6} / normal ${next.guard.thresholds.normal}\n` +
      `dryRun=${String(next.actions.dryRun)}，动作上限 ${next.actions.actionDailyCap}/天，守 ${guardGroups.size} 个群\n` +
      `粗筛 ${next.screen.enabled ? '开' : '关'}（超时 ${next.screen.timeoutMs}ms）、终审 ${next.judge.model}（超时 ${next.judge.timeoutMs}ms）`;
    if (needRestart.length > 0) {
      text += `\n注意：${needRestart.join('、')} 变了，这类配置必须重启进程才生效（本次没动）`;
      log.warn(`[reload] ${needRestart.join('、')} 变了，需要重启进程才生效`);
    }
    return text;
  } finally {
    reloading = false;
  }
}

/** 文件变更 → 防抖 900ms 热加载；Syncthing 半截写入会校验失败，保持旧配置即可 */
let reloadTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleReload(reason: string): void {
  if (reloadTimer !== undefined) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = undefined;
    void reloadConfig(reason);
  }, 900);
}

function startConfigWatcher(): void {
  const root = process.cwd();
  const watched = [path.join(root, 'config.json'), path.join(root, '.env')];
  for (const file of watched) {
    try {
      watch(file, { persistent: false }, () => scheduleReload(`文件变更：${path.basename(file)}`));
    } catch (err) {
      log.warn(`[reload] 盯不住 ${file}（${err instanceof Error ? err.message : String(err)}），只能靠 #test reload 手动热加载`);
    }
  }
  // 学到的词写在 dataDir，文件变了也要立刻生效
  try {
    watch(config.dataDir, { persistent: false }, (event, filename) => {
      if (filename === null || filename === LEARN_FILE) scheduleReload(`文件变更：${LEARN_FILE}`);
    });
  } catch (err) {
    log.warn(`[reload] 盯不住 data 目录（${err instanceof Error ? err.message : String(err)}），学到的词要等下次热加载才生效`);
  }
}

/** 非文本段一律压成 [type] 占位，日志与送审看到的是同一份文本 */
function plainText(message: string | MessageSegment[]): string {
  if (typeof message === 'string') return message;
  return message
    .map((seg) => {
      if (seg.type === 'text') {
        const t = seg.data.text;
        return typeof t === 'string' ? t : '';
      }
      return `[${seg.type}]`;
    })
    .join('');
}

/** @机器人（at 段目标是自己）或正文以 /举报 开头 */
function isReportEvent(msg: MessageEvent): boolean {
  const selfId = String(client.selfId);
  const atToken = `[CQ:at,qq=${selfId}]`;
  if (Array.isArray(msg.message)) {
    for (const seg of msg.message) {
      if (seg.type !== 'at') continue;
      const qq = seg.data.qq;
      if (qq !== undefined && String(qq) === selfId) return true;
    }
  } else if (msg.message.includes(atToken)) {
    return true;
  }
  if (typeof msg.raw_message === 'string' && msg.raw_message.includes(atToken)) return true;
  return plainText(msg.message).trimStart().startsWith('/举报');
}

function logDecision(rec: ViolationRecord): void {
  const flags: string[] = [];
  if (rec.degraded) flags.push('降级');
  if (rec.cooledDown) flags.push('冷却');
  const tail = flags.length > 0 ? ` ${flags.join('/')}` : '';
  const why = rec.reason.length > 0 ? ` —— ${rec.reason}` : '';
  log.info(
    `[judge] 群${rec.groupId} 用户${rec.userId} 条款${rec.rule} 档${rec.severity} 置信${rec.confidence.toFixed(2)} 动作${rec.action}${tail}${why}`,
  );
}

async function runPipeline(msg: MessageEvent, asReport: boolean): Promise<void> {
  const groupId = Number(msg.group_id ?? 0);
  const ctx = pipeCtx(groupId);
  const res: PipeResult = asReport ? await handleReport(msg, ctx, deps) : await handleMessage(msg, ctx, deps);
  const rec = res.record;
  const decision = res.decision;
  if (decision === null || rec === undefined) return;
  // 先落盘再动手：记录是证据，动作是可失败的外部调用
  await appendViolation(config.dataDir, rec);
  logDecision(rec);

  // 举报受理后的拆词（2026-11-02 用户拍板）：云端除了档位还指回「哪句话惹的祸」，
  // 判到 1 档以上就收进 data/learned-keywords.json（只进 hints：强制本地粗筛、不直通云），
  // 写完立刻热加载，下一条同样的消息就命中；私聊回主人一句「收了什么」。
  if (rec.channel === 'report' && rec.severity >= 1 && typeof rec.span === 'string') {
    const table = deps.rules.table;
    const taken = [
      ...table.redline,
      ...(table.alarm ?? []),
      ...(table.softAlarm ?? []),
      ...table.recordOnly,
      ...Object.values(table.rules).flat(),
      ...Object.values(table.hints ?? {}).flat(),
      ...Object.values(table.gated ?? {}).flat(),
    ];
    const learned = await recordLearned(config.dataDir, {
      span: rec.span,
      rule: rec.rule,
      groupId,
      userId: rec.userId,
      messageId: rec.messageId,
      ts: rec.ts,
      taken,
    });
    if (learned.added) {
      await reloadConfig('举报拆词入库');
      for (const qq of config.onebot.ownerQqs) {
        const tierText =
          learned.tier === 'direct'
            ? 'direct：命中直接送云'
            : 'gated：先本地确认，确认可疑才送云';
        await replyToOperator(
          actionDeps,
          qq,
          `已收词「${learned.word}」→ ${learned.rule}（${tierText}；要删就删 ${path.join(config.dataDir, LEARN_FILE)}）`,
        );
      }
    } else {
      log.debug(`[learn] 没收词「${learned.word}」：${learned.reason}`);
    }
  }

  // 报警词（炸群/喊停）与条款 9：判定完私聊通知主人 + 群主（2026-11-01 用户拍板）。
  // 只私聊、不进群；dryRun 时只打日志。
  const alarmHit = decision.hits.some((hit) => hit.kind === 'alarm');
  // 通知触发（2026-11-01 用户拍板）：炸群报警词 / 条款9 / 终审到 S2 及以上。
  // 只私聊主人 + 群主，群里一个字不发；notify.enabled=true 时通知不受 dryRun 拦截。
  const noticeWhy = alarmHit
    ? '炸群报警词'
    : rec.rule === 'R9'
      ? '条款9（bhhs 等）只记录'
      : decision.action === 'notify'
        ? '色情静默（本条未在群里提醒）'
        : rec.severity >= 2
          ? `判定到 ${rec.severity} 级（${RULE_TITLES[rec.rule]}）`
          : undefined;
  if (noticeWhy !== undefined && decision.action === 'escalate') {
    // 3 级：群内警示 + 私聊证据已经发给同一批收件人，不再补第二条通知（2026-11-02 修重复私聊）
    log.info(
      `[action] 群${groupId} 消息${rec.messageId} 3 级证据已私聊同一批收件人，跳过通知（${noticeWhy}）`,
    );
  } else if (noticeWhy !== undefined) {
    const notice = await notifyOwners(actionDeps, {
      why: noticeWhy,
      decision,
      target: rec,
      groupId,
      live: config.notify.enabled,
    });
    if (notice.failures > 0) {
      log.error(`[action] 群${groupId} 消息${rec.messageId} 通知${noticeWhy} 有 ${notice.failures} 条没发出去（不重试）`);
    }
  }

  // 举报通道的回执发举报人（msg.user_id），不是被举报那条的作者
  const report = await executeAction(actionDeps, decision, rec, groupId, Number(msg.user_id));
  if (report.failures > 0) {
    log.error(
      `[action] 群${groupId} 消息${rec.messageId} 有 ${report.failures} 条没发出去（不重试，只记日志）` +
        (report.fallback ? '，已群内 @主人 兜底' : ''),
    );
  }
}

/** `#test` 的回复出口：只私聊回发起人；runSelfTest 返回 null（不是命令/没权限）时一个字都不发 */
async function answerSelfTest(senderId: number, text: string, groupId: number): Promise<void> {
  const ctx: SelfTestContext = {
    text,
    senderId,
    startedAt,
    config,
    store,
    deps,
    rings,
    operators,
    collect: { enabled: collector.enabled, dir: collector.dir, lines: collector.lines },
    screen: { enabled: config.screen.enabled, degraded: screener.degraded },
    selfId: client.selfId,
    online: client.online,
    reload: () => reloadConfig('手动 #test reload'),
  };
  const reply = await runSelfTest(ctx);
  if (reply === null) return;
  log.info(`[selftest] ${senderId} 的 #test 已私聊回复（${reply.length} 字，群${groupId}）`);
  await replyToOperator(actionDeps, senderId, reply);
}

/**
 * 私聊收件箱（用户 2026-11-01 拍板「私聊只收不判」）：
 * 只收 OWNER_QQ 名单里的人，原文落 D 盘并回一行回执；其他人私聊静默丢弃。
 * 不判定、不进 collect、不写 violations、不花云预算。
 */
async function ingestPrivate(msg: MessageEvent, senderId: number): Promise<void> {
  if (!config.inbox.enabled) return;
  if (!config.onebot.ownerQqs.includes(senderId)) return;

  const nickname = msg.sender?.card || msg.sender?.nickname || String(senderId);
  const text = plainText(msg.message);
  const segments = Array.isArray(msg.message) ? msg.message : [];
  const rec: InboxRecord = {
    ts: localIso(new Date()),
    userId: senderId,
    nickname,
    messageId: Number(msg.message_id),
    segTypes: segments.map((seg) => seg.type),
    text,
    raw: typeof msg.raw_message === 'string' ? msg.raw_message : text,
    message: msg.message,
  };

  // 合并转发在消息里只有一个 id，内容要单独取；取不到就只留原始段（原文不丢，内容可能过期）
  for (const seg of segments) {
    if (seg.type !== 'forward') continue;
    const idRaw = (seg as { data?: { id?: unknown } }).data?.id;
    const id = idRaw === undefined ? '' : String(idRaw);
    if (id === '') continue;
    const expanded = await client.getForwardMsg(id);
    if (expanded !== null) {
      rec.forward = expanded;
      break;
    }
  }

  const seq = inbox.append(rec);
  log.info(
    `[inbox] 已存主人私聊 1 条（今天第 ${seq} 条，${rec.segTypes.join('+') || 'text'}）`,
  );
  await replyToOperator(actionDeps, senderId, `已收（今天第 ${seq} 条），存 ${inbox.todayFile()}`);
  log.info(`[inbox] 回执 → ${senderId}（今天第 ${seq} 条）`);
}

function handle(ev: OneBotEvent): void {
  if (config.mock) log.debug(`原始事件 ${JSON.stringify(ev)}`);
  if (ev.post_type !== 'message') return;
  const msg: MessageEvent = ev;
  const senderId = Number(msg.sender?.user_id ?? msg.user_id);
  const text = plainText(msg.message);

  // 私聊只认 #test（运维通道）与收件箱；不判定、不回复其他人
  if (msg.message_type === 'private') {
    if (senderId === client.selfId) return;
    // 私聊诊断（2026-11-02）：只记来源、身份和是不是命令，不记正文——
    // 出过一次「回执到底发给了谁」对不上的疑问，靠这行反查。
    const fromOwner = config.onebot.ownerQqs.includes(senderId);
    const isCmd = isSelfTestCommand(text);
    log.info(
      `[private] 收到私聊 发送者=${senderId} 消息ID=${Number(msg.message_id) || 0} 主人=${fromOwner ? '是' : '否'} 命令=${isCmd ? '是' : '否'}`,
    );
    if (isCmd) {
      void answerSelfTest(senderId, text, 0).catch((err: unknown) => {
        log.error('#test 处理出错（已吞掉，不退出进程）', err);
      });
      return;
    }
    void ingestPrivate(msg, senderId).catch((err: unknown) => {
      log.error('私聊收件出错（已吞掉，不退出进程）', err);
    });
    return;
  }

  if (msg.message_type !== 'group' || msg.group_id === undefined) return;
  if (senderId === client.selfId) return;
  if (!guardGroups.has(Number(msg.group_id))) return;
  if (client.isDuplicate(Number(msg.message_id))) return;

  const nickname = msg.sender?.card || msg.sender?.nickname || String(senderId);
  const groupId = Number(msg.group_id);
  // 这行是 npm run smoke 的断言对象：格式与位置都不动；判定在其后异步跑，不拖慢收消息
  log.recv(groupId, senderId, nickname, text);

  // `#test` 必须在管线之前拦下（方案 §6）：不 push 环、不落 collect、不写 violations、群里不回话
  if (isSelfTestCommand(text)) {
    void answerSelfTest(senderId, text, groupId).catch((err: unknown) => {
      log.error('#test 处理出错（已吞掉，不退出进程）', err);
    });
    return;
  }

  // 采集钩子：守卫群里每条真实消息落一行（只排队落盘，不阻塞判定）
  collector.append({
    ts: localIso(new Date()),
    groupId,
    userId: senderId,
    nickname,
    messageId: Number(msg.message_id),
    role: msg.sender?.role ?? 'member',
    text,
    segTypes: Array.isArray(msg.message) ? msg.message.map((seg) => seg.type) : ['text'],
    raw: typeof msg.raw_message === 'string' ? msg.raw_message : text,
  });

  const asReport = isReportEvent(msg);
  runPipeline(msg, asReport).catch((err: unknown) => {
    // 单条消息炸了不能带走进程；appendViolation 在判定之后才动盘，不会写半条记录
    log.error('判定链路出错（已吞掉，不退出进程）', err);
  });
}

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log.info(`收到 ${signal}，断开协议端并落盘状态`);
  client.close();
  try {
    await store.flush();
  } catch (err) {
    log.error('退出前状态落盘失败', err);
  }
  try {
    await collector.flush();
  } catch (err) {
    log.error('退出前采集队列没排干', err);
  }
  try {
    await inbox.flush();
  } catch (err) {
    log.error('退出前私聊收件队列没排干', err);
  }
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

log.info(
  `守卫机器人启动（M3：抽样送云 + 自检 + 采集，dryRun=${String(config.actions.dryRun)}），连 ${config.onebot.wsUrl}，守 ${guardGroups.size} 个群`,
);
const sampleRates = config.judge.sample;
log.info(
  sampleRates === undefined
    ? '送云抽样：config.json 未配 judge.sample → suspicious 全送、clean 不抽、unknown 按时间（0–8 点 0.01，其余 0.05）'
    : `送云抽样：suspicious=${sampleRates.suspicious} clean=${sampleRates.clean} unknown=${sampleRates.unknown === undefined ? '按时间' : sampleRates.unknown}`,
);
log.info(
  collector.enabled
    ? `原始流落盘：开启 → ${collector.dir}\\YYYYMMDD.jsonl（含原文与群号，仅服务器 D 盘）`
    : '原始流落盘：关闭（config.json 的 collect.enabled=false）',
);
log.info(`运维通道（#test）：${operators.join('、') || '（未配置）'}`);
log.info(
  inbox.enabled
    ? `私聊收件箱：开启 → ${inbox.dir}\\YYYYMMDD.jsonl（只收 ${config.onebot.ownerQqs.join('、') || '（未配置）'}，不判定）`
    : '私聊收件箱：关闭（config.json 的 inbox.enabled=false）',
);
const capEntries = Object.entries(config.guard.caps);
log.info(
  capEntries.length > 0
    ? `条款封顶：${capEntries.map(([rule, cap]) => `${rule} 封 ${cap} 档`).join('、')}（照常送云，只压档位）`
    : '条款封顶：未配置（所有条款按终审档位出手）',
);
const boundGroupCount = Object.keys(config.onebot.groupOwners).length;
log.info(
  boundGroupCount > 0
    ? `按群定向：${boundGroupCount} 个群有专属接收人（${Object.keys(config.onebot.groupOwners).join('、')}），其余群回退全局 OWNER_QQ`
    : '按群定向：未配置 GUARD_GROUP_OWNERS，全部群用全局 OWNER_QQ',
);
startConfigWatcher();
log.info('配置热加载：已盯住 config.json / .env / data/learned-keywords.json（改完 1 秒内生效，也可 #test reload）');
client.connect();
