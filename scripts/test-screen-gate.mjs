// B 结构闸门自测：node scripts/test-screen-gate.mjs
// 只测纯函数 applyEvidenceGate，不起网络、不需要 Ollama。
import assert from 'node:assert/strict';

process.env.NO_COLOR = '1';
process.env.GUARD_GROUP_IDS = process.env.GUARD_GROUP_IDS ?? '20001';
process.env.OWNER_QQ = process.env.OWNER_QQ ?? '99999';

const { applyEvidenceGate } = await import('../src/guard/screen.ts');

const cases = [
  // verdict, rule, evidence, 期望 verdict, 期望是否降级
  ['clean', undefined, undefined, 'clean', false],
  ['suspicious', 'R4', '开你盒', 'suspicious', false],
  ['suspicious', 'R4', '  开你盒  ', 'suspicious', false],
  ['suspicious', 'R4', '', 'clean', true],
  ['suspicious', 'R4', '   ', 'clean', true],
  ['suspicious', 'R4', undefined, 'clean', true],
  ['suspicious', undefined, '开你盒', 'clean', true],
  ['suspicious', 'OTHER', '叽里咕噜', 'clean', true],
];

let n = 0;
for (const [verdict, rule, evidence, wantVerdict, wantDown] of cases) {
  const got = applyEvidenceGate(verdict, rule, evidence);
  assert.equal(got.verdict, wantVerdict, `verdict ${String(verdict)}/${String(rule)}/${String(evidence)}`);
  assert.equal(got.downgraded, wantDown, `downgraded ${String(verdict)}/${String(rule)}/${String(evidence)}`);
  n += 1;
}
console.log(`全部通过：${n} 条断言`);
