/**
 * M2a-B 规则层：纯本地、无网络、确定性。
 * 职责：文本归一化、关键词/链接命中、豁免判断、上下文环形缓冲、多命中合并。
 * 它不做任何判定，只回答「这条消息命中了什么、要不要送审、上下文长什么样」。
 * 约束：不 import 任何网络/文件模块，不打印日志。
 */
import type { ContextItem, KeywordHit, RuleId, Severity } from './types.ts';
import type { MessageEvent, MessageSegment } from '../onebot/types.ts';

export interface KeywordTable {
  redline: string[];
  /** 报警词（炸群/喊停）：直通云，不预设条款——命中落成 OTHER，条款由终审判 */
  alarm?: string[];
  /**
   * 软报警词（别聊了/打住/撤一下）：日常聊天也用，只强制过本地粗筛，不直通云。
   * 2026-11-01 分档：59 条样本里「撤一下」是唯一被证实会误报的叫停词。
   */
  softAlarm?: string[];
  rules: Record<string, string[]>;
  /**
   * 低精度词（话题名/行为名/标签词，如「时政」「广告」「女拳」）：
   * 命中只强制过本地粗筛，粗筛判 suspicious 后才可能送云。2026-11-01 分档。
   */
  hints?: Record<string, string[]>;
  /**
   * 需本地确认的词（731/见证/垃圾 这类：命中不代表违规，语境决定一切）：
   * 命中先跑一次带思考链的本地确认（think），确认可疑才送云；确认干净只记录。
   * 2026-11-02 分档（用户 m01530 拍板）。
   */
  gated?: Record<string, string[]>;
  recordOnly: string[];
}

export interface HitScan {
  hits: KeywordHit[];
  hasLink: boolean;
  linkHosts: string[];
  mustJudge: boolean;
  /** 命中过 hints/softAlarm：调用方须继续走本地粗筛，不能按纯 recordOnly 提前返回 */
  hasHint: boolean;
  /** 命中过 gated：调用方须先跑本地确认（think），可疑才送云 */
  hasGated: boolean;
}

const IMAGE_PLACEHOLDER = '[image]';

const RULE_IDS: readonly RuleId[] = ['R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11'];
const RULE_ID_SET: ReadonlySet<string> = new Set<string>(RULE_IDS);

/**
 * recordOnly 词在 v0.2 词表里挂在条款 4 下：本层只覆盖 mustJudge（不送审），
 * 不覆盖归属条款。要改归属只改这一个常量。
 */
const RECORD_ONLY_RULE: RuleId = 'R4';

/** topRule 优先级，靠前的赢 */
const RULE_PRIORITY: readonly RuleId[] = ['REDLINE', 'R10', 'R11', 'R3', 'R4', 'R6', 'R7', 'R8', 'R9', 'R5', 'OTHER'];

/** 裸域名判定辅助：整体就是一个文件名（无 scheme、无路径）时不算链接，避免 1.jpg 之类误报 */
const FILE_EXT: ReadonlySet<string> = new Set<string>([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'mp4', 'mkv', 'mov', 'avi', 'mp3', 'wav', 'flac',
  'txt', 'md', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'rar', '7z', 'gz', 'exe', 'msi',
  'apk', 'js', 'mjs', 'cjs', 'jsx', 'tsx', 'json', 'html', 'htm', 'css', 'py', 'ini', 'log', 'toml', 'yml', 'yaml',
]);

// ---------------------------------------------------------------- 归一化

const FULLWIDTH_RE = /[\uFF01-\uFF5E]/g;
const WS_RE = /\s+/g;

/**
 * v1 归一化：NFKC + 残留全角 ASCII 转半角 + 拉丁小写 + 空白折叠。
 * 不做谐音/拆写/emoji 间隔归一，也不做繁简转换（v2 再说）。
 */
