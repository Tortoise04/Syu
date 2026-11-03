import type { JudgeInput, JudgeResult, RuleId, Severity } from './types.ts';

/**
 * 云端终审客户端：打 OpenAI 兼容的 /chat/completions（deepseek-flash）。
 * 职责只有两件：把请求拼对（含图片段），把模型输出收成严格枚举与区间。
 * 任何失败都返回 degraded:true 的 0 级结果 —— 0 级 = 只记录不动手，绝不当成「模型说没问题」。
 */

const RULE_IDS: readonly RuleId[] = [
  'REDLINE',
  'R3',
  'R4',
  'R5',
  'R6',
  'R7',
  'R8',
  'R9',
  'R10',
  'R11',
  'OTHER',
];

const RULE_SET: ReadonlySet<string> = new Set<string>(RULE_IDS);

/** reason 硬上限（字符数） */
const REASON_MAX = 200;
/** 排障用的模型原始输出尾部长度 */
const RAW_TAIL_MAX = 600;
/** 一次终审最多带几张图 */
const MAX_IMAGES = 2;

type TextPart = { type: 'text'; text: string };
type ImagePart = { type: 'image_url'; image_url: { url: string } };
type ContentPart = TextPart | ImagePart;

export type JudgeOptions = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
};

export type ParsedJudgeOutput = {
  severity: Severity;
  confidence: number;
  reason: string;
  rule: RuleId;
  extraRules: RuleId[];
  /** 导致判定的最短原话片段；空串 = 模型没给 */
  span: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}`;
}

function toRuleId(value: unknown): RuleId {
  return typeof value === 'string' && RULE_SET.has(value) ? (value as RuleId) : 'OTHER';
}

function toSeverity(value: unknown): Severity {
  const num = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(num)) return 0;
  // 取整并裁到 0..3，允许 "2.6" 这种越界/小数写法
  const rounded = Math.round(num);
  return clamp(rounded, 0, 3) as Severity;
}

/**
 * 把模型输出收成严格结构；返回 null 表示「这不是一份终审结论」（解析不出 JSON）。
 * 容忍：```json 围栏、前后解释文字、JSON 后带尾巴。
 */
export function parseJudgeOutput(raw: string): ParsedJudgeOutput | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.length === 0) return null;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }

  const obj = asRecord(parsed);
  if (obj === null) return null;

  // 四个业务字段一个都没有 = 不是终审结论（哪怕它是合法 JSON）
  const hasAny =
    'severity' in obj || 'confidence' in obj || 'rule' in obj || 'reason' in obj;
  if (!hasAny) return null;

  const confidenceRaw = obj['confidence'];
  const confidence =
    typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw)
      ? clamp(confidenceRaw, 0, 1)
      : 0;

  const rule = toRuleId(obj['rule']);

  const reasonRaw = obj['reason'];
  const reason = typeof reasonRaw === 'string' ? truncate(reasonRaw.trim(), REASON_MAX) : '';

  const extraRules: RuleId[] = [];
  const extraRaw = obj['extraRules'];
  if (Array.isArray(extraRaw)) {
    for (const item of extraRaw) {
      if (typeof item !== 'string' || !RULE_SET.has(item)) continue;
      const id = item as RuleId;
      if (id === rule) continue;
      if (extraRules.includes(id)) continue;
      extraRules.push(id);
    }
  }

  // 拆词（2026-11-02）：模型指回「导致判定的那段原话」，举报受理后用来补词表。
  // 非必需字段：老调用方/老提示词没有它也照常工作；截到 40 字再交给上层清洗。
  const spanRaw = obj['span'];
  const span = typeof spanRaw === 'string' ? truncate(spanRaw.trim(), 40) : '';

  return { severity: toSeverity(obj['severity']), confidence, reason, rule, extraRules, span };
}

function normalizeImageUrl(src: string): string {
  const value = src.trim();
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  if (value.startsWith('data:')) return value;
  // 裸 base64：补 data URL 前缀，否则 OpenAI 兼容端点会 400
  return `data:image/jpeg;base64,${value}`;
}

