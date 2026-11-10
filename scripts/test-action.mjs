// M2b 动作链路自测：node scripts/test-action.mjs
// 全部用假 client（只记录调用参数，一条消息都不发）+ 真实 StateStore（临时目录），
// 另加两条真 pipeline 断言（升 3 绕过冷却 / 其余冷却路径仍有效）。
// 退出码 0 = 全过。
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NO_COLOR = '1';
process.env.GUARD_GROUP_IDS = process.env.GUARD_GROUP_IDS ?? '20001';
process.env.OWNER_QQ = process.env.OWNER_QQ ?? '99999';

const { buildActionMessages, executeAction, notifyOwners, resetActionState } = await import('../src/guard/action.ts');
const { handleMessage } = await import('../src/guard/pipeline.ts');
const { RingBuffer } = await import('../src/guard/rules.ts');
const { StateStore } = await import('../src/state.ts');
const { loadConfig } = await import('../src/config.ts');

const config = loadConfig();
const CONFIG_PATH = new URL('../config.json', import.meta.url);
const GROUP = 20001;
const SELF = 10000;
const USER = 30001;
const REPORTER = 30002;
const OWNER = Number(process.env.OWNER_QQ);

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

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'syu-action-'));
let storeSeq = 0;
async function newStore(opts = {}) {
  storeSeq += 1;
  const file = path.join(tmpRoot, 'state-' + storeSeq, 'state.json');
  const store = new StateStore({ file, budgetDaily: opts.budgetDaily ?? 500, budgetPerGroup: opts.budgetPerGroup ?? 100 });
  await store.init();
  return { store, file };
}

/** 假 client：只把调用参数记下来；failGroup / failPrivate 用来模拟发送失败 */
class FakeClient {
  constructor() {
    this.calls = [];
    this.failGroup = false;
    this.failPrivate = false;
  }
  async sendGroup(groupId, message) {
    this.calls.push({ scope: 'group', to: Number(groupId), message });
    if (this.failGroup) throw new Error('假群发失败');
    return 1;
  }
  async sendPrivate(userId, message) {
    this.calls.push({ scope: 'private', to: Number(userId), message });
    if (this.failPrivate) throw new Error('假私聊失败');
    return 1;
  }
  groupCalls() {
    return this.calls.filter((c) => c.scope === 'group');
  }
}

function decision(over = {}) {
  return {
    channel: 'keyword',
    rule: 'R4',
    severity: 2,
    confidence: 0.93,
    action: 'warn',
    reason: '假判定：R4 档 2',
    hits: ['广告'],
    degraded: false,
    cooledDown: false,
    ...over,
  };
}
function target(over = {}) {
  return { messageId: 90001, userId: USER, nickname: '小明', text: '加我微信 卖号 广告', ...over };
}
function actionsOf(over = {}) {
  return { dryRun: false, groupSilent: false, muteEnabled: false, cooldownMs: 300000, actionDailyCap: 40, ...over };
}
function depsFor(client, store, over = {}) {
  return {
    client, store, actions: actionsOf(over), ownerQq: OWNER,
    groupOwners: over.groupOwners, adminQqs: over.adminQqs, recipients: over.recipients,
    groupRecipients: over.groupRecipients,
  };
}

function segText(message) {
  return message
    .filter((s) => s.type === 'text')
    .map((s) => s.data.text ?? '')
    .join('');
}
function segAts(message) {
  return message.filter((s) => s.type === 'at').map((s) => String(s.data.qq));
}

