// REVIEW.md sections 5 and 6 (D155 rulings 5 and 6): the line each side sees after a
// dispute or a settlement, and the explorer link under every final payout or refund.
import { POLICY_CLUSTER } from '../config';
import { rewardText } from '../scout/views';

function get(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** The prompt of a requirement id in the view's policy, or REVIEW.md 5's fallback. */
export function promptOf(view: unknown, id: unknown): string {
  const list = get(get(view, 'policy'), 'evidence_requirements');
  if (typeof id === 'string' && Array.isArray(list)) {
    const found = list.find((r) => get(r, 'id') === id);
    if (found !== undefined) return String(get(found, 'prompt'));
  }
  return 'a requirement not in this bounty';
}

export interface Outcome {
  readonly line: string;
  /** Present for a final payout or refund. */
  readonly explorerUrl?: string;
}

/** Null while the bounty is neither disputed nor settled. */
export function outcomeFor(view: unknown, role: 'requester' | 'scout'): Outcome | null {
  const state = get(view, 'state');
  const amount = rewardText(String(get(get(view, 'policy'), 'reward_amount')));
  const settlement = get(view, 'settlement');
  const kind = get(settlement, 'kind');
  const sig = get(settlement, 'tx_signature');
  const url = typeof sig === 'string'
    ? 'https://explorer.solana.com/tx/' + sig + '?cluster=' + POLICY_CLUSTER
    : undefined;
  const withLink = (line: string): Outcome => (url === undefined ? { line } : { line, explorerUrl: url });
  if (state === 'DISPUTED') {
    const named = promptOf(view, get(get(view, 'dispute'), 'failed_requirement_id'));
    return role === 'requester'
      ? { line: 'Disputed: ' + named + '. The arbiter will decide.' }
      : { line: "The requester disputed '" + named + "'. The arbiter will decide." };
  }
  if (state === 'PAID') {
    if (role === 'scout') return withLink('Paid ' + amount + '.');
    return withLink(kind === 'RESOLVED_PAID' ? 'Arbiter paid the Scout.'
      : 'Paid ' + amount + ' to the Scout.');
  }
  if (state === 'REFUNDED') {
    if (kind === 'RESOLVED_REFUNDED') {
      return withLink(role === 'requester' ? 'Arbiter refunded you.'
        : 'The arbiter refunded the requester.');
    }
    return withLink(role === 'requester' ? 'Your USDC was returned after the deadline.'
      : 'This mission ended without payment.');
  }
  return null;
}