export function normalize(text: string): string {
  if (typeof text !== 'string') throw new TypeError('normalize: text 必须是字符串');
  let out = text.normalize('NFKC');
  // NFKC 之后理论上不该再有全角 ASCII，这里兜一层（U+FF01..FF5E 减 0xFEE0 即半角）
  out = out.replace(FULLWIDTH_RE, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  out = out.toLowerCase();
  out = out.replace(WS_RE, ' ').trim();
  return out;
}

// ---------------------------------------------------------------- 玩笑白名单

const AT_MARK_RE = /\[at:\d+\]/g;
const REPLY_MARK_RE = /\[reply\]/g;
/** 标点、符号（含 emoji）、空白一律不算内容 */
const NOISE_RE = /[\p{P}\p{S}\s]/gu;

function phraseCore(text: string): string {
  return normalize(text.replace(AT_MARK_RE, ' ').replace(REPLY_MARK_RE, ' ')).replace(NOISE_RE, '');
}

/**
 * 玩笑白名单（2026-11-02 夜间用户拍板，整条级）：
 * 去掉 @、引用标记、标点、符号、空白之后，整条只剩白名单短语（可重复）才返回 true。
 * 只要还夹着别的内容就返回 false，照原文判——「草死你」放行，「草死你喵」「草死你妈」都不算。
 */
export function isOnlyExemptPhrase(text: string, phrases: readonly string[] | undefined): boolean {
  if (typeof text !== 'string') throw new TypeError('isOnlyExemptPhrase: text 必须是字符串');
  if (!Array.isArray(phrases) || phrases.length === 0) return false;
  const core = phraseCore(text);
  if (core.length === 0) return false;
  for (const raw of phrases) {
    if (typeof raw !== 'string') continue;
    const p = phraseCore(raw);
    if (p.length === 0 || core.length % p.length !== 0) continue;
    if (core === p.repeat(core.length / p.length)) return true;
  }
  return false;
}

// ------------------------------------------------------ 「艹」类口头语

/** 「艹」的常见写法（normalize 之后基本只剩这几种；曹是规避写法） */
const CAO_CHARS = '艹操草肏曹';
const CAO_RE = new RegExp(`[${CAO_CHARS}]`, 'u');
/**
 * 家庭辱骂（2026-11-03 用户拍板）：只有骂到家里人这一种才照判。
 * 覆盖谐音/字母规避写法：草泥马 / 草拟吗 / 操你m / 操你ma / 草你全家 / 曹死你吗。
 */
const FAMILY_INSULT_RE = new RegExp(
  `[${CAO_CHARS}](?:死|飞|爆|饲)?(?:你|泥|拟|尼|妳|他|她|它)?(?:妈|马|麻|吗|媽|m|ma|mb|全家|祖宗|家里人|家人|老母|爸|爹|娘)`,
  'u',
);

/**
 * 「艹」类口头语（2026-11-03 用户拍板原话：「草饲我，草死你，xx来草我，我草xx可以。
 * 群友相互草可以，草死都可以，只是玩笑，但是比如操你妈，草泥全家，草拟吗这种不行」）。
 * 只要出现「艹/操/草/肏/曹」又不是家庭辱骂，一律当 0 档处理（不判、不记、不计数），
 * 避免被「当天同条款第 2 次」顶成 3 级证据。
 */
export function isCasualCaoTalk(text: string): boolean {
  if (typeof text !== 'string') throw new TypeError('isCasualCaoTalk: text 必须是字符串');
  const core = phraseCore(text);
  if (core.length === 0) return false;
  if (!CAO_RE.test(core)) return false;
  return !FAMILY_INSULT_RE.test(core);
}

// ------------------------------------------------------ 游戏语境 vs 真开盒（R11）

/**
 * 游戏语境词（2026-11-03 用户拍板 C 方案）：群里说「box 发来」指的是角色池截图，
 * 「申请会诊」「帮看号」是看配队，不是开盒。命中这些词只说明「像在聊游戏」，
 * 单凭它不能判定为误判——还要看下面那张开盒要素表有没有出现。
 */
const GAME_TALK_WORDS: readonly string[] = [
  'box',
  '角色池',
  '会诊',
  '配队',
  '队伍',
  '深渊',
  '混沌回忆',
  '虚构叙事',
  '忘却之庭',
  '模拟宇宙',
  '抽卡',
  '命座',
  '星魂',
  '遗器',
  '圣遗物',
  '词条',
  '面板',
  '毕业',
  '光锥',
  '命途',
  '看号',
  '帮看',
  '满命',
  '满精',
  '专武',
];

/**
 * 开盒要素词：出现任何一个就说明这条可能真在说人，游戏语境盖不住它，
 * 照旧走 R11——「非要恶俗大手子满地跑」「我要挂人社工库查他」都在这一类。
 */
const BOX_RISK_WORDS: readonly string[] = [
  '真名',
  '实名',
  '姓名',
  '身份证',
  '户籍',
  '户口',
  '住址',
  '地址',
  '手机号',
  '电话',
  '单位',
  '学校',
  '家里人',
  '家人',
  '父母',
  '开盒',
  '人肉',
  '社工库',
  '挂人',
  '出道',
  '恶俗',
  'esu',
  '大手子',
  '黑屁',
  '上门',
  '查你',
  '查他',
  '查她',
  '跟踪',
  '偷拍',
  '报警',
  '照片',
  '病历',
  '定位',
];

/**
 * R11 语境判别（2026-11-03 用户拍板 C 方案）：
 * 同时满足「含游戏语境词」且「不含任何开盒要素词」才算游戏聊天，
 * 返回 true 时调用方把 R11 的判定降到 0 级（只记录）。
 * 只放宽"说的话像游戏"，不放宽"说的话像开盒"——后者一旦出现要素词就照判。
 */
export function isGameContextOnly(text: string): boolean {
  if (typeof text !== 'string') throw new TypeError('isGameContextOnly: text 必须是字符串');
  const norm = normalize(text);
  if (norm.length === 0) return false;
  if (!GAME_TALK_WORDS.some((w) => norm.includes(w))) return false;
  if (BOX_RISK_WORDS.some((w) => norm.includes(w))) return false;
  return true;
}

// ---------------------------------------------------------------- 关键词表校验

function assertWordList(list: unknown, where: string): string[] {
  if (!Array.isArray(list)) throw new TypeError('scan: ' + where + ' 必须是字符串数组');
  for (const w of list) {
    if (typeof w !== 'string') throw new TypeError('scan: ' + where + ' 里出现非字符串词：' + String(w));
    const norm = normalize(w);
    if (norm.length < 2) {
      throw new Error('scan: ' + where + ' 里的词「' + w + '」不满足至少双字（归一化后为「' + norm + '」）');
    }
  }
  return list as string[];
}

// ---------------------------------------------------------------- 链接

const LINK_RE = /(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{2,5})?(?:\/[\x21-\x7e]*)?/g;

function toHost(raw: string): string | undefined {
  let s = raw.trim();
  const schemeAt = s.indexOf('://');
  if (schemeAt >= 0) s = s.slice(schemeAt + 3);
  const cut = s.search(/[/?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  const at = s.lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  const port = s.indexOf(':');
  if (port >= 0) s = s.slice(0, port);
  s = s.replace(/^\.+/, '').replace(/\.+$/, '');
  return s.length > 0 ? s : undefined;
}

function normalizeWhitelist(list: string[]): string[] {
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string') {
      throw new TypeError('scan: opts.linkWhitelist 里出现非字符串：' + String(entry));
    }
    const host = toHost(normalize(entry));
    if (host !== undefined) out.push(host);
  }
  return out;
}

/** 命中条件：域名等于白名单项，或域名以「.白名单项」结尾（bilibili.com.evil.cn 不算） */
function hostMatches(host: string, whitelist: string[]): boolean {
  for (const w of whitelist) {
    if (host === w) return true;
    if (host.length > w.length + 1 && host.endsWith('.' + w)) return true;
  }
  return false;
}

interface FoundLink {
  host: string;
  whitelisted: boolean;
  at: number;
}

function findLinks(text: string, whitelist: string[]): FoundLink[] {
  const out: FoundLink[] = [];
  const seen = new Set<string>();
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null = LINK_RE.exec(text);
  while (m !== null) {
    const raw = m[0];
    const at = m.index;
    m = LINK_RE.exec(text);
    const hasScheme = raw.startsWith('http://') || raw.startsWith('https://');
    const rest = hasScheme ? raw.slice(raw.indexOf('://') + 3) : raw;
    const host = toHost(raw);
    if (host === undefined) continue;
    const hasPath = /[/?#]/.test(rest);
    if (!hasScheme && !hasPath && FILE_EXT.has(host.slice(host.lastIndexOf('.') + 1))) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    out.push({ host, whitelisted: hostMatches(host, whitelist), at });
  }
  return out;
}

// ---------------------------------------------------------------- 命中扫描

interface PendingHit {
  hit: KeywordHit;
  at: number;
  seq: number;
}

/**
 * 扫描一条消息（正文 + 调用方拼进来的引用原文/卡片文字），合并返回命中。
 * 同一调用内同词只留一条（保留首次出现），链接按域名去重。
 */
export function scan(text: string, table: KeywordTable, opts: { linkWhitelist: string[] }): HitScan {
  if (typeof text !== 'string') throw new TypeError('scan: text 必须是字符串');
  if (table === null || typeof table !== 'object') throw new TypeError('scan: table 必须是对象');
  if (opts === null || typeof opts !== 'object') throw new TypeError('scan: opts 必须是对象');
  if (!Array.isArray(opts.linkWhitelist)) throw new TypeError('scan: opts.linkWhitelist 必须是字符串数组');

  const redline = assertWordList(table.redline, 'redline');
  const alarm = assertWordList(table.alarm ?? [], 'alarm');
  const softAlarm = assertWordList(table.softAlarm ?? [], 'softAlarm');
  const recordOnly = assertWordList(table.recordOnly, 'recordOnly');
  const rulesObj = table.rules;
  if (rulesObj === null || typeof rulesObj !== 'object') throw new TypeError('scan: table.rules 必须是对象');

  const ruleGroups: Array<{ rule: RuleId; words: string[] }> = [];
  for (const key of Object.keys(rulesObj)) {
    if (!RULE_ID_SET.has(key)) {
      throw new Error('scan: table.rules 的键「' + key + '」不是 R3..R11 之一');
    }
    ruleGroups.push({ rule: key as RuleId, words: assertWordList(rulesObj[key], 'rules.' + key) });
  }
  ruleGroups.sort((a, b) => RULE_IDS.indexOf(a.rule) - RULE_IDS.indexOf(b.rule));

  const hintsObj = table.hints ?? {};
  if (hintsObj === null || typeof hintsObj !== 'object') throw new TypeError('scan: table.hints 必须是对象');
  const hintGroups: Array<{ rule: RuleId; words: string[] }> = [];
  for (const key of Object.keys(hintsObj)) {
    if (!RULE_ID_SET.has(key)) {
      throw new Error('scan: table.hints 的键「' + key + '」不是 R3..R11 之一');
    }
    hintGroups.push({ rule: key as RuleId, words: assertWordList(hintsObj[key], 'hints.' + key) });
  }
  hintGroups.sort((a, b) => RULE_IDS.indexOf(a.rule) - RULE_IDS.indexOf(b.rule));

  const gatedObj = table.gated ?? {};
  if (gatedObj === null || typeof gatedObj !== 'object') throw new TypeError('scan: table.gated 必须是对象');
  const gatedGroups: Array<{ rule: RuleId; words: string[] }> = [];
  for (const key of Object.keys(gatedObj)) {
    if (!RULE_ID_SET.has(key)) {
      throw new Error('scan: table.gated 的键「' + key + '」不是 R3..R11 之一');
    }
    gatedGroups.push({ rule: key as RuleId, words: assertWordList(gatedObj[key], 'gated.' + key) });
  }
  gatedGroups.sort((a, b) => RULE_IDS.indexOf(a.rule) - RULE_IDS.indexOf(b.rule));

  const whitelist = normalizeWhitelist(opts.linkWhitelist);
  const norm = normalize(text);

  const pending: PendingHit[] = [];
  const seenWords = new Set<string>();
  const seenHosts = new Set<string>();
  let seq = 0;

  const addWord = (
    rawWord: string,
    rule: RuleId,
    kind: 'redline' | 'rule' | 'alarm' | 'hint' | 'gated',
    mustJudge: boolean,
  ): void => {
    const w = normalize(rawWord);
    if (seenWords.has(w)) return;
    const at = norm.indexOf(w);
    if (at < 0) return;
    seenWords.add(w);
    pending.push({ hit: { rule, word: rawWord, kind, mustJudge }, at, seq: seq++ });
  };

  // 扫描顺序即去重优先级：redline > alarm > softAlarm > recordOnly > hints > rules.* > gated
  // gated 放最后：同一个词既写在 rules（直通云）又写进 gated 时，直通云优先。
  // 交易词（出号/收号/代练/代充）同时出现在 R4 与 recordOnly 里，先扫 recordOnly
  // 才能落成「命中但只记录不送审」。
  for (const w of redline) addWord(w, 'REDLINE', 'redline', true);
  // 报警词不预设条款：rule 固定 OTHER，条款交给终审（用户 2026-11-01 拍板）
  for (const w of alarm) addWord(w, 'OTHER', 'alarm', true);
  // 软报警词：只强制过本地粗筛（2026-11-01 分档，见 KeywordTable.softAlarm）
  for (const w of softAlarm) addWord(w, 'OTHER', 'hint', false);
  for (const w of recordOnly) addWord(w, RECORD_ONLY_RULE, 'rule', false);
  // 低精度词：不直通云，只强制过本地粗筛（2026-11-01 分档，见 KeywordTable.hints）
  for (const group of hintGroups) {
    for (const w of group.words) addWord(w, group.rule, 'hint', false);
  }
  for (const group of ruleGroups) {
    for (const w of group.words) addWord(w, group.rule, 'rule', true);
  }
  // 需本地确认的词：不直通云，先跑 think 确认（2026-11-02 分档，见 KeywordTable.gated）
  for (const group of gatedGroups) {
    for (const w of group.words) addWord(w, group.rule, 'gated', false);
  }

  const links = findLinks(norm, whitelist);
  const linkHosts: string[] = [];
  for (const link of links) {
    linkHosts.push(link.host);
    if (link.whitelisted) continue;
    if (seenHosts.has(link.host)) continue;
    seenHosts.add(link.host);
    pending.push({
      hit: { rule: 'OTHER', word: link.host, kind: 'link', mustJudge: true },
      at: link.at,
      seq: seq++,
    });
  }

  pending.sort((a, b) => (a.at - b.at) || (a.seq - b.seq));
  const hits: KeywordHit[] = pending.map((p) => p.hit);
  return {
    hits,
    hasLink: links.length > 0,
    linkHosts,
    mustJudge: hits.some((h) => h.mustJudge),
    hasHint: hits.some((h) => h.kind === 'hint'),
    hasGated: hits.some((h) => h.kind === 'gated'),
  };
}

// ---------------------------------------------------------------- 条款排序

function severitySeedOf(rule: RuleId): Severity {
  if (rule === 'REDLINE' || rule === 'R10' || rule === 'R11') return 3;
  if (rule === 'OTHER') return 1;
  return 2;
}

/** 多命中取最重条款；空 hits 给 OTHER/0。recordOnly 命中也会给出条款，调用方须先看 mustJudge */
export function topRule(hits: KeywordHit[]): { rule: RuleId; severitySeed: Severity } {
  if (!Array.isArray(hits)) throw new TypeError('topRule: hits 必须是数组');
  if (hits.length === 0) return { rule: 'OTHER', severitySeed: 0 };
  let best: RuleId | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const h of hits) {
    const rank = RULE_PRIORITY.indexOf(h.rule);
    if (rank < 0) continue;
    if (rank < bestRank) {
      bestRank = rank;
      best = h.rule;
    }
  }
  if (best === undefined) return { rule: 'OTHER', severitySeed: 0 };
  return { rule: best, severitySeed: severitySeedOf(best) };
}

// ---------------------------------------------------------------- 消息抽取

interface CardBits {
  title?: string;
  text: string;
}

function pickStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

function dedupeStrings(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** 卡片 json/xml 段只取 title/desc 类文本，不取 url 属性（否则卡片链接会变成必判链接） */
function parseCardData(kind: 'json' | 'xml', data: string): CardBits {
  if (data.length === 0) return { text: '' };
  const titles: string[] = [];
  const texts: string[] = [];

  if (kind === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return { text: '' };
    }
    const root = asRecord(parsed);
    if (root === undefined) return { text: '' };
    const push = (into: string[], v: unknown): void => {
      const s = pickStr(v);
      if (s !== undefined) into.push(s);
    };
    push(texts, root.prompt);
    const meta = asRecord(root.meta);
    if (meta !== undefined) {
      push(titles, meta.title);
      push(texts, meta.title);
      push(texts, meta.desc);
      const news = asRecord(meta.news);
      if (news !== undefined) {
        push(titles, news.title);
        push(texts, news.title);
        push(texts, news.desc);
      }
      for (const key of ['detail_1', 'detail_2']) {
        const detail = asRecord(meta[key]);
        if (detail === undefined) continue;
        push(titles, detail.title);
        push(texts, detail.title);
        push(texts, detail.desc);
      }
    }
    const title = titles[0];
    const text = dedupeStrings(titles.concat(texts)).join(' ');
    return title === undefined ? { text } : { title, text };
  }

  const grab = (source: string, into: string[]): void => {
    const re = new RegExp(source, 'g');
    let m: RegExpExecArray | null = re.exec(data);
    while (m !== null) {
      const s = pickStr(m[1]);
      if (s !== undefined) into.push(s);
      m = re.exec(data);
    }
  };
  grab('\\btitle="([^"]{1,200})"', titles);
  grab('<title>([\\s\\S]{1,200}?)<\\/title>', titles);
  grab('\\b(?:brief|desc|summary)="([^"]{1,200})"', texts);

  const title = titles[0];
  const text = dedupeStrings(titles.concat(texts)).join(' ');
  return title === undefined ? { text } : { title, text };
}

const SEG_PLACEHOLDER: Record<string, string> = {
  image: IMAGE_PLACEHOLDER,
  record: '[record]',
  video: '[video]',
  file: '[file]',
  forward: '[forward]',
};

/**
 * @ 段保留「@了谁」：全部压成 `[at]` 会让终审看不出「你是傻逼」是在对某个群友说，
 * 于是把第二人称辱骂误判成「在骂策划」（2026-11-01 群 222222222 实证）。
 */
function atPlaceholder(qq: string | undefined): string {
  if (qq === undefined || qq.length === 0) return '[at]';
  return qq === 'all' ? '[at:全体]' : '[at:' + qq + ']';
}

const CQ_RE = /\[CQ:([a-z0-9_.-]+)((?:,[^\[\]]*)?)\]/gi;

type CqParams = { [key: string]: string | undefined };

function parseCqParams(s: string): CqParams {
  const out: CqParams = {};
  if (s.length === 0) return out;
  for (const part of s.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim().toLowerCase();
    const raw = part.slice(i + 1);
    out[key] = raw
      .replace(/&#44;/g, ',')
      .replace(/&#91;/g, '[')
      .replace(/&#93;/g, ']')
      .replace(/&amp;/g, '&');
  }
  return out;
}

interface CqParse {
  text: string;
  images: string[];
  replyId?: number;
  cardTitle?: string;
  cardTexts: string[];
}

function parseCqString(s: string): CqParse {
  const textParts: string[] = [];
  const images: string[] = [];
  const cardTexts: string[] = [];
  let replyId: number | undefined;
  let cardTitle: string | undefined;
  let last = 0;

  CQ_RE.lastIndex = 0;
  let m: RegExpExecArray | null = CQ_RE.exec(s);
  while (m !== null) {
    if (m.index > last) textParts.push(s.slice(last, m.index));
    last = m.index + m[0].length;
    const name = m[1].toLowerCase();
    const params = parseCqParams(m[2] ?? '');
    m = CQ_RE.exec(s);

    if (name === 'text') {
      const t = params.text;
      if (t !== undefined) textParts.push(t);
      continue;
    }
    if (name === 'image') {
      const url = params.url !== undefined ? params.url : params.file;
      if (url !== undefined && url.length > 0) images.push(url);
    }
    if (name === 'reply') {
      const n = Number(params.id);
      if (Number.isFinite(n)) replyId = n;
      continue;
    }
    if (name === 'at') {
      textParts.push(atPlaceholder(params.qq));
      continue;
    }
    if (name === 'json' || name === 'xml') {
      const bits = parseCardData(name, params.data ?? '');
      if (bits.title !== undefined && cardTitle === undefined) cardTitle = bits.title;
      if (bits.text.length > 0) cardTexts.push(bits.text);
      continue;
    }
    if (SEG_PLACEHOLDER[name] !== undefined) textParts.push(SEG_PLACEHOLDER[name]);
  }
  if (last < s.length) textParts.push(s.slice(last));

  const out: CqParse = { text: textParts.join(' '), images, cardTexts };
  if (replyId !== undefined) out.replyId = replyId;
  if (cardTitle !== undefined) out.cardTitle = cardTitle;
  return out;
}

/**
 * 取出可匹配文本：正文（image 段落 [image] 占位）+ 卡片 title/desc。
 * 引用原文拿不到，只给 replyId——调用方要匹配引用原文时自己从环形缓冲取，再拼到 text 后传给 scan。
 */
export function extractMessage(
  message: string | MessageSegment[],
  raw?: string,
): { text: string; images: string[]; replyId?: number; cardTitle?: string } {
  const textParts: string[] = [];
  const images: string[] = [];
  const cardTexts: string[] = [];
  let replyId: number | undefined;
  let cardTitle: number | string | undefined;

  if (typeof message === 'string') {
    const parsed = parseCqString(message);
    if (parsed.text.length > 0) textParts.push(parsed.text);
    for (const u of parsed.images) images.push(u);
    for (const t of parsed.cardTexts) cardTexts.push(t);
    if (parsed.replyId !== undefined) replyId = parsed.replyId;
    if (parsed.cardTitle !== undefined) cardTitle = parsed.cardTitle;
  } else if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg === null || typeof seg !== 'object') continue;
      const type = seg.type;
      const data = seg.data;
      if (type === 'text') {
        const t = data !== undefined ? pickStr(data.text) : undefined;
        if (t !== undefined) textParts.push(t);
        continue;
      }
      if (type === 'image') {
        const url = data !== undefined ? pickStr(data.url) : undefined;
        const file = data !== undefined ? pickStr(data.file) : undefined;
        const src = url !== undefined ? url : file;
        if (src !== undefined) images.push(src);
        textParts.push(IMAGE_PLACEHOLDER);
        continue;
      }
      if (type === 'reply') {
        const idRaw = data !== undefined ? data.id : undefined;
        const n = typeof idRaw === 'number' ? idRaw : Number(idRaw);
        if (Number.isFinite(n)) replyId = n;
        continue;
      }
      if (type === 'at') {
        textParts.push(atPlaceholder(data !== undefined ? pickStr(data.qq) : undefined));
        continue;
      }
      if (type === 'json' || type === 'xml') {
        const payload = data !== undefined ? pickStr(data.data) : undefined;
        if (payload === undefined) continue;
        const bits = parseCardData(type, payload);
        if (bits.title !== undefined && typeof cardTitle !== 'string') cardTitle = bits.title;
        if (bits.text.length > 0) cardTexts.push(bits.text);
        continue;
      }
      if (SEG_PLACEHOLDER[type] !== undefined) textParts.push(SEG_PLACEHOLDER[type]);
      // at / face / mface / markdown / 未知段：不取昵称、不猜内容
    }
  } else {
    throw new TypeError('extractMessage: message 必须是字符串或消息段数组');
  }

  if (typeof raw === 'string' && raw.length > 0) {
    const parsed = parseCqString(raw);
    if (replyId === undefined && parsed.replyId !== undefined) replyId = parsed.replyId;
    if (textParts.length === 0 && cardTexts.length === 0) {
      if (parsed.text.length > 0) textParts.push(parsed.text);
      for (const u of parsed.images) images.push(u);
      for (const t of parsed.cardTexts) cardTexts.push(t);
      if (cardTitle === undefined && parsed.cardTitle !== undefined) cardTitle = parsed.cardTitle;
    }
  }

  const out: { text: string; images: string[]; replyId?: number; cardTitle?: string } = {
    text: normalize(textParts.concat(cardTexts).join(' ')),
    images: dedupeStrings(images),
  };
  if (replyId !== undefined) out.replyId = replyId;
  if (typeof cardTitle === 'string') out.cardTitle = cardTitle;
  return out;
}

// ---------------------------------------------------------------- 豁免

/** 接收人名单归一：ownerQqs 为准；旧单值 ownerQq 并入（保留既有调用点）；正数、去重 */
function ownerListOf(opts: { ownerQqs?: number[]; ownerQq?: number }): number[] {
  const out: number[] = [];
  const add = (v: unknown): void => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return;
    if (!out.includes(v)) out.push(v);
  };
  if (Array.isArray(opts.ownerQqs)) for (const qq of opts.ownerQqs) add(qq);
  add(opts.ownerQq);
  return out;
}