// ------------------------------------------------------------------ 配置默认值
await test('0) actions 取值：真实 config.json 已开群内警告，内置默认仍是 dryRun=true', async () => {
  // 2026-11-01 21:48 用户明确要求「把群里警告打开」，真实配置 dryRun=false；
  // 但内置默认必须保持 true —— 漏写 actions 节的配置要落在最安全的那一侧。
  assert.equal(config.actions.dryRun, false, '真实 config.json 现在应已打开群内警告');
  assert.equal(config.actions.muteEnabled, false);
  assert.equal(config.actions.cooldownMs, 300000);
  assert.equal(config.actions.actionDailyCap, 40);
  assert.equal(config.actions.groupSilent, true, '2026-11-02 用户拍板：群里一条都不发，私聊照发');

  const raw = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
  delete raw.actions;
  const noActions = path.join(tmpRoot, 'no-actions.json');
  await fsp.writeFile(noActions, JSON.stringify(raw));
  const cfg = loadConfig({ ...process.env, GUARD_CONFIG_PATH: noActions });
  assert.equal(cfg.actions.dryRun, true, '配置里不写 actions 节，内置默认也必须 dryRun=true');
  assert.equal(cfg.actions.groupSilent, false, '内置默认不进群静默');
});

await test('0b) actions 未知子键 ⇒ 启动即抛错并点名该键', async () => {
  const raw = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
  raw.actions = { ...(raw.actions ?? {}), bogusKey: 1 };
  const bad = path.join(tmpRoot, 'bad-actions.json');
  await fsp.writeFile(bad, JSON.stringify(raw));
  assert.throws(() => loadConfig({ ...process.env, GUARD_CONFIG_PATH: bad }), /actions 有未知键：bogusKey/);
});

// ------------------------------------------------------------------- dryRun
await test('1) dryRun=true ⇒ 零发送，计划与文案照算', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const rep = await executeAction(depsFor(client, store, { dryRun: true }), decision(), target(), GROUP);
  assert.equal(client.calls.length, 0, 'dryRun 一条 send 都不许有');
  assert.equal(rep.status, 'dry-run');
  assert.equal(rep.sent, 0);
  assert.equal(rep.attempts.length, 1, '计划照算：2 级 1 条');
  assert.match(rep.attempts[0].text, /明确警告/);
  assert.match(rep.attempts[0].text, /人身攻击／引战／广告/);
});

// ------------------------------------------------------------- 1/2/3 级文案
await test('2) 1 级 remind ⇒ 群内 1 条，@当事人，点明违反哪条但不引原文', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const rep = await executeAction(depsFor(client, store), decision({ severity: 1, action: 'remind' }), target(), GROUP);
  assert.equal(rep.status, 'sent');
  assert.equal(client.calls.length, 1, '一条消息最多 1 条群内动作');
  const call = client.calls[0];
  assert.equal(call.scope, 'group');
  assert.equal(call.to, GROUP);
  assert.deepEqual(segAts(call.message), [String(USER)], '必须 @ 当事人');
  const text = segText(call.message);
  assert.match(text, /注意群规第4条/, '1 级也要写清违反哪条（2026-11-01 用户要求）');
  assert.match(text, /人身攻击／引战／广告/, '用群规条名，不用内部代号');
  assert.ok(!/\bR4\b/.test(text), '群内文案不暴露内部代号');
  assert.ok(!/加我微信/.test(text), '不引原文');
});

await test('3) 2 级 warn ⇒ 群内 1 条，@当事人 + 条款名，不引原文不念编号', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const rep = await executeAction(depsFor(client, store), decision({ severity: 2, action: 'warn' }), target(), GROUP);
  assert.equal(rep.status, 'sent');
  assert.equal(client.calls.length, 1);
  const call = client.calls[0];
  assert.equal(call.scope, 'group');
  assert.equal(call.to, GROUP);
  assert.deepEqual(segAts(call.message), [String(USER)]);
  const text = segText(call.message);
  assert.match(text, /明确警告/);
  assert.match(text, /人身攻击／引战／广告/, '用 config 里的条款名');
  assert.ok(!/R4/.test(text), '文案里不许出现条款编号');
  assert.ok(!/加我微信/.test(text), '不许引用原话');
});

