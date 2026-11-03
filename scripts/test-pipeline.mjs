// M2a-D 判定链路自测：node scripts/test-pipeline.mjs
// 全部注入假 screener / judge，不起真网络；逐条对齐任务单的 15 条断言。
// 退出码 0 = 全过。
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NO_COLOR = '1';
process.env.GUARD_GROUP_IDS = process.env.GUARD_GROUP_IDS ?? '20001';
process.env.OWNER_QQ = process.env.OWNER_QQ ?? '99999';

const { handleMessage, handleReport, collectReportContext } = await import('../src/guard/pipeline.ts');
const { RingBuffer } = await import('../src/guard/rules.ts');
const { StateStore } = await import('../src/state.ts');
const { appendViolation } = await import('../src/guard/record.ts');
const { loadConfig } = await import('../src/config.ts');

const config = loadConfig();
const GROUP = 20001;
const SELF = 10000;
const USER = 30001;
const OWNER = 99999;

const failures = [];
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  PASS ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  FAIL ' + name);
    console.log('       ' + (err instanceof Error ? err.message : String(err)).split('\n').slice(0, 6).join('\n       '));
  }
}

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'syu-pipeline-'));
let storeSeq = 0;
async function newStore(opts = {}) {
  storeSeq += 1;
  const store = new StateStore({
    file: path.join(tmpRoot, 'state-' + storeSeq, 'state.json'),
    budgetDaily: opts.budgetDaily ?? 500,
    budgetPerGroup: opts.budgetPerGroup ?? 100,
    ...(opts.now ? { now: opts.now } : {}),
  });
  await store.init();
  return store;
}

let msgSeq = 70000;
function groupMsg(opts = {}) {
  const userId = opts.userId ?? USER;
  const messageId = opts.messageId ?? ++msgSeq;
  const body = opts.message ?? opts.text ?? '';
  const ev = {
    post_type: 'message',
    message_type: 'group',
    time: opts.time ?? Math.floor(Date.now() / 1000),
    self_id: SELF,
    message_id: messageId,
    user_id: userId,
    group_id: opts.groupId ?? GROUP,
    message: body,
    raw_message: typeof body === 'string' ? body : '',
    sender: { user_id: userId, nickname: opts.nickname ?? '小明', ...(opts.role ? { role: opts.role } : {}) },
  };
  return ev;
}

function ok(severity, confidence, rule, extra = {}) {
  return { severity, confidence, reason: '假终审：' + rule + ' 档 ' + severity, rule, degraded: false, ...extra };
}
function degraded(reason = '网络失败') {
  return { severity: 0, confidence: 0, reason, rule: 'OTHER', degraded: true };
}

function harness({ store, now, random } = {}) {
  const h = {
    judgeCalls: 0,
    screenCalls: 0,
    judgeInputs: [],
    screenInputs: [],
    nextJudge: () => ok(2, 0.9, 'R4'),
    nextScreen: () => ({ verdict: 'clean', degraded: false }),
  };
  const deps = {
    store,
    rules: { table: config.guard.keywords, linkWhitelist: config.guard.linkWhitelist },
    screener: {
      async screen(text, context) {
        h.screenCalls += 1;
        h.screenInputs.push({ text, context });
        return h.nextScreen(text);
      },
    },
    judge: {
      async judge(input) {
        h.judgeCalls += 1;
        h.judgeInputs.push(input);
        return h.nextJudge(input);
      },
    },
    rulesText: config.guard.rulesText,
    thresholds: config.guard.thresholds,
    ownerQq: OWNER,
  };
  if (now) deps.now = now;
  if (random) deps.random = random;
  h.deps = deps;
  h.ring = new RingBuffer(30);
  h.ctx = { ring: h.ring };
  return h;
}

async function fresh(opts = {}) {
  const store = await newStore(opts);
  const h = harness({ store, now: opts.now, random: opts.random });
  return { store, h };
}

const noon = () => new Date(2026, 4, 1, 12, 0, 0);

// ---------------------------------------------------------------- 1 豁免
await test('1) 豁免：self / role=admin / owner ⇒ decision=null 且不落记录', async () => {
  const { h } = await fresh();
  const cases = [
    groupMsg({ text: '这是冰毒', userId: SELF }),
    groupMsg({ text: '这是冰毒', role: 'admin' }),
    groupMsg({ text: '这是冰毒', userId: OWNER }),
  ];
  for (const ev of cases) {
    const res = await handleMessage(ev, h.ctx, h.deps);
    assert.equal(res.decision, null);
    assert.equal(res.record, undefined);
  }
  assert.equal(h.judgeCalls, 0, '豁免消息不许送审');
});