export function isExempt(
  ev: MessageEvent,
  opts: {
    selfId: number;
    ownerQqs?: number[];
    ownerQq?: number;
    adminIds?: number[];
    /** 按群绑定的接收人（方案 §14.2）：绑定者只在绑定的群豁免，其他群照常判定 */
    groupOwners?: Record<number, number[]>;
    /**
     * 不检测名单（2026-11-02）：名单里的人说话不判定，但他们不是管理员——
     * 这里只影响「说不说话要不要判」，不给任何主人/群主权限。
     */
    whitelist?: number[];
  },
): boolean {
  if (ev === null || typeof ev !== 'object') throw new TypeError('isExempt: ev 必须是 MessageEvent');
  if (opts === null || typeof opts !== 'object') throw new TypeError('isExempt: opts 必须是对象');
  const adminIds = opts.adminIds === undefined ? [] : opts.adminIds;
  if (!Array.isArray(adminIds)) throw new TypeError('isExempt: opts.adminIds 必须是数组');
  const whitelist = opts.whitelist === undefined ? [] : opts.whitelist;
  if (!Array.isArray(whitelist)) throw new TypeError('isExempt: opts.whitelist 必须是数组');
  const ownerQqs = ownerListOf(opts);
  const uid = ev.user_id;
  if (uid === opts.selfId) return true;
  if (ownerQqs.includes(uid)) return true;
  if (adminIds.includes(uid)) return true;
  if (whitelist.includes(uid)) return true;
  // 按群绑定：仅当事发群 = 绑定群时豁免（全局 owner 上面已经 return 了）
  const bound = opts.groupOwners === undefined ? undefined : opts.groupOwners[Number(ev.group_id ?? 0)];
  if (bound !== undefined && Array.isArray(bound) && bound.includes(uid)) return true;
  const role = ev.sender === undefined ? undefined : ev.sender.role;
  return role === 'admin' || role === 'owner';
}