await test('4) 3 级 escalate ⇒ 两条：群内不 @ 当事人 + 私聊主人证据', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const tgt = target({ messageId: 90004, text: '加我微信卖号' });
  const rep = await executeAction(depsFor(client, store), decision({ severity: 3, action: 'escalate' }), tgt, GROUP);
  assert.equal(client.calls.length, 2, '3 级正好两条');
  assert.equal(rep.sent, 2);
  assert.equal(rep.failures, 0);

  const pub = client.calls[0];
  assert.equal(pub.scope, 'group');
  assert.equal(pub.to, GROUP);
  assert.deepEqual(segAts(pub.message), [], '群内警示不许 @ 当事人');
  assert.match(segText(pub.message), /已记录/);
  assert.match(segText(pub.message), /群规第4条/, '3 级群内警示也要写清违反哪条');

  const priv = client.calls[1];
  assert.equal(priv.scope, 'private');
  assert.equal(priv.to, OWNER, '私聊主人');
  const ev = segText(priv.message);
  assert.match(ev, /时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, '私信要带时间（2026-11-01 用户要求）');
  assert.match(ev, /群：20001/, '谁、在哪群');
  assert.match(ev, /小明/);
  assert.match(ev, new RegExp(String(USER)));
  assert.match(ev, /加我微信卖号/, '原话');
  assert.match(ev, /R4/);
  assert.match(ev, /0\.93/, '置信度');
  assert.ok(!/通道：/.test(ev), '私信去掉「通道」行（2026-11-01 用户要求）');
});

// ------------------------------------------------------------------- 兜底
await test('5) 3 级私聊主人失败 ⇒ 群内补一条 @主人 的实话提示', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  client.failPrivate = true;
  const rep = await executeAction(
    depsFor(client, store),
    decision({ severity: 3, action: 'escalate' }),
    target({ messageId: 90005 }),
    GROUP,
  );
  assert.equal(rep.fallback, true);
  assert.equal(rep.failures, 1);
  assert.equal(rep.sent, 2, '群内警示 + 兜底各成功 1 条');
  assert.equal(client.calls.length, 3, '发起 3 次：群警示、私聊（失败）、兜底');
  const fb = client.calls[2];
  assert.equal(fb.scope, 'group');
  assert.equal(fb.to, GROUP);
  assert.deepEqual(segAts(fb.message), [String(OWNER)], '兜底要 @主人');
  const text = segText(fb.message);
  assert.match(text, /私聊通知失败/);
  assert.match(text, /请查看日志/);
  assert.ok(!/已通知成功/.test(text), '不许谎称通知成功');
});

await test('6) 群发失败 ⇒ 不重试、无兜底、不记幂等位', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  client.failGroup = true;
  const rep = await executeAction(
    depsFor(client, store),
    decision({ severity: 2, action: 'warn' }),
    target({ messageId: 90006 }),
    GROUP,
  );
  assert.equal(client.calls.length, 1, '重试次数上限 0');
  assert.equal(rep.failures, 1);
  assert.equal(rep.fallback, false, '群发失败没有兜底文案');
  assert.notEqual(store.snapshot.lastActionMessageId, 90006, '没发成功就不占幂等位');
});

// ------------------------------------------------------------------- 幂等
await test('7) 同 messageId 二次执行 ⇒ 零二次发送（进程内集合）', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const d = decision({ severity: 2, action: 'warn' });
  const tgt = target({ messageId: 90007 });
  const first = await executeAction(depsFor(client, store), d, tgt, GROUP);
  assert.equal(first.status, 'sent');
  assert.equal(client.calls.length, 1);
  const second = await executeAction(depsFor(client, store), d, tgt, GROUP);
  assert.equal(second.status, 'duplicate');
  assert.equal(second.sent, 0);
  assert.equal(client.calls.length, 1, '重放事件不许二次刷屏');
});

