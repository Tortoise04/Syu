/**
 * 拆词补词表（src/guard/learn.ts + config.ts 的 hints 合并）单测。
 * 跑法：node scripts/test-learn.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'syu-learn-'));

process.env.GUARD_GROUP_IDS ??= '20001';
process.env.OWNER_QQ ??= '99999';

const { normalizeSpan, recordLearned, readLearnedSync, LEARN_DAILY_CAP, SPAN_MAX, learnedPath, auditPath } =
  await import('../src/guard/learn.ts');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  PASS ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  FAIL ' + name);
  }
}

const TS = '2026-11-02T09:40:00.000+08:00';

await test('0) normalizeSpan：去掉 @ 占位符与包装，压到 15 字', () => {
  assert.equal(normalizeSpan('[at:123] 我弄死你'), '我弄死你');
  assert.equal(normalizeSpan('「开你盒」'), '开你盒');
  assert.equal(normalizeSpan('  傻逼。'), '傻逼');
  assert.equal(normalizeSpan('一'.repeat(40)).length, SPAN_MAX);
});

await test('1) 太短 / 全数字 / 非群规条款 一律不收', async () => {
  const dataDir = path.join(tmpRoot, 'd1');
  const a = await recordLearned(dataDir, { span: '啊', rule: 'R4', groupId: 1, userId: 2, messageId: 3, ts: TS });
  assert.equal(a.added, false);
  const b = await recordLearned(dataDir, { span: '123456', rule: 'R4', groupId: 1, userId: 2, messageId: 3, ts: TS });
  assert.equal(b.added, false);
  const c = await recordLearned(dataDir, { span: '我弄死你', rule: 'REDLINE', groupId: 1, userId: 2, messageId: 3, ts: TS });
  assert.equal(c.added, false, 'REDLINE/OTHER 不是群规条款号，不进词表');
  assert.deepEqual(readLearnedSync(dataDir), {});
});

await test('2) 收一个词 → 落 learned-keywords.json + 审计行；重复与词表已有都不收', async () => {
  const dataDir = path.join(tmpRoot, 'd2');
  const first = await recordLearned(dataDir, { span: '我弄死你', rule: 'R4', groupId: 11, userId: 22, messageId: 33, ts: TS });
  assert.equal(first.added, true);
  assert.equal(first.word, '我弄死你');
  assert.deepEqual(readLearnedSync(dataDir), { R4: ['我弄死你'] });

  const audit = await fs.readFile(auditPath(dataDir), 'utf8');
  assert.match(audit, /"word":"我弄死你"/);
  assert.match(audit, /"messageId":33/);

  const again = await recordLearned(dataDir, { span: '我弄死你', rule: 'R4', groupId: 11, userId: 22, messageId: 44, ts: TS });
  assert.equal(again.added, false, '同一个词不重复收');

  const inTable = await recordLearned(dataDir, {
    span: '傻逼',
    rule: 'R4',
    groupId: 11,
    userId: 22,
    messageId: 55,
    ts: TS,
    taken: ['傻逼'],
  });
  assert.equal(inTable.added, false, '词表里已有的词不再收');
});

await test('3) 当日上限：写满 20 条审计后就停手', async () => {
  const dataDir = path.join(tmpRoot, 'd3');
  await fs.mkdir(dataDir, { recursive: true });
  const lines = Array.from({ length: LEARN_DAILY_CAP }, (_, i) =>
    JSON.stringify({ ts: TS, rule: 'R4', word: '旧词' + i, span: '旧词' + i, groupId: 1, userId: 2, messageId: i }),
  );
  await fs.writeFile(auditPath(dataDir), lines.join('\n') + '\n', 'utf8');
  const over = await recordLearned(dataDir, { span: '我弄死你', rule: 'R4', groupId: 1, userId: 2, messageId: 9, ts: TS });
  assert.equal(over.added, false);
  assert.match(over.reason, /学满/);
});

await test('4) loadConfig 把学到的词并进 gated（不直通云、不改 config.json）', async () => {
  const dataDir = path.join(tmpRoot, 'd4');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(learnedPath(dataDir), JSON.stringify({ R4: ['我弄死你'] }, null, 2), 'utf8');

  const base = JSON.parse(await fs.readFile(path.resolve('config.json'), 'utf8'));
  base.dataDir = dataDir;
  const cfgPath = path.join(tmpRoot, 'config-with-learned.json');
  await fs.writeFile(cfgPath, JSON.stringify(base, null, 2), 'utf8');
  const before = await fs.readFile(cfgPath, 'utf8');

  process.env.GUARD_CONFIG_PATH = cfgPath;
  const { loadConfig } = await import('../src/config.ts');
  const cfg = loadConfig();
  assert.ok(cfg.guard.keywords.gated.R4.includes('我弄死你'), '旧格式学到的词按 gated 读');
  assert.ok(!cfg.guard.keywords.rules.R4.includes('我弄死你'), '不许进 rules（那会直通云）');
  assert.equal(await fs.readFile(cfgPath, 'utf8'), before, 'config.json 一个字节都不许改');
  delete process.env.GUARD_CONFIG_PATH;
});

await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

console.log('');
if (failures.length === 0) {
  console.log('全部通过：' + passed + ' 条');
  process.exit(0);
}
console.log(failures.length + ' 条 FAIL，' + passed + ' 条通过');
for (const f of failures) {
  console.log('--- ' + f.name);
  console.log(f.err instanceof Error ? f.err.stack : String(f.err));
}
process.exit(1);