// ---------------------------------------------------------------- 上下文环形缓冲

function asCount(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export class RingBuffer {
  private readonly cap: number;
  private items: ContextItem[] = [];

  constructor(cap: number) {
    if (!Number.isInteger(cap) || cap < 1) {
      throw new RangeError('RingBuffer: cap 必须是 >=1 的整数，收到 ' + String(cap));
    }
    this.cap = cap;
  }

  push(item: ContextItem): void {
    if (item === null || typeof item !== 'object') {
      throw new TypeError('RingBuffer.push: item 必须是 ContextItem');
    }
    this.items.push(item);
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
  }

  /** 以 messageId 为中心取前后若干条，按 time 升序，含目标；找不到返回 [] */
  around(messageId: number, before: number, after: number): ContextItem[] {
    const idx = this.items.findIndex((it) => it.messageId === messageId);
    if (idx < 0) return [];
    const from = Math.max(0, idx - asCount(before));
    const to = Math.min(this.items.length, idx + asCount(after) + 1);
    return this.items.slice(from, to).sort((x, y) => x.time - y.time);
  }

  recent(n: number): ContextItem[] {
    const k = asCount(n);
    if (k === 0) return [];
    return this.items.slice(Math.max(0, this.items.length - k));
  }

  snapshot(): ContextItem[] {
    return this.items.slice();
  }

  get size(): number {
    return this.items.length;
  }
}