await test('8) 进程内集合清空后 ⇒ 仍靠 lastActionMessageId 拦住同一条', async () => {
  resetActionState();
  const { store, file } = await newStore();
  const client = new FakeClient();
  const d = decision({ severity: 2, action: 'warn' });
  const tgt = target({ messageId: 90008 });
  await executeAction(depsFor(client, store), d, tgt, GROUP);
  assert.equal(client.calls.length, 1);

  resetActionState(); // 模拟进程重启：内存集合没了，state 文件还在
  const again = await executeAction(depsFor(client, store), d, tgt, GROUP);
  assert.equal(again.status, 'duplicate');
  assert.equal(client.calls.length, 1);

  // StateStore 是防抖+原子写，进程退出前必须 flush 一次才落盘（见 src/state.ts:221-232）
  await store.flush();
  const store2 = new StateStore({ file, budgetDaily: 500, budgetPerGroup: 100 });
  await store2.init();
  assert.equal(store2.snapshot.lastActionMessageId, 90008, '新进程读回幂等位');
});

// --------------------------------------------------------------- 举报通道
await test('9) report 通道 ⇒ 群里照常对当事人动作，举报人一条私聊都收不到', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const d = decision({ channel: 'report', severity: 2, action: 'warn', rule: 'R7' });
  const tgt = target({ messageId: 90009, userId: OWNER, nickname: '被举报者' });
  const rep = await executeAction(depsFor(client, store), d, tgt, GROUP, REPORTER);
  // 2026-11-01 晚口径：举报人自己在群里 @ 机器人，身份已公开，「群里一声不吭」只是放过违规
  assert.equal(client.groupCalls().length, 1, '判到档位就要在群里动作');
  const group = client.groupCalls()[0];
  assert.equal(group.to, GROUP);
  assert.deepEqual(segAts(group.message), [String(OWNER)], '@ 的是被判定那条的作者，不是举报人');
  assert.ok(!/举报/.test(segText(group.message)), '群内文案一个字都不提举报');
  // 2026-11-04 用户拍板：收到举报不给举报人私聊，连回执也不发
  const priv = client.calls.filter((c) => c.scope === 'private');
  assert.equal(priv.length, 0, '举报人收不到任何私聊');
  assert.equal(rep.sent, 1);
});

await test('10) report 通道 escalate ⇒ 私聊只发主人的证据，举报人不在收件人里', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const rep = await executeAction(
    depsFor(client, store),
    decision({ channel: 'report', action: 'escalate', severity: 3, rule: 'R7' }),
    target({ messageId: 90010 }),
    GROUP,
    REPORTER,
  );
  const priv = client.calls.filter((c) => c.scope === 'private');
  assert.ok(priv.length > 0, '3 级证据照发主人');
  assert.ok(priv.every((c) => c.to !== REPORTER), '举报人收不到私聊');
  assert.equal(rep.fallback, false, '私聊没失败就不兜底');
});

// ------------------------------------------------------------------- mute
await test('11) mute 档恒不产出（本轮零禁言，开关打开也不变）', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const rep = await executeAction(
    depsFor(client, store, { muteEnabled: true }),
    decision({ severity: 3, action: 'mute' }),
    target({ messageId: 90011 }),
    GROUP,
  );
  assert.equal(client.calls.length, 0);
  assert.equal(rep.status, 'none');
  assert.deepEqual(buildActionMessages(decision({ action: 'mute' }), target(), GROUP, { ownerQq: OWNER }), []);
});

// --------------------------------------------------------------- 当日上限
await test('12) 当日动作上限 ⇒ 超限只记录不发送', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const deps = depsFor(client, store, { actionDailyCap: 1 });
  const a = await executeAction(deps, decision({ action: 'warn' }), target({ messageId: 90012 }), GROUP);
  assert.equal(a.status, 'sent');
  const b = await executeAction(deps, decision({ action: 'warn' }), target({ messageId: 90013 }), GROUP);
  assert.equal(b.status, 'capped');
  assert.equal(client.calls.length, 1, '超限不许再发');
});