// ------------------------------------------------- 2 多词合并只调一次 judge
await test('2) 「肢解」「虐杀」「见证」同行 ⇒ judge 调用 =1', async () => {
  const { h } = await fresh();
  const res = await handleMessage(groupMsg({ text: '肢解 虐杀 见证 都在这条' }), h.ctx, h.deps);
  assert.equal(h.judgeCalls, 1);
  assert.equal(res.decision.hits.length, 3);
  assert.equal(res.decision.channel, 'keyword');
});

// ------------------------------------------- 2b 低精度词（hints）只过粗筛、不直通云
await test('2b) 「对线」⇒ 走 screen、不是 keyword 直判；命中带 hint 标记', async () => {
  const { h } = await fresh();
  h.nextScreen = () => ({ verdict: 'clean', score: 0.1, degraded: false });
  const res = await handleMessage(groupMsg({ text: '又来对线了' }), h.ctx, h.deps);
  assert.equal(h.screenCalls, 1, 'hints 必须过本地粗筛');
  assert.equal(h.judgeCalls, 0, 'clean 不送审');
  assert.equal(res.record.channel, 'screen');
  assert.ok(res.record.keywords.includes('对线'), '命中词要落进记录，方便事后查');
  assert.equal(res.record.severity, 0);
});

// ------------------------------------------- 2e 不检测名单：说话跳过判定，但不给权限
await test('2e) 不检测名单里的人说话 ⇒ 不判定、不落记录、不花预算', async () => {
  const { h } = await fresh();
  const ui = 777001;
  h.deps.whitelist = [ui];
  const res = await handleMessage(groupMsg({ text: '肢解 虐杀 见证 都在这条', userId: ui }), h.ctx, h.deps);
  assert.equal(res.decision, null);
  assert.equal(res.record, undefined);
  assert.equal(h.screenCalls, 0);
  assert.equal(h.judgeCalls, 0);
  // 同一条消息如果换了人发，照样要判——名单只按发送人，不按内容
  const other = await handleMessage(groupMsg({ text: '肢解 虐杀 见证 都在这条' }), h.ctx, h.deps);
  assert.ok(other.decision !== null, '名单外的人照判');
});

// ------------------------------------------- 2f 玩笑白名单：整条只剩白名单短语放过，夹内容照判
await test('2f) 玩笑白名单「你好」⇒ 整条不判不记；夹着别的内容照样判', async () => {
  const { h } = await fresh();
  h.deps.exemptPhrases = ['你好'];
  const only = await handleMessage(groupMsg({ text: '[at:10001] 你好！' }), h.ctx, h.deps);
  assert.equal(only.decision, null);
  assert.equal(only.record, undefined);
  assert.equal(h.screenCalls, 0, '整条只有白名单词：粗筛都不该跑');
  assert.equal(h.judgeCalls, 0, '整条只有白名单词：不送云');
  // 夹着别的内容（这里带一个 gated 词）就按原文判
  const withExtra = await handleMessage(groupMsg({ text: '你好 垃圾' }), h.ctx, h.deps);
  assert.ok(withExtra.decision !== null, '夹着别的内容要照判');
  assert.ok(withExtra.record !== undefined, '照判就要落记录');
});

// ------------------------------------------- 2g 「艹」类口头语：不判不记、不计数
await test('2g) 「艹」类口头语不判不记；只有家庭辱骂照判', async () => {
  const { h } = await fresh();
  const self = await handleMessage(groupMsg({ text: '所有人来艹我' }), h.ctx, h.deps);
  assert.equal(self.decision, null);
  assert.equal(self.record, undefined);
  assert.equal(h.screenCalls, 0, '口头语：粗筛都不该跑');
  assert.equal(h.judgeCalls, 0, '口头语：不送云');
  const you = await handleMessage(groupMsg({ text: '[at:10001] 我艹死你' }), h.ctx, h.deps);
  assert.equal(you.decision, null, '我艹死你也算玩笑互怼');
  const mom = await handleMessage(groupMsg({ text: '操你妈' }), h.ctx, h.deps);
  assert.ok(mom.decision !== null, '家庭辱骂照判');
});

