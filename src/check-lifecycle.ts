/**
 * check-lifecycle — does each card's lifecycle still match the dated source?
 *
 * A wrong `preview` badge on a feature that went GA months ago is the same class
 * of error as a wrong region count, but no gate was looking at it because
 * `lifecycle` is a schema field rather than prose.
 *
 * Usage:
 *   node src/check-lifecycle.ts            # every card with a detectable signal
 *   node src/check-lifecycle.ts --drift    # only the mismatches
 *   node src/check-lifecycle.ts --strict   # exit non-zero if any card has drifted
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCards, paths } from './lib/store.ts';
import { datedEntriesFrom } from './lib/verifier.ts';
import { detectAll } from './lib/lifecycle.ts';
import type { FactSet } from './lib/types.ts';

const driftOnly = process.argv.includes('--drift');
const strict = process.argv.includes('--strict');

function factSets(): FactSet[] {
  if (!existsSync(paths.facts)) return [];
  return readdirSync(paths.facts)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(paths.facts, f), 'utf8')) as FactSet);
}

function main(): void {
  const entries = datedEntriesFrom(factSets());
  if (!entries.length) {
    console.error('check-lifecycle: no dated source in facts/ — run node src/ingest/docs-release-notes.ts first');
    process.exit(1);
  }

  const findings = detectAll(loadCards().sort((a, b) => a.card_id.localeCompare(b.card_id)), entries);
  const drifted = findings.filter((f) => f.drift);
  const matched = findings.filter((f) => f.latest && !f.drift);
  const silent = findings.filter((f) => !f.latest);

  if (drifted.length) {
    console.log(`\n=== LIFECYCLE DRIFT (${drifted.length}) — the card disagrees with the dated source ===`);
    for (const f of drifted) {
      console.log(`\n${f.card_id}  card says "${f.card_lifecycle}"`);
      for (const s of f.signals) {
        console.log(`  ${s.iso_month}  ${s.lifecycle.toUpperCase().padEnd(7)} ${s.heading}`);
      }
      console.log(`  → ${f.reason}`);
    }
  }

  if (!driftOnly && matched.length) {
    console.log(`\n=== AGREES WITH THE SOURCE (${matched.length}) ===`);
    for (const f of matched) {
      console.log(`  ${f.card_id}  ${f.card_lifecycle}  ←  ${f.latest!.month_label} "${f.latest!.heading}"`);
    }
  }

  console.log('\n' + '─'.repeat(67));
  console.log(`check-lifecycle: ${findings.length} cards against ${entries.length} dated entries`);
  console.log(`  drifted            ${drifted.length}${drifted.length ? '  ' + drifted.map((d) => d.card_id).join(' ') : ''}`);
  console.log(`  confirmed correct  ${matched.length}`);
  console.log(`  no signal found    ${silent.length}  (nothing in the source names these cards)`);
  console.log('─'.repeat(67));

  if (strict && drifted.length) {
    console.error(`\ncheck-lifecycle: --strict and ${drifted.length} card(s) have drifted`);
    process.exit(1);
  }
}

main();