// ------------------------------------------------- 升 3 绕过冷却（真 pipeline）
let msgSeq = 80000;
function groupMsg(over = {}) {
  const userId = over.userId ?? USER;
  const messageId = over.messageId ?? ++msgSeq;
  const body = over.text ?? '肢解';
  return {
    post_type: 'message',
    message_type: 'group',
    time: Math.floor(Date.now() / 1000),
    self_id: SELF,
    message_id: messageId,
    user_id: userId,
    group_id: over.groupId ?? GROUP,
    message: body,
    raw_message: body,
    sender: { user_id: userId, nickname: '小明' },
  };
}
function pipeHarness(store) {
  const h = { judgeCalls: 0, nextJudge: () => ({ severity: 2, confidence: 0.9, reason: '假终审', rule: 'R4', degraded: false }) };
  const deps = {
    store,
    rules: { table: config.guard.keywords, linkWhitelist: config.guard.linkWhitelist },
    screener: { async screen() { return { verdict: 'clean', degraded: false }; } },
    judge: {
      async judge() {
        h.judgeCalls += 1;
        return h.nextJudge();
      },
    },
    rulesText: config.guard.rulesText,
    thresholds: config.guard.thresholds,
    ownerQq: OWNER,
  };
  const ring = new RingBuffer(30);
  return { h, deps, ctx: { ring } };
}

await test('13) 升 3 绕过冷却：5 分钟内同群同条款第 2 条 action=escalate', async () => {
  const { store } = await newStore();
  const { h, deps, ctx } = pipeHarness(store);
  h.nextJudge = () => ({ severity: 2, confidence: 0.9, reason: '假终审', rule: 'R4', degraded: false });
  const first = await handleMessage(groupMsg({ text: '肢解' }), ctx, deps);
  assert.equal(first.decision.action, 'warn');
  assert.equal(first.decision.cooledDown, false);
  const second = await handleMessage(groupMsg({ text: '肢解' }), ctx, deps);
  assert.equal(second.decision.severity, 3, '同群同条款第 2 次升 3');
  assert.notEqual(second.decision.action, 'none', '升 3 那次不许被冷却吞掉');
  assert.equal(second.decision.action, 'escalate');
  assert.equal(second.decision.cooledDown, false);
});

await test('14) 冷却其余路径仍有效：OTHER 条款 5 分钟内第 2 条 = none', async () => {
  const { store } = await newStore();
  const { h, deps, ctx } = pipeHarness(store);
  h.nextJudge = () => ({ severity: 2, confidence: 0.9, reason: '假终审', rule: 'OTHER', degraded: false });
  const first = await handleMessage(groupMsg({ text: '肢解' }), ctx, deps);
  assert.equal(first.decision.action, 'warn');
  const second = await handleMessage(groupMsg({ text: '肢解' }), ctx, deps);
  assert.equal(second.decision.action, 'none');
  assert.equal(second.decision.cooledDown, true);
});

// ------------------------------------------------------------------- 按群定向（方案 §14）
await test('15) 按群定向：绑定群 3 级只发绑定者 + adminQqs，全局 owner 不收', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const BOUND = [888001, 888002];
  const ADMIN = 770001;
  const deps = depsFor(client, store, { groupOwners: { [GROUP]: BOUND }, adminQqs: [ADMIN] });
  const rep = await executeAction(deps, decision({ severity: 3, action: 'escalate' }), target({ messageId: 90015 }), GROUP);
  const privs = client.calls.filter((c) => c.scope === 'private').map((c) => c.to);
  assert.deepEqual(privs.sort((a, b) => a - b), [ADMIN, ...BOUND].sort((a, b) => a - b), '只发给绑定者 + adminQqs');
  assert.ok(!privs.includes(OWNER), '绑定群：全局 owner 不收');
  assert.equal(rep.failures, 0);
});

await test('16) 按群定向：未绑定群回退全局 owner + adminQqs，别群的绑定者不收', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const OTHER_GROUP = 20002;
  const ADMIN = 770001;
  const deps = depsFor(client, store, { groupOwners: { [GROUP]: [888001] }, adminQqs: [ADMIN] });
  const rep = await executeAction(deps, decision({ severity: 3, action: 'escalate' }), target({ messageId: 90016 }), OTHER_GROUP);
  const privs = client.calls.filter((c) => c.scope === 'private').map((c) => c.to);
  assert.deepEqual(privs.sort((a, b) => a - b), [ADMIN, OWNER].sort((a, b) => a - b), '未绑定群 → 全局 owner + adminQqs');
  assert.ok(!privs.includes(888001), '别群的绑定者不收');
  assert.equal(rep.failures, 0);
});