function buildSystemPrompt(rulesText: string): string {
  const rules = rulesText.trim().length > 0 ? rulesText.trim() : '（群规原文缺失）';
  return [
    '你是 QQ 群管理助手，负责按下述群规判断一条被举报/被怀疑的群消息是否违规，并给出处置档位。',
    '【群规原文】',
    rules,
    '',
    '【处置档位 severity】',
    '0 = 无违规或证据不足，只记录不动手',
    '1 = 轻微违规，@ 提醒',
    '2 = 明确违规，@ 警告',
    '3 = 严重违规（红线/色情交易/诈骗/军火），私聊管理员与主人',
    '',
    '【条款编号 rule】只能是这些值之一：',
    'REDLINE 红线（毒品/诈骗跑分/色情交易/军火炸药）、R3、R4、R5、R6、R7、R8、R9、R10、R11（esu 恶俗、开盒人肉群友）、OTHER（不属于上面任何一条）',
    '',
    '【开盒威胁与暴力威胁的边界（2026-11-02 用户拍板）】',
    '- 开盒 / 人肉 / 查户籍 / 社工库 / 挂人：针对群内真实用户、或声称能查到其真实身份 → R11（秒杀级），severity 3，理由写「开盒威胁群友」。',
    '- 口语常省字：「再bb开你」「查你」「你家在哪」「我知道你住哪」这种对群友说要找上门、要查身份的话，同样按开盒威胁 → R11，severity 3；不要因为没写「盒」字就降档放过。',
    '- 「弄死你」「杀了你」这类暴力威胁，对象是群内真实用户 → R4，severity 2；对象是游戏角色/台词/玩梗 → 0。',
    '- 开盒词出现在讨论、新闻、引用的语境里（不是在威胁群友）→ 0，并在 reason 里说明是转述。',
  // 2026-11-03 用户拍板（C 方案）：不许放宽 R11 的定义，只补两条锚例教模型分语境。
  '- 游戏语境不算开盒（2026-11-03 用户拍板）：「box发来」「发box看看」「申请会诊」「帮看号」里的 box 指角色池截图，是看配队，severity 0，理由写「游戏语境，非开盒」。',
  '- 但 esu 黑话本身就是开盒话题，不许因为像整活就放过：「非要恶俗大手子满地跑,才晓得要维护环境」「我要挂人社工库查他」「再串小心被挂某吧」→ R11，severity 3，理由写「开盒威胁群友」。',
    '',
    '【R3 判定口径（2026-11-02 用户拍板）】',
    '- R3 里这几类内容属**秒杀级**（severity 3，不解释）：猎奇（肢解/虐杀/恋尸/食人/虐杀动物等具体描述或图）、男女权对立（男拳/女拳式的性别攻击、挑性别对立）、时政/键政（见证明示、表达政治立场、就政治事件或人物站队、键政对线）、731 娱乐化（把 731 部队当梗、开玩笑、娱乐化）。',
    '- 时政的边界（2026-11-03 用户拍板）：把政治人物名字当**无观点的整活道具**、没有立场表达、不指向真实政治事件（例：「奖励一个蒋介石胸罩」「高市早苗内裤」）→ severity 0，reason 写「整活提及人名」；只有表达了政治立场、评论政治事件、或借人名攻击现实群体时才按 R3 秒杀。',
    '- 731 单独出现（日期、编号、年份）不算违规；只有当它被拿来娱乐化、调侃、或与「娱乐/好玩/梗」连用时，才按 R3 秒杀 3 级。',
    '- 只有「发癫/开玩笑/口嗨」这类没有具体内容、没有指向的胡话，才按 1–2 级处理，不要一律秒杀。',
    '',
    '【R9 bhhs 口径（2026-11-02 用户拍板）】',
    '- bhhs / 白海黑少 / hs：判定为 R9；档位给 0（只记录），并在 reason 里写明是 R9 提及。机器人会把这条私聊发给群主，不在群里 @ 或警告。',
    '- 除非该条本身另有违规（如同时开盒、骂人），否则 R9 不升档。',
    '',
    '【R4 判定口径（2026-11-01 用户拍板）】',
    '- 拉踩 = 有明确比较/捧踩的行为（如「XX 就是个垃圾，不如 YY」），抬高一边、贬低另一边。',
    '- 对游戏角色、剧情、作品的随口吐槽或爆粗（如「这孙子」「策划是狗」）不是拉踩，也不是人身攻击。',
    '- 人身攻击 = 对群内真实用户的人格侮辱（针对人的辱骂、威胁、羞辱）。对象是虚拟角色/作品时一律不适用。',
    '- 群规没有「禁止爆粗」这一条：单句脏话、口头禅不构成违规，不要为了凑档位硬套 R4。',
    '- 只有两种情况仍按 R4 从严：①辱骂或威胁具体群友（认定标准是有明确侮辱性词汇、人格侮辱、威胁，或连续攻击同一人）；**@ 了具体群友本身不构成认定理由**——「去你的」「滚」「靠」这类没有实际侮辱内容的口头语，即使 @ 了人也判 0 级（2026-11-03 用户拍板）；②组织性捧一踩一、把争吵引到群里并已引发对线。',
    '- 广告 = 有明确导流意图：群号、外部链接、二维码拉人、代练代充出售、价格+联系方式。机器人自己的「扫码绑定」「免责声明」「验证码」「米游社 uid/stoken」提示、游戏内交易、单纯加好友闲聊都**不是**广告 → 0。',
    '',
    '【消息里的占位符】',
    '- `[at:123456]` = 这条消息 @ 了 QQ 123456 这位群友；`[at:全体]` = @全体成员。',
    '- `[image]` = 图片占位符（不是可读文字）；`[reply]` 表示引用了别的消息，被引用的原文会出现在上下文里。',
    '- 判脏话（傻逼/垃圾/废物…）时先看本条有没有 `[at:…]`：@ 了具体群友就是对着人说的，按 R4 从严；没有 @、且上下文在聊策划/角色/作品时按「吐槽作品」处理。别因为上下文全在骂策划，就把本条 @ 了群友的辱骂也算成骂策划。注意「去你的/滚/靠」这类口头语不适用这条从严规则，见上一条。',
    '',
    '【判定要求】',
    '只依据给出的上下文与本条消息判断；截图/反讽/缩写要结合上下文理解。',
    '证据不足时 severity 给 0 并说明原因，不要为了凑档位而猜。',
    'confidence 是 0..1 的小数，表示你对 severity 判断的把握。',
    '',
    '【拆词 span】',
    '- span 只写「导致这次判定的那段最短原话」，例如「我弄死你」「开你盒」；没有明确片段就填空字符串。',
    '- 不要复述整句、不要写条款名、不要写解释；最长 15 个字，不含标点与 @ 占位符。',
    '',
    '只输出一个 JSON 对象，不要代码围栏，不要任何解释文字：',
    '{"severity":0-3,"confidence":0-1,"reason":"中文一句话","rule":"<枚举>","extraRules":[],"span":"<原话片段，可为空串>"}',
  ].join('\n');
}

