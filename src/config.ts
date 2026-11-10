import { readFileSync } from 'node:fs';
import type { LogLevel } from './log.ts';
import { log } from './log.ts';
import type { SampleRates } from './guard/sample.ts';
import { isLearnedRule, readLearnedTieredSync } from './guard/learn.ts';
import type { SilentSexConfig } from './guard/silentSex.ts';
import { DEFAULT_SILENT_SEX, SILENT_SEX_GROUPS } from './guard/silentSex.ts';

/** 关键词表里能配的条款号；R1/R2 是引导语不检测，R10 原词未定（本轮留空但不许省键） */
export type KeywordRuleId = 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'R10' | 'R11';

export type KeywordTable = {
  redline: string[];
  /** 报警词（炸群/喊停）：直通云、不预设条款（2026-11-01 用户拍板） */
  alarm: string[];
  /** 软报警词（别聊了/打住/撤一下）：日常也会用，只强制过本地粗筛（2026-11-01 分档） */
  softAlarm: string[];
  rules: Record<KeywordRuleId, string[]>;
  /** 低精度词（话题名/行为名/标签词）：只强制过本地粗筛，不直通云（2026-11-01 分档） */
  hints: Record<KeywordRuleId, string[]>;
  /** 需本地确认的词（731/垃圾 这类语境词）：先跑带思考链的本地确认，可疑才送云（2026-11-02 分档） */
  gated: Record<KeywordRuleId, string[]>;
  /** 命中但只落记录、不送审的群内交易词 */
  recordOnly: string[];
};

/** 本地登录控制台（方案文档 §12）：独立进程读这一段，守卫进程不用 */
export type ConsoleConfig = {
  enabled: boolean;
  /** 只允许 loopback：控制台没有 token 门 */
  host: string;
  port: number;
  /** NapCat 安装目录（含 NapCatWinBootMain.exe 与 cache/qrcode.png） */
  napcatDir: string;
  /** 本机器人专用的 QQ 主程序；按这个路径前缀才允许杀 */
  qqPath: string;
};

export type GuardConfig = {
  onebot: {
    wsUrl: string;
    token?: string;
    /** 目标群白名单：只守这些群，其他群的消息在入口就被丢掉 */
    groupIds: number[];
    /** 主人/接收人 QQ 名单：名单里的人说话不判定（恒豁免），也是未绑定群的 3 级兜底收件人 */
    ownerQqs: number[];
    /** 按群绑定的 3 级接收人（方案 §14.1）：键是群号；绑定群只发绑定者，绑定者仅本群豁免 */
    groupOwners: Record<number, number[]>;
  };
  logLevel: LogLevel;
  /** mock 开关：打开后把原始事件打出来，便于对着 mock 调 */
  mock: boolean;
  guard: {
    keywords: KeywordTable;
    thresholds: { redline: number; normal: number; remind: number };
    budget: { daily: number; perGroup: number; groupDaily: Record<string, number> };
    /** 官方/大站域名（含子域）跳过必判，仍过本地粗筛 */
    linkWhitelist: string[];
    /** 群规原文，原样进 judge prompt */
    rulesText: string;
    /**
     * 条款封顶（2026-11-01 用户拍板「r9 还是只记录，但是我要查得查得到」）：
     * 键是条款号（R3…R11 / REDLINE / OTHER），值是 0–3 的档位上限。
     * 只压档位、不压送云——命中的照样进云端终审，只是结论封在 0 档、不出手。
     */
    caps: Record<string, number>;
  /** 色情静默闸门（2026-11-02）：受管条款 + 极端词表 */
  silentSex: SilentSexConfig;
    /**
     * 不检测名单（2026-11-02 用户拍板）：「权限不如我和群主，只是不检测他说的话，其他都一样」。
     * 名单里的人在群里说的话不走判定链（不进记录、不花预算）；
     * 但他们没有主人/管理员的权限——不能用 #test、私聊也不回执，别的行为照常。
     */
    whitelist: number[];
    /**
     * 玩笑白名单（2026-11-02 夜间用户拍板「草死你可以，曹死你吗不可以」）：
     * 整条消息去掉 @/引用/标点/符号后**只剩白名单词**（可重复），就整条不判不记、不花预算。
     * 只要还夹着别的内容，照原文判——「草死你喵」放行，「草死你妈」照样抓。
     */
    exemptPhrases: string[];
  };
  screen: { baseUrl: string; model: string; enabled: boolean; timeoutMs: number; gatedTimeoutMs: number };
  judge: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    maxTokens: number;
    timeoutMs: number;
    /** 送云抽检率（方案 §3.1）；不配就是不配，由 sample.ts 的缺省口径接手 */
    sample?: SampleRates;
  };
  /**
   * 3 级证据私聊的额外接收人（群主等）；不参与「说话豁免」。
   * recipients 是「通知人」（2026-11-04 用户拍板）：与主人/群主同批收提醒，但零权限——
   * 不进 operators（不能发运维命令）、不豁免、不收私聊收件箱。
   * groupRecipients 把通知人绑到具体群（2026-11-04 追加）：某群配了它，就只给该群发，且不再并全局 recipients。
   * enabled=true 时「通知类私聊」不受 actions.dryRun 拦截（群里动作仍由 dryRun 管）。
   */
  notify: {
    enabled: boolean;
    adminQqs: number[];
    recipients: number[];
    groupRecipients: Record<string, number[]>;
  };
  /** 原始群消息落盘（方案 §3.3）；默认关，显式打开才写 */
  collect: { enabled: boolean; dir: string };
  /** 私聊收件箱：只收主人的私聊原文，不判定（2026-11-01 用户拍板）；默认关 */
  inbox: { enabled: boolean; dir: string };
  /** 动作链路的开关与额度（M2b）：全部有默认值，默认最保守 */
  actions: ActionsConfig;
  dataDir: string;
  console: ConsoleConfig;
};

export type ActionsConfig = {
  /** true = 只打日志不发送（安全阀：不显式关闭就只打日志） */
  dryRun: boolean;
  /**
   * 群内静默（2026-11-02 用户拍板）：true = 群里一条都不发（不 @、不公开警示、不兜底），
   * 私聊照发——3 级证据、通知类私聊都不受影响。
   */
  groupSilent: boolean;
  /** 禁言开关：本轮只留开关位置，代码里零调用点 */
  muteEnabled: boolean;
  /** 冷却窗口毫秒，与 pipeline 的 5 分钟常量同义 */
  cooldownMs: number;
  /** 每日动作条数上限（进程内计数，重启归零） */
  actionDailyCap: number;
};

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

const CONFIG_FILE_DEFAULT = 'config.json';
const KEYWORD_RULE_IDS: KeywordRuleId[] = ['R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11'];
const TOP_KEYS = ['guard', 'screen', 'judge', 'actions', 'dataDir', 'console', 'notify', 'collect', 'inbox'];
const GUARD_KEYS = [
  'keywords',
  'thresholds',
  'budget',
  'linkWhitelist',
  'rulesText',
  'caps',
  'whitelist',
  'exemptPhrases',
  'silentSex',
];
const ACTIONS_KEYS = ['dryRun', 'groupSilent', 'muteEnabled', 'cooldownMs', 'actionDailyCap'];
const CONSOLE_KEYS = ['enabled', 'host', 'port', 'napcatDir', 'qqPath'];
const NOTIFY_KEYS = ['enabled', 'adminQqs', 'recipients', 'groupRecipients'];
const COLLECT_KEYS = ['enabled', 'dir'];
const SAMPLE_KEYS = ['suspicious', 'clean', 'unknown'];

