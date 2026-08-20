/**
 * verify-parity — content parity against the original hand-authored deck.
 *
 * WHAT CHANGED, AND WHY IT HAD TO
 *
 * This gate used to compare the generated HTML byte-for-byte against the
 * original file: template source, CSS, pictograms, 84 face renders, and the
 * whole shell. That was the right check for exactly one job — proving the
 * migration from a hardcoded DECK array to card JSON lost nothing — and it
 * passed.
 *
 * But it also froze the markup. The deck shipped with a real accessibility
 * defect (both faces permanently in the DOM with no aria-hidden, so a screen
 * reader read the answer aloud while the question was showing), and every
 * frontend improvement in the spec — search, tags, deep links, spaced
 * repetition, provenance display — necessarily changes the DOM. A gate that
 * forbids all of those is no longer protecting anything worth protecting.
 *
 * So the guarantee moved rather than weakened:
 *   - BEHAVIOUR is now pinned by tests/deck-state.test.ts (filter, navigate,
 *     flip, shuffle, clamping, progress, and the a11y invariant), against a
 *     state machine extracted out of the DOM.
 *   - AUTHORED CONTENT is still pinned here: revert every slot to its seed_text
 *     and the result must equal the original deck exactly. That is what stops a
 *     card's wording being lost or quietly edited.
 *   - DETERMINISTIC CORRECTIONS are reported, not failed — they are the point.
 *
 * Anything else differing is unexplained drift, and fails.
 *
 * Usage: node src/verify-parity.ts [--verbatim]
 *   --verbatim  additionally require ZERO corrections (the original P1 condition)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, DIST_HTML, loadCards, loadCategories } from './lib/store.ts';
import { loadLegacy } from './lib/legacy.ts';
import { authoredText } from './lib/render.ts';
import { canonical } from './lib/hash.ts';
import { originalProjection } from './lib/provenance.ts';
import type { Card } from './lib/types.ts';

const verbatim = process.argv.includes('--verbatim');
const failures: string[] = [];
const checks: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) checks.push(`PASS  ${name}`);
  else failures.push(`FAIL  ${name}${detail ? '\n      ' + detail : ''}`);
}


function main(): void {
  const legacy = loadLegacy(paths.legacyHtml);
  // Same exclusion build.ts applies (2026-08-20): a retired card's lead text
  // is deliberately NOT in the published HTML, so checking for it here would
  // fail this gate every time a card is retired, on a mismatch this gate
  // itself created rather than a real parity defect. Excluding it keeps this
  // gate's claim accurate: "the built HTML matches what SHOULD be built",
  // not "matches everything sitting in cards/ regardless of lifecycle".
  const cards = loadCards()
    .filter((c) => c.lifecycle !== 'retired')
    .sort((a, b) => a.card_id.localeCompare(b.card_id));
  const categories = loadCategories();

  /**
   * Match the original 21 cards BY ID, not by position, and say nothing about
   * cards added since.
   *
   * The gate used to assert `cards.length === legacy.DECK.length`, which made
   * growing the deck impossible — the third time this gate has had to stop
   * forbidding a legitimate change. The guarantee it actually owes is "the
   * migration lost nothing", not "the deck never grows": every card the original
   * deck had must still be present and still say what it said, and a new card is
   * simply out of its jurisdiction.
   */
  const byId = new Map(cards.map((c) => [c.card_id, c]));
  const missing = legacy.DECK.filter((d) => !byId.has(d.id)).map((d) => d.id);
  check(
    `all ${legacy.DECK.length} original cards are still present`,
    missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')} — cards are tombstoned, never removed (FR-9)` : '',
  );
  const added = cards.filter((c) => !legacy.DECK.some((d) => d.id === c.card_id)).map((c) => c.card_id);

  // ---- authored content parity, over the original cards only ----
  let unexplained = 0;
  for (const legacyCard of legacy.DECK) {
    const card = byId.get(legacyCard.id);
    if (!card) continue;
    const seeded = authoredText(originalProjection(card), categories);
    if (canonical(seeded) !== canonical(legacyCard)) {
      unexplained++;
      failures.push(`FAIL  ${legacyCard.id}: authored text differs with no fact-governed slot and no recorded field correction to explain it\n${firstDiff(seeded, legacyCard)}`);
    }
  }
  check(`authored text of all ${legacy.DECK.length} original cards accounted for (slots reverted to seed, recorded field corrections inverted)`, unexplained === 0);

  // ---- every card still resolves and renders ----
  let renderable = 0;
  for (const card of cards) {
    try {
      authoredText(card, categories);
      renderable++;
    } catch (e) {
      failures.push(`FAIL  ${card.card_id}: does not render — ${(e as Error).message}`);
    }
  }
  check(`all ${cards.length} cards resolve their slots and render`, renderable === cards.length);

  // ---- the built artifact reflects the current card data ----
  const generatedPath = paths.distHtml;
  if (!existsSync(generatedPath)) {
    failures.push(`FAIL  dist/${DIST_HTML} not found — run node src/build.ts first`);
  } else {
    const generated = readFileSync(generatedPath, 'utf8');
    let missing = 0;
    for (const card of cards) {
      const lead = authoredText(card, categories).back.lead;
      if (!generated.includes(JSON.stringify(lead))) missing++;
    }
    check('every card\u2019s current lead text is present in the built HTML', missing === 0, `${missing} missing`);
    check('the built HTML has no unreplaced build markers',
      !/@@[A-Z]+@@|\/\*__[A-Z]+__\*\//.test(generated));
    check('the accessibility fix is present in the built HTML',
      generated.includes('aria-hidden') && generated.includes('applyFaceState'),
      'aria-hidden toggling not found — the screen-reader defect would be back');
  }

  // ---- corrections: expected, itemised, never a failure ----
  const corrected = cards.flatMap((c) =>
    Object.entries(c.slots)
      .filter(([, s]) => s.rendered !== s.seed_text)
      .map(([slot, s]) => ({ id: c.card_id, slot, before: s.seed_text, after: s.rendered })),
  );
  if (verbatim && corrected.length) {
    failures.push(`FAIL  --verbatim: ${corrected.length} slot(s) corrected away from the original text`);
  }

  if (added.length) {
    console.log(`\nCards added since the original deck (${added.length}), outside this gate's jurisdiction: ${added.join(', ')}`);
  }
  report(legacy.DECK.length, corrected);
}