// ------------------------------------------- 2d gated 词：先本地确认，确认可疑才送云
await test('2d) 「731」⇒ 先跑本地确认（think），可疑才送云；确认干净只记录', async () => {
  const cleanOne = await fresh();
  cleanOne.h.nextScreen = () => ({ verdict: 'clean', score: 0.05, degraded: false, rule: 'R3' });
  const r1 = await handleMessage(groupMsg({ text: '731 年这个楼就建好了' }), cleanOne.h.ctx, cleanOne.h.deps);
  assert.equal(cleanOne.h.screenCalls, 1, 'gated 命中要先本地确认');
  assert.equal(cleanOne.h.judgeCalls, 0, '确认 clean 不送云');
  assert.equal(r1.record.channel, 'gated');
  assert.equal(r1.record.severity, 0);
  assert.ok(r1.record.keywords.includes('731'));

  const susOne = await fresh();
  susOne.h.nextScreen = () => ({
    verdict: 'suspicious',
    score: 0.9,
    degraded: false,
    rule: 'R3',
    evidence: '731 就该拿来玩',
    reason: '731 娱乐化',
  });
  susOne.h.nextJudge = () => ok(3, 0.95, 'R3');
  const r2 = await handleMessage(groupMsg({ text: '731 就该拿来玩' }), susOne.h.ctx, susOne.h.deps);
  assert.equal(susOne.h.screenCalls, 1);
  assert.equal(susOne.h.judgeCalls, 1, '确认可疑要送云');
  assert.equal(r2.record.channel, 'gated');
  assert.equal(r2.decision.severity, 3);
});

// ------------------------------------------- 2c 纯图不跑文本粗筛（非必要不识图）
await test('2c) 纯图片 ⇒ 不跑粗筛、不送审、只落 0 级记录', async () => {
  const { h } = await fresh();
  const ev = groupMsg({ message: [{ type: 'image', data: { file: 'a.jpg' } }] });
  const res = await handleMessage(ev, h.ctx, h.deps);
  assert.equal(h.screenCalls, 0, '纯图不跑文本粗筛');
  assert.equal(h.judgeCalls, 0);
  assert.equal(res.record.severity, 0);
  assert.equal(res.record.rule, 'OTHER');
  assert.ok(res.record.reason.includes('纯图片'), '理由要说清是纯图');
});

// ----------------------------------------------- 3 recordOnly 不送审不吃预算
await test('3) 「出号」⇒ judge 0 次、预算未扣、记录 severity=0', async () => {
  const { store, h } = await fresh();
  const res = await handleMessage(groupMsg({ text: '有人出号吗' }), h.ctx, h.deps);
  assert.equal(h.judgeCalls, 0);
  assert.equal(h.screenCalls, 0);
  assert.equal(store.snapshot.budget.total, 0);
  assert.equal(res.record.severity, 0);
  assert.equal(res.record.rule, 'R4');
  assert.equal(res.record.action, 'none');
});

// --------------------------------------------------------------- 4 链接
await test('4) 白名单 bilibili ⇒ judge 0 次且走 screen；bit.ly ⇒ judge 1 次', async () => {
  const a = await fresh();
  const okRes = await handleMessage(
    groupMsg({ text: '看这个 https://www.bilibili.com/video/BV1xx411c7mD' }),
    a.h.ctx,
    a.h.deps,
  );
  assert.equal(a.h.judgeCalls, 0);
  assert.equal(a.h.screenCalls, 1);
  assert.equal(okRes.record.channel, 'screen');

  const b = await fresh();
  const badRes = await handleMessage(groupMsg({ text: 'https://bit.ly/abc' }), b.h.ctx, b.h.deps);
  assert.equal(b.h.judgeCalls, 1);
  assert.equal(b.h.screenCalls, 0);
  assert.equal(badRes.decision.channel, 'link');
});