/** 关键词表 v0.2（定稿）。config.json 缺失时就用这份 */
/** 关键词表 v0.3（2026-11-01 分档：直通云 / 只过粗筛 / 只记录）。config.json 缺失时就用这份 */
const DEFAULT_KEYWORDS: KeywordTable = {
  // 公开仓库不带真实词表（见 PUSH_RULES.md）：真实词表只放本地 config.json 的 guard.keywords。
  // 默认值刻意留空——config.json 缺这一节就等于没有词，启动日志会提示。
  // 想直接用样例：复制 keywords.example.json 的结构后自己填。
  redline: [],
  alarm: [],
  softAlarm: [],
  rules: { R3: [], R4: [], R5: [], R6: [], R7: [], R8: [], R9: [], R10: [], R11: [] },
  hints: { R3: [], R4: [], R5: [], R6: [], R7: [], R8: [], R9: [], R10: [], R11: [] },
  gated: { R3: [], R4: [], R5: [], R6: [], R7: [], R8: [], R9: [], R10: [], R11: [] },
  recordOnly: [],
};

/** 群规原文（方案文档 7.1，原样进 judge prompt） */
const DEFAULT_RULES_TEXT = [
  '★示例★：在此填写你自己群的群规全文（禁止项、处置力度、申诉方式）。',
  '1. 禁止一切违法与平台红线内容。',
  '2. 禁止人身攻击、引战、造谣与无关广告。',
  '3. 禁止露骨色情内容。',
].join('\n');

const DEFAULT_THRESHOLDS = { redline: 0.6, normal: 0.75, remind: 0.6 };
const DEFAULT_BUDGET = { daily: 500, perGroup: 100, groupDaily: {} as Record<string, number> };
const DEFAULT_LINK_WHITELIST = ['bilibili.com', 'b23.tv', 'miyoushe.com', 'douyin.com'];
const DEFAULT_SCREEN = {
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen3:8b',
  enabled: true,
  timeoutMs: 8000,
  gatedTimeoutMs: 30000,
};
const DEFAULT_JUDGE = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', maxTokens: 512, timeoutMs: 20000 };
const DEFAULT_DATA_DIR = './data';
/** 原始流落盘：默认关；目录必须是服务器 D 盘（含原文，不进 Syncthing 共享目录） */
const DEFAULT_COLLECT = { enabled: false, dir: 'D:\\Syu\\samples\\collect' };
/** 私聊收件箱：默认关，显式打开才写；目录同样必须在 D 盘 */
const DEFAULT_INBOX = { enabled: false, dir: 'D:\\Syu\\samples\\private-inbox' };
const INBOX_KEYS = ['enabled', 'dir'];
/** 条款封顶允许的键：与 judge 可能吐出来的条款号一致 */
const CAP_RULE_IDS = ['REDLINE', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'OTHER'];
/** 动作链路默认值：dryRun 默认 true 是安全阀，配错了也只是不发消息 */
const DEFAULT_ACTIONS: ActionsConfig = { dryRun: true, groupSilent: false, muteEnabled: false, cooldownMs: 300000, actionDailyCap: 40 };
/** 控制台默认值：只监听本机 8789；NapCat 用 D:\Syu\napcat，QQ 用系统安装版（副本 QQ 会被服务端判会话失效，见方案 §17.3） */
const DEFAULT_CONSOLE: ConsoleConfig = {
  enabled: true,
  host: '127.0.0.1',
  port: 8789,
  napcatDir: 'D:\\Syu\\napcat',
  qqPath: 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
};

// .env 是本地可选文件；没有就走进程环境变量，不报错
/**
 * 读 .env。刻意不走 process.loadEnvFile()：它只补「压根不存在」的键，
 * 父进程传了空字符串时它不会覆盖——控制台的 startBot 就是拿上游 process.env
 * 起守卫，于是守卫带着 GUARD_GROUP_IDS="" 启动失败（2026-11-01 实际踩到）。
 * 这里的口径：只填「未设置或空字符串」的键，已经有真值的绝不覆盖。
 */
function loadDotEnv(file = '.env'): void {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return; // 没有 .env：只用环境变量
  }
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (text === '' || text.startsWith('#')) continue;
    const eq = text.indexOf('=');
    if (eq <= 0) continue;
    const key = text.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = text.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    const current = process.env[key];
    if (current !== undefined && current !== '') continue;
    process.env[key] = value;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cloneKeywords(t: KeywordTable): KeywordTable {
  const rules = {} as Record<KeywordRuleId, string[]>;
  const hints = {} as Record<KeywordRuleId, string[]>;
  const gated = {} as Record<KeywordRuleId, string[]>;
  for (const id of KEYWORD_RULE_IDS) {
    rules[id] = [...(t.rules[id] ?? [])];
    hints[id] = [...(t.hints[id] ?? [])];
    gated[id] = [...(t.gated[id] ?? [])];
  }
  return {
    redline: [...t.redline],
    alarm: [...t.alarm],
    softAlarm: [...t.softAlarm],
    rules,
    hints,
    gated,
    recordOnly: [...t.recordOnly],
  };
}

function defaulted(what: string): void {
  log.warn('config.json 里缺少 ' + what + '，用内置默认');
}

/**
 * guard.whitelist：不检测名单。只收 QQ 号（数字或纯数字字符串），去重；
 * 不配就是空名单——空名单不改变任何行为。
 */
function parseQqList(src: unknown, where: string, fallback: number[], problems: string[]): number[] {
  if (src === undefined) return [...fallback];
  if (!Array.isArray(src)) {
    problems.push(where + ' 必须是 QQ 号数组，拿到：' + JSON.stringify(src));
    return [...fallback];
  }
  const out: number[] = [];
  for (const raw of src) {
    const num = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (!Number.isInteger(num) || num <= 0) {
      problems.push(where + ' 里有不是 QQ 号的项：' + JSON.stringify(raw));
      continue;
    }
    if (!out.includes(num)) out.push(num);
  }
  return out;
}

/**
 * guard.exemptPhrases：玩笑白名单词（2026-11-02 夜间用户拍板）。
 * 只收短语（非空字符串、去首尾空白、去重）；归一化后少于 2 个字的报错并丢弃。
 * 不配就是空表——空表不改变任何行为。
 */
