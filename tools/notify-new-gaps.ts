/**
 * Notify on a NEW coverage gap, by email, with zero new infrastructure.
 *
 * WHY A GITHUB ISSUE AND NOT A NEW EMAIL PATH
 *
 * This project already has exactly one approval channel: GitHub's own
 * reply-to-email PR flow (see draft-new-card.yml). Adding SES, SMTP or any
 * mail-sending credential for this one notification would be new
 * infrastructure for a problem GitHub already solves — GitHub emails every
 * watcher the instant an issue is opened or commented on, using the same
 * `github.token` this repo's workflows already carry. So the "email" here
 * is not sent by this tool at all; it is GitHub's own notification, and this
 * tool's only job is deciding WHEN a gap is new enough to deserve one.
 *
 * WHY NOT JUST OPEN A NEW ISSUE PER GAP
 *
 * The daily refresh runs every morning; a gap that appeared yesterday and
 * was not yet drafted would re-trigger every single day, and every renotify
 * is a fresh, unread-feeling email for something already seen. So this tool
 * maintains exactly ONE open tracking issue (title matched exactly, same
 * discipline as content/coverage-ignore.json's exact-heading matching) and
 * only appends a comment — which still emails a watcher — for a heading not
 * already listed in the issue body. A gap that gets drafted and closed
 * (tools/apply-new-card.ts merges, or a human closes the issue by hand) lets
 * a genuinely new report start clean.
 *
 * WHAT THIS NEVER DOES
 *
 * It never drafts, applies, or opens a card PR itself — it only tells a human
 * a gap exists and exactly which `gh workflow run` command would draft it.
 * The one-click trigger from draft-new-card.yml is still the human action;
 * this tool exists only to make sure that click is prompted rather than
 * dependent on someone remembering to read a report.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadCards, paths } from '../src/lib/store.ts';
import { datedEntriesFrom } from '../src/lib/verifier.ts';
import { detectCoverage, type CoverageFinding, type IgnoreEntry } from '../src/lib/coverage.ts';
import { newsSets, loadServiceScope, applyServiceScope } from '../src/check-coverage.ts';
import type { FactSet } from '../src/lib/types.ts';

const TRACKING_ISSUE_TITLE = 'Coverage gaps awaiting a drafting decision';

function factSets(): FactSet[] {
  if (!existsSync(paths.facts)) return [];
  return readdirSync(paths.facts).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(paths.facts, f), 'utf8')) as FactSet);
}

function loadIgnore(): IgnoreEntry[] {
  const p = join(paths.content, 'coverage-ignore.json');
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  return Array.isArray(raw?.entries) ? raw.entries : [];
}

/** The actionable "candidate NEW card" findings — same filter check-coverage.ts --new applies. */
export function newGapFindings(): CoverageFinding[] {
  const sets = factSets();
  const news = newsSets(sets);
  const entries = datedEntriesFrom(news);
  const ignore = loadIgnore();
  const scopes = loadServiceScope();
  const findings = applyServiceScope(detectCoverage(loadCards(), entries, ignore), scopes);
  return findings.filter((f) => f.status === 'uncovered' && f.significance !== 'minor');
}

/**
 * One line per gap, including the exact command a human runs to draft it.
 *
 * The heading is wrapped in its own fenced block rather than inlined into
 * the shell command's quotes, so a heading containing a double quote (AWS
 * announcement titles do this) can never break out of the command it is
 * embedded in.
 */
export function gapLine(f: CoverageFinding): string {
  // f.entry.service comes from the FACT SET's own file prefix (which feed the
  // entry was fetched into), not from re-reading the entry's own text — so an
  // AgentCore announcement that also mentions "Bedrock" and lands in
  // facts/bedrock.whats-new.json reports service=bedrock here even when a
  // human would call it bedrock-agentcore. This is a pre-existing property of
  // docs-whats-new.ts's classification, not something this tool can correct,
  // which is exactly why draft-new-card.yml's --service input exists: read the
  // heading before trusting the value printed below.
  const service = f.entry.service ? ` --service ${f.entry.service}` : ' --service <see below, none recorded>';
  return [
    `- **${f.entry.heading}** (${f.entry.month_label}, ${f.significance})`,
    '  ```',
    `  gh workflow run draft-new-card.yml -f entry="${f.entry.heading.replace(/"/g, '\\"')}"${service}`,
    '  ```',
  ].join('\n');
}

/** Headings already named in a tracking-issue body, so a rerun only adds what's new. */
export function newHeadings(findings: CoverageFinding[], existingBody: string): CoverageFinding[] {
  return findings.filter((f) => !existingBody.includes(f.entry.heading));
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function findTrackingIssue(): { number: number; body: string } | null {
  const raw = gh(['issue', 'list', '--state', 'open', '--search', `"${TRACKING_ISSUE_TITLE}" in:title`, '--json', 'number,title,body']);
  const issues = JSON.parse(raw) as { number: number; title: string; body: string }[];
  const exact = issues.find((i) => i.title === TRACKING_ISSUE_TITLE);
  return exact ? { number: exact.number, body: exact.body } : null;
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const findings = newGapFindings();

  if (!findings.length) {
    console.log('notify-new-gaps: no actionable new-card gaps — nothing to notify');
    process.exit(0);
  }

  const existing = dryRun ? null : findTrackingIssue();
  const toReport = existing ? newHeadings(findings, existing.body) : findings;

  if (!toReport.length) {
    console.log(`notify-new-gaps: ${findings.length} gap(s) exist, all already on issue #${existing?.number} — nothing new to notify`);
    process.exit(0);
  }

  const intro = existing
    ? `${toReport.length} new gap(s) since this issue was last updated:`
    : `${toReport.length} coverage gap(s) found — each is a candidate for a new card. ` +
      'Pick one and run its command (or via the Actions tab: draft-new-card.yml), which opens a ' +
      'PR you approve by replying to GitHub\'s own review-request email. Nothing merges without that reply.';

  const body = [intro, '', ...toReport.map(gapLine)].join('\n');

  console.log(`notify-new-gaps: ${toReport.length} new gap(s) to report`);
  console.log(body);

  if (dryRun) {
    console.log('\nnotify-new-gaps: dry run, nothing posted to GitHub');
    process.exit(0);
  }

  if (existing) {
    gh(['issue', 'comment', String(existing.number), '--body', body]);
    console.log(`notify-new-gaps: commented on existing issue #${existing.number}`);
  } else {
    const out = gh(['issue', 'create', '--title', TRACKING_ISSUE_TITLE, '--body', body]);
    console.log(`notify-new-gaps: opened tracking issue — ${out.trim()}`);
  }
}

if (import.meta.filename === process.argv[1]) main();