// ------------------------------------------------------- 通知人（2026-11-04）：只收提醒、零权限
await test('16b) 通知人：3 级证据与通知类私聊都收，且不改主人/管理员名单', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const WATCHER = 660001;
  const deps = depsFor(client, store, { recipients: [WATCHER] });
  const rep = await executeAction(deps, decision({ severity: 3, action: 'escalate' }), target({ messageId: 90017 }), GROUP);
  const privs = client.calls.filter((c) => c.scope === 'private').map((c) => c.to);
  assert.deepEqual(privs.sort((a, b) => a - b), [OWNER, WATCHER].sort((a, b) => a - b), '通知人与主人同批收 3 级证据');
  assert.equal(rep.failures, 0);

  resetActionState();
  const client2 = new FakeClient();
  const deps2 = depsFor(client2, store, { recipients: [WATCHER] });
  const notice = await notifyOwners(deps2, { why: '炸群报警词', decision: decision(), target: target(), groupId: GROUP });
  assert.equal(notice.status, 'sent');
  assert.deepEqual(notice.to.sort((a, b) => a - b), [OWNER, WATCHER].sort((a, b) => a - b), '通知类私聊也发给通知人');
});

await test('16c) 通知人只多收私聊：不改变群内动作，3 级群内警示仍只有一条', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const WATCHER = 660002;
  const deps = depsFor(client, store, { recipients: [WATCHER] });
  await executeAction(deps, decision({ severity: 3, action: 'escalate' }), target({ messageId: 90018 }), GROUP);
  const groups = client.calls.filter((c) => c.scope === 'group');
  assert.equal(groups.length, 1, '群内动作不受通知人影响，仍是一条警示');
});

await test('16d) 按群通知人：配了主群就只发给主群，别的群不发；全局名单不并进来', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const WATCHER_MAIN = 660011;
  const WATCHER_OTHER = 660012;
  const GLOBAL = 660013;
  const deps = depsFor(client, store, {
    recipients: [GLOBAL],
    groupRecipients: { [String(GROUP)]: [WATCHER_MAIN] },
  });
  const rep = await executeAction(deps, decision({ severity: 3, action: 'escalate' }), target({ messageId: 90019 }), GROUP);
  const privs = client.calls.filter((c) => c.scope === 'private').map((c) => c.to);
  assert.deepEqual(privs.sort((a, b) => a - b), [OWNER, WATCHER_MAIN].sort((a, b) => a - b), '主群只发绑定的通知人，不并全局');
  assert.equal(rep.failures, 0);

  resetActionState();
  const client2 = new FakeClient();
  const otherGroup = 20002;
  const deps2 = depsFor(client2, store, {
    recipients: [GLOBAL],
    groupRecipients: { [String(GROUP)]: [WATCHER_MAIN] },
  });
  await executeAction(deps2, decision({ severity: 3, action: 'escalate' }), target({ messageId: 90020 }), otherGroup);
  const privs2 = client2.calls.filter((c) => c.scope === 'private').map((c) => c.to);
  assert.deepEqual(privs2.sort((a, b) => a - b), [OWNER, GLOBAL].sort((a, b) => a - b), '没绑的群回退全局通知人，不串到别的群');
  assert.ok(!privs2.includes(WATCHER_MAIN) && !privs2.includes(WATCHER_OTHER), '别的群不会收到主群通知人');
});

// ------------------------------------------------------- 通知类私聊（报警词 / R9）
await test('17) notifyOwners dryRun=true ⇒ 零发送，只报计划收件人', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const deps = depsFor(client, store, { dryRun: true });
  const rep = await notifyOwners(deps, { why: '炸群报警词', decision: decision(), target: target(), groupId: GROUP });
  assert.equal(rep.status, 'dry-run');
  assert.deepEqual(rep.to, [OWNER]);
  assert.equal(client.calls.length, 0, 'dryRun 一条都不发');
});

