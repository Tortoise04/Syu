/**
 * `#test` 自检命令（采集与自检方案 §4）。
 *
 * 三条硬规矩：
 * 1) 只有主人与群主能用（名单由上层传进来），其他人静默忽略——不回复、不记录、不落 collect；
 * 2) 回复只走私聊，群里一个字都不回；
 * 3) 本模块不碰环形缓冲、不写 violations.jsonl、不执行动作；`#test pipe` 用全新的空 RingBuffer。
 *
 * 花钱的口子只有两个：`#test judge` 和 `#test pipe` 走真实 takeBudget()，
 * 预算耗尽时直接回「今日预算已用尽」，不硬送。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GuardConfig } from '../config.ts';
import type { MessageEvent } from '../onebot/types.ts';
import type { StateStore } from '../state.ts';
import { log } from '../log.ts';
import { RingBuffer, scan } from './rules.ts';
import type { ContextItem, RuleId } from './types.ts';
import type { PipeContext, PipelineDeps, PipeResult } from './pipeline.ts';
import { handleMessage, thresholdFor } from './pipeline.ts';
import {
  DEFAULT_SAMPLE_RATES,
  SAMPLE_RATE_DAY,
  SAMPLE_RATE_NIGHT,
  type SampleRates,
} from './sample.ts';

export const SELF_TEST_PREFIX = '#test';
/** 文本入参上限，与方案一致 */
const INPUT_MAX = 200;
/** `#test pipe` 空文本时用的默认句（方案 §4 原文） */
const DEFAULT_PIPE_TEXT = '这是一条 #test 测试消息';
/** `#test pipe` 用的临时环形缓冲容量，与 RING_CAP 保持一致 */
const PIPE_RING_CAP = 30;

export interface SelfTestContext {
  /** 原始消息正文，含 `#test` 前缀 */
  text: string;
  senderId: number;
  /** 进程启动时刻（ms），用于算 uptime */
  startedAt: number;
  config: GuardConfig;
  store: StateStore;
  deps: PipelineDeps;
  /** 真实每群环形缓冲，只读条数，绝不写入 */
  rings: Map<number, RingBuffer>;
  /** 主人 + 群主，由上层合并好 */
  operators: number[];
  collect: { enabled: boolean; dir: string; lines: number };
  screen: { enabled: boolean; degraded: boolean };
  selfId: number;
  online: boolean;
  /** 配置热加载（2026-11-02）：由 index.ts 接进来，返回一句给人看的结果 */
  reload?: () => Promise<string>;
}

/** 独立成词才算命令：`#testxxx` 不是命令 */
export function isSelfTestCommand(text: string): boolean {
  const t = text.trimStart();
  if (!t.startsWith(SELF_TEST_PREFIX)) return false;
  const rest = t.slice(SELF_TEST_PREFIX.length);
  return rest.length === 0 || /^\s/.test(rest);
}

export function isOperator(senderId: number, operators: number[]): boolean {
  return operators.includes(senderId);
}

function clampText(raw: string): string {
  const t = raw.trim();
  return t.length > INPUT_MAX ? t.slice(0, INPUT_MAX) : t;
}

function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  parts.push(`${mins} 分`);
  return parts.join(' ');
}

function localDayStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function localClock(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

/** 今天那个 collect 文件已经有多少行；读不到就当 0，不抛 */
async function countCollectLines(dir: string, now: Date): Promise<number> {
  try {
    const raw = await readFile(path.join(dir, `${localDayStamp(now)}.jsonl`), 'utf8');
    return raw.split('\n').filter((x) => x.length > 0).length;
  } catch {
    return 0;
  }
}

function rateLine(rates: SampleRates): string {
  const unknown =
    rates.unknown === undefined
      ? `按时间（白天 ${SAMPLE_RATE_DAY}、0–8 点 ${SAMPLE_RATE_NIGHT}）`
      : String(rates.unknown);
  return `suspicious=${rates.suspicious} clean=${rates.clean} unknown=${unknown}`;
}

function usage(): string {
  return [
    '【#test 用法】仅主人/群主可用；私聊回复，群里不回',
    '',
    '#test / #test status       快照（不调任何模型）',
    '#test rules <文本>         只跑关键词/链接层',
    '#test screen <文本>        只跑本地粗筛（占 GPU）',
    '#test judge <文本>         只跑云端终审（占 1 次云预算）',
    '#test pipe <文本>          空上下文跑完整链路（不动作、不写记录）',
    '#test reload               重新读 config.json / .env（不重启进程）',
    '#test help                 本用法',
    '',
    `文本截断到 ${INPUT_MAX} 字。`,
  ].join('\n');
}

function statusText(ctx: SelfTestContext): string {
  const cfg = ctx.config;
  const now = new Date();
  const snap = ctx.store.snapshot;
  const rates = cfg.judge.sample ?? DEFAULT_SAMPLE_RATES;
  const groups = cfg.onebot.groupIds;
  const perGroup = snap.budget.perGroup;
  const groupPart =
    groups.length === 0
      ? '（未配置）'
      : groups
          .map((gid) => {
            // 每群真实上限 = groupDaily 覆盖值 ?? perGroup（与 state.ts takeBudget 同口径）
            const cap = cfg.guard.budget.groupDaily?.[String(gid)] ?? cfg.guard.budget.perGroup;
            const mark = cfg.guard.budget.groupDaily?.[String(gid)] === undefined ? '' : '*';
            return `${gid} 已用 ${perGroup[String(gid)] ?? 0} / ${cap}${mark}`;
          })
          .join('；');
  const ringTotal = [...ctx.rings.values()].reduce((n, r) => n + r.size, 0);

  const lines = [
    '【群守卫·自检】',
    `版本：M3 抽样送云 + 原始流落盘`,
    `运行：${formatDuration(Date.now() - ctx.startedAt)}（启动于 ${localClock(new Date(ctx.startedAt))}）`,
    `连接：${ctx.online ? '已连上协议端' : '未连上协议端'}（登录 ${ctx.selfId}）`,
    `守卫群：${groups.length} 个${groups.length === 0 ? '' : `（${groups.join('、')}）`}`,
    `今日预算：已用 ${snap.budget.total} / ${cfg.guard.budget.daily}；${groupPart}`,
    `粗筛：${ctx.screen.enabled ? '开启' : '关闭'}${ctx.screen.degraded ? '（当前降级中）' : ''}`,
    `终审：${cfg.judge.model}（云端 key ${cfg.judge.apiKey === undefined ? '未配置' : '已配置'}）`,
    `抽样：${rateLine(rates)}`,
    cfg.collect.enabled
      ? `采集：已开启 → ${ctx.collect.dir}（今日 ${ctx.collect.lines} 行）`
      : '采集：未开启（config.json 的 collect.enabled=false）',
    `环形缓冲：${ctx.rings.size} 个群共 ${ringTotal} 条`,
    `动作：dryRun=${cfg.actions.dryRun}（${cfg.actions.dryRun ? '只打日志不真发' : '会真发'}），每日上限 ${cfg.actions.actionDailyCap}`,
    `状态文件：${path.join(cfg.dataDir, 'state.json')}（${snap.date}）`,
  ];
  return lines.join('\n');
}

function rulesText(ctx: SelfTestContext, body: string): string | null {
  const text = clampText(body);
  if (text.length === 0) return '用法：#test rules <文本>';
  const found = scan(text, ctx.deps.rules.table, {
    linkWhitelist: ctx.deps.rules.linkWhitelist,
  });
  const lines = ['【#test rules】' + text];

  if (found.hits.length === 0 && !found.hasLink) {
    lines.push('命中：0 个');
    lines.push('结论：无必判命中 → 进本地粗筛');
    return lines.join('\n');
  }

  if (found.hits.length > 0) {
    const must = found.hits.filter((h) => h.mustJudge).length;
    lines.push(`命中：${found.hits.length} 个（必判 ${must}）`);
    for (const h of found.hits) {
      lines.push(`  · ${h.word}（${h.rule}，${h.mustJudge ? '必判' : '只记录'}）`);
    }
  } else {
    lines.push('命中：0 个关键词');
  }
  if (found.hasLink) {
    lines.push(`链接：${found.linkHosts.join('、') || '（无域名）'}`);
  }
  if (found.mustJudge) {
    lines.push('结论：进必判分支，会送云端终审');
  } else {
    lines.push('结论：只有 recordOnly 命中 → 只记录，不送审、不占预算');
  }
  return lines.join('\n');
}

async function screenText(ctx: SelfTestContext, body: string): Promise<string | null> {
  const text = clampText(body);
  if (text.length === 0) return '用法：#test screen <文本>';
  const started = Date.now();
  let result;
  try {
    // 不带上下文：自检要的是「换个时候再跑结果应当一样」，掺真实上下文就不可复现了
    result = await ctx.deps.screener.screen(text, []);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `【#test screen】${text}\n粗筛抛出异常：${msg}`;
  }
  const ms = Date.now() - started;
  const lines = [
    `【#test screen】${text}`,
    `判定：${result.verdict}`,
    `条款：${result.rule === undefined ? '（未给）' : result.rule}`,
    `可疑度：${result.score === undefined ? '（未给）' : result.score}`,
    `耗时：${ms}ms`,
    `降级：${result.degraded ? '是' : '否'}${result.detail === undefined ? '' : `（${result.detail}）`}`,
    '上下文：不带（空数组）',
  ];
  return lines.join('\n');
}

function targetOf(text: string, senderId: number): ContextItem {
  return {
    messageId: 0,
    userId: senderId,
    nickname: '#test',
    time: Math.floor(Date.now() / 1000),
    text,
    images: [],
    isTarget: true,
  };
}

async function judgeText(ctx: SelfTestContext, body: string): Promise<string | null> {
  const text = clampText(body);
  if (text.length === 0) return '用法：#test judge <文本>（会占 1 次云预算）';
  const gid = ctx.config.onebot.groupIds[0];
  if (gid === undefined) return '没有配置守卫群，无法扣预算：#test judge 需要 GUARD_GROUP_IDS';
  if (!ctx.store.takeBudget(gid)) {
    return `今日预算已用尽（群 ${gid}），#test judge 不硬送云端，稍后再试`;
  }

  const target = targetOf(text, ctx.senderId);
  const started = Date.now();
  let judged;
  try {
    judged = await ctx.deps.judge.judge({
      channel: 'keyword',
      target,
      context: [target],
      rulesText: ctx.deps.rulesText,
      keywordHits: [],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `【#test judge】${text}\n终审抛出异常：${msg}（已扣 1 次预算）`;
  }
  const ms = Date.now() - started;
  // 与 runJudge 共用同一套门槛算法：1 档提醒走 remind，2/3 档走 normal，红线走 redline
  const threshold = thresholdFor(judged.rule, judged.severity, ctx.deps.thresholds);
  const lines = [
    `【#test judge】${text}`,
    `条款：${judged.rule} → 档位 ${judged.severity}`,
    `置信度：${judged.confidence}（过门槛线 ${threshold}：${judged.confidence >= threshold ? '是' : '否'}）`,
    `理由：${judged.reason}`,
    `降级：${judged.degraded ? '是' : '否'}`,
    `耗时：${ms}ms（已扣 1 次预算）`,
  ];
  return lines.join('\n');
}

async function pipeText(ctx: SelfTestContext, body: string): Promise<string | null> {
  const text = clampText(body) || DEFAULT_PIPE_TEXT;
  const gid = ctx.config.onebot.groupIds[0];
  if (gid === undefined) return '没有配置守卫群，无法跑完整链路：#test pipe 需要 GUARD_GROUP_IDS';

  // 空缓冲：绝不能把自检文本塞进真实上下文
  const ring = new RingBuffer(PIPE_RING_CAP);
  const pipeCtx: PipeContext = { ring };

  // 去掉豁免名单与 selfId：否则主人自己发 #test 会被当成「自己人」直接放行，测不出东西
  const base: PipelineDeps = { ...ctx.deps, selfId: 0, ownerQqs: [] };
  delete base.ownerQq;
  let judgeCalls = 0;
  const deps: PipelineDeps = {
    ...base,
    judge: {
      judge: async (input) => {
        judgeCalls += 1;
        return base.judge.judge(input);
      },
    },
  };

  const ev: MessageEvent = {
    post_type: 'message',
    message_type: 'group',
    time: Math.floor(Date.now() / 1000),
    self_id: 0,
    message_id: Number(String(Date.now()).slice(-9)),
    user_id: ctx.senderId,
    group_id: gid,
    message: text,
    raw_message: text,
    sender: { user_id: ctx.senderId, nickname: '#test', role: 'member' },
  };

  const started = Date.now();
  let res: PipeResult;
  try {
    res = await handleMessage(ev, pipeCtx, deps);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `【#test pipe】${text}\n链路抛出异常：${msg}`;
  }
  const ms = Date.now() - started;
  const lines = [`【#test pipe】${text}`];

  if (res.decision === null || res.record === undefined) {
    lines.push('结论：被豁免（decision=null），这条不会判定');
    return lines.join('\n');
  }

  const d = res.decision;
  const rec = res.record;
  lines.push(`条款：${d.rule} → 档位 ${d.severity}，动作 ${d.action}`);
  lines.push(`通道：${d.channel}`);
  if (rec.sampled === undefined) {
    lines.push('抽检：本条没走抽检（必判/举报/只记录词）');
  } else {
    const roll = rec.sampleRoll === undefined ? '?' : rec.sampleRoll.toFixed(4);
    const rate = rec.sampleRate === undefined ? '?' : String(rec.sampleRate);
    lines.push(
      `抽检：${rec.sampled ? '抽中' : '未抽中'}（roll=${roll} ${rec.sampled ? '<' : '≥'} rate=${rate}）`,
    );
  }
  lines.push(`是否走云：${judgeCalls > 0 ? `是（judge 调用 ${judgeCalls} 次，占 1 次预算）` : '否'}`);
  lines.push(`理由：${d.reason}`);
  lines.push(`记录：severity=${rec.severity} confidence=${rec.confidence}（未写 violations.jsonl）`);
  lines.push(`冷却：${d.cooledDown ? '命中冷却，只记录' : '未命中'}；降级：${d.degraded ? '是' : '否'}`);
  lines.push(`耗时：${ms}ms`);
  return lines.join('\n');
}

/**
 * 执行一条 `#test`。返回要私聊回去的正文；没权限（或不是命令）返回 null → 一个字都不发。
 */
export async function runSelfTest(ctx: SelfTestContext): Promise<string | null> {
  if (!isSelfTestCommand(ctx.text)) return null;
  if (!isOperator(ctx.senderId, ctx.operators)) {
    log.debug(`[selftest] 忽略非授权人的 #test（${ctx.senderId}）`);
    return null;
  }

  const body = ctx.text.trimStart().slice(SELF_TEST_PREFIX.length).trim();
  const space = body.search(/\s/);
  const cmd = (space === -1 ? body : body.slice(0, space)).toLowerCase();
  const rest = space === -1 ? '' : body.slice(space + 1);

  try {
    switch (cmd) {
      case '':
      case 'status': {
        const lines = await countCollectLines(ctx.collect.dir, new Date());
        return statusText({ ...ctx, collect: { ...ctx.collect, lines } });
      }
      case 'rules':
        return rulesText(ctx, rest);
      case 'screen':
        return screenText(ctx, rest);
      case 'judge':
        return judgeText(ctx, rest);
      case 'pipe':
        return pipeText(ctx, rest);
      case 'reload':
        return ctx.reload === undefined ? '热加载未接入（旧进程）' : await ctx.reload();
      case 'help':
        return usage();
      default:
        return [`未知子命令：${cmd}`, '', usage()].join('\n');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    log.error('[selftest] 自检出错（已吞掉，不影响守卫）', err);
    return `【#test ${cmd}】执行出错：${msg}`;
  }
}