function firstDiff(a: unknown, b: unknown): string {
  const sa = JSON.stringify(a, null, 1).split('\n');
  const sb = JSON.stringify(b, null, 1).split('\n');
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    if (sa[i] !== sb[i]) return `      now:      ${sa[i] ?? '<end>'}\n      original: ${sb[i] ?? '<end>'}`;
  }
  return '';
}

function report(cardCount: number, corrected: { id: string; slot: string; before: string; after: string }[]): void {
  for (const c of checks) console.log(c);
  for (const f of failures) console.error(f);

  if (corrected.length) {
    console.log(`\nDeterministic corrections since the original deck (${corrected.length}) — expected, not failures:`);
    for (const c of corrected) {
      console.log(`  ${c.id}.${c.slot}`);
      console.log(`    was: ${c.before}`);
      console.log(`    now: ${c.after}`);
    }
  }

  const ok = failures.length === 0;
  console.log(
    `\nverify-parity: ${ok ? 'PASS' : 'FAIL'} · ${cardCount} cards · ${checks.length} check(s) passed · ${failures.length} failed · ${corrected.length} deterministic correction(s)`,
  );
  console.log('verify-parity: behaviour and a11y are covered by `node --test tests/*.test.ts`, not by this gate');
  process.exit(ok ? 0 : 1);
}

main();
