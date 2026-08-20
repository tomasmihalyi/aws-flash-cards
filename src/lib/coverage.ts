/**
 * Coverage detection — what has AWS published that the deck says nothing about?
 *
 * WHY THIS IS THE MISSING HALF
 *
 * Every other mechanism here keeps existing cards CORRECT. `verify-claims`
 * re-checks their numbers, `check-lifecycle` catches a stale preview badge,
 * `check-rename` catches a renamed product, the ingests refresh the facts they
 * cite. Not one of them can notice that the deck is INCOMPLETE.
 *
 * For a deck whose stated purpose is "services, updates and news", that is the
 * load-bearing gap: it could be perfectly accurate about thirty cards while AWS
 * shipped forty things nobody wrote down.
 *
 * THIS IS A TO-DO LIST, NEVER A DEFECT LIST
 *
 * The distinction matters more than the mechanism. A missing card is not an
 * error — the deck is deliberately curated and will never cover every entry, nor
 * should it. So coverage never fails a build and never marks a card wrong. It
 * produces a ranked queue of candidates, and the ranking is what makes it usable:
 * an unranked list of ninety entries is indistinguishable from noise, and a
 * report people learn to ignore is worse than no report.
 *
 * TWO DIFFERENT ANSWERS, KEPT APART
 *
 *   UNCOVERED  no card's subject matches this entry at all. A candidate NEW card.
 *   STALE      a card DOES match, but the entry is dated after that card's
 *              `verified_at`. The card exists and may simply not mention this
 *              change. A candidate card UPDATE.
 *
 * The second is the more valuable signal and the easier one to miss. "Gateway:
 * Configurable rate limits" does not need a new card — AC-06 is the Gateway card
 * — it needs AC-06 to say something about rate limits.
 *
 * SUPPRESSION IS PART OF THE DESIGN
 *
 * Most release-notes entries do not deserve a card ("Observability: UI
 * Enhancements for Trace and Trajectory"). Without a way to say so, every run
 * re-reports the same sixty minor items forever and the signal dies. Deliberate
 * non-coverage is recorded in `content/coverage-ignore.json` WITH A REASON, so
 * "we decided not to" is visible and revisitable rather than being indistinguishable
 * from "we never looked".
 */

import type { Card } from './types.ts';
import type { DatedEntry } from './verifier.ts';
import { scoreHeading, headingFrequency } from './lifecycle.ts';
import { subjectTokens } from './verifier.ts';
import { inScope } from './scope.ts';

/** Why an entry looks like it deserves a card. Ranked highest first. */
export type Significance = 'launch' | 'ga' | 'preview' | 'capability' | 'expansion' | 'minor';

const SIGNAL_RE: { kind: Significance; re: RegExp; weight: number }[] = [
  // A thing that did not exist before. The strongest reason to write a card.
  { kind: 'launch', re: /\b(?:launch(?:es|ed)?|introducing|now available|initial release)\b/i, weight: 10 },
  { kind: 'ga', re: /\b(?:is now generally available|now generally available|general availability|reached ga)\b/i, weight: 9 },
  { kind: 'preview', re: /\b(?:public preview|now in preview|in preview|preview launch)\b/i, weight: 8 },
  // New behaviour on something that already exists — usually a card UPDATE.
  { kind: 'capability', re: /\b(?:now supports?|adds?|support for|enables?|new (?:api|feature|capability))\b/i, weight: 5 },
  // Real but rarely card-worthy on its own.
  { kind: 'expansion', re: /\b(?:region expansion|now available in|additional regions?)\b/i, weight: 2 },
];

/** Headings that are documentation housekeeping, not product news. */
const HOUSEKEEPING_RE =
  /\b(?:added documentation|documentation for|ui enhancements?|latency improvements?|updated list|clarified|doc(?:umentation)? (?:update|history))\b/i;

/**
 * SageMaker JumpStart model-roster additions, downweighted for the same
 * reason Bedrock's model roster is (content/coverage-ignore.json's Claude
 * Opus 5 / GPT-5.6 / Grok 4.6 entries): a JumpStart model announcement is
 * "launch"-language by construction ("X model now available on Amazon
 * SageMaker JumpStart"), so SIGNAL_RE alone would classify every one of them
 * at the HIGHEST significance weight — measured at 8 of a single feed page's
 * SageMaker entries the day SageMaker was added to service-scope.json. Unlike
 * Bedrock, where one concept card (BR-01) already exists to absorb this
 * pattern, this repo has authored no SageMaker JumpStart concept card yet —
 * so this downweights to `minor` rather than routing to per-model suppression
 * entries, which content/coverage-ignore.json's exact-heading matching would
 * otherwise need one of per model, forever. Revisit (raise this back up, or
 * write the concept card and keep the downweight) once that card exists.
 */