// ------------------------------------------------------- 5 粗筛三态
await test('5) screen suspicious/clean/unknown 三条分支', async () => {
  const s1 = await fresh({ now: noon });
  s1.h.nextScreen = () => ({ verdict: 'suspicious', score: 0.8, degraded: false });
  await handleMessage(groupMsg({ text: '今天天气不错' }), s1.h.ctx, s1.h.deps);
  assert.equal(s1.h.judgeCalls, 1, 'suspicious 必须送审');
  assert.equal(s1.h.judgeInputs[0].channel, 'screen');

  const s2 = await fresh({ now: noon });
  s2.h.nextScreen = () => ({ verdict: 'clean', score: 0.1, rule: 'R5', degraded: false });
  const cleanRes = await handleMessage(groupMsg({ text: '今天天气不错' }), s2.h.ctx, s2.h.deps);
  assert.equal(s2.h.judgeCalls, 0, 'clean 不送审');
  assert.ok(cleanRes.record, 'clean 也要写 0 级记录');
  assert.equal(cleanRes.record.severity, 0);
  assert.equal(cleanRes.record.degraded, false);
  // 粗筛猜的条款只落 hintRule 线索字段，不能改写判定条款（2026-11-02 假 R5/R9 的教训）
  assert.equal(cleanRes.record.rule, 'OTHER', '未终审时条款仍是 OTHER');
  assert.equal(cleanRes.record.hintRule, 'R5', '粗筛猜的条款进 hintRule');
  assert.equal(cleanRes.record.screenScore, 0.1, '粗筛可疑度进 screenScore');

  const s2b = await fresh({ now: noon, random: () => 0.99 });
  // 默认 fixture 的 suspicious 抽检率是 1（全送），这里显式压低，才测得到「没抽中」分支
  s2b.h.deps.sample = { suspicious: 0.3, clean: 0.02 };
  s2b.h.nextScreen = () => ({ verdict: 'suspicious', score: 0.8, rule: 'R9', degraded: false });
  const susRes = await handleMessage(groupMsg({ text: '今天天气不错' }), s2b.h.ctx, s2b.h.deps);
  assert.equal(s2b.h.judgeCalls, 0, 'suspicious 没抽中不送审');
  assert.equal(susRes.record.hintRule, 'R9');
  assert.equal(susRes.record.screenScore, 0.8);
  assert.equal(susRes.record.rule, 'OTHER');

  const s3 = await fresh({ now: noon, random: () => 0.99 });
  s3.h.nextScreen = () => ({ verdict: 'unknown', degraded: true, detail: '连不上 ollama' });
  const notSampled = await handleMessage(groupMsg({ text: '今天天气不错' }), s3.h.ctx, s3.h.deps);
  assert.equal(s3.h.judgeCalls, 0, '没抽中不送审');
  assert.equal(notSampled.record.degraded, true);
  assert.equal(notSampled.record.action, 'none');

  const s4 = await fresh({ now: noon, random: () => 0.01 });
  s4.h.nextScreen = () => ({ verdict: 'unknown', degraded: true });
  await handleMessage(groupMsg({ text: '今天天气不错' }), s4.h.ctx, s4.h.deps);
  assert.equal(s4.h.judgeCalls, 1, '抽中必须送审');
  assert.equal(s4.h.judgeInputs[0].channel, 'sample');
});

// --------------------------------------------------- 6 degraded 不计数不升级
await test('6) degraded ⇒ 记录 degraded、action=none、不 bumpDailyCount', async () => {
  const { store, h } = await fresh();
  h.nextJudge = () => degraded();
  for (let i = 0; i < 3; i += 1) {
    const res = await handleMessage(groupMsg({ text: '肢解刷屏' }), h.ctx, h.deps);
    assert.equal(res.record.degraded, true);
    assert.equal(res.record.action, 'none');
    assert.equal(res.record.severity, 0);
    assert.equal(res.decision.rule, 'OTHER');
  }
  assert.equal(store.dailyCount(GROUP, 'R4'), 0, 'degraded 不许 bumpDailyCount');
  h.nextJudge = () => ok(2, 0.9, 'R4');
  const res4 = await handleMessage(groupMsg({ text: '肢解刷屏' }), h.ctx, h.deps);
  assert.equal(res4.decision.severity, 2, '前 3 次降级不得把第 4 次升到 3');
  assert.equal(res4.decision.action, 'warn');
});

