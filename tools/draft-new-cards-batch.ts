/**
 * Draft the top-N pending coverage gaps in ONE workflow_dispatch click,
 * instead of one click per gap.
 *
 * WHY THIS EXISTS, GIVEN draft-new-card.yml ALREADY DOES ONE GAP PER CLICK
 *
 * That workflow was deliberately single-gap ("no draft-everything mode... one
 * gap at a time" — src/ingest/draft-new-card.ts's own header), so a bad day
 * for AWS's feed could not flood the repo with drafts from one trigger. That
 * reasoning still holds for an UNBOUNDED batch. It does not hold for a
 * BOUNDED one: notify-new-gaps.ts already ranks pending gaps by significance
 * (CoverageFinding.rank, highest first), so "draft the top 3" is not
 * materially riskier than three separate manual clicks in a row — it is the
 * same three clicks, just requested together.
 *
 * WHAT DOES NOT CHANGE
 *
 * - Each gap is still drafted and gated INDEPENDENTLY. One discard/failure
 *   does not sink the others — this loop continues and reports it.
 * - Each accepted draft still becomes its OWN card, its OWN branch, its OWN
 *   PR, requiring its OWN separate human approval. Batching collapses the
 *   TRIGGER, never the review. There is still no accept-and-merge path for a
 *   new card, ever — new-card-gate.ts's NewCardVerdict type still has no
 *   'accept' value.
 * - The default cap is 3, matching this feature's own original design intent
 *   ("bounded number of new-card drafts per run ... top ~3 by significance").
 *   Override with --limit N for a one-off larger batch.
 *
 * WHY EACH GAP'S DRAFT-APPLY-COMMIT CYCLE MUST FULLY COMPLETE BEFORE THE
 * NEXT GAP'S DRAFT STARTS (the bug this design fixes)
 *
 * Card-id allocation (nextCardId() in draft-new-card.ts) reads the id ledger
 * FROM DISK. draft-new-card.ts --write never commits the ledger itself —
 * only apply-new-card.ts does, via saveIdLedger(). An earlier version of
 * this tool drafted ALL gaps first and applied them afterward in a second
 * pass; running two Bedrock gaps back to back in that order allocated BOTH
 * "BR-04" — the ledger genuinely had not moved between the two drafts,
 * because nothing had committed it yet. Caught live: a real 2-gap test run
 * produced drafted_card_ids=BR-04,BR-04. Fixed by making each gap's full
 * cycle (draft -> branch -> apply -> commit -> push -> PR) complete, in
 * that order, before the next gap's draft call reads the ledger.
 *
 * This tool therefore owns the git branch/commit/push/PR step itself (via
 * execFileSync calls to git and gh), rather than deferring it to the
 * workflow YAML's own loop — the ordering guarantee above is easiest to keep
 * correct in one place, in code, with tests, rather than split across a TS
 * tool and a shell loop that has to be kept in lockstep with it.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from '../src/lib/store.ts';
import { newGapFindings } from './notify-new-gaps.ts';

const DEFAULT_LIMIT = 3;
const REVIEWER = 'tomasmihalyi';

type BatchOutcome = { heading: string; status: 'pr-opened' | 'discarded' | 'errored'; detail: string };

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function run(cmd: string, args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, output };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ''}\n${err.stderr ?? ''}` };
  }
}

function git(args: string[]): { ok: boolean; output: string } {
  return run('git', args);
}

/**
 * Extract the card id from draft-new-card.ts's own "wrote <path>" log line.
 *
 * Never scan drafts/ for a matching *.new-card.json file instead: this tool
 * runs the drafter SEQUENTIALLY over multiple gaps into the same drafts/
 * directory, so a directory scan could match a stale artifact left by an
 * earlier gap in this same batch, or an unrelated leftover from a prior
 * manual run. The drafter's own log line is the one place that names
 * exactly what IT just wrote, this call, nothing else's.
 */
export function cardIdFromDraftOutput(output: string): string | null {
  const m = output.match(/draft-new-card: wrote .*[\\/](\S+)\.new-card\.json/);
  return m?.[1] ?? null;
}

