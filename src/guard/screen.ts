import type { RuleId, ScreenResult } from './types.ts';

/**
 * 本地粗筛客户端：打 Ollama 的 /api/chat。
 * 选 /api/chat 而不是 /api/generate：Ollama 的 chat 端点支持 system+user 两段、
 * 支持 format:'json' 强约束、且和云端终审的 messages 形状一致，两个客户端读同一套提示词结构。
 * 失败一律 unknown + degraded，绝不回落成 clean（unknown 是「没筛成」，不是「干净」）。
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

export type ScreenerOptions = {
  baseUrl: string;
  model: string;
  enabled: boolean;
  timeoutMs: number;
  /** gated 词的「本地确认」超时（开思考链，慢 2–4 倍），缺省 30000 */
  gatedTimeoutMs?: number;
};

/** 粗筛只允许这两态；unknown 由客户端在解析失败时给出，不由模型给出 */
type ModelVerdict = 'clean' | 'suspicious';

const SYSTEM_PROMPT = [
  '你是 QQ 群消息的本地粗筛器，只决定要不要送云端终审，不下结论。',
  '群规条款：',
  'REDLINE 红线（毒品/诈骗跑分/色情交易/军火炸药）',
  'R3 猎奇血腥、性别对立、时政键政',
  'R4 人身攻击、引战、广告拉群、账号代练交易',
  'R5 无意义论战（各说各的、吵不出结果的口水仗）',
  'R6 营销号标题党（速看/不看后悔）',
  'R7 明确的色情内容（性行为、性器官、性交易、索要露点图）',
  'R8 打探隐私/炫富（家产几套房月薪工资收入存款房贷车贷年薪）',
  'R9 黑话 bhhs',
  'R11 恶俗 esu、开盒/人肉群友（秒杀级）',
  // 2026-11-02 用户拍板：R3 的猎奇/男女权/时政 是秒杀级内容；731 娱乐化也是秒杀。
  'R3 里的猎奇（肢解/虐杀/恋尸/食人/虐动物）、男女权对立（男拳女拳式性别攻击）、时政键政（表达政治立场/评论政治事件）、731 娱乐化 → 秒杀级，照实判 suspicious。',
  '把政治人物名字当无观点的整活道具、没有立场表达（如「奖励一个蒋介石胸罩」「高市早苗内裤」）→ clean，不要当 R3。',
  '731 单独出现（年份/编号）不算；被拿来开玩笑、娱乐化、当梗用才算。',
  '只有「发癫/口嗨/没内容的胡话」才按 1–2 级处理，不要秒杀。',
  // 2026-11-02 变体：恢复「宁可错杀」判定口径，但保留 evidence 字段（供 B 门禁抽掉空证据的猜测）。
  // 依据：A+B 在 59 条有标注样本上把 ≥1 级召回从 28–29/29 打到 3/29，且 58 行里没有一行是门禁降级——
  // 是模型自己判的 clean（reason 多为「讨论历史事件，无明确违规」），所以问题在口径不在门禁。
  '判定原则：粗筛不是判决。漏一条真违规没人兜底，多报一条只多花一次云调用——宁可错杀不可放过。',
  '1. 先看「待筛选消息」里有没有一段能原样抄出来的原文，它可能和某条条款有关；谐音、缩写、黑话、隐喻、代称都算，抄原文即可，不用解释。',
  '2. 找到：verdict=suspicious，rule 填最接近的条款，evidence 原样抄那段原文（1–30 字，必须能在消息里逐字找到）。',
  '3. 拿不准、看不懂、像谐音/缩写/反讽/玩笑/隐喻、要推理或补背景才明白 → 一律 suspicious，把那段可疑原文抄进 evidence。',
  '4. 只有明确无关的日常闲聊（打招呼、约时间、问价、游戏攻略、报进度、天气、表情）才判 clean：evidence 填 ""，score 写 0.0 到 0.2。',
  // 2026-11-04 用户拍板：只讲判据、不举具体句子——举句子会让模型去认句子，换种说法就失效。
  '5. 判断看「这句话在做什么」，不看它出现了哪些词：',
  '- 在为暴力、极权、军国、恶俗仪式叫好、怀旧或审美化 → R3 或 R11。',
  '- 在把色情资源当话题索要、兜售或交换 → R7。',
  '- 在把威胁落到群内真人身上 → R4 或 R11。',
  '- 在拿它们当梗、反讽、引用批判，或对象是虚构作品/游戏角色 → clean。',
  '判据是立场和作用，不是字面；同一个意思换十种说法，结论应当一样。',
  'rule 不要填 OTHER：确实套不上条款但明显不对劲的，选最接近的一条。',
  '6. 引用别人的话、讨论群规、叫停、玩梗，不是本人在违规，判 clean。',
  'R4 必须对号入座，对不上就 clean：',
  '- 人身攻击：辱骂、威胁群内真实用户（如「你个垃圾」「弄死你」，对象是群友）。「去你的」「滚」「靠」这类没有实际侮辱内容的口头语不算辱骂，即使 @ 了人 → clean。',
  '- 引战：明确挑起两个群体/两个人对骂（如「XX 的都滚出去」「你们也配」）。',
  '- 广告：出现群号、链接、二维码、价格、联系方式，或「加群/代练/代充/出售」。',
  '- 不是广告：机器人自己的「扫码绑定」「免责声明」「验证码」「米游社 uid/stoken」提示、游戏内交易、单纯加好友闲聊 → clean。',
  '- 对游戏角色、剧情、策划、厂商的吐槽或爆粗 → clean。',
  // 2026-11-02 用户拍板：开盒/人肉是红线（3 级），暴力威胁对群友是 R4（2 级）。
  '开盒/人肉/查户籍/社工库/挂人：针对群内真实用户、或声称能查到其真实身份 → R11（秒杀级），evidence 引用原话；',
  '口语常常省字：「再bb开你」「查你」「你家在哪」这种对群友说要找上门的，同样算开盒威胁 → R11，不要因为没写「盒」字就放过。',
  '「弄死你」「杀了你」对群友 → R4（2 级）；对游戏角色、台词、玩梗 → clean。',
  '「box发来」「发box看看」「申请会诊」「帮看号」：box 指角色池截图，属看配队 → clean；只有同时说到真名/住址/身份证/户籍/社工库/挂人/人肉/查你这类才判 R11。',
  'R7 只认明确描述性行为、性器官、性交易，或索要/发布露点图的文字；游戏里的「火花」「珍珠」「水凉凉的」不算。',
  '只输出一个 JSON 对象，不要解释、不要代码围栏、不要多余文字：',
  '{"verdict":"clean 或 suspicious","rule":"REDLINE|R3|R4|R5|R6|R7|R8|R9|R10|R11|OTHER","score":0.0 到 1.0,"evidence":"逐字引用的违规片段，没有就空字符串","reason":"30 字以内，违反了哪条、对谁"}',
].join('\n');

