// M2a-A 状态与配置层自测：node scripts/test-state.mjs
// 逐条对齐任务单的 4 条验收；任何一条断言失败退出码非 0。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NO_COLOR = '1';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

const { StateStore } = await import('../src/state.ts');
const { loadConfig } = await import('../src/config.ts');

// ---- 落盘计数：拦 fs.promises（state.ts 用的是同一个对象）----
const realRename = fsp.rename;
let renameCount = 0;
let tmpSeenAtRename = 0;
let tmpParsedOk = 0;
fsp.rename = async (from, to) => {
  const toStr = String(to);
  if (toStr.endsWith('state.json')) {
    renameCount += 1;
    const fromStr = String(from);
    if (fromStr.endsWith('state.json.tmp') && fs.existsSync(fromStr)) {
      tmpSeenAtRename += 1;
      try {
        JSON.parse(fs.readFileSync(fromStr, 'utf8'));
        tmpParsedOk += 1;
      } catch {
        /* 半截 JSON：不计数，让断言失败 */
      }
    }
  }
  return realRename(from, to);
};

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'syu-state-'));

/**
 * 在临时工作目录里执行：config.json 的 dataDir 是相对路径 './data'，
 * 而 loadConfig 会把 data/learned-keywords.json 并进词表。测试要断言「配置文件里写的词」，
 * 必须先离开仓库根，否则会被本机跑出来的学词记录污染（2026-11-02 实测踩到）。
 */
