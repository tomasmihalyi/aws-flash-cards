/**
 * Claim decomposition (T4.1).
 *
 * A card is prose. A verifier cannot check prose, so before anything can be
 * verified the card has to be broken into ATOMIC CLAIMS — the smallest units
 * that are independently true or false.
 *
 * The split that matters is not sentence boundaries, it is CHECKABILITY:
 *
 *   checkable   a number, a price, a date, a region id, a count. Either it
 *               appears in a fetched source or it does not. No judgement.
 *   judgement   "Gateway is the choke point", "think LEGO not monolith". These
 *               are positioning and framing. A verifier that scored them would
 *               be inventing an opinion and calling it verification.
 *
 * Only checkable claims are ever verified. Judgement claims are counted,
 * labelled, and routed to Tier C — which is the honest outcome, not a gap.
 */

import type { Card } from './types.ts';
import { SLOT_RE } from './facts.ts';

export type ClaimKind = 'number' | 'money' | 'date' | 'year' | 'region' | 'duration' | 'judgement';

export type Claim = {
  /** `AC-19:back.lead#2` — stable enough to cite in a report */
  claim_id: string;
  card_id: string;
  /** where in the card it came from */
  field: string;
  kind: ClaimKind;
  /** the literal token being claimed, e.g. "19", "$0.005", "8 hours" */
  token: string;
  /** the sentence it sits in, for human review */
  context: string;
  /** the slot governing it, if any — a governed claim already has provenance */
  slot: string | null;
  /** true when a fact set supplies this value, so it needs no text match */
  fact_governed: boolean;
};

/** Order matters: the most specific pattern must win. */
const PATTERNS: { kind: ClaimKind; re: RegExp }[] = [
  // $0.005 · $1.80 · US$12 · $0.10–$3.00
  { kind: 'money', re: /(?:US)?\$\s?\d+(?:[.,]\d+)*(?:\s?[–—-]\s?(?:US)?\$?\s?\d+(?:[.,]\d+)*)?/g },
  // ap-southeast-2, us-gov-west-1
  { kind: 'region', re: /\b(?:af|ap|ca|cn|eu|il|me|mx|sa|us)(?:-gov)?(?:-iso[a-z]?)?-(?:north|south|east|west|central|northeast|southeast|northwest|southwest)(?:east|west)?-\d\b/g },
  // Oct 13 2025 · Jul 16 2025 · Dec 2 2025 · July 30, 2026
  { kind: 'date', re: /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+(?:19|20)\d{2}\b/g },
  /**
   * October 2025 · March 2026 · Nov 2023 — a date at MONTH precision.
   *
   * This has to exist, and has to sit ahead of the bare-year pattern, or
   * reducing a claim to the month the source supports makes it WEAKER instead of
   * checkable: "generally available October 2025" was being extracted as the
   * year "2025", which then verified against any topically-related 2025 entry in
   * any month. A month-precision claim must be checked against that month.
   */
  { kind: 'date', re: /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+(?:19|20)\d{2}\b/g },
  // 8 hours · 30 seconds · sub-second
  { kind: 'duration', re: /\b\d+(?:[.,]\d+)?\s?(?:hours?|hrs?|minutes?|mins?|seconds?|secs?|days?|weeks?|months?|years?)\b/g },
  // bare years
  { kind: 'year', re: /\b(?:19|20)\d{2}\b/g },
  // 19 AWS regions · 13 built-in evaluators · 30–70% · 1,000 events
  //
  // The unit noun is allowed up to two words after the number, because real
  // prose writes "19 AWS regions" and "13 built-in evaluators", not "19 regions".
  // Requiring adjacency made this pattern miss the very claim on AC-19 that the
  // whole pipeline exists to keep correct.
  {
    kind: 'number',
    re: /\b\d+(?:,\d{3})*(?:\.\d+)?(?:\s?[–—-]\s?\d+(?:\.\d+)?)?(?:\s+[A-Za-z][\w-]*){0,2}\s*(?:%|regions?|evaluators?|events?|tokens?|calls?|invocations?|services?|primitives?|languages?|GB|MB|TB|vCPU)\b/gi,
  },
];