function parsePhraseList(src: unknown, where: string, problems: string[]): string[] {
  if (src === undefined) return [];
  if (!Array.isArray(src)) {
    problems.push(where + ' 必须是短语数组，拿到：' + JSON.stringify(src));
    return [];
  }
  const out: string[] = [];
  for (const raw of src) {
    if (typeof raw !== 'string') {
      problems.push(where + ' 里有非字符串项：' + JSON.stringify(raw));
      continue;
    }
    const phrase = raw.trim();
    if (phrase === '') {
      problems.push(where + ' 里有空串，删掉或补全');
      continue;
    }
    if (phrase !== raw) problems.push(where + ' 的「' + raw + '」首尾有空白，去掉才能匹配');
    if (phrase.length < 2) {
      problems.push(where + ' 的「' + phrase + '」太短（至少 2 个字）');
      continue;
    }
    if (!out.includes(phrase)) out.push(phrase);
  }
  return out;
}

/** 词表校验：中文/短语至少 2 个字；纯拉丁词（bhhs/esu）不做长度断言 */
function parseWordList(src: unknown, where: string, problems: string[]): string[] {
  if (!Array.isArray(src)) {
    problems.push(where + ' 必须是字符串数组，拿到：' + JSON.stringify(src));
    return [];
  }
  const out: string[] = [];
  for (const item of src) {
    if (typeof item !== 'string') {
      problems.push(where + ' 里有非字符串项：' + JSON.stringify(item));
      continue;
    }
    const word = item.trim();
    if (word === '') {
      problems.push(where + ' 里有空词（""），删掉或补全');
      continue;
    }
    if (word !== item) problems.push(where + ' 的词「' + item + '」首尾有空白，去掉才能匹配');
    const latinOnly = /^[\x20-\x7E]+$/.test(word);
    if (!latinOnly && [...word].length < 2) {
      problems.push(where + ' 的词「' + word + '」只有 1 个字：中文/短语词至少 2 个字（bhhs/esu 这类拉丁词不受限）');
    }
    out.push(word);
  }
  return out;
}

function parseKeywordTable(src: unknown, problems: string[]): KeywordTable {
  if (src === undefined) {
    defaulted('guard.keywords');
    return cloneKeywords(DEFAULT_KEYWORDS);
  }
  if (!isPlainObject(src)) {
    problems.push('guard.keywords 必须是对象');
    return cloneKeywords(DEFAULT_KEYWORDS);
  }

  let redline: string[];
  if (src.redline === undefined) {
    defaulted('guard.keywords.redline');
    redline = [...DEFAULT_KEYWORDS.redline];
  } else {
    redline = parseWordList(src.redline, 'guard.keywords.redline', problems);
  }

  let recordOnly: string[];
  if (src.recordOnly === undefined) {
    defaulted('guard.keywords.recordOnly');
    recordOnly = [...DEFAULT_KEYWORDS.recordOnly];
  } else {
    recordOnly = parseWordList(src.recordOnly, 'guard.keywords.recordOnly', problems);
  }

  // 报警词：可整段省略（缺省用内置那份），写了就以写的为准
  let alarm: string[];
  if (src.alarm === undefined) {
    alarm = [...DEFAULT_KEYWORDS.alarm];
  } else {
    alarm = parseWordList(src.alarm, 'guard.keywords.alarm', problems);
  }

  // 软报警词：同 alarm，可整段省略
  let softAlarm: string[];
  if (src.softAlarm === undefined) {
    softAlarm = [...DEFAULT_KEYWORDS.softAlarm];
  } else {
    softAlarm = parseWordList(src.softAlarm, 'guard.keywords.softAlarm', problems);
  }

  const rules = {} as Record<KeywordRuleId, string[]>;
  const rulesSrc = src.rules;
  if (rulesSrc === undefined) {
    defaulted('guard.keywords.rules');
    for (const id of KEYWORD_RULE_IDS) rules[id] = [...DEFAULT_KEYWORDS.rules[id]];
  } else if (!isPlainObject(rulesSrc)) {
    problems.push('guard.keywords.rules 必须是对象，形如 { "R3": [...], ..., "R11": [...] }');
    for (const id of KEYWORD_RULE_IDS) rules[id] = [...DEFAULT_KEYWORDS.rules[id]];
  } else {
    const extra = Object.keys(rulesSrc).filter((k) => !KEYWORD_RULE_IDS.includes(k as KeywordRuleId));
    if (extra.length > 0) {
      problems.push('guard.keywords.rules 有未知条款键：' + extra.join(', ') + '（只认 ' + KEYWORD_RULE_IDS.join('/') + '）');
    }
    for (const id of KEYWORD_RULE_IDS) {
      const v = rulesSrc[id];
      if (v === undefined) {
        defaulted('guard.keywords.rules.' + id);
        rules[id] = [...DEFAULT_KEYWORDS.rules[id]];
      } else {
        rules[id] = parseWordList(v, 'guard.keywords.rules.' + id, problems);
      }
    }
  }

  // 低精度词：缺省用内置分档（v0.3），写了的条款键就以写的为准
  const hints = {} as Record<KeywordRuleId, string[]>;
  const hintsSrc = src.hints;
  if (hintsSrc === undefined) {
    for (const id of KEYWORD_RULE_IDS) hints[id] = [...DEFAULT_KEYWORDS.hints[id]];
  } else if (!isPlainObject(hintsSrc)) {
    problems.push('guard.keywords.hints 必须是对象，形如 { "R3": [...], ... }（只强制过本地粗筛的低精度词）');
    for (const id of KEYWORD_RULE_IDS) hints[id] = [...DEFAULT_KEYWORDS.hints[id]];
  } else {
    const extra = Object.keys(hintsSrc).filter((k) => !KEYWORD_RULE_IDS.includes(k as KeywordRuleId));
    if (extra.length > 0) {
      problems.push('guard.keywords.hints 有未知条款键：' + extra.join(', ') + '（只认 ' + KEYWORD_RULE_IDS.join('/') + '）');
    }
    for (const id of KEYWORD_RULE_IDS) {
      const v = hintsSrc[id];
      if (v === undefined) {
        defaulted('guard.keywords.hints.' + id);
        hints[id] = [...DEFAULT_KEYWORDS.hints[id]];
      } else {
        hints[id] = parseWordList(v, 'guard.keywords.hints.' + id, problems);
      }
    }
  }

  const gated = {} as Record<KeywordRuleId, string[]>;
  const gatedSrc = src.gated;
  if (gatedSrc === undefined) {
    for (const id of KEYWORD_RULE_IDS) gated[id] = [...DEFAULT_KEYWORDS.gated[id]];
  } else if (!isPlainObject(gatedSrc)) {
    problems.push(
      'guard.keywords.gated 必须是对象，形如 { "R3": [...], ... }（需本地确认的词）',
    );
    for (const id of KEYWORD_RULE_IDS) gated[id] = [...DEFAULT_KEYWORDS.gated[id]];
  } else {
    const extra = Object.keys(gatedSrc).filter((k) => !KEYWORD_RULE_IDS.includes(k as KeywordRuleId));
    if (extra.length > 0) {
      problems.push('guard.keywords.gated 有未知条款键：' + extra.join(', ') + '（只认 ' + KEYWORD_RULE_IDS.join('/') + '）');
    }
    for (const id of KEYWORD_RULE_IDS) {
      const v = gatedSrc[id];
      if (v === undefined) {
        defaulted('guard.keywords.gated.' + id);
        gated[id] = [...DEFAULT_KEYWORDS.gated[id]];
      } else {
        gated[id] = parseWordList(v, 'guard.keywords.gated.' + id, problems);
      }
    }
  }

  return { redline, alarm, softAlarm, rules, hints, gated, recordOnly };
}