function buildUserText(input: JudgeInput): string {
  const parts: string[] = [];

  const hits = input.keywordHits;
  if (hits.length > 0) {
    parts.push('【本地关键词命中】');
    for (const hit of hits) {
      const flag = hit.mustJudge ? '送审' : '仅记录';
      parts.push(`- ${hit.word}（规则 ${hit.rule}，${hit.kind}，${flag}）`);
    }
    parts.push('');
  } else {
    parts.push('【本地关键词命中】（无）');
    parts.push('');
  }

  parts.push(`【送审原因】${input.channel}`);
  parts.push('');
  parts.push('【群聊上下文（时间升序，【被举报】标记的是被判定那条）】');
  const ordered = [...input.context].sort((a, b) => a.time - b.time);
  if (ordered.length === 0) {
    parts.push('- （无上下文，只有被举报消息）');
  }
  for (const item of ordered) {
    const mark = item.isTarget ? '【被举报】' : '';
    const images = item.images.length > 0 ? ` [附图 ${item.images.length} 张]` : '';
    parts.push(
      `- ${mark}${item.nickname}(${item.userId}) ${item.time}: ${truncate(item.text, 500)}${images}`,
    );
  }

  if (!input.context.some((item) => item.isTarget)) {
    parts.push('');
    parts.push('【被举报消息】');
    parts.push(`${input.target.nickname}(${input.target.userId}) ${input.target.time}: ${truncate(input.target.text, 1000)}`);
  }

  parts.push('');
  parts.push('请按群规判定，只输出那一个 JSON 对象。');
  return parts.join('\n');
}

