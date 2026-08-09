/**
 * Rename detection (Tier A).
 *
 * WHY A SEPARATE MODULE FROM lifecycle.ts
 *
 * A lifecycle transition says the card is STALE. A rename says the thing the card
 * describes is now CALLED something else. The deck's answer to the second is
 * aliasing, never overwriting: the old name keeps resolving so a link someone
 * shared six months ago still lands on the right card. That is a P0 non-negotiable
 * and `aka[]` has existed since the first schema for exactly this.
 *
 * Until now nothing populated it. AC-14 was titled "Agent Registry" while two AWS
 * documentation surfaces had moved to "AWS Agent Registry", and no gate in the
 * repo could see it — the same shape of blind spot that let three cards ship a
 * `preview` badge months after GA.
 *
 * WHY A RENAME NEEDS TWO SOURCES WHERE A LIFECYCLE TRANSITION NEEDS ONE
 *
 * "Is now generally available" is a fixed phrase with one meaning. A product NAME
 * is different: documentation is full of near-miss labels for the same thing, and
 * a release-notes heading is written by a human who may be describing rather than
 * naming. AgentCore's own notes contain both "AgentCore Registry is now in Public
 * Preview" (April) and "AWS Agent Registry launches under the new agent-registry
 * namespace" (August) — three candidate names for one feature across two entries.
 *
 * So a rename is only applied when a SECOND, INDEPENDENT source uses the same new
 * name verbatim. One source proposing a name is a candidate for review; two
 * agreeing is a fact. Anything less is reported and left alone, because renaming a
 * card on a doc writer's turn of phrase would churn the deck's vocabulary against
 * itself.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not touch `lifecycle`, `service`, or prose.
 *
 *  - `lifecycle` is lifecycle.ts's job, and the August rename entry carries no GA
 *    language at all. Reading "launches" as "generally available" would be exactly
 *    the overreach this repo exists to prevent.
 *  - `service` is the key that joins a card to its deterministic sources. The
 *    release notes announce an `agent-registry` API namespace, but the pinned
 *    botocore snapshot still carries every Registry operation under
 *    `bedrock-agentcore-control`, and the docs sources that describe Registry are
 *    all AgentCore pages. The namespace is recorded as an observation on the
 *    finding rather than acted on.
 *  - prose is authorship. The detector reports which fields still contain the old
 *    name so a human can rewrite them under Tier C.
 */

import type { Card, FactSet } from './types.ts';
import type { DatedEntry } from './verifier.ts';
import { subjectTokens } from './verifier.ts';
import { cardSubject } from './lifecycle.ts';

export type RenameSignal = {
  /** the name the source uses now */
  new_name: string;
  /** an API/namespace token the heading mentions, recorded but never applied */
  namespace: string | null;
  iso_month: string;
  month_label: string;
  heading: string;
  url: string;
  /** distinctive tokens shared with the card, for auditability */
  matched: string[];
};

export type Corroboration = {
  /** fact set that independently uses the same name */
  fact_set_id: string;
  url: string;
  /** the surrounding text, so a human can see the usage */
  quote: string;
};

export type RenameFinding = {
  card_id: string;
  card_title: string;
  candidate: RenameSignal | null;
  corroboration: Corroboration[];
  /** true only when a second independent source agrees — the auto-apply gate */
  confident: boolean;
  /** card fields whose text still contains the old name (prose, for Tier C) */
  stale_prose: string[];
  reason: string;
};

/**
 * Headings that announce a name change, with the new name captured.
 *
 * Narrow on purpose, in the same spirit as lifecycle.ts's GA_RE. Each pattern is
 * a phrase a docs writer uses when they mean "this is now called X", not merely
 * when they mention X.
 */