const JUMPSTART_MODEL_RE = /\bmodels? (?:is )?now available on (?:amazon )?sagemaker jumpstart\b/i;

export function significanceOf(heading: string, summary: string): { kind: Significance; weight: number } {
  if (HOUSEKEEPING_RE.test(heading)) return { kind: 'minor', weight: 0 };
  if (JUMPSTART_MODEL_RE.test(heading)) return { kind: 'minor', weight: 0 };
  for (const s of SIGNAL_RE) {
    if (s.re.test(heading)) return { kind: s.kind, weight: s.weight };
  }
  // Fall back to the summary: some headings are bare feature names.
  for (const s of SIGNAL_RE) {
    if (s.re.test(summary)) return { kind: s.kind, weight: Math.max(1, s.weight - 3) };
  }
  /**
   * A heading that names a subject but uses no announcement verb is still a
   * feature announcement — "Gateway: Configurable rate limits" is how these notes
   * title half their entries.
   *
   * `minor` is reserved for documentation housekeeping, which is caught above.
   * Treating an unsignalled heading as minor dropped real changes out of the
   * actionable queue, which is the failure that makes a to-do list useless.
   */
  return { kind: 'capability', weight: 4 };
}

export type IgnoreEntry = { heading: string; reason: string };

export type CoverageFinding = {
  entry: DatedEntry;
  /** cards whose subject matches this entry, best first */
  matches: { card_id: string; score: number; precision: number; matched: string[] }[];
  status: 'uncovered' | 'stale' | 'covered' | 'ignored' | 'unmatchable';
  significance: Significance;
  /** ranking weight — significance, then recency */
  rank: number;
  reason: string;
};

/**
 * Words that describe a TRANSITION, not a subject.
 *
 * "Generally", "available", "launch", "support" are what a release note says about
 * a thing; they never identify which thing. They have to be excluded explicitly
 * rather than left to the corpus-frequency cap, because on 102 headings "gener"
 * lands at df=12 against a cap of 12.2 and is classed distinctive by a whisker —
 * which made "General Availability" look like a nameable subject.
 */
const LIFECYCLE_LANGUAGE = new Set(
  ['generally', 'general', 'available', 'availability', 'launch', 'launches', 'launched',
    'preview', 'support', 'supports', 'release', 'initial', 'additional', 'update', 'updated',
    'enhancement', 'enhancements', 'improvement', 'improvements', 'expansion',
    // Generic nouns for "a thing changed" that never say WHICH thing. "Additional
    // Features" and "New feature" name nothing at all.
    'feature', 'features', 'capability', 'capabilities'].map((w) => w.slice(0, 5)),
);

/**
 * Does any card look like it is ABOUT this heading?
 *
 * Deliberately more permissive than `scoreHeading`, and the asymmetry is the
 * point. Lifecycle asks "is this card WRONG", so a false positive accuses a
 * correct card and it demands two weighted tokens. Coverage asks "does a card
 * exist", where a false NEGATIVE is the expensive error: it sends someone to write
 * a card that is already there, and two of those make the whole report untrusted.
 *
 * Measured: `gatew` appears in 20 of 102 headings, so it scores weight 1 and
 * AC-06 — the Gateway card — failed to match "Gateway: AgentCore Runtime targets
 * are now generally available". A common word can still be the name of the thing.
 *
 * So a single token from the card's TITLE is enough here. Tag-only matches still
 * go through the stricter scorer, because tags are loose associations.
 */
/**
 * Scope is checked BEFORE any token scoring here — see `src/lib/scope.ts` for why
 * it is exact rather than scored, and why it is a shared module rather than a
 * function each detector keeps its own copy of.
 */

function coversHeading(
  card: Card,
  heading: string,
  df: Map<string, number>,
  total: number,
): { matched: string[]; score: number; precision: number } | null {
  const headingTokens = new Set(subjectTokens(heading));
  const titleTokens = subjectTokens(card.title).filter((t) => !LIFECYCLE_LANGUAGE.has(t));
  const fromTitle = titleTokens.filter((t) => headingTokens.has(t));
  if (fromTitle.length) {
    return {
      matched: fromTitle,
      score: fromTitle.length * 2,
      precision: fromTitle.length / Math.max(headingTokens.size, 1),
    };
  }
  return scoreHeading(card, heading, df, total);
}

/** Recency as a small tiebreaker, never the main signal. */
function recencyBonus(isoMonth: string, entries: DatedEntry[]): number {
  const months = [...new Set(entries.map((e) => e.iso_month))].sort();
  const i = months.indexOf(isoMonth);
  return i < 0 ? 0 : (i / Math.max(1, months.length - 1)) * 3;
}