function parseRatio(v: unknown, key: string, fallback: number, problems: string[]): number {
  if (v === undefined) {
    log.warn('config.json 里缺少 ' + key + '，用默认 ' + fallback);
    return fallback;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    problems.push(key + ' 必须是 0..1 之间的数字，拿到：' + JSON.stringify(v));
    return fallback;
  }
  return v;
}

function parsePositiveInt(v: unknown, key: string, fallback: number, problems: string[]): number {
  if (v === undefined) {
    log.warn('config.json 里缺少 ' + key + '，用默认 ' + fallback);
    return fallback;
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    problems.push(key + ' 必须是正整数，拿到：' + JSON.stringify(v));
    return fallback;
  }
  return v;
}

function parseNonEmptyString(v: unknown, key: string, fallback: string, problems: string[]): string {
  if (v === undefined) {
    log.warn('config.json 里缺少 ' + key + '，用默认：' + fallback);
    return fallback;
  }
  if (typeof v !== 'string' || v.trim() === '') {
    problems.push(key + ' 必须是非空字符串，拿到：' + JSON.stringify(v));
    return fallback;
  }
  return v.trim();
}

function parseBool(v: unknown, key: string, fallback: boolean, problems: string[]): boolean {
  if (v === undefined) {
    log.warn('config.json 里缺少 ' + key + '，用默认 ' + String(fallback));
    return fallback;
  }
  if (typeof v !== 'boolean') {
    problems.push(key + ' 必须是 true / false，拿到：' + JSON.stringify(v));
    return fallback;
  }
  return v;
}

function parseHttpUrl(v: unknown, key: string, fallback: string, problems: string[]): string {
  if (v === undefined) {
    log.warn('config.json 里缺少 ' + key + '，用默认：' + fallback);
    return fallback;
  }
  const text = typeof v === 'string' ? v.trim() : '';
  let ok = false;
  try {
    const parsed = new URL(text);
    ok = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    ok = false;
  }
  if (!ok) {
    problems.push(key + ' 不是合法的 http/https 地址：' + JSON.stringify(v));
    return fallback;
  }
  return text;
}

function parseThresholds(
  src: unknown,
  problems: string[],
): { redline: number; normal: number; remind: number } {
  if (src === undefined) {
    defaulted('guard.thresholds');
    return { ...DEFAULT_THRESHOLDS };
  }
  if (!isPlainObject(src)) {
    problems.push('guard.thresholds 必须是对象');
    return { ...DEFAULT_THRESHOLDS };
  }
  return {
    redline: parseRatio(src.redline, 'guard.thresholds.redline', DEFAULT_THRESHOLDS.redline, problems),
    normal: parseRatio(src.normal, 'guard.thresholds.normal', DEFAULT_THRESHOLDS.normal, problems),
    // remind 是 2026-11-01 晚新增的「1 档提醒」门槛，老配置里没有它属正常，不告警
    remind:
      src.remind === undefined
        ? DEFAULT_THRESHOLDS.remind
        : parseRatio(src.remind, 'guard.thresholds.remind', DEFAULT_THRESHOLDS.remind, problems),
  };
}

/** guard.budget.groupDaily：群号 → 该群每日上限（不写就走 perGroup） */
function parseGroupDaily(src: unknown, problems: string[]): Record<string, number> {
  if (src === undefined) return {};
  if (!isPlainObject(src)) {
    problems.push('guard.budget.groupDaily 必须是对象（群号 → 每日上限）');
    return {};
  }
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(src)) {
    if (!/^\d+$/.test(key)) {
      problems.push(`guard.budget.groupDaily 的键「${key}」不是群号`);
      continue;
    }
    out[key] = parsePositiveInt(value, `guard.budget.groupDaily.${key}`, DEFAULT_BUDGET.perGroup, problems);
  }
  return out;
}

function parseBudget(src: unknown, problems: string[]): {
  daily: number;
  perGroup: number;
  groupDaily: Record<string, number>;
} {
  if (src === undefined) {
    defaulted('guard.budget');
    return { ...DEFAULT_BUDGET, groupDaily: {} };
  }
  if (!isPlainObject(src)) {
    problems.push('guard.budget 必须是对象');
    return { ...DEFAULT_BUDGET, groupDaily: {} };
  }
  return {
    daily: parsePositiveInt(src.daily, 'guard.budget.daily', DEFAULT_BUDGET.daily, problems),
    perGroup: parsePositiveInt(src.perGroup, 'guard.budget.perGroup', DEFAULT_BUDGET.perGroup, problems),
    groupDaily: parseGroupDaily(src.groupDaily, problems),
  };
}

function parseWhitelist(src: unknown, problems: string[]): string[] {
  if (src === undefined) {
    defaulted('guard.linkWhitelist');
    return [...DEFAULT_LINK_WHITELIST];
  }
  if (!Array.isArray(src)) {
    problems.push('guard.linkWhitelist 必须是域名数组，例如 ["bilibili.com","b23.tv"]');
    return [...DEFAULT_LINK_WHITELIST];
  }
  const out: string[] = [];
  for (const item of src) {
    if (typeof item !== 'string' || item.trim() === '') {
      problems.push('guard.linkWhitelist 里有非法项（必须是非空字符串）：' + JSON.stringify(item));
      continue;
    }
    const domain = item.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain.includes('.')) {
      problems.push('guard.linkWhitelist 里的「' + item + '」不像域名（白名单写域名，不要写通配符）');
      continue;
    }
    out.push(domain);
  }
  return out;
}

function parseRulesText(src: unknown, problems: string[]): string {
  if (src === undefined) {
    defaulted('guard.rulesText');
    return DEFAULT_RULES_TEXT;
  }
  if (typeof src !== 'string' || src.trim() === '') {
    problems.push('guard.rulesText 必须是非空字符串（群规原文）');
    return DEFAULT_RULES_TEXT;
  }
  return src;
}

function defaultGuard(): GuardConfig['guard'] {
  return {
    keywords: cloneKeywords(DEFAULT_KEYWORDS),
    thresholds: { ...DEFAULT_THRESHOLDS },
    budget: { ...DEFAULT_BUDGET, groupDaily: {} },
    linkWhitelist: [...DEFAULT_LINK_WHITELIST],
    rulesText: DEFAULT_RULES_TEXT,
    caps: {},
    whitelist: [],
    exemptPhrases: [],
    silentSex: cloneSilentSex(DEFAULT_SILENT_SEX),
  };
}

function cloneSilentSex(src: SilentSexConfig): SilentSexConfig {
  const extreme: Record<string, string[]> = {};
  for (const [group, words] of Object.entries(src.extreme)) extreme[group] = [...words];
  return { rules: [...src.rules], extreme };
}

/**
 * guard.silentSex（2026-11-02 用户拍板）：色情静默闸门的受管条款 + 极端词表。
 * 缺省用内置默认（R7 + REDLINE，七组词）；写错了只报问题、退回默认，不放宽也不收紧别的条款。
 */