/** B 结构闸门：suspicious 必须给出条款与逐字证据，否则降级 clean（2026-11-02 用户拍板） */
export function applyEvidenceGate(
  verdict: 'clean' | 'suspicious',
  rule: RuleId | undefined,
  evidence: string | undefined,
): { verdict: 'clean' | 'suspicious'; downgraded: boolean; why: string } {
  if (verdict !== 'suspicious') return { verdict, downgraded: false, why: '' };
  const ev = (evidence ?? '').trim();
  if (ev.length === 0) return { verdict: 'clean', downgraded: true, why: 'suspicious 但没给逐字证据，降级 clean' };
  if (rule === undefined) return { verdict: 'clean', downgraded: true, why: 'suspicious 但没给条款，降级 clean' };
  if (rule === 'OTHER') return { verdict: 'clean', downgraded: true, why: 'suspicious 但条款是 OTHER，降级 clean' };
  return { verdict, downgraded: false, why: '' };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 从模型输出里抠出 JSON 对象：容忍 ```json 围栏、前后解释文字、JSON 后带尾巴。
 * 抠不出返回 null（调用方一律按 unknown 处理）。
 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return asRecord(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return null;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export class Screener {
  #baseUrl: string;
  #model: string;
  #enabled: boolean;
  #timeoutMs: number;
  #gatedTimeoutMs: number;
  #degraded: boolean;

  constructor(opts: ScreenerOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.#model = opts.model;
    this.#enabled = opts.enabled;
    this.#timeoutMs = opts.timeoutMs;
    this.#gatedTimeoutMs = opts.gatedTimeoutMs ?? 30000;
    this.#degraded = !opts.enabled;
  }

  /** true = 降级模式（本地模型没开/超时/报错/输出非法），上层必须写进判定记录 */
  get degraded(): boolean {
    return this.#degraded;
  }

  /** 探活：/api/tags 通了就算本地模型已恢复，内部清零 degraded */
  async probe(): Promise<boolean> {
    try {
      const res = await fetch(`${this.#baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      // 排空响应体，避免连接悬挂
      await res.arrayBuffer().catch(() => undefined);
      if (!res.ok) {
        this.#degraded = true;
        return false;
      }
      this.#degraded = false;
      return true;
    } catch {
      this.#degraded = true;
      return false;
    }
  }

  /**
   * 任何异常都返回 { verdict:'unknown', degraded:true }，绝不说成 clean。
   * opts.think = true 时打开 qwen3 思考链（gated 词用的「本地确认」），实测慢 2–4 倍，必须配 20–30s 超时。
   */
  async screen(
    text: string,
    context: string[],
    opts?: { think?: boolean; timeoutMs?: number },
  ): Promise<ScreenResult> {
    if (!this.#enabled) {
      this.#degraded = true;
      return { verdict: 'unknown', degraded: true, detail: '粗筛未启用（enabled=false），走降级路径' };
    }

    try {
      const res = await fetch(`${this.#baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.#model,
          stream: false,
          format: 'json',
          // 关掉 qwen3 的思考链：粗筛只要一个 JSON 结论，实测开 thinking 生成 462 token、
          // 关掉只要 19 token，墙钟 15.9s → 8.1s；5 条真实样本 4 条结论不变
          think: opts?.think === true,
          options: { temperature: 0 },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserContent(text, context) },
          ],
        }),
        signal: AbortSignal.timeout(
          opts?.timeoutMs ?? (opts?.think === true ? this.#gatedTimeoutMs : this.#timeoutMs),
        ),
      });

      if (!res.ok) {
        this.#degraded = true;
        return { verdict: 'unknown', degraded: true, detail: `粗筛 HTTP ${res.status}` };
      }

      const body = asRecord(await res.json());
      const message = asRecord(body?.['message']);
      const content = message?.['content'] ?? body?.['response'];
      if (typeof content !== 'string') {
        this.#degraded = true;
        return { verdict: 'unknown', degraded: true, detail: '粗筛响应里没有 message.content' };
      }

      const parsed = extractJsonObject(content);
      if (parsed === null) {
        this.#degraded = true;
        return { verdict: 'unknown', degraded: true, detail: '粗筛输出不是合法 JSON' };
      }

      const verdictRaw = parsed['verdict'];
      if (verdictRaw !== 'clean' && verdictRaw !== 'suspicious') {
        this.#degraded = true;
        return { verdict: 'unknown', degraded: true, detail: `粗筛 verdict 非法：${String(verdictRaw)}` };
      }
      const verdict = verdictRaw as ModelVerdict;

      const scoreRaw = parsed['score'];
      if (typeof scoreRaw !== 'number' || !Number.isFinite(scoreRaw)) {
        this.#degraded = true;
        return { verdict: 'unknown', degraded: true, detail: `粗筛 score 非法：${String(scoreRaw)}` };
      }

      const ruleRaw = parsed['rule'];
      let rule: RuleId | undefined;
      if (ruleRaw !== undefined && ruleRaw !== null) {
        if (typeof ruleRaw !== 'string' || !RULE_SET.has(ruleRaw)) {
          this.#degraded = true;
          return { verdict: 'unknown', degraded: true, detail: `粗筛 rule 非法：${String(ruleRaw)}` };
        }
        rule = ruleRaw as RuleId;
      }

      // A 举证：模型自报的逐字证据与一句话理由（老模型没这两个字段时按空处理，闸门会兜住）
      const evidence = typeof parsed['evidence'] === 'string' ? parsed['evidence'].trim() : '';
      const reason = typeof parsed['reason'] === 'string' ? parsed['reason'].trim() : '';

      // B 结构闸门：suspicious 但没有条款/条款是 OTHER/没有逐字证据 → 降级 clean，不送云
      const gate = applyEvidenceGate(verdict, rule, evidence);
      this.#degraded = false;
      const result: ScreenResult = { verdict: gate.verdict, score: clamp01(scoreRaw), degraded: false };
      if (rule !== undefined) result.rule = rule;
      if (evidence !== '') result.evidence = evidence;
      if (reason !== '') result.reason = reason;
      if (gate.downgraded) result.detail = gate.why;
      return result;
    } catch (err) {
      this.#degraded = true;
      return { verdict: 'unknown', degraded: true, detail: `粗筛异常：${errText(err)}` };
    }
  }
}

function buildUserContent(text: string, context: string[]): string {
  const recent = context
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-10);
  const parts: string[] = [];
  if (recent.length > 0) {
    parts.push('【最近上下文（时间升序，仅供理解指代）】');
    for (const line of recent) parts.push(`- ${truncate(line, 300)}`);
    parts.push('');
  }
  parts.push('【待筛选消息】');
  parts.push(truncate(text, 1000));
  return parts.join('\n');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
