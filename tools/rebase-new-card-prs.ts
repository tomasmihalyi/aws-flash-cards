/**
 * Auto-resolve the one conflict shape a batch of new-card PRs always
 * produces: content/card-id-ledger.json, when two PRs from the same batch
 * both append a new id and the first one merges before the second.
 *
 * WHY THIS IS SAFE TO AUTOMATE RATHER THAN A GENERIC CONFLICT RESOLVER
 *
 * Every new-card PR's diff on the ledger is EXACTLY one line inserted into
 * a sorted, append-only JSON array (saveIdLedger() always re-sorts before
 * writing — see src/lib/store.ts). Two such diffs can only conflict by both
 * inserting near the same point, and the correct resolution is always the
 * UNION of both insertions, re-sorted — never a judgement call, never a
 * "which one wins". That is a mechanical fact about this file's shape, not
 * a general git-conflict solver, which is why this tool only ever touches
 * ONE file and refuses outright if a conflict appears anywhere else.
 *
 * Confirmed by hand twice in one session (2026-08-20): PR #27 and #28 both
 * conflicted on the ledger after PR #26 merged first, from the SAME
 * draft-new-cards-batch.yml run. Every batch of >=2 same-prefix gaps
 * reproduces this, so it is worth automating rather than a recurring manual
 * `git rebase` + hand-edit each time.
 *
 * WHAT THIS NEVER DOES
 *
 * - Never merges anything itself. It rebases a PR's branch, resolves ONLY
 *   the ledger conflict, force-pushes the SAME branch, and stops — the PR
 *   still needs its own human review and merge, exactly as before.
 * - Never touches a PR whose conflict involves any file other than the
 *   ledger — if cards/<ID>.json itself conflicts (which should not happen,
 *   since every card gets its own unique filename) or any other file does,
 *   this tool aborts that PR's rebase and reports it for a human to resolve
 *   by hand rather than guessing.
 * - Never force-pushes over a branch it did not just rebase in this same
 *   run — no blind `--force`, always `--force-with-lease`.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from '../src/lib/store.ts';

const LEDGER_PATH = join(ROOT, 'content', 'card-id-ledger.json');
const LEDGER_REL = 'content/card-id-ledger.json';
const PR_HEAD_PREFIX = 'new-card/';

type LedgerFile = { comment: string; issued: string[] };

function run(cmd: string, args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, output };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ''}\n${err.stderr ?? ''}` };
  }
}

function gh(args: string[]): { ok: boolean; output: string } {
  return run('gh', args);
}

function git(args: string[]): { ok: boolean; output: string } {
  return run('git', args);
}

type OpenPr = { number: number; headRefName: string; mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' };

export function listOpenNewCardPrs(repo: string): OpenPr[] {
  const raw = gh(['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,headRefName,mergeable']);
  if (!raw.ok) throw new Error(`gh pr list failed: ${raw.output}`);
  const all = JSON.parse(raw.output) as OpenPr[];
  return all.filter((p) => p.headRefName.startsWith(PR_HEAD_PREFIX));
}

/**
 * Union two id arrays and re-sort, exactly matching saveIdLedger()'s own
 * convention (src/lib/store.ts: `[...new Set([...existing, ...current])].sort()`).
 * Pure and independently testable — the one piece of logic in this tool that
 * is not "shell out to git".
 */
export function mergeLedgerIssued(ours: string[], theirs: string[]): string[] {
  return [...new Set([...ours, ...theirs])].sort();
}

/** True only when the ONLY conflicted path is the ledger — refuses anything broader. */
export function isLedgerOnlyConflict(conflictedPaths: string[]): boolean {
  return conflictedPaths.length === 1 && conflictedPaths[0] === LEDGER_REL;
}

type Outcome = { pr: number; branch: string; status: 'rebased' | 'clean' | 'skipped' | 'errored'; detail: string };

function conflictedPaths(): string[] {
  const diff = git(['diff', '--name-only', '--diff-filter=U']);
  return diff.output.split('\n').map((l) => l.trim()).filter(Boolean);
}