// ------------------------------------------------------------- 7 置信度门槛
await test('7) 门槛：REDLINE 0.55 none / 0.65 escalate；R4 0.7 none / 0.8 按档位', async () => {
  const r1 = await fresh();
  r1.h.nextJudge = () => ok(3, 0.55, 'REDLINE');
  const a = await handleMessage(groupMsg({ text: '这是冰毒' }), r1.h.ctx, r1.h.deps);
  assert.equal(a.decision.action, 'none', '0.55 < 0.6 不许动手');
  assert.match(a.decision.reason, /门槛/);

  const r2 = await fresh();
  r2.h.nextJudge = () => ok(3, 0.65, 'REDLINE');
  const b = await handleMessage(groupMsg({ text: '这是冰毒' }), r2.h.ctx, r2.h.deps);
  assert.equal(b.decision.action, 'escalate');
  assert.equal(b.decision.severity, 3);

  const r3 = await fresh();
  r3.h.nextJudge = () => ok(2, 0.7, 'R4');
  const c = await handleMessage(groupMsg({ text: '肢解' }), r3.h.ctx, r3.h.deps);
  assert.equal(c.decision.action, 'none', '0.7 < 0.75');

  const r4 = await fresh();
  r4.h.nextJudge = () => ok(2, 0.8, 'R4');
  const d = await handleMessage(groupMsg({ text: '肢解' }), r4.h.ctx, r4.h.deps);
  assert.equal(d.decision.action, 'warn');
  assert.equal(d.decision.severity, 2);

  // 2026-11-01 晚：1 档只是群内轻提醒，门槛降到 0.6；2/3 档仍是 0.75
  const r5 = await fresh();
  r5.h.nextJudge = () => ok(1, 0.62, 'R4');
  const e = await handleMessage(groupMsg({ text: '刷单' }), r5.h.ctx, r5.h.deps);
  assert.equal(e.decision.action, 'remind', '0.62 ≥ remind 门槛 0.6 ⇒ 1 档要提醒');

  const r6 = await fresh();
  r6.h.nextJudge = () => ok(1, 0.58, 'R4');
  const f = await handleMessage(groupMsg({ text: '刷单' }), r6.h.ctx, r6.h.deps);
  assert.equal(f.decision.action, 'none', '0.58 < 0.6 仍不动手');
  assert.match(f.decision.reason, /门槛 0\.6/);

  const r7 = await fresh();
  r7.h.nextJudge = () => ok(2, 0.62, 'R4');
  const g = await handleMessage(groupMsg({ text: '刷单' }), r7.h.ctx, r7.h.deps);
  assert.equal(g.decision.action, 'none', '2 档仍用 0.75，0.62 不够');
});

// --------------------------------------------------------------- 8 升 3 级
await test('8) 升 3 级：第 1 次 warn，冷却窗外第 2 次 escalate', async () => {
  let fakeNow = new Date(2026, 4, 1, 12, 0, 0);
  const { h } = await fresh({ now: () => fakeNow });
  h.nextJudge = () => ok(2, 0.9, 'R4');
  const first = await handleMessage(groupMsg({ text: '肢解' }), h.ctx, h.deps);
  assert.equal(first.decision.severity, 2);
  assert.equal(first.decision.action, 'warn');
  assert.equal(first.decision.cooledDown, false);

  fakeNow = new Date(fakeNow.getTime() + 5 * 60 * 1000 + 1000);
  const second = await handleMessage(groupMsg({ text: '肢解' }), h.ctx, h.deps);
  assert.equal(second.decision.severity, 3, '同群同人同条款第 2 次升 3');
  assert.equal(second.decision.action, 'escalate');
});

// --------------------------------------------------------------- 9 冷却
await test('9) 冷却：5 分钟内第 2 次 ⇒ judge 照调、action=none、cooledDown=true、记录照写', async () => {
  // 用 OTHER：它不参与「当日同群同条款第 2 次升 3」计数（见 pipeline.ts 的 countsForEscalation）。
  // 用 R4 的话第 2 条会被那条用户拍板的例外升到 3 级并绕过冷却，这里就测不到冷却本身了 —— 那个例外由第 8 条守着。
  const { h } = await fresh();
  h.nextJudge = () => ok(2, 0.9, 'OTHER');
  await handleMessage(groupMsg({ text: '肢解' }), h.ctx, h.deps);
  const second = await handleMessage(groupMsg({ text: '肢解' }), h.ctx, h.deps);
  assert.equal(h.judgeCalls, 2, '冷却不压送审');
  assert.equal(second.decision.action, 'none');
  assert.equal(second.decision.cooledDown, true);
  assert.ok(second.record, '冷却照写记录');
  assert.equal(second.record.cooledDown, true);
});

