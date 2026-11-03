/**
 * 色情静默闸门（2026-11-02 用户拍板）。
 *
 * 口径：R7 / REDLINE 只有「极端」文字才在群里出声；其余一律群里一个字不发，私聊照发。
 * 进群七类：交易、招嫖、站点、猥亵、长篇、导流、换脸。
 * 只私聊：未成年/恋童（用户判断可能是玩笑）、口嗨绕词、新闻讨论。
 *
 * 词表在 config.json 的 guard.silentSex.extreme 里可覆盖；「站点」「长篇」两组是谓词判定，词表留空。
 */
import type { RuleId } from './types.ts';

export interface SilentSexConfig {
  /** 受闸门管的条款 */
  rules: RuleId[];
  /** 极端词表：组名 → 词列表（空数组＝该组不用词表判定） */
  extreme: Record<string, string[]>;
}

export const SILENT_SEX_GROUPS = ['交易', '招嫖', '站点', '猥亵', '长篇', '导流', '换脸'] as const;
export type SilentSexGroup = (typeof SILENT_SEX_GROUPS)[number];

/** 判定「在说色情」的底词：极端组大多要先落到色情语境上 */
const SEX_WORDS = [
  '色情',
  '涉黄',
  '黄图',
  '色图',
  '涩图',
  '涩涩',
  '裸照',
  '裸体',
  '露点',
  '无码',
  '黄片',
  '黄漫',
  '成人视频',
  '发情',
  '性行为',
  '约炮',
  '卖淫',
  '嫖娼',
  '色情直播',
  '福利姬',
  '裸聊',
  '恋童',
  '萝莉',
  '正太',
  '幼女',
  '开苞',
];

/** 未成年 + 性语境：E3「初中的要不要，13 岁刚开发」这类，用户判为玩笑，只该私聊 */
const MINOR_RE = /初中|小学|初一|初二|高中|未成年|1[3-7]\s*岁/;
const SEXUAL_INTENT_RE = /要不要|开发|约|睡|做|摸|看|玩/;

/** 长篇描写用的动作词，命中 3 个以上才算「大段描写」 */
const ACT_WORDS = ['插', '舔', '操', '口交', '床上', '姿势', '高潮', '射', '脱光', '抚摸', '呻吟', '下体'];

/** 价码：招嫖组要求同时有价码或色情语境，避免「一小时」这种日常词误报 */
const PRICE_RE = /[0-9]{2,5}\s*(元|块|rmb|一小时|一次|一晚)/i;
const LINK_RE = /https?:\/\/|\b[a-z0-9-]+\.(?:com|net|xyz|top|cc|vip|me|io|cn)\b/i;
/** 换脸组要求指名「被做成视频的人」 */
const CLOSE_RE = /照片|视频|同学|同事|熟人|朋友/;

export const DEFAULT_SILENT_SEX: SilentSexConfig = {
  rules: ['R7', 'REDLINE'],
  extreme: {
    交易: ['打包', '一套', '私我', '多少钱', '包月', '会员', '充值', '收钱', '套餐', '单价'],
    招嫖: ['有妹', '上门', '包夜', '一小时', '点钟', '楼凤', '快餐', '学生妹', '兼职妹'],
    站点: [],
    猥亵: ['舔', '操你', '操死', '睡你', '摸你', '给你口', '发我裸照', '来我家', '亲你'],
    长篇: [],
    导流: ['房间号', '直播间', '进来就脱', '露点直播', '开播了', '房号'],
    换脸: ['换脸', 'ai换脸', '做成那种视频', '合成视频', '假视频'],
  },
};

function low(s: string): string {
  return s.toLowerCase();
}

function wordsOf(cfg: SilentSexConfig, group: SilentSexGroup): string[] {
  const raw = cfg.extreme[group];
  return Array.isArray(raw) ? raw.map((w) => low(w)) : [];
}

function hasAny(text: string, list: string[]): boolean {
  for (const w of list) if (w !== '' && text.includes(w)) return true;
  return false;
}

function countAny(text: string, list: string[]): number {
  let n = 0;
  for (const w of list) if (w !== '' && text.includes(w)) n += 1;
  return n;
}

/**
 * 本条是不是在说色情（闸门的前置）：只靠条款号不够——REDLINE 里还有毒品/军火/枪支，
 * 那些第二次该升档，绝不能因为「条款在静默名单里」被一起静音。
 */
export function looksSexual(text: string, cfg?: SilentSexConfig): boolean {
  const t = low(text);
  if (hasAny(t, SEX_WORDS)) return true;
  if (MINOR_RE.test(t) && SEXUAL_INTENT_RE.test(t)) return true;
  return extremeSexGroups(text, cfg).length > 0;
}

/** 条款是否归闸门管（默认 R7 + REDLINE） */
export function isSilentSexRule(rule: RuleId, cfg?: SilentSexConfig): boolean {
  const c = cfg === undefined ? DEFAULT_SILENT_SEX : cfg;
  return c.rules.includes(rule);
}

/** 命中的极端组；空数组＝够不上极端，只该私聊 */
export function extremeSexGroups(text: string, cfg?: SilentSexConfig): SilentSexGroup[] {
  const c = cfg === undefined ? DEFAULT_SILENT_SEX : cfg;
  const t = low(text);
  const sex = hasAny(t, SEX_WORDS);
  const hits: SilentSexGroup[] = [];

  if (sex && hasAny(t, wordsOf(c, '交易'))) hits.push('交易');
  if (hasAny(t, wordsOf(c, '招嫖')) && (PRICE_RE.test(t) || sex)) hits.push('招嫖');
  if (LINK_RE.test(t) && sex) hits.push('站点');
  if (hasAny(t, wordsOf(c, '猥亵'))) hits.push('猥亵');
  if (t.replace(/\s+/g, '').length >= 120 && countAny(t, ACT_WORDS) >= 3) hits.push('长篇');
  if (hasAny(t, wordsOf(c, '导流'))) hits.push('导流');
  if (hasAny(t, wordsOf(c, '换脸')) && CLOSE_RE.test(t)) hits.push('换脸');

  return hits;
}

export function isExtremeSexText(text: string, cfg?: SilentSexConfig): boolean {
  return extremeSexGroups(text, cfg).length > 0;
}