/**
 * Phrases that read like claims but are not checkable against any source.
 * Recognising them is what stops the verifier from pretending to verify an
 * opinion.
 */
const JUDGEMENT_MARKERS = [
  'think of', 'the whole pitch', 'mental model', 'sweet spot', 'the key question',
  'why it matters', 'arguably', 'industry-leading', 'the auditor-friendly',
  'if you can recite', 'no decision', 'worse than', 'better than', 'best',
  'should', 'prefer', 'recommend', 'choke point',
];

function sentences(text: string): string[] {
  return text
    .replace(SLOT_RE, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Which slot, if any, governs this field's text. */
function governingSlot(card: Card, rawField: string): string | null {
  const raw = fieldRaw(card, rawField);
  const m = raw?.match(SLOT_RE);
  if (!m) return null;
  return m[0].replace(/\{\{slot:|\}\}/g, '');
}

function fieldRaw(card: Card, field: string): string | undefined {
  if (field === 'title') return card.title;
  if (field === 'hook') return card.hook;
  if (field === 'back.lead') return card.back.lead;
  if (field === 'back.hookline') return card.back.hookline;
  const kv = /^back\.kv\[(\d+)\]$/.exec(field);
  if (kv) return card.back.kv[Number(kv[1])]?.v;
  return undefined;
}

/**
 * Decompose one card. `resolved` is the card with slots expanded (what a learner
 * actually reads, in the renderer's shape); the card itself supplies the slot
 * structure so a claim can be traced back to the slot governing it.
 */
export function decompose(
  card: Card,
  resolved: { t: string; hook: string; back: { lead: string; kv: [string, string][]; hookline: string } },
): Claim[] {
  const fields: [string, string][] = [
    ['title', resolved.t],
    ['hook', resolved.hook],
    ['back.lead', resolved.back.lead],
    ...resolved.back.kv.map((r, i) => [`back.kv[${i}]`, r[1]] as [string, string]),
    ['back.hookline', resolved.back.hookline],
  ];

  const claims: Claim[] = [];
  let n = 0;

  for (const [field, text] of fields) {
    const slot = governingSlot(card, field);
    const slotFacts = slot ? (card.slots[slot]?.facts ?? []) : [];
    const factGoverned = slotFacts.length > 0;

    for (const sentence of sentences(text)) {
      // A sentence can carry several checkable tokens; each is its own claim.
      const claimed = new Set<string>();
      for (const { kind, re } of PATTERNS) {
        for (const m of sentence.matchAll(new RegExp(re.source, re.flags))) {
          const token = m[0].trim();
          // Skip a token already captured by a more specific pattern —
          // "$0.005" must not also be counted as the bare number "0.005".
          if ([...claimed].some((t) => t.includes(token))) continue;
          claimed.add(token);
          claims.push({
            claim_id: `${card.card_id}:${field}#${n++}`,
            card_id: card.card_id,
            field,
            kind,
            token,
            context: sentence,
            slot,
            fact_governed: factGoverned,
          });
        }
      }

      // A sentence with no checkable token but judgement language is recorded so
      // the report can say what proportion of a card is opinion.
      if (!claimed.size) {
        const lower = sentence.toLowerCase();
        if (JUDGEMENT_MARKERS.some((mk) => lower.includes(mk))) {
          claims.push({
            claim_id: `${card.card_id}:${field}#${n++}`,
            card_id: card.card_id,
            field,
            kind: 'judgement',
            token: sentence.slice(0, 80),
            context: sentence,
            slot,
            fact_governed: false,
          });
        }
      }
    }
  }
  return claims;
}

export function isCheckable(kind: ClaimKind): boolean {
  return kind !== 'judgement';
}
