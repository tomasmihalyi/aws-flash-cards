/**
 * Classify what a refresh actually did — the outcome branch, as a testable unit.
 *
 * Run AFTER `npm run refresh && npm run check`. It compares the working tree
 * against HEAD and answers the one question a scheduled job has to answer before
 * it is allowed to write anything: did the DECK change, or did we merely look
 * again?
 *
 * WHY THIS EXISTS, AND WHY IT MATTERS MORE ON A DAILY SCHEDULE
 *
 * Every ingest stamps `fetched_at`, and `apply` rewrites `verified_at` on any card
 * it re-verified — so after a refresh where nothing whatsoever moved, `git status`
 * is dirty. Both facts/ and cards/ carry new timestamps.
 *
 * A job that treats "dirty" as "commit" therefore produces one empty commit per
 * run. Weekly that is 52 a year and merely untidy. DAILY it is 365, the history
 * becomes unreadable, and the signal that matters — a price moved, a badge went
 * stale — is buried in noise. So the distinction is not cosmetic; it is what makes
 * a daily cadence viable at all.
 *
 * FOUR OUTCOMES, AND THE MIDDLE TWO ARE THE INTERESTING ONES
 *
 *   NO_CHANGE       nothing on disk differs from HEAD. Nothing to do.
 *   FRESHNESS_ONLY  only timestamps moved. Every content_hash and every rendered
 *                   slot is identical. The deck is not wrong and it is not newer —
 *                   it has been re-checked, which is worth recording but is NOT a
 *                   content change.
 *   TIER_A          a deterministic source disagreed with a card and corrected it.
 *                   No judgement involved, no model involved: safe to commit
 *                   unattended, because the gate has already refused anything
 *                   uncited and the correction carries a before/after entry.
 *   NEEDS_REVIEW    something wants a human — a Tier C prose rewrite, a rename, a
 *                   lifecycle flag. This must NEVER be auto-committed. A pipeline
 *                   may correct a number by itself; it may not publish a
 *                   judgement.
 *
 * Deliberately NOT a gate: it always exits 0 unless it cannot do its job. Failing
 * a build is `npm run check`'s role, and conflating the two would mean a day with
 * a legitimate correction looked like a broken pipeline.
 *
 * Usage:
 *   node tools/refresh-outcome.ts            # human summary
 *   node tools/refresh-outcome.ts --json     # machine-readable, for CI
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Card, FactSet, HistoryEntry } from '../src/lib/types.ts';

const REPO = process.cwd();
const asJson = process.argv.includes('--json');

export type Outcome = 'NO_CHANGE' | 'FRESHNESS_ONLY' | 'TIER_A' | 'NEEDS_REVIEW';

export type CardChange = {
  card_id: string;
  /** slot name → before/after rendered text, only where the TEXT differs */
  slots: { slot: string; before: string; after: string }[];
  /** provenance entries present in the working tree and absent from HEAD */
  newHistory: HistoryEntry[];
  /** did needs_review flip false → true in this run? */
  reviewRaised: boolean;
  reviewReasons: string[];
  /** card fields (lifecycle, badge_text) corrected by an applier */
  fields: { field: string; before: string; after: string }[];
};

export type FactChange = {
  fact_set_id: string;
  before_hash: string;
  after_hash: string;
};

export type Classification = {
  outcome: Outcome;
  cards: CardChange[];
  facts: FactChange[];
  /** paths dirty in git but carrying no semantic change */
  freshnessOnlyPaths: string[];
  summary: string;
  commitSubject: string;
  commitBody: string;
};

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** File content at HEAD, or null when the path is new. */
function atHead(path: string): string | null {
  try {
    return git(['show', `HEAD:${path}`]);
  } catch {
    return null;
  }
}

