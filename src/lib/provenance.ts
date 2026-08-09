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

/** Every field-level correction or rename recorded on a card, oldest first. */
export function fieldCorrections(card: Card): { field: string; before: string; after: string; at: string; tier: string; action: string }[] {
  return card.provenance.history
    .filter((h) => (h.action === 'correct' || h.action === 'rename') && h.field)
    .map((h) => ({ field: h.field!, before: h.before ?? '', after: h.after ?? '', at: h.at, tier: String(h.tier), action: h.action }));
}