await test('18) notifyOwners 真发 ⇒ 只私聊收件人，群里一个字没有', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const ADMIN = 770002;
  const deps = depsFor(client, store, { adminQqs: [ADMIN] });
  const rep = await notifyOwners(deps, { why: '条款9（bhhs 等）只记录', decision: decision({ rule: 'R9' }), target: target(), groupId: GROUP });
  assert.equal(rep.status, 'sent');
  assert.equal(rep.sent, 2);
  assert.equal(rep.failures, 0);
  const privs = client.calls.filter((c) => c.scope === 'private').map((c) => c.to).sort((a, b) => a - b);
  assert.deepEqual(privs, [ADMIN, OWNER].sort((a, b) => a - b), '主人 + 群主各一条');
  assert.equal(client.groupCalls().length, 0, '通知类不往群里发');
  const text = segText(client.calls[0].message);
  assert.match(text, /【群守卫·通知】/, '标题与 3 级证据区分');
  assert.match(text, /条款9/);
});

await test('19) notifyOwners 无收件人 ⇒ no-recipient，不抛错', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const deps = { client, store, actions: actionsOf({}), ownerQqs: [], adminQqs: [] };
  const rep = await notifyOwners(deps, { why: '炸群报警词', decision: decision(), target: target(), groupId: GROUP });
  assert.equal(rep.status, 'no-recipient');
  assert.equal(client.calls.length, 0);
});

await test('20) notifyOwners dryRun=true + live=true ⇒ 通知照发（notify.enabled 生效，群里不动）', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const deps = depsFor(client, store, { dryRun: true });
  const rep = await notifyOwners(deps, {
    why: '判定到 2 级（人身攻击／引战／广告）',
    decision: decision({ severity: 2, rule: 'R4' }),
    target: target(),
    groupId: GROUP,
    live: true,
  });
  assert.equal(rep.status, 'sent');
  assert.equal(rep.sent, 1);
  assert.equal(rep.failures, 0);
  assert.equal(client.groupCalls().length, 0, '通知只走私聊，群里不发');
});

// ------------------------------------------- 群内静默（2026-11-02 用户拍板）
await test('21) groupSilent=true ⇒ 群内一条都不发，3 级私聊证据照发', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const rep = await executeAction(
    depsFor(client, store, { groupSilent: true }),
    decision({ severity: 3, action: 'escalate' }),
    target(),
    GROUP,
  );
  assert.equal(client.groupCalls().length, 0, '群内一条都不许发');
  const priv = client.calls.filter((c) => c.scope === 'private');
  assert.equal(priv.length, 1, '3 级证据私聊照发');
  assert.equal(rep.status, 'sent');
  assert.match(segText(priv[0].message), /3 级证据/);
});

await test('22) groupSilent=true ⇒ 2 级群里静音后一条都不发', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  const rep = await executeAction(depsFor(client, store, { groupSilent: true }), decision(), target(), GROUP);
  assert.equal(client.calls.length, 0);
  assert.equal(rep.status, 'none');
});

await test('23) groupSilent=true ⇒ 3 级私聊失败也不许群内兜底', async () => {
  resetActionState();
  const { store } = await newStore();
  const client = new FakeClient();
  client.failPrivate = true;
  const rep = await executeAction(
    depsFor(client, store, { groupSilent: true }),
    decision({ severity: 3, action: 'escalate' }),
    target(),
    GROUP,
  );
  assert.equal(client.groupCalls().length, 0, '兜底也不许进群');
  assert.equal(rep.fallback, false);
});

if (failures.length === 0) {
  console.log('');
  console.log('全部通过：' + passed + ' 条');
  process.exit(0);
}
console.log('');
console.log('失败 ' + failures.length + ' 条');
process.exit(1);