// --------------------------------------------------------------- 10 预算耗尽
await test('10) 预算耗尽（budgetDaily=1）⇒ 第 2 条不再送审、记录 degraded', async () => {
  const { store, h } = await fresh({ budgetDaily: 1, budgetPerGroup: 100 });
  h.nextJudge = () => ok(2, 0.9, 'R4');
  await handleMessage(groupMsg({ text: '肢解' }), h.ctx, h.deps);
  assert.equal(h.judgeCalls, 1);
  assert.equal(store.snapshot.budget.total, 1);

  const second = await handleMessage(groupMsg({ text: '肢解' }), h.ctx, h.deps);
  assert.equal(h.judgeCalls, 1, '预算用完不许再送审');
  assert.equal(second.record.degraded, true);
  assert.equal(second.decision.action, 'none');
});

// --------------------------------------------------------------- 11 report 通道
await test('11) report 通道：预算已耗尽仍送审；5 分钟内第二次举报不受冷却', async () => {
  const { store, h } = await fresh({ budgetDaily: 1, budgetPerGroup: 100 });
  h.nextJudge = () => ok(2, 0.9, 'R4');
  await handleMessage(groupMsg({ text: '肢解' }), h.ctx, h.deps);
  assert.equal(store.takeBudget(GROUP), false, '预算应当已耗尽');
  const before = h.judgeCalls;

  const rep1 = await handleReport(groupMsg({ text: '/举报 这个人一直发广告' }), h.ctx, h.deps);
  assert.equal(h.judgeCalls, before + 1, '举报不受预算限制');
  assert.equal(rep1.decision.channel, 'report');

  const rep2 = await handleReport(groupMsg({ text: '/举报 又来了' }), h.ctx, h.deps);
  assert.equal(h.judgeCalls, before + 2);
  assert.equal(rep2.decision.cooledDown, false, '举报不受冷却');
  assert.equal(rep2.decision.action, 'escalate', '冷却没压掉举报的动作');
});

// --------------------------------------------------------------- 12 引用原文
await test('12) 引用原文：带 replyId 的 [image] 命中被引用那条的 REDLINE', async () => {
  const { h } = await fresh();
  h.nextJudge = () => ok(3, 0.9, 'REDLINE');
  const quotedId = 70001;
  h.ring.push({
    messageId: quotedId,
    userId: USER,
    nickname: '小明',
    time: Math.floor(Date.now() / 1000) - 5,
    text: '这是冰毒',
    images: [],
    isTarget: false,
  });
  const ev = groupMsg({
    messageId: 70002,
    message: [
      { type: 'image', data: { file: 'a.jpg' } },
      { type: 'reply', data: { id: quotedId } },
    ],
  });
  const res = await handleMessage(ev, h.ctx, h.deps);
  assert.equal(h.judgeCalls, 1);
  assert.ok(
    res.decision.hits.some((x) => x.rule === 'REDLINE'),
    '引用原文没被拼进送审文本',
  );
  assert.ok(res.record.keywords.includes('冰毒'));
});

// --------------------------------------------------------------- 13 字段完整
await test('13) 记录字段完整、text ≤ 200', async () => {
  const { h } = await fresh();
  h.nextJudge = () => ok(1, 0.9, 'R4');
  const res = await handleMessage(groupMsg({ text: '肢解 ' + '洗屏'.repeat(200) }), h.ctx, h.deps);
  const rec = res.record;
  const need = [
    'ts', 'groupId', 'userId', 'nickname', 'messageId', 'channel', 'text', 'rule',
    'extraRules', 'severity', 'confidence', 'reason', 'keywords', 'action', 'cooledDown', 'degraded',
  ];
  for (const k of need) assert.ok(k in rec, '缺字段 ' + k);
  assert.ok(rec.text.length <= 200, 'text 超 200：' + rec.text.length);
  assert.equal(rec.text.length, 200);
  assert.ok(!Number.isNaN(Date.parse(rec.ts)), 'ts 必须能解析：' + rec.ts);
  assert.equal(rec.groupId, GROUP);
  assert.equal(rec.userId, USER);
  assert.equal(rec.channel, 'keyword');
});

// ----------------------------------------------------- 14 appendViolation 自建目录
await test('14) appendViolation：目录不存在时自建并追加一行、能 JSON.parse 回来', async () => {
  const dir = path.join(tmpRoot, 'deep', 'nested', 'data');
  const rec = {
    ts: new Date().toISOString(),
    groupId: 1,
    userId: 2,
    nickname: 'n',
    messageId: 3,
    channel: 'keyword',
    text: 'x'.repeat(400),
    rule: 'R4',
    extraRules: [],
    severity: 0,
    confidence: 0,
    reason: 'r',
    keywords: ['肢解'],
    action: 'none',
    cooledDown: false,
    degraded: false,
  };
  await appendViolation(dir, rec);
  const raw = await fsp.readFile(path.join(dir, 'violations.jsonl'), 'utf8');
  const lines = raw.split('\n').filter((x) => x.length > 0);
  assert.equal(lines.length, 1);
  const back = JSON.parse(lines[0]);
  assert.equal(back.messageId, 3);
  assert.equal(back.text.length, 200, 'text 截 200');
});

