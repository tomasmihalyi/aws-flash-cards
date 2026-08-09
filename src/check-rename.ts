/**
 * check-rename — has the thing a card describes been renamed?
 *
 * Reports candidates and says plainly which ones are corroborated by a second
 * independent source. Only corroborated ones are safe to apply, and
 * src/ingest/apply-rename.ts refuses the rest.
 *
 * Usage:
 *   node src/check-rename.ts              # every card with a candidate
 *   node src/check-rename.ts --confident  # only the corroborated ones
 *   node src/check-rename.ts --strict     # exit non-zero if any card has drifted
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCards, paths } from './lib/store.ts';
import { datedEntriesFrom } from './lib/verifier.ts';
import { detectAllRenames } from './lib/rename.ts';
import type { FactSet } from './lib/types.ts';

const confidentOnly = process.argv.includes('--confident');
const strict = process.argv.includes('--strict');
const only = (() => {
  const i = process.argv.indexOf('--card');
  return i >= 0 ? process.argv[i + 1] : null;
})();

function factSets(): FactSet[] {
  if (!existsSync(paths.facts)) return [];
  return readdirSync(paths.facts)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(paths.facts, f), 'utf8')) as FactSet);
}

function main(): void {
  const sets = factSets();
  const entries = datedEntriesFrom(sets);
  if (!entries.length) {
    console.error('check-rename: no dated source in facts/ — run node src/ingest/docs-release-notes.ts first');
    process.exit(1);
  }

  let cards = loadCards().sort((a, b) => a.card_id.localeCompare(b.card_id));
  if (only) cards = cards.filter((c) => c.card_id === only.toUpperCase());

  const findings = detectAllRenames(cards, entries, sets);
  const withCandidate = findings.filter((f) => f.candidate);
  const confident = withCandidate.filter((f) => f.confident);
  const unconfirmed = withCandidate.filter((f) => !f.confident);

  if (confident.length) {
    console.log('\n=== RENAMED, CORROBORATED BY A SECOND SOURCE (safe to apply) ===');
    for (const f of confident) {
      const c = f.candidate!;
      console.log(`\n  ${f.card_id}  "${f.card_title}"  \u2192  "${c.new_name}"`);
      console.log(`     ${c.month_label} \u2014 ${c.heading}`);
      console.log(`     matched on: ${c.matched.join(', ')}`);
      if (c.namespace) {
        console.log(`     namespace mentioned: ${c.namespace}  (recorded only \u2014 the card's service key is not repointed)`);
      }
      for (const co of f.corroboration) {
        console.log(`     corroborated by ${co.fact_set_id}: \u201c\u2026${co.quote}\u2026\u201d`);
      }
      if (f.stale_prose.length) {
        console.log(`     prose still using the old name (needs Tier C): ${f.stale_prose.join(', ')}`);
      }
    }
  }

  if (unconfirmed.length && !confidentOnly) {
    console.log('\n=== CANDIDATE, NOT CORROBORATED (reported, never applied) ===');
    for (const f of unconfirmed) {
      const c = f.candidate!;
      console.log(`\n  ${f.card_id}  "${f.card_title}"  ?\u2192  "${c.new_name}"`);
      console.log(`     ${c.month_label} \u2014 ${c.heading}`);
      console.log(`     ${f.reason}`);
    }
  }

  console.log('\n' + '\u2500'.repeat(67));
  console.log(`check-rename: ${cards.length} card(s) against ${entries.length} dated entries`);
  console.log(`  corroborated       ${confident.length}`);
  console.log(`  candidate only     ${unconfirmed.length}  (a single source's phrasing is not a rename)`);
  console.log(`  no rename signal   ${findings.length - withCandidate.length}`);
  console.log('\u2500'.repeat(67));

  if (strict && confident.length) {
    console.error('check-rename: --strict and a corroborated rename is unapplied. Run node src/ingest/apply-rename.ts');
    process.exit(1);
  }
}

main();