function pickImages(input: JudgeInput): string[] {
  const fromTarget = input.target.images.filter((img) => img.trim().length > 0);
  if (fromTarget.length > 0) return fromTarget.slice(0, MAX_IMAGES);
  const fromContext = input.context
    .filter((item) => item.isTarget)
    .flatMap((item) => item.images)
    .filter((img) => img.trim().length > 0);
  return fromContext.slice(0, MAX_IMAGES);
}

function degradedResult(reason: string, raw?: string): JudgeResult {
  const result: JudgeResult = { severity: 0, confidence: 0, reason, rule: 'OTHER', degraded: true };
  if (raw !== undefined) result.raw = raw;
  return result;
}

export class Judge {
  #baseUrl: string;
  #apiKey: string | undefined;
  #model: string;
  #maxTokens: number;
  #timeoutMs: number;

  constructor(opts: JudgeOptions) {
    const base = opts.baseUrl.trim().replace(/\/+$/, '');
    // 允许调用方把完整路径传进来（含或以 /chat/completions 结尾）
    this.#baseUrl = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    const key = (opts.apiKey ?? '').trim();
    this.#apiKey = key.length > 0 ? key : undefined;
    this.#model = opts.model;
    this.#maxTokens = opts.maxTokens;
    this.#timeoutMs = opts.timeoutMs;
  }

  /** 任何异常都返回 degraded:true 的 0 级结果 */
  async judge(input: JudgeInput): Promise<JudgeResult> {
    if (this.#apiKey === undefined) {
      // 不发请求：由上层把这种情况记成「未配置终审」
      return degradedResult('终审未配置：缺少 API key');
    }

    try {
      const userContent: string | ContentPart[] = buildUserContent(input);
      const res = await fetch(this.#baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify({
          model: this.#model,
          max_tokens: this.#maxTokens,
          temperature: 0,
          stream: false,
          messages: [
            { role: 'system', content: buildSystemPrompt(input.rulesText) },
            { role: 'user', content: userContent },
          ],
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        return degradedResult(`终审 HTTP ${res.status}: ${truncate(bodyText, 120)}`);
      }

      const body = asRecord(await res.json());
      const choices = body?.['choices'];
      const choice = Array.isArray(choices) ? asRecord(choices[0]) : null;
      const message = asRecord(choice?.['message']);
      const contentRaw = message?.['content'];
      const content = typeof contentRaw === 'string' ? contentRaw : '';
      const finishReason = choice?.['finish_reason'];

      // 推理模型的思考 token 也计入 max_tokens：被截断且正文空 = 没拿到结论
      if (finishReason === 'length' && content.trim().length === 0) {
        return degradedResult('终审被 max_tokens 截断（思考 token 占满，正文为空），按未拿到结论处理');
      }
      if (content.trim().length === 0) {
        return degradedResult('终审返回空正文', typeof finishReason === 'string' ? `finish_reason=${finishReason}` : undefined);
      }

      const parsed = parseJudgeOutput(content);
      const rawTail = content.length > RAW_TAIL_MAX ? content.slice(-RAW_TAIL_MAX) : content;
      if (parsed === null) {
        return degradedResult('终审输出无法解析为 JSON 结论', rawTail);
      }

      return {
        severity: parsed.severity,
        confidence: parsed.confidence,
        reason: parsed.reason,
        rule: parsed.rule,
        extraRules: parsed.extraRules,
        span: parsed.span,
        raw: rawTail,
        degraded: false,
      };
    } catch (err) {
      return degradedResult(`终审异常：${errText(err)}`);
    }
  }
}

/** 纯文本走 string；有图才拼数组（空数组会被 OpenAI 兼容端点判 400） */
function buildUserContent(input: JudgeInput): string | ContentPart[] {
  const text = buildUserText(input);
  const images = pickImages(input);
  if (images.length === 0) return text;
  const parts: ContentPart[] = [{ type: 'text', text }];
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: normalizeImageUrl(img) } });
  }
  return parts;
}
