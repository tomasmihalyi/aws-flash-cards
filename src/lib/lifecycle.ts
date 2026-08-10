/**
 * Lifecycle drift detection (Tier A).
 *
 * WHY THIS EXISTS
 *
 * The claim verifier decomposes card PROSE into claims. `lifecycle` is a
 * top-level schema field with no slot governing it, so it was invisible to every
 * check in the repo — and three cards were shipping a `preview` badge for
 * features that had gone GA months earlier. The deck was confidently wrong in
 * exactly the way the whole project exists to prevent, and no gate noticed.
 *
 * The design doc already put this in Tier A: "GA/preview transitions" are listed
 * alongside region availability and pricing as deterministic, auto-commit
 * signals. This module is the missing implementation, not a new idea.
 *
 * PRECISION OVER RECALL
 *
 * Asserting "your card's lifecycle is wrong" is an accusation, so the same
 * asymmetry applies as elsewhere in this codebase: matching is done on entry
 * HEADINGS only, never summaries. A heading names the feature; a summary
 * mentions half the platform in passing. Heading-only matching means the
 * detector finds fewer transitions but almost never invents one.
 */

import type { Card } from './types.ts';
import type { DatedEntry } from './verifier.ts';
import { subjectTokens } from './verifier.ts';

export type LifecycleSignal = {
  /** what the source says the state became */
  lifecycle: 'preview' | 'ga';
  iso_month: string;
  month_label: string;
  heading: string;
  url: string;
  /** distinctive stems shared with the card, for auditability */
  matched: string[];
};

export type LifecycleFinding = {
  card_id: string;
  card_lifecycle: string;
  /** the most recent transition the source supports */
  latest: LifecycleSignal | null;
  /** every transition found, oldest first */
  signals: LifecycleSignal[];
  /** true when the card disagrees with the latest signal */
  drift: boolean;
  reason: string;
};

/** Headings that announce a GA transition. Deliberately narrow. */
const GA_RE = /\b(?:is now generally available|now generally available|general availability|reached ga|is now ga)\b/i;
/** Headings that announce a preview. */
const PREVIEW_RE = /\b(?:public preview|now in preview|is now in preview|\(preview\)|preview launch|preview)\b/i;

/**
 * Tokenise for lifecycle matching.
 *
 * Now a thin alias for the shared tokenizer in verifier.ts.
 *
 * The acronym handling was written here first, to fix a detector that missed
 * AC-16 because "CLI" stemmed away to nothing — and CLI, MCP, SDK and A2A are the
 * most distinctive tokens in this corpus, not the least. The verifier turned out
 * to have the identical blind spot on the identical card, so the implementation
 * moved next to `stemsOf` and both callers share it. Two copies of a subtle
 * tokenizer is exactly how a gate and the thing it guards drift apart.
 */
const lifecycleTokens = subjectTokens;

/**
 * How often each token appears across all headings.
 *
 * A token in many headings ("runtime", "gateway", "auth") cannot identify a card
 * on its own; a rare one ("harness", "cli", "payments") can. Without this the
 * detector matched the Identity card against "Web Bot Auth (Preview)" on the
 * single token "auth" and declared the card wrong.
 */
