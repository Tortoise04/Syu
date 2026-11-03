/**
 * 守卫管线的共享契约。由调度方维护，各模块只读不改：
 * 模块需要额外类型就在自己的文件里定义，不要往这里加。
 * 这里只有类型，没有运行时代码。
 */

/** 判定条款：红线 + 群规第 3..11 条。judge 吐出的 rule 必须落成这些值之一，否则归 OTHER */
export type RuleId =
  | 'REDLINE'
  | 'R3'
  | 'R4'
  | 'R5'
  | 'R6'
  | 'R7'
  | 'R8'
  | 'R9'
  | 'R10'
  | 'R11'
  | 'OTHER';

/** 处置档位，见方案第 4 节：0 只记录 / 1 @提醒 / 2 @警告 / 3 私聊管理员+主人 */
export type Severity = 0 | 1 | 2 | 3;

/** 为什么送审。冷却只压 action，不压送审；预算才压一切（举报除外） */
export type Channel = 'keyword' | 'link' | 'screen' | 'gated' | 'report' | 'sample';

/** 本地粗筛三态。unknown 是「没筛成」，不是「干净」，不允许被当成 clean 放行 */
export type ScreenVerdict = 'clean' | 'suspicious' | 'unknown';

export interface ScreenResult {
  verdict: ScreenVerdict;
  /** 只有 suspicious 时有意义：粗筛猜的条款 */
  rule?: RuleId;
  /** 0..1，粗筛自报的可疑度，仅供参考，不参与判定 */
  score?: number;
  detail?: string;
  /** 模型给出的逐字违规片段（A 举证式提示词才有；空 = 没举证） */
  evidence?: string;
  /** 模型给的一句话理由 */
  reason?: string;
  /** true = 降级模式（本地模型没开/超时/报错），必须同时体现在判定记录里 */
  degraded: boolean;
}

/** 一条消息的上下文快照；判定只读快照，不回读环形缓冲 */
export interface ContextItem {
  messageId: number;
  userId: number;
  nickname: string;
  /** 秒级时间戳（OneBot 的 time 字段） */
  time: number;
  /** 归一化正文，图片段占位为 [image] */
  text: string;
  /** 本条消息里的图片（URL 或 base64，由 judge 决定怎么拼） */
  images: string[];
  /** 被举报/被追问的那条 */
  isTarget: boolean;
}

export interface KeywordHit {
  rule: RuleId;
  /** 命中的词，保留原始大小写便于日志核对 */
  word: string;
  /** alarm = 报警词（炸群/喊停），直通云但不预设条款，rule 落成 OTHER 由终审定；
   *  hint = 低精度词/软报警词，命中只强制过本地粗筛，不直通云；
   *  gated = 需本地确认的词（如 731/垃圾），命中先跑带思考的本地确认，可疑才送云 */
  kind: 'redline' | 'rule' | 'link' | 'flood' | 'alarm' | 'hint' | 'gated';
  /** false = 命中但要记录不送审（例：允许的群内交易词 出号/收号/代练/代充） */
  mustJudge: boolean;
}

export interface JudgeInput {
  channel: Channel;
  target: ContextItem;
  /** 时间升序，含 target */
  context: ContextItem[];
  /** 群规原文 */
  rulesText: string;
  /** 同一 message_id 的所有关键词命中已合并，一次送审 */
  keywordHits: KeywordHit[];
}

export interface JudgeResult {
  severity: Severity;
  /** 0..1 */
  confidence: number;
  reason: string;
  /** 只信枚举值；模型给了非法值已归 OTHER，且 OTHER 不参与「当天第 2 次升 3」 */
  rule: RuleId;
  /** 模型原始输出尾部，排障用 */
  raw?: string;
  /** true = 没拿到有效终审（网络/超时/非 JSON/预算），按「只记录不动手」处理 */
  degraded: boolean;
  /** 同一判定里额外命中的条款，写进同一条记录 */
  extraRules?: RuleId[];
  /** 导致判定的最短原话片段（云端拆词，2026-11-02）：举报受理后据它补词表 */
  span?: string;
}

/**
 * 最终动作。none 也包括「判定成立但被冷却压在只记录」的情况。
 * notify（2026-11-02）：色情静默档——群里一个字不发，只私聊收件人。
 */
export type ActionTaken = 'none' | 'remind' | 'warn' | 'escalate' | 'mute' | 'notify';

export interface Decision {
  channel: Channel;
  rule: RuleId;
  severity: Severity;
  confidence: number;
  action: ActionTaken;
  reason: string;
  hits: KeywordHit[];
  degraded: boolean;
  /** 被冷却拦住、只记录没动作 */
  cooledDown: boolean;
}

/** violations.jsonl 一行一条，判 0 级的也写 */
export interface ViolationRecord {
  /** 本地 ISO 时间 */
  ts: string;
  groupId: number;
  userId: number;
  nickname: string;
  messageId: number;
  channel: Channel;
  /** 原文摘要，最长 200 字 */
  text: string;
  rule: RuleId;
  extraRules: RuleId[];
  severity: Severity;
  confidence: number;
  reason: string;
  keywords: string[];
  action: ActionTaken;
  cooledDown: boolean;
  degraded: boolean;
  /** 是否被抽中送云端终审；没走抽检的通道（必判/举报/只记录词）不写这个字段 */
  sampled?: boolean;
  /** 抽签结果 [0,1)，配合 sampleRate 可事后复算「为什么这条没送云」 */
  sampleRoll?: number;
  /** 本条适用的抽检率 */
  sampleRate?: number;
  /**
   * 粗筛当时猜的条款（只在走了粗筛、没进终审的记录里写）。
   * 和 rule 分开：rule 是「判定结论的条款」，hintRule 是「8B 的猜测」，
   * 混在一起会让控制台把猜测显示成判定（2026-11-01 假 R5/R9 的根源）。
   */
  hintRule?: RuleId;
  /** 粗筛自报的可疑度 0..1，仅供参考 */
  screenScore?: number;
  /** 粗筛给出的逐字证据片段（A 举证式提示词；空 = 没举证） */
  screenEvidence?: string;
  /** 粗筛给的一句话理由 */
  screenReason?: string;
  /** 云端拆出的「导致判定的最短原话」（举报受理后据它补词表，2026-11-02） */
  span?: string;
  /** 真正发出去的那条文案（动作层填；dryRun 或没动手时留空） */
  sentText?: string;
}