function parseSilentSex(src: unknown, problems: string[]): SilentSexConfig {
  const out = cloneSilentSex(DEFAULT_SILENT_SEX);
  if (src === undefined) return out;
  if (!isPlainObject(src)) {
    problems.push(
      'guard.silentSex 必须是对象，形如 { "rules": ["R7","REDLINE"], "extreme": { "交易": ["打包"] } }',
    );
    return out;
  }
  if (src.rules !== undefined) {
    if (!Array.isArray(src.rules)) {
      problems.push('guard.silentSex.rules 必须是条款号数组（只认 R7 / REDLINE）');
    } else {
      const list = src.rules.filter((r) => r === 'R7' || r === 'REDLINE') as SilentSexConfig['rules'];
      if (list.length !== src.rules.length) problems.push('guard.silentSex.rules 里有不认的条款号（只认 R7 / REDLINE）');
      out.rules = list;
    }
  }
  if (src.extreme !== undefined) {
    if (!isPlainObject(src.extreme)) {
      problems.push('guard.silentSex.extreme 必须是对象（组名 → 词数组）');
    } else {
      for (const [group, words] of Object.entries(src.extreme)) {
        if (!SILENT_SEX_GROUPS.includes(group as (typeof SILENT_SEX_GROUPS)[number])) {
          problems.push('guard.silentSex.extreme 有未知组「' + group + '」（只认 ' + SILENT_SEX_GROUPS.join(' / ') + '）');
          continue;
        }
        if (!Array.isArray(words) || words.some((w) => typeof w !== 'string')) {
          problems.push('guard.silentSex.extreme.' + group + ' 必须是字符串数组');
          continue;
        }
        out.extreme[group] = (words as string[]).filter((w) => w.trim() !== '');
      }
    }
  }
  return out;
}

/**
 * guard.caps：条款 → 档位上限（0–3）。
 * 缺省空表（不封顶，保持旧行为）；只有显式写了才压档。
 */
function parseSeverityCaps(src: unknown, problems: string[]): Record<string, number> {
  if (src === undefined) return {};
  if (!isPlainObject(src)) {
    problems.push('guard.caps 必须是对象，形如 { "R9": 0 }（键是条款号，值是 0–3 的档位上限）');
    return {};
  }
  const caps: Record<string, number> = {};
  for (const [key, value] of Object.entries(src)) {
    if (!CAP_RULE_IDS.includes(key)) {
      problems.push('guard.caps 的键「' + key + '」不是条款号（只认 ' + CAP_RULE_IDS.join(' / ') + '）');
      continue;
    }
    const n = typeof value === 'number' ? value : Number.NaN;
    if (!Number.isInteger(n) || n < 0 || n > 3) {
      problems.push('guard.caps.' + key + ' 必须是 0–3 的整数，拿到：' + JSON.stringify(value));
      continue;
    }
    caps[key] = n;
  }
  return caps;
}

function defaultJudge(env: NodeJS.ProcessEnv): GuardConfig['judge'] {
  const judge: GuardConfig['judge'] = { ...DEFAULT_JUDGE };
  const keyRaw = (env.DEEPSEEK_API_KEY ?? '').trim();
  if (keyRaw !== '') judge.apiKey = keyRaw;
  return judge;
}

function parseGuardSection(file: Record<string, unknown> | null, problems: string[]): GuardConfig['guard'] {
  const src = file === null ? undefined : file.guard;
  if (src === undefined) {
    // 整个文件都不在时上层的警告已经说明了原因，不再逐段刷屏
    if (file !== null) defaulted('guard');
    return defaultGuard();
  }
  if (!isPlainObject(src)) {
    problems.push('config.json 的 guard 必须是对象');
    return defaultGuard();
  }
  const obj = src;
  const extra = Object.keys(obj).filter((k) => !GUARD_KEYS.includes(k));
  if (extra.length > 0) problems.push('config.json 的 guard 有未知键：' + extra.join(', ') + '（只认 ' + GUARD_KEYS.join(' / ') + '）');
  return {
    keywords: parseKeywordTable(obj.keywords, problems),
    thresholds: parseThresholds(obj.thresholds, problems),
    budget: parseBudget(obj.budget, problems),
    linkWhitelist: parseWhitelist(obj.linkWhitelist, problems),
    rulesText: parseRulesText(obj.rulesText, problems),
    caps: parseSeverityCaps(obj.caps, problems),
    silentSex: parseSilentSex(obj.silentSex, problems),
    whitelist: parseQqList(obj.whitelist, 'guard.whitelist', [], problems),
    exemptPhrases: parsePhraseList(obj.exemptPhrases, 'guard.exemptPhrases', problems),
  };
}

function parseScreenSection(file: Record<string, unknown> | null, problems: string[]): GuardConfig['screen'] {
  const src = file === null ? undefined : file.screen;
  if (src === undefined) {
    if (file !== null) defaulted('screen');
    return { ...DEFAULT_SCREEN };
  }
  if (!isPlainObject(src)) {
    problems.push('config.json 的 screen 必须是对象');
    return { ...DEFAULT_SCREEN };
  }
  return {
    baseUrl: parseHttpUrl(src.baseUrl, 'screen.baseUrl', DEFAULT_SCREEN.baseUrl, problems),
    model: parseNonEmptyString(src.model, 'screen.model', DEFAULT_SCREEN.model, problems),
    enabled: parseBool(src.enabled, 'screen.enabled', DEFAULT_SCREEN.enabled, problems),
    timeoutMs: parsePositiveInt(src.timeoutMs, 'screen.timeoutMs', DEFAULT_SCREEN.timeoutMs, problems),
    gatedTimeoutMs: parsePositiveInt(
      src.gatedTimeoutMs,
      'screen.gatedTimeoutMs',
      DEFAULT_SCREEN.gatedTimeoutMs,
      problems,
    ),
  };
}

function parseJudgeSection(
  file: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv,
  problems: string[],
): GuardConfig['judge'] {
  const src = file === null ? undefined : file.judge;
  let obj: Record<string, unknown> = {};
  if (src === undefined) {
    if (file !== null) defaulted('judge');
    return defaultJudge(env);
  }
  if (!isPlainObject(src)) {
    problems.push('config.json 的 judge 必须是对象');
  } else {
    obj = src;
    if (src.apiKey !== undefined) {
      log.warn('config.json 里的 judge.apiKey 已忽略：这个目录会同步到两端，密钥只走 .env 的 DEEPSEEK_API_KEY');
    }
  }

  const keyRaw = (env.DEEPSEEK_API_KEY ?? '').trim();
  const judge: GuardConfig['judge'] = {
    baseUrl: parseHttpUrl(obj.baseUrl, 'judge.baseUrl', DEFAULT_JUDGE.baseUrl, problems),
    model: parseNonEmptyString(obj.model, 'judge.model', DEFAULT_JUDGE.model, problems),
    maxTokens: parsePositiveInt(obj.maxTokens, 'judge.maxTokens', DEFAULT_JUDGE.maxTokens, problems),
    timeoutMs: parsePositiveInt(obj.timeoutMs, 'judge.timeoutMs', DEFAULT_JUDGE.timeoutMs, problems),
  };
  if (keyRaw !== '') judge.apiKey = keyRaw;
  const sample = parseSampleRates(obj.sample, problems);
  if (sample !== undefined) judge.sample = sample;
  return judge;
}