function rebaseOnePr(repo: string, pr: OpenPr): Outcome {
  if (pr.mergeable !== 'CONFLICTING') {
    return { pr: pr.number, branch: pr.headRefName, status: 'clean', detail: 'already mergeable, nothing to do' };
  }

  const checkout = git(['checkout', pr.headRefName]);
  if (!checkout.ok) return { pr: pr.number, branch: pr.headRefName, status: 'errored', detail: `checkout failed: ${checkout.output}` };

  git(['fetch', 'origin', 'main']);
  const rebase = git(['rebase', 'origin/main']);
  if (rebase.ok) {
    // Rebased with no conflict at all (e.g. it was CONFLICTING against a
    // stale local view but the real diff no longer overlaps) — nothing to
    // resolve, just push the now-current branch.
    const push = git(['push', 'origin', `HEAD:${pr.headRefName}`, '--force-with-lease']);
    if (!push.ok) return { pr: pr.number, branch: pr.headRefName, status: 'errored', detail: `push failed: ${push.output}` };
    return { pr: pr.number, branch: pr.headRefName, status: 'rebased', detail: 'rebased clean, no conflict markers to resolve' };
  }

  const paths = conflictedPaths();
  if (!isLedgerOnlyConflict(paths)) {
    git(['rebase', '--abort']);
    return {
      pr: pr.number,
      branch: pr.headRefName,
      status: 'skipped',
      detail: `conflict touches ${paths.join(', ') || 'an unknown path'}, not only the ledger — needs a human to resolve`,
    };
  }

  if (!existsSync(LEDGER_PATH)) {
    git(['rebase', '--abort']);
    return { pr: pr.number, branch: pr.headRefName, status: 'errored', detail: 'ledger path missing mid-rebase — aborted' };
  }

  // Both sides of the conflict are present in the working tree via git's own
  // conflict markers, but the reliable way to read "ours" and "theirs" is
  // `git show`, not scraping markers out of the file — markers are for a
  // human diff, not a parser.
  const oursRaw = git(['show', `HEAD:${LEDGER_REL}`]);
  const theirsRaw = git(['show', `origin/main:${LEDGER_REL}`]);
  if (!oursRaw.ok || !theirsRaw.ok) {
    git(['rebase', '--abort']);
    return { pr: pr.number, branch: pr.headRefName, status: 'errored', detail: 'could not read both sides of the ledger conflict — aborted' };
  }

  let ours: LedgerFile;
  let theirs: LedgerFile;
  try {
    ours = JSON.parse(oursRaw.output);
    theirs = JSON.parse(theirsRaw.output);
  } catch {
    git(['rebase', '--abort']);
    return { pr: pr.number, branch: pr.headRefName, status: 'errored', detail: 'one side of the ledger conflict is not valid JSON — aborted' };
  }

  const merged: LedgerFile = { ...theirs, issued: mergeLedgerIssued(ours.issued, theirs.issued) };
  writeFileSync(LEDGER_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

  const add = git(['add', LEDGER_REL]);
  if (!add.ok) {
    git(['rebase', '--abort']);
    return { pr: pr.number, branch: pr.headRefName, status: 'errored', detail: `git add failed: ${add.output}` };
  }
  const cont = git(['rebase', '--continue']);
  if (!cont.ok) {
    git(['rebase', '--abort']);
    return { pr: pr.number, branch: pr.headRefName, status: 'errored', detail: `rebase --continue failed: ${cont.output}` };
  }

  const push = git(['push', 'origin', `HEAD:${pr.headRefName}`, '--force-with-lease']);
  if (!push.ok) return { pr: pr.number, branch: pr.headRefName, status: 'errored', detail: `push failed: ${push.output}` };

  return { pr: pr.number, branch: pr.headRefName, status: 'rebased', detail: `resolved ledger conflict (${merged.issued.length} ids), pushed` };
}

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main(): void {
  const repo = argOf('--repo') ?? 'tomasmihalyi/aws-flash-cards';
  const startBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).output.trim();

  const prs = listOpenNewCardPrs(repo);
  const conflicting = prs.filter((p) => p.mergeable === 'CONFLICTING');

  if (!conflicting.length) {
    console.log(`rebase-new-card-prs: ${prs.length} open new-card PR(s), 0 conflicting — nothing to do`);
    process.exit(0);
  }

  console.log(`rebase-new-card-prs: ${conflicting.length} of ${prs.length} open new-card PR(s) are conflicting — rebasing one at a time`);

  const outcomes: Outcome[] = [];
  for (const pr of conflicting) {
    console.log(`\n=== PR #${pr.number} (${pr.headRefName}) ===`);
    outcomes.push(rebaseOnePr(repo, pr));
  }

  git(['checkout', startBranch]);

  console.log('\n--- summary ---');
  for (const o of outcomes) console.log(`  PR #${o.pr} (${o.branch}): ${o.status} — ${o.detail}`);

  const errored = outcomes.filter((o) => o.status === 'errored');
  const skipped = outcomes.filter((o) => o.status === 'skipped');
  if (skipped.length) console.log(`\n${skipped.length} PR(s) need a human to resolve — conflict was not ledger-only.`);
  if (errored.length) process.exit(1);
}

if (import.meta.filename === process.argv[1]) main();
