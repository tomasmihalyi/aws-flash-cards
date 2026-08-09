/**
 * Provenance helpers.
 *
 * The card as originally authored, reconstructed from the append-only ledger.
 * Shared by the parity gate and its test so there is one implementation of what
 * "accounted for" means — duplicating it would let the gate and the test drift
 * apart, which is the failure mode this whole repo is built to avoid.
 */

import type { Card } from './types.ts';

/**
 * Revert a card to what its author originally wrote.
 *
 * Three kinds of change come back out, and the distinctions are the point:
 *
 *   SLOTS — every slot returns to its `seed_text`, accounting for deterministic
 *   fact corrections.
 *
 *   CORRECTIONS — a `correct` entry naming a `field` is inverted to its recorded
 *   `before`, accounting for a real correction to a card field such as a stale
 *   `preview` badge.
 *
 *   RENAMES — a `rename` entry naming a `field` is inverted the same way. A
 *   rename is NOT a correction and the ledger keeps them apart: the card was not
 *   wrong, the world changed its mind about what the thing is called. The parity
 *   gate treats both as recorded reasons because that is what it checks for, but
 *   collapsing them into one action would lose the only signal that distinguishes
 *   "we were mistaken" from "AWS renamed it".
 *
 * The guarantee this supports is not "nothing changed" — that forbids all change
 * forever, which is the trap the original byte-for-byte DOM gate fell into. It is
 * "nothing changed without a recorded reason", which is weaker and far more useful.
 *
 * The EARLIEST entry per field carries the original value, because history is
 * append-only and chronological.
 */
export function originalProjection(card: Card): Card {
  const clone = JSON.parse(JSON.stringify(card)) as Card;
  for (const slot of Object.values(clone.slots)) slot.rendered = slot.seed_text;

  const firstBefore = new Map<string, string>();
  for (const h of clone.provenance.history) {
    if (h.action !== 'correct' && h.action !== 'rename') continue;
    if (!h.field || h.before === undefined) continue;
    if (!firstBefore.has(h.field)) firstBefore.set(h.field, h.before);
  }
  for (const [field, before] of firstBefore) {
    (clone as unknown as Record<string, string>)[field] = before;
  }
  return clone;
}

/**
 * Confidence is DERIVED, never asserted.
 *
 * The single implementation, shared by `src/ingest/apply.ts` (which stamps it on
 * every resolve) and `tools/sign-off.ts` (which recomputes it when a human clears
 * a review flag). It lived privately inside apply.ts, and a second copy in the
 * sign-off tool would be the same drift hazard that already bit this repo twice —
 * once with the tokenizer duplicated between lifecycle.ts and verifier.ts, once
 * with `originalProjection` nearly duplicated between the parity gate and its test.
 *
 * The ladder, strongest constraint first:
 *
 *   low     any slot still renders from its seed literal. Unverifiable by
 *           construction, whatever else is true.
 *   medium  awaiting human review, OR never verified against a source at all.
 *           This is where a permanently unsourced positioning card lands even
 *           after a human endorses it — endorsement is not verification.
 *   high    every slot resolved, a verification timestamp, and no open review.
 */
export function deriveConfidence(card: Card): Card['confidence'] {
  const anySeed = Object.values(card.slots).some((s) => s.rendered_from === 'seed');
  if (anySeed) return 'low';
  if (card.needs_review || !card.verified_at) return 'medium';
  return 'high';
}

/** Every field-level correction or rename recorded on a card, oldest first. */
export function fieldCorrections(card: Card): { field: string; before: string; after: string; at: string; tier: string; action: string }[] {
  return card.provenance.history
    .filter((h) => (h.action === 'correct' || h.action === 'rename') && h.field)
    .map((h) => ({ field: h.field!, before: h.before ?? '', after: h.after ?? '', at: h.at, tier: String(h.tier), action: h.action }));
}
