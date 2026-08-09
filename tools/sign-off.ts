/**
 * Human sign-off on Tier C review flags.
 *
 * WHAT SIGN-OFF IS, AND WHAT IT IS NOT
 *
 * The design gates judgement rewrites behind a human. With no remote to raise a
 * pull request against, `needs_review` IS the pull request: an agent applies a
 * Tier C change, flags the card, and the card renders "Needs review — awaiting
 * human sign-off" to the learner until a person agrees.
 *
 * Signing off records that agreement. It does NOT make a claim verified. A
 * permanently unsourced positioning card still renders "Unsourced — positioning
 * and practice judgement, no deterministic source applies" afterwards, and
 * `deriveConfidence` still caps it at `medium` because it has no `verified_at`.
 * Endorsement and verification are different properties and the deck shows both
 * separately — collapsing them would let a confident human launder a claim no
 * source supports.
 *
 * NOTHING IS DELETED
 *
 * The review reasons come off the card's live state, but the `flag-review` entry
 * that recorded WHY it was flagged stays in the append-only history, and a
 * `clear-review` entry is appended naming the approver and quoting what they
 * approved. Reading the card's history later still answers "who decided this was
 * acceptable, and on what basis".
 *
 * Confidence is recomputed through the shared `deriveConfidence`, not set by hand,
 * so this tool cannot invent a rating the validator would reject.
 *
 * Usage:
 *   node tools/sign-off.ts --by "Tomas Mihalyi" --all
 *   node tools/sign-off.ts --by "Tomas Mihalyi" AC-01 AC-11 [--dry-run]
 */

import { loadCards, saveCard } from '../src/lib/store.ts';
import { deriveConfidence } from '../src/lib/provenance.ts';
import type { Card } from '../src/lib/types.ts';

const GENERATOR = 'tools/sign-off.ts';
const dryRun = process.argv.includes('--dry-run');
const all = process.argv.includes('--all');

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

/** Card ids given positionally, ignoring flags and their values. */
function requestedIds(): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--by') {
      i++; // skip its value
      continue;
    }
    if (a.startsWith('--')) continue;
    out.push(a.toUpperCase());
  }
  return out;
}

function main(): void {
  const by = flag('by');
  if (!by) {
    // An unattributed sign-off is worthless as a record: the whole point is that
    // a NAMED human took responsibility for a judgement an agent made.
    console.error('sign-off: --by "<name>" is required. A sign-off with no approver is not a sign-off.');
    process.exit(1);
  }

  const cards = loadCards();
  const ids = requestedIds();
  if (!all && !ids.length) {
    console.error('sign-off: name the card ids to sign off, or pass --all');
    process.exit(1);
  }

  const pending = cards.filter((c) => c.needs_review);
  const targets = all ? pending : cards.filter((c) => ids.includes(c.card_id));

  const unknown = ids.filter((id) => !cards.some((c) => c.card_id === id));
  if (unknown.length) {
    console.error(`sign-off: no such card(s): ${unknown.join(', ')}`);
    process.exit(1);
  }

  const now = new Date().toISOString();
  const touched: Card[] = [];

  console.log(`sign-off: ${by} · ${pending.length} card(s) awaiting review\n`);

  for (const card of targets) {
    if (!card.needs_review) {
      console.log(`  ${card.card_id}: not flagged for review — nothing to sign off`);
      continue;
    }
    const before = card.confidence;
    const approved = card.review_reasons.map((r) => r.reason);

    card.provenance.history.push({
      at: now,
      tier: 'C',
      action: 'clear-review',
      generator: GENERATOR,
      reason:
        `Signed off by ${by}. Approved: ${approved.join(' | ')} ` +
        '(The flag-review entries recording why this was raised remain in this history.)',
    });

    card.needs_review = false;
    card.review_reasons = [];
    card.signed_off = { by, at: now };
    card.confidence = deriveConfidence(card);
    card.updated_at = now;
    touched.push(card);

    const note = card.confidence === 'medium' && !card.verified_at
      ? '  — stays medium: endorsed, but still unsourced, so never "verified"'
      : '';
    console.log(`  ${card.card_id.padEnd(6)} ${card.title}`);
    console.log(`         confidence ${before} → ${card.confidence}${note}`);
  }

  console.log(`\nsign-off: ${touched.length} card(s) signed off`);
  if (dryRun) {
    console.log('sign-off: --dry-run, nothing written');
    return;
  }
  for (const c of touched) saveCard(c);
  if (touched.length) console.log('sign-off: run node src/validate.ts && node src/build.ts');
}

main();