/**
 * judge.sample 的三个键都是可选的：没写就用缺省口径（suspicious 1 / clean 0 / unknown 按时间），
 * 所以这里不 warn「缺少 xxx」，只在写错时报错——漏配不该在日志里刷屏。
 */
function parseSampleRates(src: unknown, problems: string[]): SampleRates | undefined {
  if (src === undefined) return undefined;
  if (!isPlainObject(src)) {
    problems.push(
      'config.json 的 judge.sample 必须是对象，形如 { "suspicious": 0.10, "clean": 0.02, "unknown": 0.05 }',
    );
    return undefined;
  }
  const extra = Object.keys(src).filter((k) => !SAMPLE_KEYS.includes(k));
  if (extra.length > 0) {
    problems.push('judge.sample 有未知键：' + extra.join(', ') + '（只认 ' + SAMPLE_KEYS.join(' / ') + '）');
  }
  const pick = (key: string, fallback: number): number => {
    const v = src[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      problems.push('judge.sample.' + key + ' 必须是 0..1 之间的数字，拿到：' + JSON.stringify(v));
      return fallback;
    }
    return v;
  };
  const rates: SampleRates = { suspicious: pick('suspicious', 1), clean: pick('clean', 0) };
  if (src.unknown !== undefined) rates.unknown = pick('unknown', 0.05);
  return rates;
}

/**
 * 收件人：config.json 的 notify.adminQqs ∪ .env 的 ADMIN_QQ；
 * 通知人：config.json 的 notify.recipients ∪ .env 的 NOTIFY_QQ（2026-11-04 新增，只收提醒、零权限）；
 * 按群通知人：config.json 的 notify.groupRecipients（键是群号，值是该群通知人 QQ 数组）。
 */
function parseNotifySection(
  file: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv,
  problems: string[],
): GuardConfig['notify'] {
  const fromFile: number[] = [];
  const recipientsFromFile: number[] = [];
  const groupRecipients: Record<string, number[]> = {};
  let enabled = false;
  const src = file === null ? undefined : file.notify;
  if (src !== undefined) {
    if (!isPlainObject(src)) {
      problems.push('config.json 的 notify 必须是对象，形如 { "adminQqs": [444444444] }');
    } else {
      const extra = Object.keys(src).filter((k) => !NOTIFY_KEYS.includes(k));
      if (extra.length > 0) {
        problems.push('config.json 的 notify 有未知键：' + extra.join(', ') + '（只认 ' + NOTIFY_KEYS.join(' / ') + '）');
      }
      const rawEnabled = src.enabled;
      if (rawEnabled !== undefined) {
        if (typeof rawEnabled !== 'boolean') {
          problems.push('notify.enabled 必须是 true / false');
        } else {
          enabled = rawEnabled;
        }
      }
      const readQqList = (key: string, into: number[]): void => {
        const raw = src[key];
        if (raw === undefined) return;
        if (!Array.isArray(raw)) {
          problems.push(`notify.${key} 必须是数字数组，形如 [444444444]`);
          return;
        }
        for (const v of raw) {
          if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
            problems.push(`notify.${key} 里有非法 QQ 号：` + JSON.stringify(v));
          } else {
            into.push(v);
          }
        }
      };
      readQqList('adminQqs', fromFile);
      readQqList('recipients', recipientsFromFile);

      const rawGroup = src.groupRecipients;
      if (rawGroup !== undefined) {
        if (!isPlainObject(rawGroup)) {
          problems.push('notify.groupRecipients 必须是对象，形如 { "123456": [444444444] }');
        } else {
          for (const [gidKey, list] of Object.entries(rawGroup)) {
            if (!/^\d+$/.test(gidKey) || Number(gidKey) <= 0) {
              problems.push('notify.groupRecipients 的键必须是群号：' + JSON.stringify(gidKey));
              continue;
            }
            if (!Array.isArray(list)) {
              problems.push(`notify.groupRecipients["${gidKey}"] 必须是数字数组`);
              continue;
            }
            const qqs: number[] = [];
            for (const v of list) {
              if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
                problems.push(`notify.groupRecipients["${gidKey}"] 里有非法 QQ 号：` + JSON.stringify(v));
              } else {
                qqs.push(v);
              }
            }
            if (qqs.length > 0) groupRecipients[gidKey] = Array.from(new Set(qqs));
          }
        }
      }
    }
  }

  const readEnvQqList = (key: string): number[] => {
    const raw = (env[key] ?? '').split(/[,\s]+/).filter((s) => s.length > 0);
    const bad = raw.filter((q) => !/^\d+$/.test(q) || Number(q) <= 0);
    if (bad.length > 0) problems.push(`${key} 里有非法 QQ 号：` + bad.join(', '));
    return raw.filter((q) => /^\d+$/.test(q) && Number(q) > 0).map(Number);
  };
  const fromEnv = readEnvQqList('ADMIN_QQ');
  const recipientsFromEnv = readEnvQqList('NOTIFY_QQ');

  return {
    enabled,
    adminQqs: Array.from(new Set([...fromFile, ...fromEnv])),
    recipients: Array.from(new Set([...recipientsFromFile, ...recipientsFromEnv])),
    groupRecipients,
  };
}

/** 原始流落盘：collect.enabled 默认 false，只有显式打开才写文件 */
function parseCollectSection(file: Record<string, unknown> | null, problems: string[]): GuardConfig['collect'] {
  const src = file === null ? undefined : file.collect;
  if (src === undefined) {
    if (file !== null) {
      log.info('config.json 没写 collect 段：原始流不落盘（要采集时加 { "enabled": true, "dir": "D:\\\\Syu\\\\samples\\\\collect" }）');
    }
    return { ...DEFAULT_COLLECT };
  }
  if (!isPlainObject(src)) {
    problems.push('config.json 的 collect 必须是对象，形如 { "enabled": true, "dir": "D:\\\\Syu\\\\samples\\\\collect" }');
    return { ...DEFAULT_COLLECT };
  }
  const extra = Object.keys(src).filter((k) => !COLLECT_KEYS.includes(k));
  if (extra.length > 0) {
    problems.push('config.json 的 collect 有未知键：' + extra.join(', ') + '（只认 ' + COLLECT_KEYS.join(' / ') + '）');
  }
  const enabled = parseBool(src.enabled, 'collect.enabled', DEFAULT_COLLECT.enabled, problems);
  const dir = parseNonEmptyString(src.dir, 'collect.dir', DEFAULT_COLLECT.dir, problems);
  // 共享目录里落原文会同步回本机（AGENTS.md §3）；硬规矩，直接拦住
  if (enabled && /desktop[\\/]share[\\/]syu/i.test(dir)) {
    problems.push(
      'collect.dir 落在 Syncthing 共享目录里：' + dir + '（原文会同步回本机，方案 §6 要求放服务器 D 盘）',
    );
  }
  return { enabled, dir };
}