const RENAME_PATTERNS: { re: RegExp; group: 'name' }[] = [
  // "AWS Agent Registry launches under the new `agent-registry` namespace"
  { re: /^(?<name>.+?)\s+launches\s+under\s+the\s+new\s+[`'"]?(?<ns>[a-z0-9][a-z0-9-]*)[`'"]?\s+namespace/i, group: 'name' },
  // "X is now called Y" / "X is now named Y"
  { re: /\bis\s+now\s+(?:called|named)\s+(?<name>[^.,;:]+)/i, group: 'name' },
  // "X has been renamed to Y" / "X renamed to Y"
  { re: /\b(?:has\s+been\s+|is\s+)?renamed\s+(?:to|as)\s+(?<name>[^.,;:]+)/i, group: 'name' },
  // "Y (formerly X)"
  { re: /^(?<name>.+?)\s+\(\s*formerly\b/i, group: 'name' },
];

/** A namespace token, when the heading names one. Recorded, never applied. */
const NAMESPACE_RE = /\bthe\s+new\s+[`'"]?([a-z0-9][a-z0-9-]*)[`'"]?\s+namespace/i;

/** Trim the decoration a heading wraps a product name in. */
function cleanName(raw: string): string {
  return raw
    .replace(/[`'"\u201c\u201d]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:]+$/, '');
}

/**
 * Is this string plausibly a product NAME rather than a sentence fragment?
 *
 * A permissive regex over docs prose will happily capture "available in more
 * regions" as a name. A product name is short, title-cased, and not a clause.
 */
function looksLikeName(s: string): boolean {
  if (s.length < 3 || s.length > 60) return false;
  const words = s.split(' ');
  if (words.length > 6) return false;
  // At least one capitalised word, and no obvious verb-phrase joiners.
  if (!/[A-Z]/.test(s)) return false;
  if (/\b(?:and|with|for|that|which|when|now|available)\b/i.test(s)) return false;
  return true;
}

/** Extract a rename candidate from one heading, or null. */
export function renameCandidateFrom(heading: string): { new_name: string; namespace: string | null } | null {
  for (const { re } of RENAME_PATTERNS) {
    const m = re.exec(heading);
    const raw = m?.groups?.name;
    if (!raw) continue;
    const name = cleanName(raw);
    if (!looksLikeName(name)) continue;
    const ns = NAMESPACE_RE.exec(heading)?.[1] ?? null;
    return { new_name: name, namespace: ns };
  }
  return null;
}

/** Distinctive-token document frequency over headings, as lifecycle.ts does. */
function documentFrequency(entries: DatedEntry[]): { df: Map<string, number>; total: number } {
  const df = new Map<string, number>();
  for (const e of entries) {
    for (const t of new Set(subjectTokens(e.heading))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { df, total: entries.length };
}

const DISTINCTIVE_MAX_SHARE = 0.12;
const DISTINCTIVE_MIN_DOCS = 2;
const MATCH_THRESHOLD = 2;

/** Card text fields that a human would have to rewrite by hand after a rename. */
function proseFieldsContaining(card: Card, name: string): string[] {
  const out: string[] = [];
  const has = (s: string | undefined | null) => Boolean(s && s.includes(name));
  if (has(card.hook)) out.push('hook');
  if (has(card.back.lead)) out.push('back.lead');
  card.back.kv.forEach((kv, i) => {
    if (has(kv.v) || has(kv.k)) out.push(`back.kv[${i}]`);
  });
  if (has(card.back.hookline)) out.push('back.hookline');
  for (const [slotName, slot] of Object.entries(card.slots)) {
    if (has(slot.rendered)) out.push(`slots.${slotName}`);
  }
  return out;
}

/**
 * Find sources OTHER than `excludeUrl` that use `name` verbatim.
 *
 * Independence is by URL, not by fact set: two fact sets built from the same page
 * would corroborate each other and prove nothing.
 */
export function corroborate(name: string, sets: FactSet[], excludeUrl: string): Corroboration[] {
  const out: Corroboration[] = [];
  for (const s of sets) {
    if (s.source.url === excludeUrl) continue;
    const text = s.evidence?.text ?? '';
    const at = text.indexOf(name);
    if (at < 0) continue;
    out.push({
      fact_set_id: s.fact_set_id,
      url: s.source.url,
      quote: text.slice(Math.max(0, at - 60), at + name.length + 60).replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

/** Detect a rename for one card. */
export function detectRename(card: Card, entries: DatedEntry[], sets: FactSet[]): RenameFinding {
  const titleTokens = new Set(subjectTokens(card.title));
  const subject = cardSubject(card);
  const { df, total } = documentFrequency(entries);
  const cap = Math.max(DISTINCTIVE_MIN_DOCS, total * DISTINCTIVE_MAX_SHARE);
  const weightOf = (t: string) => ((df.get(t) ?? 0) <= cap ? 2 : 1);

  const known = new Set([card.title, ...card.aka.map((a) => a.name)]);
  const scored: { signal: RenameSignal; score: number }[] = [];

  for (const e of entries) {
    // Headings only, exactly as lifecycle.ts: a summary mentions half the platform.
    const headingTokens = new Set(subjectTokens(e.heading));
    const matched = subject.filter((s) => headingTokens.has(s));
    if (!matched.length) continue;
    const score = matched.reduce((sum, t) => sum + weightOf(t), 0);
    if (score < MATCH_THRESHOLD) continue;
    // A lone token match must come from the TITLE, not a tag — tags are loose.
    if (matched.length === 1 && !titleTokens.has(matched[0])) continue;

    const cand = renameCandidateFrom(e.heading);
    if (!cand) continue;
    // Already the current name, or a name we have already retired: not a rename.
    if (known.has(cand.new_name)) continue;

    scored.push({
      score,
      signal: {
        new_name: cand.new_name,
        namespace: cand.namespace,
        iso_month: e.iso_month,
        month_label: e.month_label,
        heading: e.heading,
        url: e.url,
        matched,
      },
    });
  }

  // Most recent wins; within a month, the strongest match.
  scored.sort((a, b) => a.signal.iso_month.localeCompare(b.signal.iso_month) || a.score - b.score);
  const candidate = scored.length ? scored[scored.length - 1].signal : null;

  if (!candidate) {
    return {
      card_id: card.card_id,
      card_title: card.title,
      candidate: null,
      corroboration: [],
      confident: false,
      stale_prose: [],
      reason: 'No rename language in any dated entry that names this card.',
    };
  }

  const corroboration = corroborate(candidate.new_name, sets, candidate.url);
  const confident = corroboration.length > 0;

  return {
    card_id: card.card_id,
    card_title: card.title,
    candidate,
    corroboration,
    confident,
    stale_prose: proseFieldsContaining(card, card.title),
    reason: confident
      ? `${candidate.month_label} "${candidate.heading}" renames this to "${candidate.new_name}" (matched on ${candidate.matched.join(', ')}), corroborated by ${corroboration.map((c) => c.fact_set_id).join(', ')}`
      : `${candidate.month_label} "${candidate.heading}" suggests "${candidate.new_name}", but no second independent source uses that name. Reported, not applied — one source's turn of phrase is not a rename.`,
  };
}

export function detectAllRenames(cards: Card[], entries: DatedEntry[], sets: FactSet[]): RenameFinding[] {
  return cards.map((c) => detectRename(c, entries, sets));
}