function inTmpCwd(fn) {
  const before = process.cwd();
  process.chdir(tmpRoot);
  try {
    return fn();
  } finally {
    process.chdir(before);
  }
}
let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('ok ' + passed + ' - ' + name);
  } catch (err) {
    failures.push(name);
    console.error('not ok - ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}

// 1) 无文件首启建空态
await test('首启无文件 → 建空状态并落盘', async () => {
  const file = path.join(tmpRoot, 'fresh', 'state.json');
  const s = new StateStore({ file, budgetDaily: 500, budgetPerGroup: 100 });
  await s.init();
  const snap = s.snapshot;
  assert.equal(snap.date, localDate(new Date()));
  assert.equal(snap.budget.total, 0);
  assert.deepEqual(snap.budget.perGroup, {});
  assert.deepEqual(snap.counters, {});
  assert.deepEqual(snap.cooldowns, {});
  assert.equal(snap.screenDegraded, false);
  assert.equal(snap.lastActionMessageId, undefined);
  assert.ok(fs.existsSync(file), 'init 应该把空状态写出来');
  JSON.parse(await fsp.readFile(file, 'utf8'));
  await s.flush();
});

// 2) 总预算 500 封顶
await test('takeBudget 到 500 后 false，且 total 不再涨', async () => {
  const file = path.join(tmpRoot, 'budget-total', 'state.json');
  const s = new StateStore({ file, budgetDaily: 500, budgetPerGroup: 100000 });
  await s.init();
  for (let i = 0; i < 500; i += 1) {
    assert.equal(s.takeBudget(20001), true, '第 ' + (i + 1) + ' 次应该成功');
  }
  assert.equal(s.snapshot.budget.total, 500);
  assert.equal(s.takeBudget(20001), false);
  assert.equal(s.snapshot.budget.total, 500, 'false 之后 total 不许涨');
  assert.equal(s.takeBudget(20002), false, '总预算满了，换群也不行');
  assert.equal(s.snapshot.budget.total, 500);
  assert.equal(s.snapshot.budget.perGroup['20002'], undefined, '失败不扣任何一边');
  await s.flush();
});

// 3) 单群预算 100 封顶
await test('单群到 100 后 false，且不误扣总预算', async () => {
  const file = path.join(tmpRoot, 'budget-group', 'state.json');
  const s = new StateStore({ file, budgetDaily: 100000, budgetPerGroup: 100 });
  await s.init();
  for (let i = 0; i < 100; i += 1) {
    assert.equal(s.takeBudget(20001), true, '第 ' + (i + 1) + ' 次应该成功');
  }
  assert.equal(s.takeBudget(20001), false);
  assert.equal(s.snapshot.budget.perGroup['20001'], 100);
  assert.equal(s.snapshot.budget.total, 100, '被单群上限拒掉的那次不许扣总预算');
  assert.equal(s.takeBudget(20002), true, '另一个群照常');
  assert.equal(s.snapshot.budget.total, 101);
  await s.flush();
});

// 3b) groupDaily：活跃群 500、测试群仍走 perGroup 100（2026-11-02 用户拍板）
await test('groupDaily 覆盖单群上限，别的群不受影响', async () => {
  const file = path.join(tmpRoot, 'budget-groupdaily', 'state.json');
  const s = new StateStore({
    file,
    budgetDaily: 600,
    budgetPerGroup: 100,
    groupDaily: { '111111111': 500 },
  });
  await s.init();
  for (let i = 0; i < 500; i += 1) {
    assert.equal(s.takeBudget(111111111), true, '活跃群第 ' + (i + 1) + ' 次应该成功');
  }
  assert.equal(s.takeBudget(111111111), false, '活跃群第 501 次应被拦');
  assert.equal(s.snapshot.budget.perGroup['111111111'], 500);
  for (let i = 0; i < 100; i += 1) {
    assert.equal(s.takeBudget(222222222), true, '测试群第 ' + (i + 1) + ' 次应该成功');
  }
  assert.equal(s.takeBudget(222222222), false, '测试群仍按 perGroup 100 拦');
  assert.equal(s.snapshot.budget.total, 600, '两边各用自己的上限，总量 600');
  await s.flush();
});

// 4) 注入 now() 模拟跨日
await test('跨日：预算与计数清零，冷却表不清', async () => {
  const file = path.join(tmpRoot, 'rollover', 'state.json');
  let fakeNow = new Date(2026, 2, 10, 23, 0, 0);
  const s = new StateStore({ file, budgetDaily: 500, budgetPerGroup: 100, now: () => fakeNow });
  await s.init();
  assert.equal(s.snapshot.date, '2026-03-10');
  assert.equal(s.takeBudget(20001), true);
  assert.equal(s.bumpDailyCount(20001, 'R4'), 1);
  assert.equal(s.bumpRejectReport(10001), 1);
  s.touchCooldown('20001:R4', 3 * 60 * 60 * 1000);
  assert.equal(s.isCooling('20001:R4'), true);
  await s.flush();

  fakeNow = new Date(2026, 2, 11, 0, 0, 1);
  const snap = s.snapshot;
  assert.equal(snap.date, '2026-03-11');
  assert.equal(snap.budget.total, 0, '跨日预算清零');
  assert.deepEqual(snap.budget.perGroup, {});
  assert.deepEqual(snap.counters, {}, '跨日当日计数清零');
  assert.ok('20001:R4' in snap.cooldowns, '冷却表跨日不清');
  assert.equal(s.isCooling('20001:R4'), true, '未到期的冷却跨日照样冷却');
  assert.equal(s.dailyCount(20001, 'R4'), 0);
  assert.equal(s.rejectReportCount(10001), 0);
  assert.equal(s.takeBudget(20001), true, '新的一天预算回来了');
  await s.flush();

  const reloaded = new StateStore({ file, budgetDaily: 500, budgetPerGroup: 100, now: () => fakeNow });
  await reloaded.init();
  assert.equal(reloaded.snapshot.date, '2026-03-11');
  assert.equal(reloaded.snapshot.budget.total, 1);
  assert.ok('20001:R4' in reloaded.snapshot.cooldowns, '重载后冷却仍在');
  await reloaded.flush();
});

// 5) 冷却过期边界
await test('isCooling / touchCooldown 过期边界', async () => {
  let clockMs = new Date(2026, 3, 1, 10, 0, 0).getTime();
  const file = path.join(tmpRoot, 'cooling', 'state.json');
  const s = new StateStore({ file, budgetDaily: 500, budgetPerGroup: 100, now: () => new Date(clockMs) });
  await s.init();
  assert.equal(s.isCooling('没人按过的键'), false);
  s.touchCooldown('20001:R4', 5000);
  assert.equal(s.isCooling('20001:R4'), true);
  clockMs += 4999;
  assert.equal(s.isCooling('20001:R4'), true, '差 1ms 仍冷却');
  clockMs += 1;
  assert.equal(s.isCooling('20001:R4'), false, '正好到期即解除');
  assert.equal(s.snapshot.cooldowns['20001:R4'], undefined, '过期项被自然摘掉');
  await s.flush();
});

// 6) lastActionMessageId / screenDegraded 落盘往返
await test('lastActionMessageId 与 screenDegraded 能落盘往返', async () => {
  const file = path.join(tmpRoot, 'misc', 'state.json');
  const s = new StateStore({ file, budgetDaily: 500, budgetPerGroup: 100 });
  await s.init();
  s.setLastActionMessageId(88888);
  s.setScreenDegraded(true);
  await s.flush();
  const reloaded = new StateStore({ file, budgetDaily: 500, budgetPerGroup: 100 });
  await reloaded.init();
  assert.equal(reloaded.snapshot.lastActionMessageId, 88888);
  assert.equal(reloaded.snapshot.screenDegraded, true);
  reloaded.setLastActionMessageId(undefined);
  await reloaded.flush();
  const again = new StateStore({ file, budgetDaily: 500, budgetPerGroup: 100 });
  await again.init();
  assert.equal(again.snapshot.lastActionMessageId, undefined);
  await again.flush();
});

// 7) 坏 JSON → 备份 + 空态
await test('坏 JSON → 备份成 state.json.bad-<ts> 并回到空态', async () => {
  const dir = path.join(tmpRoot, 'corrupt');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  const garbage = '{"date":"2026-01-01","budget":{"total":3,';
  await fsp.writeFile(file, garbage, 'utf8');
  const s = new StateStore({ file, budgetDaily: 500, budgetPerGroup: 100 });
  await s.init();
  const names = await fsp.readdir(dir);
  const backups = names.filter((n) => n.startsWith('state.json.bad-'));
  assert.equal(backups.length, 1, '要留下 1 个备份，实际：' + names.join(', '));
  assert.equal(await fsp.readFile(path.join(dir, backups[0]), 'utf8'), garbage, '备份必须是原坏文件');
  const snap = s.snapshot;
  assert.equal(snap.budget.total, 0);
  assert.deepEqual(snap.counters, {});
  assert.equal(snap.date, localDate(new Date()));
  const rewritten = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(rewritten.budget.total, 0, '坏文件位置被合法空态覆盖');
  await s.flush();
});

// 8) JSON 合法但校验不过 → 同样备份
await test('JSON 合法但字段不合规 → 同样备份 + 空态', async () => {
  const dir = path.join(tmpRoot, 'corrupt-schema');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  await fsp.writeFile(
    file,
    JSON.stringify({ date: '2026-01-01', budget: { total: 7, perGroup: {} }, counters: 'nope', cooldowns: {}, screenDegraded: false }),
    'utf8',
  );
  const s = new StateStore({ file, budgetDaily: 500, budgetPerGroup: 100 });
  await s.init();
  const names = await fsp.readdir(dir);
  assert.equal(names.filter((n) => n.startsWith('state.json.bad-')).length, 1);
  assert.equal(s.snapshot.budget.total, 0, '校验不过就回空态，不许把 7 带进来');
  await s.flush();
});

// 9) 防抖：50 次改内存只落盘 1 次
await test('防抖：连续 50 次改内存只落盘 1 次', async () => {
  const file = path.join(tmpRoot, 'debounce', 'state.json');
  const s = new StateStore({ file, budgetDaily: 500, budgetPerGroup: 100 });
  await s.init();
  await s.flush();
  const base = renameCount;
  for (let i = 0; i < 50; i += 1) s.bumpDailyCount(20001, 'R4');
  assert.equal(renameCount, base, '同步循环里不许落盘');
  await sleep(500);
  const writes = renameCount - base;
  assert.equal(writes, 1, '50 次改动应该只落盘 1 次，实际 ' + writes);
  assert.equal(s.dailyCount(20001, 'R4'), 50);
  const onDisk = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(onDisk.counters['20001:R4:' + localDate(new Date())], 50);
  await s.flush();
});

// 10) 原子写：rename 时 .tmp 在位且内容是完整 JSON，rename 后 .tmp 消失
await test('原子写：.tmp 先写全再 rename，且事后不留 .tmp', async () => {
  const file = path.join(tmpRoot, 'atomic', 'state.json');
  const s = new StateStore({ file, budgetDaily: 500, budgetPerGroup: 100 });
  await s.init();
  const beforeTmp = tmpSeenAtRename;
  const beforeOk = tmpParsedOk;
  s.takeBudget(20001);
  await s.flush();
  assert.ok(tmpSeenAtRename > beforeTmp, 'rename 那一刻 .tmp 必须在磁盘上');
  assert.equal(tmpParsedOk - beforeOk, tmpSeenAtRename - beforeTmp, 'rename 时 .tmp 内容必须是完整 JSON');
  assert.equal(fs.existsSync(file + '.tmp'), false, 'rename 后 .tmp 必须消失');
  JSON.parse(await fsp.readFile(file, 'utf8'));
});

// 11) 配置：单字词必须抛，且消息里带这个词
await test('config.json 里造单字词 → loadConfig 抛错且消息含该词', async () => {
  const real = JSON.parse(await fsp.readFile(path.join(projectRoot, 'config.json'), 'utf8'));
  real.guard.keywords.rules.R3.push('毒');
  const badPath = path.join(tmpRoot, 'bad-keyword.json');
  await fsp.writeFile(badPath, JSON.stringify(real, null, 2), 'utf8');
  const env = {
    ONEBOT_WS_URL: 'ws://127.0.0.1:3002',
    GUARD_GROUP_IDS: '20001',
    OWNER_QQ: '10001',
    LOG_LEVEL: 'error',
    MOCK_MODE: '0',
    GUARD_CONFIG_PATH: badPath,
  };
  let threw = null;
  try {
    loadConfig(env);
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, '单字词必须让 loadConfig 抛错，不许静默丢词');
  const msg = String(threw.message);
  assert.ok(msg.includes('毒'), '错误消息里要含那个词，实际：' + msg);
  assert.ok(msg.includes('只有 1 个字'), '错误消息要说清是长度问题，实际：' + msg);
  assert.ok(msg.includes('guard.keywords.rules.R3'), '错误消息要指明位置，实际：' + msg);
});

// 12) 配置：config.json 缺失 → 内置默认，不抛
await test('config.json 缺失 → 走内置默认且不抛', async () => {
  const env = {
    ONEBOT_WS_URL: 'ws://127.0.0.1:3002',
    GUARD_GROUP_IDS: '20001',
    OWNER_QQ: '10001',
    LOG_LEVEL: 'error',
    MOCK_MODE: '0',
    GUARD_CONFIG_PATH: path.join(tmpRoot, 'nope-not-here.json'),
  };
  const cfg = inTmpCwd(() => loadConfig(env));
  assert.equal(cfg.guard.budget.daily, 500);
  assert.equal(cfg.guard.budget.perGroup, 100);
  assert.deepEqual(cfg.guard.budget.groupDaily, {});
  assert.equal(cfg.guard.thresholds.redline, 0.6);
  assert.equal(cfg.guard.thresholds.normal, 0.75);
  // 公开版本刻意清空内置词表（真实词表只在本地 config.json）：缺省全空
  assert.deepEqual(cfg.guard.keywords.recordOnly, []);
  assert.deepEqual(cfg.guard.whitelist, [], '缺省配置的不检测名单是空表');
  assert.deepEqual(cfg.guard.exemptPhrases, [], '缺省配置的玩笑白名单是空表');
  assert.deepEqual(cfg.guard.keywords.redline, [], '公开版本不带内置红线词');
  assert.deepEqual(cfg.guard.keywords.rules.R9, []);
  assert.deepEqual(cfg.guard.keywords.rules.R10, []);
  assert.deepEqual(cfg.guard.keywords.rules.R3, []);
  assert.deepEqual(cfg.guard.keywords.gated.R4, []);
  assert.equal(cfg.notify.enabled, false, '通知私聊默认关');
  assert.deepEqual(cfg.notify.recipients, [], '通知人（2026-11-04）缺省为空');
  assert.deepEqual(cfg.notify.groupRecipients, {}, '按群通知人缺省为空');
  assert.deepEqual(cfg.guard.linkWhitelist, ['bilibili.com', 'b23.tv', 'miyoushe.com', 'douyin.com']);
  assert.ok(cfg.guard.rulesText.includes('禁止'), '缺省群规必须是可用的示例文本');
  assert.equal(cfg.screen.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(cfg.screen.enabled, true);
  assert.equal(cfg.judge.baseUrl, 'https://api.deepseek.com');
  assert.equal(cfg.judge.maxTokens, 512);
  assert.equal(cfg.dataDir, './data');
  assert.deepEqual(cfg.onebot.groupIds, [20001]);
  assert.equal(cfg.onebot.wsUrl, 'ws://127.0.0.1:3002');
});

// 13) 配置：真实的 config.json 能过校验，且与内置默认一致
await test('真实 config.json 能过校验，内容与关键词表 v0.3 一致', async () => {
  const env = {
    ONEBOT_WS_URL: 'ws://127.0.0.1:3002',
    GUARD_GROUP_IDS: '20001',
    OWNER_QQ: '10001',
    LOG_LEVEL: 'error',
    MOCK_MODE: '0',
    GUARD_CONFIG_PATH: path.join(projectRoot, 'config.json'),
  };
  const cfg = inTmpCwd(() => loadConfig(env));
  // 词表内容属于隐私（见 PUSH_RULES.md §4）：这里不写字面量，改为与本地 config.json 原文逐项比对，
  // 既验证 loadConfig 没丢词/没改词，又不会把真实词表带进仓库。
  const rawCfg = JSON.parse(await fsp.readFile(path.join(projectRoot, 'config.json'), 'utf8'));
  assert.deepEqual(cfg.guard.keywords.redline, rawCfg.guard.keywords.redline, '红线词原样带出');
  assert.deepEqual(cfg.guard.keywords.rules.R4, rawCfg.guard.keywords.rules.R4, 'R4 直通词原样带出');
  assert.deepEqual(cfg.guard.keywords.gated.R4, rawCfg.guard.keywords.gated.R4, 'R4 本地确认词原样带出');
  assert.deepEqual(cfg.guard.keywords.rules.R3, rawCfg.guard.keywords.rules.R3, 'R3 词原样带出');
  assert.deepEqual(cfg.guard.keywords.hints.R4, rawCfg.guard.keywords.hints.R4, 'R4 提示词原样带出');
  assert.deepEqual(cfg.guard.keywords.rules.R11, rawCfg.guard.keywords.rules.R11, 'R11 词原样带出');
  assert.equal(cfg.notify.enabled, true);
  // 通知人同样是隐私：只验形状、条数与键的形态，不写字面量（2026-11-04）
  assert.deepEqual(cfg.notify.recipients, [], '真实 config 的全局通知人已清空');
  const grKeys = Object.keys(cfg.notify.groupRecipients);
  assert.equal(grKeys.length, 1, '按群通知人只配了一个群');
  assert.match(grKeys[0], /^\d{5,12}$/, '按群通知人的键必须是数字群号');
  const grVals = cfg.notify.groupRecipients[grKeys[0]];
  assert.ok(Array.isArray(grVals) && grVals.length === 3, '主群绑 3 个通知人');
  assert.ok(grVals.every((n) => Number.isInteger(n)), '通知人必须是整数 QQ 号');
  assert.ok(Array.isArray(cfg.notify.adminQqs) && cfg.notify.adminQqs.length === 1, '管理员号只配一个');
  // 2026-11-02 用户拍板：活跃群 700；23:10 总量 600 → 800（用户「六百额度再加200」）
  assert.equal(cfg.guard.budget.daily, 800);
  assert.equal(cfg.guard.budget.perGroup, 100);
  assert.equal(Object.keys(cfg.guard.budget.groupDaily).length, 1, '只给一个群设了日额度');
  assert.equal(Object.values(cfg.guard.budget.groupDaily)[0], 700, '2026-11-02 17:50 用户把活跃群额度提到 700');
  assert.equal(cfg.guard.thresholds.redline, 0.6);
  // 不检测名单（2026-11-02）：默认空；真实 config 只收录一个号（19:43 加）
  assert.equal(cfg.guard.whitelist.length, 1);
  // 玩笑白名单（2026-11-02 夜间）：内容同属隐私，只验形状，不写字面量
  assert.ok(Array.isArray(cfg.guard.exemptPhrases), '玩笑白名单必须是数组');
  assert.deepEqual(cfg.guard.exemptPhrases, rawCfg.guard.exemptPhrases, '玩笑白名单原样带出');
});

// 14) 配置：坏键 / 非数字阈值也一次性收集后抛
await test('配置错误一次性收集齐再抛（未知键 + 阈值越界）', async () => {
  const real = JSON.parse(await fsp.readFile(path.join(projectRoot, 'config.json'), 'utf8'));
  real.hiddenKey = 1;
  real.guard.thresholds.normal = 1.5;
  const badPath = path.join(tmpRoot, 'bad-multi.json');
  await fsp.writeFile(badPath, JSON.stringify(real, null, 2), 'utf8');
  let threw = null;
  try {
    loadConfig({
      ONEBOT_WS_URL: 'ws://127.0.0.1:3002',
      GUARD_GROUP_IDS: '20001',
      OWNER_QQ: '10001',
      LOG_LEVEL: 'error',
      GUARD_CONFIG_PATH: badPath,
    });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, '必须抛');
  assert.ok(String(threw.message).includes('hiddenKey'), '要报未知顶层键');
  assert.ok(String(threw.message).includes('guard.thresholds.normal'), '要报阈值越界');
});

// 14b) 配置：不检测名单只收 QQ 号，坏项要报出来
await test('guard.whitelist 只收 QQ 号：字符串数字认、坏项报错、去重', async () => {
  const real = JSON.parse(await fsp.readFile(path.join(projectRoot, 'config.json'), 'utf8'));
  real.guard.whitelist = [10001, '10002', 10001, 'abc', 0];
  const okPath = path.join(tmpRoot, 'wl-bad.json');
  await fsp.writeFile(okPath, JSON.stringify(real, null, 2), 'utf8');
  let threw = null;
  try {
    loadConfig({
      ONEBOT_WS_URL: 'ws://127.0.0.1:3002',
      GUARD_GROUP_IDS: '20001',
      OWNER_QQ: '10001',
      LOG_LEVEL: 'error',
      GUARD_CONFIG_PATH: okPath,
    });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, '坏项要抛');
  assert.ok(String(threw.message).includes('guard.whitelist'), '要点名 guard.whitelist');

  real.guard.whitelist = [10001, '10002', 10001];
  const goodPath = path.join(tmpRoot, 'wl-good.json');
  await fsp.writeFile(goodPath, JSON.stringify(real, null, 2), 'utf8');
  const cfg = loadConfig({
    ONEBOT_WS_URL: 'ws://127.0.0.1:3002',
    GUARD_GROUP_IDS: '20001',
    OWNER_QQ: '10001',
    LOG_LEVEL: 'error',
    GUARD_CONFIG_PATH: goodPath,
  });
  assert.deepEqual(cfg.guard.whitelist, [10001, 10002], '字符串数字要认，重复要去重');
});

// 15) 配置：GUARD_GROUP_OWNERS 解析（方案 §14.1）+ 绑定不在守卫列表时报错
await test('GUARD_GROUP_OWNERS 正确解析为按群映射，且绑定群必须在守卫列表内', async () => {
  const baseEnv = {
    ONEBOT_WS_URL: 'ws://127.0.0.1:3002',
    GUARD_GROUP_IDS: '20001,20002',
    OWNER_QQ: '10001',
    LOG_LEVEL: 'error',
    MOCK_MODE: '0',
    GUARD_CONFIG_PATH: path.join(tmpRoot, 'nope-' + (Date.now()) + '.json'),
  };
  const cfg = loadConfig({ ...baseEnv, GUARD_GROUP_OWNERS: '20001:111,222;20002:333' });
  assert.deepEqual(cfg.onebot.groupIds, [20001, 20002]);
  assert.deepEqual(cfg.onebot.ownerQqs, [10001]);
  assert.deepEqual(cfg.onebot.groupOwners, { 20001: [111, 222], 20002: [333] }, '按群映射解析正确');

  // 缺冒号 → 报错（不允许静默吞掉）
  assert.throws(
    () => loadConfig({ ...baseEnv, GUARD_GROUP_OWNERS: '20001-111' }),
    /缺冒号/,
    '缺冒号要抛',
  );

  // 绑定的群不在守卫列表 → 启动报错（防手改漏配）
  assert.throws(
    () => loadConfig({ ...baseEnv, GUARD_GROUP_IDS: '20001', GUARD_GROUP_OWNERS: '20001:111;20003:222' }),
    /20003.*不在 GUARD_GROUP_IDS/,
    '绑定不在守卫列表的群要抛',
  );

  // 空值 = 无绑定，行为同 v2
  const cfgEmpty = loadConfig({ ...baseEnv, GUARD_GROUP_OWNERS: '' });
  assert.deepEqual(cfgEmpty.onebot.groupOwners, {}, '空 GUARD_GROUP_OWNERS = 无绑定');
});

await fsp.rm(tmpRoot, { recursive: true, force: true });

console.log('');
if (failures.length > 0) {
  console.error('失败 ' + failures.length + ' 条：' + failures.join(' | '));
  process.exit(1);
}
console.log('全部通过：' + passed + ' 条');