/**
 * Compare every dated entry against every card.
 *
 * `ignore` suppresses entries a human has deliberately decided not to cover.
 * Matching is on the exact heading, so a reworded entry resurfaces rather than
 * staying silently suppressed under a stale rule.
 */
export function detectCoverage(
  cards: Card[],
  entries: DatedEntry[],
  ignore: IgnoreEntry[] = [],
): CoverageFinding[] {
  const { df, total } = headingFrequency(entries);
  const ignored = new Map(ignore.map((i) => [i.heading, i.reason]));
  const out: CoverageFinding[] = [];

  for (const entry of entries) {
    const matches = cards
      .map((c) => {
        if (!inScope(c, entry)) return null;
        const hit = coversHeading(c, entry.heading, df, total);
        return hit ? { card_id: c.card_id, ...hit } : null;
      })
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .sort((a, b) => b.score - a.score || b.precision - a.precision);

    const { kind, weight } = significanceOf(entry.heading, entry.summary);
    const suppressed = ignored.get(entry.heading);

    let status: CoverageFinding['status'];
    let reason: string;

    /**
     * A heading with no distinctive token cannot be matched to anything, and
     * calling that "uncovered" is a lie about the deck rather than a fact about it.
     *
     * The release notes contain bare headings like "General Availability" and
     * "Initial release (preview)" whose only tokens are corpus-wide boilerplate.
     * AC-01 covers both of those. Reporting them as gaps would send someone to
     * write a card that already exists — the fastest way to make this report
     * untrustworthy.
     */
    const cap = Math.max(2, total * 0.12);
    const headingTokens = subjectTokens(entry.heading);
    const subjectBearing = headingTokens.filter((t) => !LIFECYCLE_LANGUAGE.has(t));
    const distinctive = subjectBearing.filter((t) => (df.get(t) ?? 0) <= cap);

    if (suppressed) {
      status = 'ignored';
      reason = `Deliberately not covered: ${suppressed}`;
    } else if (!matches.length && !distinctive.length) {
      status = 'unmatchable';
      reason = `Heading carries no distinctive term ("${headingTokens.join(', ') || 'none'}") — cannot be attributed to a card either way. Read it by hand rather than trusting this row.`;
    } else if (!matches.length) {
      status = 'uncovered';
      reason = `No card's subject matches this entry. Candidate NEW card (${kind}).`;
    } else {
      /**
       * A matching card exists. Is it likely to know about THIS change?
       *
       * KNOWN WEAKNESS, stated rather than hidden. `verified_at` is the date the
       * card's SOURCES were fetched, and every applier bumps it — so a routine
       * fact refresh makes every card look freshly reviewed even when its prose
       * has not been read since it was written. That means this signal
       * UNDER-REPORTS, and a reading of zero is weak evidence rather than an
       * all-clear.
       *
       * Doing it properly needs a `content_reviewed_at` that only a prose edit or
       * a human sign-off sets. Recorded as the next thing to fix here rather than
       * dressed up as working.
       */
      const best = matches[0];
      const card = cards.find((c) => c.card_id === best.card_id)!;
      const cardMonth = card.verified_at ? card.verified_at.slice(0, 7) : null;
      const entryIsNewer = cardMonth !== null && entry.iso_month > cardMonth;
      if (entryIsNewer) {
        status = 'stale';
        reason = `${best.card_id} matches but its sources were fetched ${cardMonth}, before this ${entry.month_label} entry. Candidate card UPDATE.`;
      } else {
        status = 'covered';
        reason = `Covered by ${matches.map((m) => m.card_id).join(', ')}.`;
      }
    }

    out.push({
      entry,
      matches,
      status,
      significance: kind,
      rank: weight + recencyBonus(entry.iso_month, entries),
      reason,
    });
  }

  // Highest significance first, then most recent. Deterministic tie-break on
  // heading so two runs over the same corpus report in the same order.
  return out.sort(
    (a, b) => b.rank - a.rank || b.entry.iso_month.localeCompare(a.entry.iso_month) || a.entry.heading.localeCompare(b.entry.heading),
  );
}

/** Roll-up for the report and for a cron to decide whether to notify. */
export function coverageSummary(findings: CoverageFinding[]) {
  const s = { total: findings.length, uncovered: 0, stale: 0, covered: 0, ignored: 0, unmatchable: 0, actionable: 0 };
  for (const f of findings) {
    s[f.status]++;
    // What a human would actually act on: a real signal, not housekeeping.
    if ((f.status === 'uncovered' || f.status === 'stale') && f.significance !== 'minor') s.actionable++;
  }
  return s;
}