/** The one gap, start to finish: draft -> branch -> apply -> commit -> push -> PR. */
function processOneGap(
  heading: string,
  service: string | null,
  opts: { region?: string; runId: string; skipPr: boolean },
): BatchOutcome {
  const draftArgs = ['src/ingest/draft-new-card.ts', '--entry', heading, '--write'];
  if (service) draftArgs.push('--service', service);
  if (opts.region) draftArgs.push('--region', opts.region);

  const draft = run('node', draftArgs);
  console.log(draft.output);
  if (!draft.ok) {
    return { heading, status: 'errored', detail: 'drafter exited non-zero — see log above' };
  }

  const cardId = cardIdFromDraftOutput(draft.output);
  if (!cardId) {
    // No artifact means the gate returned 'discard' — by design, no PR and no
    // trace beyond the log. Not an error in this tool; a correct refusal.
    return { heading, status: 'discarded', detail: 'no draft artifact produced (discard, or nothing to write)' };
  }

  const branch = `new-card/${cardId}-${opts.runId}`;

  // Always branch from the CURRENT main, not from wherever the previous
  // gap's branch left the working tree — every card's PR must diff cleanly
  // against main alone, same guarantee the single-gap workflow gives.
  const checkoutMain = git(['checkout', 'main', '--quiet']);
  if (!checkoutMain.ok) return { heading, status: 'errored', detail: `git checkout main failed: ${checkoutMain.output}` };
  const branchOut = git(['checkout', '-b', branch]);
  if (!branchOut.ok) return { heading, status: 'errored', detail: `git checkout -b ${branch} failed: ${branchOut.output}` };

  // apply-new-card RE-GATES against current fact sets before writing, and
  // refuses to write on main — same defence the single-gap path has, and the
  // step that actually commits the id ledger, which is why it must complete
  // HERE, before this function returns and the next gap's draft call runs.
  const apply = run('node', ['tools/apply-new-card.ts', '--card', cardId]);
  console.log(apply.output);
  if (!apply.ok) {
    git(['checkout', 'main', '--quiet']);
    git(['branch', '-D', branch]);
    return { heading, status: 'errored', detail: `apply-new-card failed for ${cardId} — see log above` };
  }

  if (opts.skipPr) {
    // Test/dry-run path: leave the drafted card + ledger update as
    // UNCOMMITTED changes on this gap's branch (never committed, never
    // pushed, no PR). Caller is responsible for inspecting/discarding them.
    return { heading, status: 'pr-opened', detail: `${cardId} (--skip-pr: left uncommitted on ${branch}, not pushed)` };
  }

  const prBody = join(ROOT, 'drafts', `${cardId}.pr.md`);
  const add = git(['add', 'cards', 'content/card-id-ledger.json']);
  if (!add.ok) return { heading, status: 'errored', detail: `git add failed: ${add.output}` };
  const commit = git([
    'commit',
    '-m', `feat(${cardId}): new card drafted from coverage gap, Tier C pending review`,
    '-m', readFileSync(prBody, 'utf8'),
  ]);
  if (!commit.ok) return { heading, status: 'errored', detail: `git commit failed: ${commit.output}` };
  const push = git(['push', 'origin', branch]);
  if (!push.ok) return { heading, status: 'errored', detail: `git push failed: ${push.output}` };

  const pr = run('gh', [
    'pr', 'create',
    '--title', `New card: ${cardId} (Tier C — needs review, never auto-merged)`,
    '--body-file', prBody,
    '--head', branch,
    '--base', 'main',
    '--reviewer', REVIEWER,
  ]);
  if (!pr.ok) return { heading, status: 'errored', detail: `gh pr create failed: ${pr.output}` };

  // NO gh pr merge --auto — same reasoning as draft-new-card.yml: main has no
  // branch protection on this personal repo (the only bypass mechanism is a
  // stored PAT, which this project's OIDC-only design deliberately avoids),
  // so --auto would merge immediately with nothing to wait on. Reply-to-
  // email approval, then a manual merge click, same as the single-gap path.
  return { heading, status: 'pr-opened', detail: `${cardId} — ${pr.output.trim()}` };
}

function main(): void {
  const limit = Number(argOf('--limit') ?? DEFAULT_LIMIT);
  const region = argOf('--region');
  const dryRun = process.argv.includes('--dry-run');
  const skipPr = process.argv.includes('--skip-pr'); // draft+apply+commit locally, never push/PR — for manual verification
  const runId = argOf('--run-id') ?? String(Date.now());

  const allPending = newGapFindings();
  const findings = allPending.slice(0, limit);

  if (!findings.length) {
    console.log('draft-new-cards-batch: no actionable gaps — nothing to draft');
    process.exit(0);
  }

  console.log(`draft-new-cards-batch: drafting the top ${findings.length} of ${allPending.length} pending gap(s) (--limit ${limit})`);
  for (const f of findings) console.log(`  - ${f.entry.heading} (${f.significance})`);
  console.log('');

  if (dryRun) {
    console.log('draft-new-cards-batch: dry run, nothing drafted');
    process.exit(0);
  }

  const startBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).output.trim();
  if (startBranch !== 'main' && !skipPr) {
    console.error(`draft-new-cards-batch: refusing to run from "${startBranch}" — this tool checks out main itself and expects to start there (CI always does; a local run should too, or pass --skip-pr for a dry local test).`);
    process.exit(2);
  }

  const outcomes: BatchOutcome[] = [];
  for (const f of findings) {
    console.log(`\n=== ${f.entry.heading} ===`);
    outcomes.push(processOneGap(f.entry.heading, f.entry.service, { region, runId, skipPr }));
  }

  console.log('\n--- batch summary ---');
  for (const o of outcomes) console.log(`  ${o.status.padEnd(10)} ${o.heading}${o.detail ? ` (${o.detail})` : ''}`);

  const opened = outcomes.filter((o) => o.status === 'pr-opened').length;
  const errored = outcomes.filter((o) => o.status === 'errored').length;
  console.log(`\n${opened} PR(s) opened, ${errored} card(s) errored, ${outcomes.length - opened - errored} discarded`);

  // A discard is a correct, deliberate outcome for THIS gap — it never fails
  // the batch. The whole batch exits non-zero only if EVERY gap failed to
  // become a PR (all errored), mirroring the single-gap workflow's "a discard
  // fails the job" behaviour scaled to "a batch where nothing landed fails".
  if (opened === 0 && errored > 0) process.exit(1);
}

if (import.meta.filename === process.argv[1]) main();
