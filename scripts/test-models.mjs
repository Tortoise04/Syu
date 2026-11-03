/**
 * M2a-C 自测：全部打本地假服务（scripts/fake-llm.mjs），真实网络请求 0 次。
 * 退出码 0 = 11 条验收全过。
 */
import { startFakeLlm } from './fake-llm.mjs';
import { Screener } from '../src/guard/screen.ts';
import { Judge, parseJudgeOutput } from '../src/guard/judge.ts';

let pass = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('PASS  ' + name + (detail === undefined ? '' : '  <- ' + detail));
  } else {
    failures.push(name);
    console.log('FAIL  ' + name + (detail === undefined ? '' : '  <- ' + detail));
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

function ctx(over = {}) {
  return {
    messageId: 1,
    userId: 20001,
    nickname: '路人甲',
    time: 1700000000,
    text: '在吗',
    images: [],
    isTarget: false,
    ...over,
  };
}

function makeInput(over = {}) {
  const target = ctx({
    messageId: 42,
    userId: 30003,
    nickname: '发广告的',
    time: 1700000100,
    text: '拉群领福利，加群 8888 二维码在下面',
    images: over.targetImages ?? [],
    isTarget: true,
  });
  return {
    channel: over.channel ?? 'keyword',
    target,
    context: [
      ctx({ messageId: 40, time: 1700000090, text: '今天谁值班' }),
      target,
      ctx({ messageId: 43, time: 1700000110, text: '好的' }),
    ],
    rulesText: '第4条：禁止广告、拉群、人身攻击、造谣引战；第7条：禁止色情擦边内容。',
    keywordHits: [{ rule: 'R4', word: '加群', kind: 'rule', mustJudge: true }],
  };
}

const fake = await startFakeLlm();

try {
  // ---- 1) screen 正常两态 ----
  {
    const clean = new Screener({ baseUrl: fake.url + '/clean', model: 'fake-screen', enabled: true, timeoutMs: 1000 });
    const r1 = await clean.screen('今天好热啊', ['有人一起吃饭吗']);
    eq('1a screen clean -> verdict=clean', r1.verdict, 'clean');
    eq('1a screen clean -> degraded=false', r1.degraded, false);

    const susp = new Screener({ baseUrl: fake.url + '/suspicious', model: 'fake-screen', enabled: true, timeoutMs: 1000 });
    const r2 = await susp.screen('加群领福利 8888', []);
    eq('1b screen suspicious -> verdict=suspicious', r2.verdict, 'suspicious');
    eq('1b screen suspicious -> degraded=false', r2.degraded, false);
    eq('1b screen suspicious -> rule=R4', r2.rule, 'R4');
  }

  // ---- 2) screen 三种失败都必须 unknown + degraded ----
  {
    const s500 = new Screener({ baseUrl: fake.url + '/500', model: 'fake-screen', enabled: true, timeoutMs: 1000 });
    const r = await s500.screen('随便说点什么', []);
    eq('2a screen 500 -> unknown', r.verdict, 'unknown');
    eq('2a screen 500 -> degraded=true', r.degraded, true);

    const bad = new Screener({ baseUrl: fake.url + '/nonjson', model: 'fake-screen', enabled: true, timeoutMs: 1000 });
    const r2 = await bad.screen('随便说点什么', []);
    eq('2b screen 非 JSON -> unknown', r2.verdict, 'unknown');
    eq('2b screen 非 JSON -> degraded=true', r2.degraded, true);

    const slow = new Screener({ baseUrl: fake.url + '/slow', model: 'fake-screen', enabled: true, timeoutMs: 100 });
    const r3 = await slow.screen('随便说点什么', []);
    eq('2c screen 超时(timeoutMs=100) -> unknown', r3.verdict, 'unknown');
    eq('2c screen 超时(timeoutMs=100) -> degraded=true', r3.degraded, true);
  }

  // ---- 3) enabled=false 不发请求 ----
  {
    fake.stats.reset();
    const off = new Screener({ baseUrl: fake.url + '/clean', model: 'fake-screen', enabled: false, timeoutMs: 1000 });
    const r = await off.screen('加群领福利 8888', []);
    eq('3 screen enabled=false -> unknown', r.verdict, 'unknown');
    eq('3 screen enabled=false -> degraded=true', r.degraded, true);
    eq('3 screen enabled=false -> 假服务没收到请求', fake.stats.count, 0);
  }

  // ---- 4) probe 探活 ----
  {
    const s = new Screener({ baseUrl: fake.url + '/clean', model: 'fake-screen', enabled: false, timeoutMs: 1000 });
    eq('4a probe 前 degraded=true（enabled=false 初始化）', s.degraded, true);
    const alive = await s.probe();
    eq('4b probe() -> true', alive, true);
    eq('4c probe 后 degraded=false', s.degraded, false);
  }

  // ---- 5) judge 正常 JSON ----
  {
    const judge = new Judge({ baseUrl: fake.url + '/normal', apiKey: 'sk-test', model: 'deepseek-flash', maxTokens: 1200, timeoutMs: 2000 });
    const r = await judge.judge(makeInput());
    eq('5a judge 正常 -> severity=2', r.severity, 2);
    eq('5b judge 正常 -> confidence=0.82', r.confidence, 0.82);
    eq('5c judge 正常 -> rule=R4', r.rule, 'R4');
    eq('5d judge 正常 -> degraded=false', r.degraded, false);
    check('5e judge 正常 -> reason 非空', typeof r.reason === 'string' && r.reason.length > 0, 'reason=' + JSON.stringify(r.reason));
    eq('5f judge 正常 -> extraRules=[R6]', JSON.stringify(r.extraRules), JSON.stringify(['R6']));
  }

  // ---- 6) 围栏 / 前后解释文字 ----
  {
    const fenced = new Judge({ baseUrl: fake.url + '/fence', apiKey: 'sk-test', model: 'deepseek-flash', maxTokens: 1200, timeoutMs: 2000 });
    const r = await fenced.judge(makeInput());
    eq('6a judge json 围栏 -> degraded=false', r.degraded, false);
    eq('6a judge json 围栏 -> rule=R5', r.rule, 'R5');
    eq('6a judge json 围栏 -> severity=1', r.severity, 1);

    const prose = new Judge({ baseUrl: fake.url + '/prose', apiKey: 'sk-test', model: 'deepseek-flash', maxTokens: 1200, timeoutMs: 2000 });
    const r2 = await prose.judge(makeInput());
    eq('6b judge 前后解释文字 -> degraded=false', r2.degraded, false);
    eq('6b judge 前后解释文字 -> severity=3', r2.severity, 3);
    eq('6b judge 前后解释文字 -> rule=REDLINE', r2.rule, 'REDLINE');
    eq('6b judge 前后解释文字 -> extraRules 只留合法且不等于 rule', JSON.stringify(r2.extraRules), JSON.stringify(['R4']));
  }

  // ---- 7) finish_reason=length 且 content 空 ----
  {
    const truncated = new Judge({ baseUrl: fake.url + '/length', apiKey: 'sk-test', model: 'deepseek-flash', maxTokens: 1200, timeoutMs: 2000 });
    const r = await truncated.judge(makeInput());
    eq('7 judge finish_reason=length + 空正文 -> degraded=true', r.degraded, true);
    eq('7 judge finish_reason=length + 空正文 -> severity=0', r.severity, 0);
  }

  // ---- 8) 越界字段收口 ----
  {
    const out = new Judge({ baseUrl: fake.url + '/outofrange', apiKey: 'sk-test', model: 'deepseek-flash', maxTokens: 1200, timeoutMs: 2000 });
    const r = await out.judge(makeInput());
    eq('8a severity=9 -> 3', r.severity, 3);
    eq('8b confidence=1.7 -> 1', r.confidence, 1);
    eq('8c rule=R99 非法 -> OTHER', r.rule, 'OTHER');
    eq('8d extraRules 只留合法且去重', JSON.stringify(r.extraRules), JSON.stringify(['R4']));
  }

  // ---- 9) apiKey 缺失不发请求 ----
  {
    fake.stats.reset();
    const noKey = new Judge({ baseUrl: fake.url + '/normal', model: 'deepseek-flash', maxTokens: 1200, timeoutMs: 2000 });
    const r = await noKey.judge(makeInput());
    eq('9a apiKey 缺失 -> degraded=true', r.degraded, true);
    eq('9a apiKey 缺失 -> severity=0', r.severity, 0);
    eq('9b apiKey 缺失 -> 假服务没收到请求', fake.stats.count, 0);
  }

  // ---- 10) 带图 -> content 是数组且含 image_url ----
  {
    const echo = new Judge({ baseUrl: fake.url + '/echo', apiKey: 'sk-test', model: 'deepseek-flash', maxTokens: 1200, timeoutMs: 2000 });
    const r = await echo.judge(makeInput({ targetImages: ['https://x/y.jpg'] }));
    eq('10a 带图判次本身正常返回', r.degraded, false);
    const body = fake.stats.lastBody ?? {};
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const userContent = msgs.length > 1 ? msgs[1].content : undefined;
    check('10b 请求体 user content 是数组', Array.isArray(userContent), 'type=' + (Array.isArray(userContent) ? 'array' : typeof userContent));
    const parts = Array.isArray(userContent) ? userContent : [];
    const imageParts = parts.filter((p) => p && p.type === 'image_url');
    check('10c 请求体含 image_url 段', imageParts.length === 1, 'imageParts=' + JSON.stringify(imageParts));
    eq('10c image_url URL 原样', imageParts[0]?.image_url?.url, 'https://x/y.jpg');
    check('10d 文本段仍在且带【被举报】标记', parts.some((p) => p && p.type === 'text' && String(p.text).includes('【被举报】')), '');
  }

  // ---- 10e) 纯文本时 content 必须是字符串（空数组会 400） ----
  {
    const echo = new Judge({ baseUrl: fake.url + '/echo', apiKey: 'sk-test', model: 'deepseek-flash', maxTokens: 1200, timeoutMs: 2000 });
    await echo.judge(makeInput());
    const msgs = Array.isArray(fake.stats.lastBody?.messages) ? fake.stats.lastBody.messages : [];
    const userContent = msgs.length > 1 ? msgs[1].content : undefined;
    check('10e 纯文本 content 是字符串（不拼空数组）', typeof userContent === 'string', 'type=' + typeof userContent);
  }

  // ---- 11) parseJudgeOutput 直接单测 ----
  {
    eq('11a parseJudgeOutput("hello") -> null', parseJudgeOutput('hello'), null);
    eq('11b parseJudgeOutput("") -> null', parseJudgeOutput(''), null);
    eq('11c parseJudgeOutput("{}") -> null（不是终审结论）', parseJudgeOutput('{}'), null);
    const parsed = parseJudgeOutput('前言 {"severity":2.6,"confidence":-3,"reason":"x","rule":"R9","extraRules":["R3","R3"]} 尾巴');
    eq('11d 小数 severity 取整 -> 3', parsed?.severity, 3);
    eq('11e 负 confidence 裁到 0', parsed?.confidence, 0);
    eq('11f extraRules 去重', JSON.stringify(parsed?.extraRules), JSON.stringify(['R3']));
    const longReason = parseJudgeOutput(JSON.stringify({ severity: 1, confidence: 0.5, reason: 'a'.repeat(500), rule: 'R4', extraRules: [] }));
    eq('11g reason 截断到 200 字', longReason?.reason.length, 200);
  }
} finally {
  await fake.close();
}

console.log('');
console.log('----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + failures.length + ' 项');
if (failures.length > 0) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('全部通过');
  process.exitCode = 0;
}