// --------------------------------------------------------------- 15 flush 落盘
await test('15) 显式 await flush() 后文件里能看到已扣预算', async () => {
  const file = path.join(tmpRoot, 'flush', 'state.json');
  const store = new StateStore({ file, budgetDaily: 500, budgetPerGroup: 100 });
  await store.init();
  assert.equal(store.takeBudget(GROUP), true);
  assert.equal(store.bumpDailyCount(GROUP, 'R4'), 1);
  await store.flush();
  const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(parsed.budget.total, 1);
  assert.equal(parsed.budget.perGroup[String(GROUP)], 1);
  assert.equal(parsed.counters[String(GROUP) + ':R4:' + parsed.date], 1);
});

// ------------------------------------------------- 额外：举报上下文取法
await test('16) collectReportContext：被回复那条 + 前后各 5 条，target 只一条', async () => {
  const ring = new RingBuffer(30);
  const base = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 20; i += 1) {
    ring.push({
      messageId: 80000 + i,
      userId: USER,
      nickname: '小明',
      time: base + i,
      text: '消息' + i,
      images: [],
      isTarget: false,
    });
  }
  // handleReport 会先把举报消息本身入环，这里照同样顺序来
  const reportEv = groupMsg({ messageId: 81000 });
  ring.push({
    messageId: 81000,
    userId: USER,
    nickname: '小明',
    time: base + 100,
    text: '/举报 有人发广告',
    images: [],
    isTarget: false,
  });
  const noReply = collectReportContext(reportEv, ring);
  assert.equal(noReply.length, 10);
  const noReplyTargets = noReply.filter((x) => x.isTarget);
  assert.equal(noReplyTargets.length, 1);
  assert.equal(noReplyTargets[0].messageId, 81000, '没引用时目标就是举报消息本身');

  const withReply = collectReportContext(
    groupMsg({ messageId: 81001, message: [{ type: 'reply', data: { id: 80010 } }] }),
    ring,
  );
  assert.equal(withReply.length, 11, '被回复那条 + 前后各 5 条');
  const targets = withReply.filter((x) => x.isTarget);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].messageId, 80010);
});

// ------------------------------------------- 17 条款封顶（R9 只记录）
await test('17) guard.caps.R9=0 ⇒ R9 命中封 0 档、照常送云、不出手', async () => {
  const { h } = await fresh();
  h.deps.caps = { R9: 0 };
  h.nextJudge = () => ok(3, 0.95, 'R9');
  const res = await handleMessage(groupMsg({ text: '又提bhhs了' }), h.ctx, h.deps);
  assert.equal(h.judgeCalls, 1, '封顶只压档位，不压送云');
  assert.equal(res.decision.severity, 0, '档位封到 0');
  assert.equal(res.decision.action, 'none', '0 档不出手');
  assert.equal(res.decision.rule, 'R9');
  assert.match(res.decision.reason, /封顶 0 档/);
  assert.equal(res.record.severity, 0, '记录里也是封顶后的档');
  assert.equal(res.record.action, 'none');
  // 同条款当日第二次：被封顶的条款连「升 3 必须出手」也不许突破
  const again = await handleMessage(groupMsg({ text: '还是bhhs', messageId: 20002 }), h.ctx, h.deps);
  assert.equal(again.decision.severity, 0);
  assert.equal(again.decision.action, 'none');
});

// ------------------------------------------- 18 报警词（炸群/喊停）
await test('18) 「炸群」报警词 ⇒ 直通云 1 次、rule 落 OTHER、hit.kind=alarm', async () => {
  const { h } = await fresh();
  h.nextJudge = () => ok(1, 0.8, 'OTHER');
  const res = await handleMessage(groupMsg({ text: '别聊了，要炸群了' }), h.ctx, h.deps);
  assert.equal(h.judgeCalls, 1, '报警词必判，不受抽检影响');
  assert.equal(res.decision.channel, 'keyword');
  assert.equal(res.decision.rule, 'OTHER', '报警词不预设条款');
  const kinds = res.decision.hits.map((x) => x.kind);
  assert.ok(kinds.includes('alarm'), '命中里要有 alarm 标记，通知钩子靠它识别');
  assert.ok(res.decision.hits.some((x) => x.word === '炸群'));
});