function changedPaths(): string[] {
  // --porcelain is stable across git versions; the first three chars are status.
  return git(['status', '--porcelain', '--', 'cards', 'facts', 'content'])
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

/**
 * Compare two provenance ledgers and return the entries only the second has.
 *
 * Matched on the whole entry rather than on `at`, because two entries can share a
 * timestamp within one run — every applier stamps the same `now`.
 */
function newEntries(before: HistoryEntry[], after: HistoryEntry[]): HistoryEntry[] {
  const seen = new Map<string, number>();
  for (const e of before) {
    const k = JSON.stringify(e);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const out: HistoryEntry[] = [];
  for (const e of after) {
    const k = JSON.stringify(e);
    const n = seen.get(k) ?? 0;
    if (n > 0) seen.set(k, n - 1);
    else out.push(e);
  }
  return out;
}

/**
 * The pure comparison — exported so the decision logic is testable without a
 * git repo, a network call or a filesystem. Everything above this line is I/O.
 */
export function diffCard(before: Card, after: Card): CardChange | null {
  const slots: CardChange['slots'] = [];
  for (const [name, slot] of Object.entries(after.slots ?? {})) {
    const prev = before.slots?.[name];
    if (!prev) {
      slots.push({ slot: name, before: '(new slot)', after: slot.rendered });
      continue;
    }
    // ONLY the rendered text. rendered_from and the seed are provenance, and a
    // seed→tier-a promotion with identical text is not a content change.
    if (prev.rendered !== slot.rendered) {
      slots.push({ slot: name, before: prev.rendered, after: slot.rendered });
    }
  }

  const fields: CardChange['fields'] = [];
  for (const f of ['lifecycle', 'badge_text', 'badge_variant', 'title'] as const) {
    if (before[f] !== after[f]) fields.push({ field: f, before: String(before[f]), after: String(after[f]) });
  }

  const newHistory = newEntries(before.provenance?.history ?? [], after.provenance?.history ?? []);
  const reviewRaised = !before.needs_review && after.needs_review;

  if (!slots.length && !fields.length && !reviewRaised && !newHistory.some((e) => e.action !== 'verify')) {
    return null; // freshness only
  }
  return {
    card_id: after.card_id,
    slots,
    newHistory,
    reviewRaised,
    reviewReasons: after.review_reasons.map((r) => r.reason),
    fields,
  };
}

/** Did a fact set's SOURCE say something different, or was it merely re-fetched? */
export function diffFact(before: FactSet, after: FactSet): FactChange | null {
  // content_hash is taken over the PARSED payload, so an unchanged hash means the
  // source said the same thing — regardless of fetched_at moving.
  if (before.source.content_hash === after.source.content_hash) return null;
  return {
    fact_set_id: after.fact_set_id,
    before_hash: before.source.content_hash,
    after_hash: after.source.content_hash,
  };
}

/**
 * The outcome branch itself.
 *
 * Order matters: review beats correction. A run that both corrects a number and
 * raises a review must go to a PR, because the safe half does not license the
 * unsafe half to ride along unattended.
 */
export function decideOutcome(cards: CardChange[], facts: FactChange[], dirtyPaths: number): Outcome {
  const reviewNeeded =
    cards.some((c) => c.reviewRaised) ||
    cards.some((c) => c.newHistory.some((e) => e.tier === 'C' || e.action === 'flag-review' || e.action === 'rename'));
  if (!dirtyPaths) return 'NO_CHANGE';
  if (reviewNeeded) return 'NEEDS_REVIEW';
  if (cards.length || facts.length) return 'TIER_A';
  return 'FRESHNESS_ONLY';
}

function classifyCard(path: string): CardChange | null {
  const headRaw = atHead(path);
  if (!headRaw) {
    // A brand-new card is authored content, never something a refresh produces.
    // Treat it as review-worthy rather than silently committing it.
    const now = JSON.parse(readFileSync(join(REPO, path), 'utf8')) as Card;
    return {
      card_id: now.card_id,
      slots: [],
      newHistory: [],
      reviewRaised: true,
      reviewReasons: [`${now.card_id} is a NEW card — authored content, not a refresh outcome`],
      fields: [],
    };
  }
  return diffCard(JSON.parse(headRaw) as Card, JSON.parse(readFileSync(join(REPO, path), 'utf8')) as Card);
}

function classifyFact(path: string): FactChange | null {
  const headRaw = atHead(path);
  if (!headRaw) {
    const now = JSON.parse(readFileSync(join(REPO, path), 'utf8')) as FactSet;
    return { fact_set_id: now.fact_set_id, before_hash: '(new)', after_hash: now.source.content_hash };
  }
  return diffFact(JSON.parse(headRaw) as FactSet, JSON.parse(readFileSync(join(REPO, path), 'utf8')) as FactSet);
}

export function classify(): Classification {
  const paths = changedPaths();
  const cards: CardChange[] = [];
  const facts: FactChange[] = [];
  const freshnessOnlyPaths: string[] = [];

  for (const p of paths) {
    if (p.startsWith('cards/') && p.endsWith('.json')) {
      const c = classifyCard(p);
      if (c) cards.push(c);
      else freshnessOnlyPaths.push(p);
    } else if (p.startsWith('facts/') && p.endsWith('.json')) {
      const f = classifyFact(p);
      if (f) facts.push(f);
      else freshnessOnlyPaths.push(p);
    } else {
      // content/ — the taxonomy or the ignore list. Curated by hand, so a refresh
      // changing one is unexpected and belongs in front of a human.
      cards.push({
        card_id: p,
        slots: [],
        newHistory: [],
        reviewRaised: true,
        reviewReasons: [`${p} changed — curated content is not a refresh outcome`],
        fields: [],
      });
    }
  }

  const outcome: Outcome = decideOutcome(cards, facts, paths.length);

  /**
   * Count corrections from the PROVENANCE LEDGER, not from the slot text diff.
   *
   * Those two can legitimately disagree. If a card on disk drifts and a refresh
   * corrects it back to what HEAD already said, there is no text diff against
   * HEAD — yet a correction genuinely happened and is recorded. Counting only
   * text diffs reported "TIER_A · 0 corrections", which is a self-contradicting
   * sentence and exactly the kind of output that teaches people to stop reading.
   *
   * The ledger is the authoritative record of what an applier did; the text diff
   * is for showing a human what moved relative to the committed deck.
   */
  const correctionCount =
    cards.reduce((n, c) => n + c.newHistory.filter((e) => e.action === 'correct' || e.action === 'rename').length, 0) ||
    cards.reduce((n, c) => n + c.slots.length + c.fields.length, 0);
  const summary =
    outcome === 'NO_CHANGE'
      ? 'nothing changed on disk'
      : outcome === 'FRESHNESS_ONLY'
        ? `re-verified ${freshnessOnlyPaths.length} file(s); every content_hash and rendered slot identical`
        : outcome === 'TIER_A'
          ? `${correctionCount} deterministic correction(s) across ${cards.length} card(s), ${facts.length} fact set(s) moved`
          : `${cards.filter((c) => c.reviewRaised).length} card(s) need a human`;

  const lines: string[] = [];
  for (const c of cards) {
    for (const s of c.slots) lines.push(`${c.card_id}.${s.slot}\n  - ${s.before}\n  + ${s.after}`);
    for (const f of c.fields) lines.push(`${c.card_id}.${f.field}: ${f.before} → ${f.after}`);
    for (const r of c.reviewRaised ? c.reviewReasons : []) lines.push(`${c.card_id} NEEDS REVIEW: ${r}`);
  }
  if (facts.length) {
    lines.push('', 'fact sets whose content moved:');
    for (const f of facts) lines.push(`  ${f.fact_set_id}`);
  }

  const commitSubject =
    outcome === 'TIER_A'
      ? `chore(refresh): ${correctionCount} deterministic correction(s)`
      : outcome === 'FRESHNESS_ONLY'
        ? 'chore(refresh): freshness only — sources re-checked, nothing moved'
        : outcome === 'NEEDS_REVIEW'
          ? 'chore(refresh): changes needing review'
          : 'chore(refresh): no change';

  return { outcome, cards, facts, freshnessOnlyPaths, summary, commitSubject, commitBody: lines.join('\n') };
}

function main(): void {
  const c = classify();
  if (asJson) {
    console.log(JSON.stringify(c, null, 2));
    return;
  }
  console.log(`\nrefresh-outcome: ${c.outcome}`);
  console.log(`  ${c.summary}`);
  if (c.freshnessOnlyPaths.length) {
    console.log(`\n  ${c.freshnessOnlyPaths.length} file(s) changed by timestamp only — NOT a content change`);
  }
  if (c.commitBody) console.log(`\n${c.commitBody}`);
  console.log(`\n  suggested subject: ${c.commitSubject}`);
  if (c.outcome === 'NEEDS_REVIEW') {
    console.log('\n  → open a PR. A pipeline may correct a number by itself; it may not publish a judgement.');
  }
}

if (import.meta.filename === process.argv[1]) main();