/** 私聊收件箱：inbox.enabled 默认 false，只有显式打开才写文件 */
function parseInboxSection(file: Record<string, unknown> | null, problems: string[]): GuardConfig['inbox'] {
  const src = file === null ? undefined : file.inbox;
  if (src === undefined) {
    if (file !== null) {
      log.info('config.json 没写 inbox 段：私聊只认 #test，不收件');
    }
    return { ...DEFAULT_INBOX };
  }
  if (!isPlainObject(src)) {
    problems.push('config.json 的 inbox 必须是对象，形如 { "enabled": true, "dir": "D:\\\\Syu\\\\samples\\\\private-inbox" }');
    return { ...DEFAULT_INBOX };
  }
  const extra = Object.keys(src).filter((k) => !INBOX_KEYS.includes(k));
  if (extra.length > 0) {
    problems.push('config.json 的 inbox 有未知键：' + extra.join(', ') + '（只认 ' + INBOX_KEYS.join(' / ') + '）');
  }
  const enabled = parseBool(src.enabled, 'inbox.enabled', DEFAULT_INBOX.enabled, problems);
  const dir = parseNonEmptyString(src.dir, 'inbox.dir', DEFAULT_INBOX.dir, problems);
  if (enabled && /desktop[\\/]share[\\/]syu/i.test(dir)) {
    problems.push(
      'inbox.dir 落在 Syncthing 共享目录里：' + dir + '（私聊原文含昵称/QQ 号，必须放 D 盘）',
    );
  }
  return { enabled, dir };
}

/**
 * 把 data/learned-keywords.json 里的词并进 hints（2026-11-02）：
 * hints 只强制过本地粗筛、不直通云，学错一个词最坏是多一次粗筛，不会多花云预算。
 */
function mergeLearnedKeywords(table: KeywordTable, dataDir: string): void {
  const learned = readLearnedTieredSync(dataDir);
  const existing = new Set<string>([
    ...table.redline,
    ...table.alarm,
    ...table.softAlarm,
    ...table.recordOnly,
    ...Object.values(table.rules).flat(),
    ...Object.values(table.hints).flat(),
    ...Object.values(table.gated).flat(),
  ]);
  // 学来的词按档并入：gated（默认）与 direct（秒杀级硬词）
  for (const tier of ['gated', 'direct'] as const) {
    const target = tier === 'direct' ? table.rules : table.gated;
    for (const [rule, words] of Object.entries(learned[tier])) {
      if (!isLearnedRule(rule)) continue;
      const bucket = target[rule];
      if (bucket === undefined) continue;
      let added = 0;
      for (const word of words) {
        if (existing.has(word)) continue;
        bucket.push(word);
        existing.add(word);
        added += 1;
      }
      if (added > 0) {
        log.info(`[learn] 并入 ${added} 个学到的词到 ${tier === 'direct' ? 'rules' : 'gated'}.${rule}（来自 ${dataDir}）`);
      }
    }
  }
}

function parseActionsSection(file: Record<string, unknown> | null, problems: string[]): ActionsConfig {
  const src = file === null ? undefined : file.actions;
  if (src === undefined) {
    if (file !== null) defaulted('actions');
    return { ...DEFAULT_ACTIONS };
  }
  if (!isPlainObject(src)) {
    problems.push('config.json 的 actions 必须是对象');
    return { ...DEFAULT_ACTIONS };
  }
  const extra = Object.keys(src).filter((k) => !ACTIONS_KEYS.includes(k));
  if (extra.length > 0) {
    problems.push('config.json 的 actions 有未知键：' + extra.join(', ') + '（只认 ' + ACTIONS_KEYS.join(' / ') + '）');
  }
  return {
    dryRun: parseBool(src.dryRun, 'actions.dryRun', DEFAULT_ACTIONS.dryRun, problems),
    groupSilent: parseBool(src.groupSilent, 'actions.groupSilent', DEFAULT_ACTIONS.groupSilent, problems),
    muteEnabled: parseBool(src.muteEnabled, 'actions.muteEnabled', DEFAULT_ACTIONS.muteEnabled, problems),
    cooldownMs: parsePositiveInt(src.cooldownMs, 'actions.cooldownMs', DEFAULT_ACTIONS.cooldownMs, problems),
    actionDailyCap: parsePositiveInt(src.actionDailyCap, 'actions.actionDailyCap', DEFAULT_ACTIONS.actionDailyCap, problems),
  };
}

function parseConsoleSection(file: Record<string, unknown> | null, problems: string[]): ConsoleConfig {
  const src = file === null ? undefined : file.console;
  if (src === undefined) {
    if (file !== null) defaulted('console');
    return { ...DEFAULT_CONSOLE };
  }
  if (!isPlainObject(src)) {
    problems.push('config.json 的 console 必须是对象');
    return { ...DEFAULT_CONSOLE };
  }
  const extra = Object.keys(src).filter((k) => !CONSOLE_KEYS.includes(k));
  if (extra.length > 0) problems.push('config.json 的 console 有未知键：' + extra.join(', ') + '（只认 ' + CONSOLE_KEYS.join(' / ') + '）');
  const host = parseNonEmptyString(src.host, 'console.host', DEFAULT_CONSOLE.host, problems);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    log.warn('console.host = ' + host + '：控制台没有 token 门，正常只该监听 127.0.0.1');
  }
  return {
    enabled: parseBool(src.enabled, 'console.enabled', DEFAULT_CONSOLE.enabled, problems),
    host,
    port: parsePositiveInt(src.port, 'console.port', DEFAULT_CONSOLE.port, problems),
    napcatDir: parseNonEmptyString(src.napcatDir, 'console.napcatDir', DEFAULT_CONSOLE.napcatDir, problems),
    qqPath: parseNonEmptyString(src.qqPath, 'console.qqPath', DEFAULT_CONSOLE.qqPath, problems),
  };
}

function parseDataDir(file: Record<string, unknown> | null, problems: string[]): string {
  if (file === null) return DEFAULT_DATA_DIR;
  return parseNonEmptyString(file.dataDir, 'dataDir', DEFAULT_DATA_DIR, problems);
}

/** 读 config.json；不存在返回 null（走内置默认，只 warn 一次） */
function readConfigFile(configPath: string, problems: string[]): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log.warn('没有 ' + configPath + '：用内置默认配置（关键词表 v0.2 + 已定策略）');
    } else {
      problems.push('读不了配置文件 ' + configPath + '：' + String((err as Error).message));
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    problems.push('配置文件 ' + configPath + ' 不是合法 JSON：' + (err as Error).message);
    return null;
  }
  if (!isPlainObject(parsed)) {
    problems.push('配置文件 ' + configPath + ' 顶层必须是对象');
    return null;
  }
  const unknown = Object.keys(parsed).filter((k) => !TOP_KEYS.includes(k));
  if (unknown.length > 0) {
    problems.push('配置文件 ' + configPath + ' 有未知顶层键：' + unknown.join(', ') + '（只认 ' + TOP_KEYS.join(' / ') + '）');
  }
  return parsed;
}

