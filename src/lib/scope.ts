/**
 * May this source speak about this card at all?
 *
 * ONE predicate, deliberately. Every detector that matches a dated source entry
 * against a card imports this and nothing else — `check-coverage` and
 * `check-lifecycle` today. Copying it is how the defect below happened.
 *
 * Checked BEFORE any token scoring, because it is an exact fact where scoring is
 * a heuristic. No threshold can fix a cross-product match: `cli` really is both
 * cards' subject, so the scorer is right and still wrong.
 *
 * `null` scope is permissive: an unregistered source keeps its old behaviour
 * rather than silently matching nothing, which in coverage would look like total
 * coverage and in lifecycle like a deck with no drift.
 *
 * WHY THIS IS A MODULE AND NOT A FUNCTION IN coverage.ts
 *
 * It lived in coverage.ts and only coverage called it, which read as sufficient
 * because coverage is where the rule was first needed. The lifecycle detector
 * matched on tokens alone, and the miss was invisible for as long as no two
 * products shipped a lifecycle change under a shared noun.
 *
 * On 2026-08-12 Kiro shipped "CLI: Cloud Sessions Preview and Smarter Command
 * Menus". The lifecycle detector matched it to AC-16 — the AgentCore CLI card —
 * on `cli`, decided the newest signal said `preview`, and reported the card as
 * drifting. The card was correct; the detector was reading another product's
 * changelog. The scheduled refresh then failed its gate for two consecutive days.
 *
 * That is the SAME defect class the README documents as fixed, on the SAME card,
 * from the SAME source. It was fixed in one detector and not the other, so the
 * fix is now a shared import that both must go through.
 */
import type { Card } from './types.ts';
import type { DatedEntry } from './verifier.ts';

export function inScope(card: Card, entry: DatedEntry): boolean {
  if (!entry.service) return true;
  return card.service === entry.service;
}
