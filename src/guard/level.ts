import type { Decision } from './types.ts';

/**
 * 秒杀级判定（2026-11-18 用户拍板）：
 * 只有 REDLINE（毒品/诈骗/军火/色情交易）、R11（esu/开盒人肉）、R3 的**真 3 档**秒杀内容
 * （猎奇、男女权对立、时政键政、731 娱乐化）才通知主人。
 * 被「同条款当日第 2 次」次数规则抬到 3 档的 R4 辱骂、R7 色情等不算秒杀，不私聊、不发证据。
 */
export function instantKill(decision: Pick<Decision, 'rule' | 'severity' | 'escalatedToThree'>): boolean {
  if (decision.rule === 'REDLINE' || decision.rule === 'R11') return true;
  return decision.rule === 'R3' && decision.severity === 3 && !decision.escalatedToThree;
}