function documentFrequency(entries: DatedEntry[]): { df: Map<string, number>; total: number } {
  const df = new Map<string, number>();
  for (const e of entries) {
    for (const t of new Set(lifecycleTokens(e.heading))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { df, total: entries.length };
}

/**
 * A token is distinctive if it names few things in this corpus.
 *
 * Expressed as a share WITH AN ABSOLUTE FLOOR. A pure share is undefined-ish on a
 * small corpus: with three entries every token appears in 33% of headings and
 * nothing is ever distinctive, so the detector silently matches nothing. The
 * floor of 2 makes a small corpus behave sensibly and leaves the 102-entry
 * production corpus unchanged (0.12 × 102 ≈ 12, well above the floor).
 */
const DISTINCTIVE_MAX_SHARE = 0.12;
const DISTINCTIVE_MIN_DOCS = 2;
/** Distinctive tokens are worth 2, generic ones 1, and a match needs 2. */
const MATCH_THRESHOLD = 2;

/**
 * Distinctive tokens naming what a card is about.
 *
 * Title and tags only — NOT the body. AC-16's body mentions Claude Code, Kiro and
 * Q Developer, which would drag in unrelated entries.
 */
export function cardSubject(card: Card): string[] {
  return lifecycleTokens(`${card.title} ${card.tags.join(' ')}`);
}

/**
 * How well one card's subject matches one heading, using this corpus's own
 * distinctiveness.
 *
 * Extracted so `check-coverage` can ask the SAME question in the opposite
 * direction — "which entries does no card match" instead of "which entries match
 * this card". A second copy of this scoring would drift from this one, which is
 * the mistake this repo has already made twice with the tokenizer and with
 * `originalProjection`.
 *
 * Returns null when the card does not match at all.
 */
export function scoreHeading(
  card: Card,
  heading: string,
  df: Map<string, number>,
  total: number,
): { matched: string[]; score: number; precision: number } | null {
  const titleTokens = new Set(lifecycleTokens(card.title));
  const subject = cardSubject(card);
  const cap = Math.max(DISTINCTIVE_MIN_DOCS, total * DISTINCTIVE_MAX_SHARE);
  const weightOf = (t: string) => ((df.get(t) ?? 0) <= cap ? 2 : 1);

  const headingTokens = new Set(lifecycleTokens(heading));
  const matched = subject.filter((s) => headingTokens.has(s));
  if (!matched.length) return null;

  const score = matched.reduce((sum, t) => sum + weightOf(t), 0);
  if (score < MATCH_THRESHOLD) return null;

  /**
   * A single-token match must come from the card's TITLE, not from a tag.
   *
   * Tags are loose associations; a title names the thing. Without this rule the
   * Identity card matched "Web Bot Auth (Preview)" on the lone tag "auth".
   */
  if (matched.length === 1 && !titleTokens.has(matched[0])) return null;

  return { matched, score, precision: matched.length / Math.max(headingTokens.size, 1) };
}

/** Token document-frequency across a corpus of headings. Exported for coverage. */
export function headingFrequency(entries: DatedEntry[]): { df: Map<string, number>; total: number } {
  return documentFrequency(entries);
}

/** Detect the lifecycle transitions a source supports for one card. */
export function detectLifecycle(card: Card, entries: DatedEntry[]): LifecycleFinding {
  const { df, total } = documentFrequency(entries);

  const scored: { signal: LifecycleSignal; score: number; precision: number }[] = [];

  for (const e of entries) {
    // Headings only. A summary mentions half the platform in passing.
    const hit = scoreHeading(card, e.heading, df, total);
    if (!hit) continue;
    const { matched, score, precision } = hit;

    const isGa = GA_RE.test(e.heading);
    const isPreview = !isGa && PREVIEW_RE.test(e.heading);
    if (!isGa && !isPreview) continue;

    scored.push({
      score,
      precision,
      signal: {
        lifecycle: isGa ? 'ga' : 'preview',
        iso_month: e.iso_month,
        month_label: e.month_label,
        heading: e.heading,
        url: e.url,
        matched,
      },
    });
  }

  // Latest month wins; within a month, the strongest and most specific match wins.
  scored.sort(
    (a, b) =>
      a.signal.iso_month.localeCompare(b.signal.iso_month) ||
      a.score - b.score ||
      a.precision - b.precision,
  );
  const signals = scored.map((s) => s.signal);
  const latest = signals.length ? signals[signals.length - 1] : null;

  if (!latest) {
    return {
      card_id: card.card_id,
      card_lifecycle: card.lifecycle,
      latest: null,
      signals,
      drift: false,
      reason: 'No lifecycle transition for this card in the dated source — nothing to compare against.',
    };
  }

  // Only `preview` and `ga` are detectable from release notes. A card marked
  // deprecated/superseded/retired is a human judgement this must not override.
  if (card.lifecycle !== 'preview' && card.lifecycle !== 'ga') {
    return {
      card_id: card.card_id,
      card_lifecycle: card.lifecycle,
      latest,
      signals,
      drift: false,
      reason: `Card lifecycle "${card.lifecycle}" is a human judgement this detector does not second-guess.`,
    };
  }

  const drift = card.lifecycle !== latest.lifecycle;
  return {
    card_id: card.card_id,
    card_lifecycle: card.lifecycle,
    latest,
    signals,
    drift,
    reason: drift
      ? `Card says "${card.lifecycle}" but ${latest.month_label} release notes say "${latest.heading}" (matched on ${latest.matched.join(', ')})`
      : `Card lifecycle "${card.lifecycle}" agrees with ${latest.month_label} "${latest.heading}"`,
  };
}

export function detectAll(cards: Card[], entries: DatedEntry[]): LifecycleFinding[] {
  return cards.map((c) => detectLifecycle(c, entries));
}
