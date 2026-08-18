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
import { detectCoverage, coverageSummary, type IgnoreEntry, type CoverageFinding } from './lib/coverage.ts';
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
 *
 * `vendor-changelog` — Kiro. Added because a single-source corpus made this whole
 * detector blind to four of the five services in scope: AgentCore had release
 * notes, and a Kiro release could not be noticed at all. Its feed is curated,
 * day-precision and classified by the vendor, so it passes the test above.
 *
 * WHY `github-releases` IS NOT HERE, having been measured rather than assumed
 *
 * Strands has no curated changelog — strandsagents.com carries no changelog path
 * and the repo has no CHANGELOG.md (both 404). The only dated surface is the
 * GitHub releases feed, and it fails the announcement test twice over: every
 * entry's title is a version tag ("typescript/v1.12.0"), which contains no
 * subject a card could ever be matched against, and the body is explicitly
 * "auto-drafted from commits, grouped by conventional-commit type" — 40-odd
 * `feat(middleware): …` lines per release.
 *
 * Admitting it would reproduce the Bedrock doc-history mistake exactly: a large
 * number of rows, none of them a thing a human would write a flashcard about.
 * It is ingested and IS available to the verifier for dating a version claim; it
 * simply is not news. When a curated Strands changelog appears, add its kind here
 * rather than reclassifying this one.
 */
const NEWS_KINDS = new Set(['aws-docs-release-notes', 'vendor-changelog']);

/**
 * docs-whats-new.ts also produces day-precision, per-item announcements —
 * the same SHAPE as the doc-history sources, but curated news rather than a
 * documentation changelog (see that file's header for the admission
 * reasoning). It reuses the 'aws-docs-doc-history' source.kind because the
 * data shape genuinely is identical (evidence.canonical rows with iso_date +
 * heading + summary + url), which is what datedEntriesFrom() actually keys
 * on. But that kind ALSO covers bedrock.doc-history — precisely the noisy
 * source the original NEWS_KINDS comment excludes (261 false gaps out of
 * 366, measured). Discriminating by generator rather than kind keeps that
 * exclusion intact while admitting the new source.
 */
const WHATS_NEW_GENERATOR = 'src/ingest/docs-whats-new.ts';

export function newsSets(sets: FactSet[]): FactSet[] {
  return sets.filter((s) => NEWS_KINDS.has(s.source.kind) || s.generator === WHATS_NEW_GENERATOR);
}

export type ServiceScope = { service: string; depth: 'comprehensive' | 'boundary' };

export function loadServiceScope(): ServiceScope[] {
  const p = join(paths.content, 'service-scope.json');
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  return Array.isArray(raw?.services) ? raw.services : [];
}

/**
 * A 'boundary' service (Quick, today) is deliberately covered only for one
 * question, not tracked comprehensively. An uncovered entry there is real
 * news, but reporting it as a gap the same way an AgentCore gap is reported
 * would misstate what this deck promises — see content/service-scope.json
 * for the reasoning. Downgrading rather than dropping it: the entry still
 * appears with --all, just not in the actionable queue, so 'we decided not
 * to track this' stays visible rather than silently vanishing.
 *
 * Deliberately does NOT touch a 'covered' finding — a boundary service that
 * already matched a card (even loosely) is a separate, pre-existing matcher
 * question, not this filter's job.
 */
export function applyServiceScope(findings: CoverageFinding[], scopes: ServiceScope[]): CoverageFinding[] {
  const boundaryServices = new Set(scopes.filter((s) => s.depth === 'boundary').map((s) => s.service));
  return findings.map((f) => {
    if (f.status !== 'uncovered' || !f.entry.service || !boundaryServices.has(f.entry.service)) return f;
    return {
      ...f,
      status: 'ignored' as const,
      reason: `${f.entry.service} is covered only for its boundary question (content/service-scope.json), not tracked comprehensively. Feature-level news outside that question is not a gap in this deck's stated scope.`,
    };
  });
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
  const scopes = loadServiceScope();
  const findings = applyServiceScope(detectCoverage(loadCards(), entries, ignore), scopes);
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
