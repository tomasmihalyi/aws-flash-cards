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
 * Two kinds of change come back out, and the distinction is the point:
 *
 *   SLOTS — every slot returns to its `seed_text`, accounting for deterministic
 *   fact corrections.
 *
 *   FIELDS — a `correct` entry naming a `field` is inverted to its recorded
 *   `before`, accounting for a real correction to a card field such as a stale
 *   `preview` badge.
 *
 * The guarantee this supports is not "nothing changed" — that forbids all change
 * forever, which is the trap the original byte-for-byte DOM gate fell into. It is
 * "nothing changed without a recorded reason", which is weaker and far more useful.
 *
 * The EARLIEST correction per field carries the original value, because history is
 * append-only and chronological.
 */
export function originalProjection(card: Card): Card {
  const clone = JSON.parse(JSON.stringify(card)) as Card;
  for (const slot of Object.values(clone.slots)) slot.rendered = slot.seed_text;

  const firstBefore = new Map<string, string>();
  for (const h of clone.provenance.history) {
    if (h.action !== 'correct' || !h.field || h.before === undefined) continue;
    if (!firstBefore.has(h.field)) firstBefore.set(h.field, h.before);
  }
  for (const [field, before] of firstBefore) {
    (clone as unknown as Record<string, string>)[field] = before;
  }
  return clone;
}

/** Every field-level correction recorded on a card, oldest first. */
export function fieldCorrections(card: Card): { field: string; before: string; after: string; at: string; tier: string }[] {
  return card.provenance.history
    .filter((h) => h.action === 'correct' && h.field)
    .map((h) => ({ field: h.field!, before: h.before ?? '', after: h.after ?? '', at: h.at, tier: String(h.tier) }));
}