/**
 * 一次把所有问题收集齐再抛，免得用户改一个跑一次。
 * 环境变量管 OneBot 连接与日志；关键词表/阈值/预算/端点/群规从 config.json 读。
 * OWNER_QQ 支持多个 QQ（逗号/空白分隔），名单里的人既豁免说话判定，也收 3 级证据私聊。
 * GUARD_GROUP_OWNERS 按群绑定 3 级接收人（方案 §14）：绑定群只发绑定者，绑定者仅本群豁免。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GuardConfig {
  loadDotEnv();

  const problems: string[] = [];

  // 3002 是本机器人的 NapCat；3001 是服务器上 Dyu 的 NapCat，不能抢
  const wsUrl = (env.ONEBOT_WS_URL ?? 'ws://127.0.0.1:3002').trim();
  let urlOk = false;
  try {
    const parsed = new URL(wsUrl);
    urlOk = parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  } catch {
    urlOk = false;
  }
  if (!urlOk) problems.push('ONEBOT_WS_URL 不是合法的 ws/wss 地址：' + wsUrl);

  const tokenRaw = (env.ONEBOT_TOKEN ?? '').trim();
  const token = tokenRaw === '' ? undefined : tokenRaw;

  const groupRaw = (env.GUARD_GROUP_IDS ?? '').split(/[,\s]+/).filter((s) => s.length > 0);
  if (groupRaw.length === 0) {
    problems.push('缺少 GUARD_GROUP_IDS：不知道要守哪些群（例：GUARD_GROUP_IDS=20001,20002）');
  }
  const badGroups = groupRaw.filter((g) => !/^\d+$/.test(g) || Number(g) <= 0);
  if (badGroups.length > 0) {
    problems.push('GUARD_GROUP_IDS 里有非法群号：' + badGroups.join(', '));
  }
  const groupIds = groupRaw.filter((g) => /^\d+$/.test(g) && Number(g) > 0).map(Number);

  // 与 GUARD_GROUP_IDS 同一套解析：逗号/空白分隔，单值写法继续有效
  const ownerRaw = (env.OWNER_QQ ?? '').split(/[,\s]+/).filter((s) => s.length > 0);
  if (ownerRaw.length === 0) {
    problems.push('缺少 OWNER_QQ：接收人 QQ 号，多个用逗号分隔（例：OWNER_QQ=111,222；说话豁免与 3 级证据私聊都要用）');
  }
  const badOwners = ownerRaw.filter((q) => !/^\d+$/.test(q) || Number(q) <= 0);
  if (badOwners.length > 0) {
    problems.push('OWNER_QQ 里有非法 QQ 号：' + badOwners.join(', '));
  }
  const ownerQqs = Array.from(new Set(ownerRaw.filter((q) => /^\d+$/.test(q) && Number(q) > 0).map(Number)));

  // GUARD_GROUP_OWNERS（方案 §14.1）：`20001:111,222;20002:333`。空/缺 = 无绑定，行为同 v2。
  // 绑定的群必须在 GUARD_GROUP_IDS 里，否则启动报错（防手改漏配）。
  const groupOwnersRaw = (env.GUARD_GROUP_OWNERS ?? '').trim();
  const groupOwners: Record<number, number[]> = {};
  if (groupOwnersRaw !== '') {
    for (const entryRaw of groupOwnersRaw.split(';')) {
      const entry = entryRaw.trim();
      if (entry === '') continue;
      const colon = entry.indexOf(':');
      if (colon <= 0) {
        problems.push('GUARD_GROUP_OWNERS 条目缺冒号（应为 群号:QQ,QQ）：' + entry);
        continue;
      }
      const groupPart = entry.slice(0, colon).trim();
      if (!/^\d+$/.test(groupPart) || Number(groupPart) <= 0) {
        problems.push('GUARD_GROUP_OWNERS 里的群号不合法：' + groupPart);
        continue;
      }
      const gid = Number(groupPart);
      if (!groupIds.includes(gid)) {
        problems.push('GUARD_GROUP_OWNERS 绑定的群 ' + gid + ' 不在 GUARD_GROUP_IDS 里，先把它加进守卫列表');
        continue;
      }
      const qqRaw = entry.slice(colon + 1).split(/[,\s]+/).filter((s) => s.length > 0);
      const badQq = qqRaw.filter((q) => !/^\d+$/.test(q) || Number(q) <= 0);
      if (badQq.length > 0) {
        problems.push('GUARD_GROUP_OWNERS 群 ' + gid + ' 里有非法 QQ 号：' + badQq.join(', '));
        continue;
      }
      const bound = Array.from(new Set(qqRaw.filter((q) => /^\d+$/.test(q) && Number(q) > 0).map(Number)));
      if (bound.length > 0) groupOwners[gid] = bound;
    }
  }

  const logLevelRaw = (env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel)) {
    problems.push('LOG_LEVEL 只能是 ' + LOG_LEVELS.join(' | ') + '，拿到：' + logLevelRaw);
  }
  const logLevel = (LOG_LEVELS.includes(logLevelRaw as LogLevel) ? logLevelRaw : 'info') as LogLevel;

  const mock = ['1', 'true', 'yes', 'on'].includes((env.MOCK_MODE ?? '').trim().toLowerCase());

  // config.json：路径可从环境变量改（测试与多实例用），默认工程根目录
  const configPath = (env.GUARD_CONFIG_PATH ?? '').trim() || CONFIG_FILE_DEFAULT;
  const file = readConfigFile(configPath, problems);
  const guard = parseGuardSection(file, problems);
  const screen = parseScreenSection(file, problems);
  const judge = parseJudgeSection(file, env, problems);
  const actions = parseActionsSection(file, problems);
  const dataDir = parseDataDir(file, problems);
  const consoleCfg = parseConsoleSection(file, problems);
  const notify = parseNotifySection(file, env, problems);
  const collect = parseCollectSection(file, problems);
  const inbox = parseInboxSection(file, problems);

  // 举报受理后学到的词（data/learned-keywords.json）：只并入 hints（低精度、只强制本地粗筛），
  // 不直通云、不改 config.json；删掉那个文件就等于忘掉（2026-11-02 用户拍板）。
  mergeLearnedKeywords(guard.keywords, dataDir);

  if (problems.length > 0) {
    throw new Error('配置有问题，启动中止：\n  - ' + problems.join('\n  - '));
  }

  return {
    onebot: { wsUrl, token, groupIds, ownerQqs, groupOwners },
    logLevel,
    mock,
    guard,
    screen,
    judge,
    notify,
    collect,
    inbox,
    actions,
    dataDir,
    console: consoleCfg,
  };
}

/**
 * 控制台单独读配置：守卫没起来时它也得能跑，所以不能因为
 * GUARD_GROUP_IDS / OWNER_QQ 缺失就抛错。这一段写坏了只 warn，用默认值继续。
 */
export function loadConsoleConfig(env: NodeJS.ProcessEnv = process.env): ConsoleConfig {
  loadDotEnv();
  const problems: string[] = [];
  const configPath = (env.GUARD_CONFIG_PATH ?? '').trim() || CONFIG_FILE_DEFAULT;
  const file = readConfigFile(configPath, problems);
  const cfg = parseConsoleSection(file, problems);
  for (const p of problems) log.warn('控制台配置：' + p);
  return cfg;
}