// ------------------------------------------- 19 举报通道不按举报人豁免
await test('19) 主人自己 @机器人 / 发 /举报 也要判；机器人自己的消息仍挡', async () => {
  const { h } = await fresh();
  h.nextJudge = () => ok(2, 0.9, 'R4');
  const byOwner = await handleReport(groupMsg({ userId: OWNER, text: '人肉你' }), h.ctx, h.deps);
  assert.equal(h.judgeCalls, 1, '主人举报不该被豁免吞掉');
  assert.equal(byOwner.decision.channel, 'report');
  assert.equal(byOwner.decision.severity, 2);

  const bySelf = await handleReport(groupMsg({ userId: SELF, text: '/举报 冰毒' }), h.ctx, h.deps);
  assert.equal(bySelf.decision, null, '机器人自己发的消息不判，避免自循环');
  assert.equal(h.judgeCalls, 1);
});

// ------------------------------------------- 20 @ 目标进送审文本
await test('20) @ 段保留成 [at:QQ] 进送审文本；纯图+@ 仍按纯图片处理', async () => {
  const { h } = await fresh();
  h.nextScreen = () => ({ verdict: 'suspicious', score: 0.9, degraded: false, rule: 'R4', evidence: '傻逼' });
  h.nextJudge = () => ok(2, 0.9, 'R4');
  const atMsg = groupMsg({
    userId: USER,
    message: [
      { type: 'at', data: { qq: '888888888' } },
      { type: 'text', data: { text: ' 你是傻逼' } },
    ],
  });
  const res = await handleMessage(atMsg, h.ctx, h.deps);
  assert.equal(h.judgeCalls, 1, '关键词「傻逼」必判');
  const sent = h.judgeInputs[0].target.text;
  assert.match(sent, /\[at:888888888\]/, '必须带上 @ 的是谁，否则终审看不出在骂群友');
  assert.match(sent, /你是傻逼/);
  assert.equal(res.decision.rule, 'R4');

  // 纯图 + @：仍然走「纯图片」分支，不跑粗筛、不送云
  const pureAt = groupMsg({
    userId: USER,
    message: [
      { type: 'at', data: { qq: 'all' } },
      { type: 'image', data: { url: 'https://example.com/a.jpg' } },
    ],
  });
  const before = h.judgeCalls;
  const screenBefore = h.screenCalls;
  const pure = await handleMessage(pureAt, h.ctx, h.deps);
  assert.equal(h.judgeCalls, before, '纯图不该送云');
  assert.equal(h.screenCalls, screenBefore, '纯图不该跑粗筛');
  assert.match(pure.decision.reason, /纯图片/);
});

// ------------------------------------------------- 拆词（2026-11-02 举报受理后补词表）
await test('21) 举报通道：云端指回的原话片段写进记录 span（供补词表用）', async () => {
  const { h } = await fresh();
  h.nextJudge = () => ok(2, 0.9, 'R4', { span: '我弄死你' });
  const msg = groupMsg({ userId: USER, message: '我弄死你' });
  const res = await handleReport(msg, h.ctx, h.deps);
  assert.equal(h.judgeCalls, 1, '举报必判');
  assert.equal(res.record.channel, 'report');
  assert.equal(res.record.span, '我弄死你', 'span 要跟着记录走，index 才有得收词');

  // 降级（没拿到结论）不许带 span：没结论就没有「哪句话惹的祸」
  const { h: h2 } = await fresh();
  h2.nextJudge = () => ({ severity: 0, confidence: 0, reason: '网络失败', rule: 'OTHER', degraded: true, span: '我弄死你' });
  const res2 = await handleReport(msg, h2.ctx, h2.deps);
  assert.equal(res2.record.span, undefined, '降级记录不许带 span');
});

await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

console.log('');
if (failures.length === 0) {
  console.log('全部 PASS（' + passed + ' 项）');
  process.exit(0);
}
console.log(failures.length + ' 项 FAIL，' + passed + ' 项 PASS');
for (const f of failures) {
  console.log('--- ' + f.name);
  console.log(f.err instanceof Error ? f.err.stack : String(f.err));
}
process.exit(1);
