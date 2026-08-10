/**
 * check-coverage — what has AWS published that the deck does not cover?
 *
 * The half of "self-maintaining" that every other gate misses. verify-claims,
 * check-lifecycle and check-rename all keep EXISTING cards correct; none of them
 * can see that something was published and never written about.
 *
 * Reports, never fails. A missing card is a to-do, not a defect — the deck is
 * curated on purpose. `--strict` exists for a cron that wants a non-zero exit when
 * something actionable appears, and even then it is opt-in.
 *
 * Usage:
 *   node src/check-coverage.ts                 # ranked actionable queue
 *   node src/check-coverage.ts --all           # include covered and ignored
 *   node src/check-coverage.ts --new           # candidate NEW cards only
 *   node src/check-coverage.ts --stale         # candidate card UPDATES only
 *   node src/check-coverage.ts --limit 5
 *   node src/check-coverage.ts --strict        # exit 1 if anything is actionable
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCards, paths } from './lib/store.ts';
import { datedEntriesFrom } from './lib/verifier.ts';
import { detectCoverage, coverageSummary, type IgnoreEntry } from './lib/coverage.ts';
import type { FactSet } from './lib/types.ts';

const showAll = process.argv.includes('--all');
const onlyNew = process.argv.includes('--new');
const onlyStale = process.argv.includes('--stale');
const strict = process.argv.includes('--strict');
const limit = (() => {
  const i = process.argv.indexOf('--limit');
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : 12;
})();

function factSets(): FactSet[] {
  if (!existsSync(paths.facts)) return [];
  return readdirSync(paths.facts)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(paths.facts, f), 'utf8')) as FactSet);
}

/**
 * The sources that are a PRODUCT NEWS FEED for this deck's scope.
 *
 * Not every dated source is a content source. The Bedrock document history was
 * ingested to verify DATES — it carries 264 entries about model additions, quota
 * wording and Data Automation, most of which are out of the deck's stated scope
 * (requirements.md §4) and none of which is AgentCore product news.
 *
 * Measured before restricting: including it produced 261 "uncovered" entries out
 * of 366, which is not a to-do list, it is noise wearing a to-do list's clothes.
 * A coverage report nobody reads is worth less than none.
 *
 * Release notes are the AgentCore product feed. Add a source here only when it is
 * genuinely "things that were announced", not "things that changed on a page".
 */
const NEWS_KINDS = new Set(['aws-docs-release-notes']);

function newsSets(sets: FactSet[]): FactSet[] {
  return sets.filter((s) => NEWS_KINDS.has(s.source.kind));
}

function loadIgnore(): IgnoreEntry[] {
  const p = join(paths.content, 'coverage-ignore.json');
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  return Array.isArray(raw?.entries) ? raw.entries : [];
}

function main(): void {
  const all = factSets();
  const news = newsSets(all);
  const entries = datedEntriesFrom(news);
  if (!entries.length) {
    console.error('check-coverage: no product-news source in facts/ — run node src/ingest/docs-release-notes.ts first');
    process.exit(1);
  }

  const ignore = loadIgnore();
  const findings = detectCoverage(loadCards(), entries, ignore);
  const s = coverageSummary(findings);

  const wanted = findings.filter((f) => {
    if (showAll) return true;
    if (onlyNew) return f.status === 'uncovered' && f.significance !== 'minor';
    if (onlyStale) return f.status === 'stale' && f.significance !== 'minor';
    return (f.status === 'uncovered' || f.status === 'stale') && f.significance !== 'minor';
  });

  const heading = onlyNew
    ? 'CANDIDATE NEW CARDS'
    : onlyStale
      ? 'CANDIDATE CARD UPDATES'
      : showAll
        ? 'EVERY DATED ENTRY'
        : 'ACTIONABLE — ranked by significance, then recency';

  console.log(`\n=== ${heading} ===`);
  if (!wanted.length) {
    console.log('  nothing actionable — every significant entry is covered or deliberately ignored');
  }
  for (const f of wanted.slice(0, limit)) {
    const tag =
      f.status === 'uncovered' ? 'NEW ' : f.status === 'stale' ? 'STALE' : f.status === 'ignored' ? 'SKIP' : 'OK  ';
    console.log(`\n  ${tag} [${f.entry.month_label}] ${f.significance.toUpperCase()}`);
    console.log(`       ${f.entry.heading}`);
    console.log(`       ${f.reason}`);
    if (f.matches.length) {
      console.log(`       matched: ${f.matches.map((m) => `${m.card_id}(${m.matched.join('+')})`).join(' · ')}`);
    }
  }
  if (wanted.length > limit) {
    console.log(`\n  … +${wanted.length - limit} more (use --limit ${wanted.length})`);
  }

  console.log('\n' + '\u2500'.repeat(67));
  console.log(`check-coverage: ${s.total} product-news entries against ${loadCards().length} cards`);
  console.log(`  sources: ${news.map((n) => n.fact_set_id).join(', ')}  (of ${all.length} fact sets \u2014 date-only sources excluded)`);
  console.log(`  covered            ${s.covered}`);
  console.log(`  candidate NEW      ${s.uncovered}  (no card's subject matches)`);
  console.log(`  candidate UPDATE   ${s.stale}  (a card matches but predates the entry \u2014 UNDER-REPORTS: every applier bumps verified_at, so zero is weak evidence)`);
  console.log(`  unmatchable        ${s.unmatchable}  (bare heading, no distinctive term \u2014 read by hand)`);
  console.log(`  deliberately skipped ${s.ignored}  (content/coverage-ignore.json, each with a reason)`);
  console.log(`  ACTIONABLE         ${s.actionable}  (excludes documentation housekeeping)`);
  console.log('\u2500'.repeat(67));
  console.log('A missing card is a to-do, not a defect. This never fails a build unless --strict.');

  if (strict && s.actionable > 0) {
    console.error(`\ncheck-coverage: --strict and ${s.actionable} actionable item(s)`);
    process.exit(1);
  }
}

if (import.meta.filename === process.argv[1]) main();
