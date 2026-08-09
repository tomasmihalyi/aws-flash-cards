/**
 * The verifier (T4.2, T4.5).
 *
 * THE ONE RULE: numeric, date and region claims are STRING-MATCHED against
 * fetched source text. They are never judged, scored, or assessed for
 * plausibility. A model asked "does 19 regions sound right?" will say yes to
 * almost any number, which is precisely the failure this exists to catch.
 *
 * A claim passes only if its value is present in evidence that was actually
 * fetched — either as a fact-set value, or literally in the retained source text.
 *
 * TIER DEMOTION: any failing checkable claim demotes the WHOLE card to Tier C
 * (human-gated). Not the claim, the card. A card with one unverifiable number is
 * a card a learner will quote wrongly, and partial publication would ship exactly
 * the confident-and-wrong artefact the whole design is built to prevent.
 */

import type { Card, FactSet } from './types.ts';
import type { Claim } from './claims.ts';
import { isCheckable } from './claims.ts';
import { FactStore, formatFact } from './facts.ts';

export type Verdict = 'verified' | 'partial' | 'unsupported' | 'contradicted' | 'unverifiable' | 'judgement';

/**
 * A dated entry from a documentation source.
 *
 * Two precisions exist and the difference is load-bearing: release notes are
 * organised by month and cannot attest a day, while a document-history table
 * records an exact calendar day. `precision` is carried per entry so the
 * verifier never has to assume which kind it is holding.
 */
export type DatedEntry = {
  iso_month: string;
  month_label: string;
  /** "2026-07-30" for day-precision sources, null for month-precision ones. */
  iso_date: string | null;
  precision: 'month' | 'day';
  heading: string;
  summary: string;
  url: string;
};

export type VerifyContext = {
  store: FactStore;
  evidenceTexts: { url: string; text: string }[];
  datedEntries: DatedEntry[];
  /** Terms identifying what the card is about, for topical matching. */
  subjectStems: string[];
};

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you', 'not', 'are', 'was',
  'its', 'has', 'have', 'can', 'all', 'any', 'per', 'via', 'now', 'new', 'one', 'two', 'own',
  'what', 'when', 'where', 'which', 'while', 'each', 'over', 'them', 'they', 'their', 'than',
  'amazon', 'aws', 'bedrock', 'agentcore', 'agent', 'agents',
  // Month names are excluded because a date must never be topical evidence for
  // ITSELF. Letting "july" count as a shared term made a July claim look related
  // to every July entry, which is circular reasoning dressed up as a match.
  ...MONTH_NAMES,
]);

/**
 * Light stemming: first five characters, lowercased.
 *
 * Crude on purpose. It has to make "available" and "availability" match, and
 * "generally" and "general", without pulling in a stemmer dependency. The
 * distinctive-term requirement below is what keeps it from over-matching.
 */
export function stem(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
}

/**
 * Distinctive stems from a piece of text.
 *
 * The service's own name is a stopword HERE specifically: every entry in an
 * AgentCore release-notes page mentions AgentCore, so matching on it would make
 * every date claim match every month. Excluding it is the same discipline as
 * refusing to let service-level region data substantiate a feature-level claim.
 */
export function stemsOf(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        // A bare number is never a topic. "2025" was letting a claim's own year
        // vouch for its own relevance.
        .filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !STOPWORDS.has(w))
        .map(stem)
        .filter(Boolean),
    ),
  ];
}

/**
 * Subject tokens: stems, plus short acronyms that stemming would erase.
 *
 * `stemsOf` drops anything under four characters, which silently deletes CLI,
 * MCP, SDK and A2A — often the most identifying word in an AgentCore heading.
 * src/lib/lifecycle.ts already had to learn this: it "dropped short acronyms
 * (missed AC-16, the target card)". The verifier had the same blind spot, and it
 * showed up on the same card — AC-16's March 2026 claim about the CLI reaching GA
 * was cited to "Code Interpreter: Node.js Support", because "AgentCore CLI is now
 * Generally Available" had no matchable token in it at all.
 *
 * Shared with the lifecycle detector rather than duplicated, so the two cannot
 * drift apart.
 */
export function subjectTokens(text: string): string[] {
  const acronyms = (text.match(/\b[A-Z][A-Z0-9]{1,4}\b/g) ?? [])
    .map((a) => a.toLowerCase())
    .filter((a) => !['aws', 'the', 'and', 'for', 'new', 'now', 'ga'].includes(a));
  return [...new Set([...stemsOf(text), ...acronyms])];
}

/**
 * How many of the dated entries each stem appears in.
 *
 * Cached per corpus because it is computed once and consulted for every claim.
 */
const dfCache = new WeakMap<DatedEntry[], { df: Map<string, number>; total: number }>();

function documentFrequency(entries: DatedEntry[]): { df: Map<string, number>; total: number } {
  const cached = dfCache.get(entries);
  if (cached) return cached;
  const df = new Map<string, number>();
  for (const e of entries) {
    for (const s of new Set(subjectTokens(`${e.heading} ${e.summary}`))) df.set(s, (df.get(s) ?? 0) + 1);
  }
  const computed = { df, total: entries.length };
  dfCache.set(entries, computed);
  return computed;
}

/**
 * Is this stem specific enough to establish that two texts are about the same
 * thing?
 *
 * Same rule the lifecycle detector uses. "available", "support" and "feature"
 * appear in most documentation entries ever written, so sharing them says
 * nothing; "classic" appears in two entries out of 264 and says a great deal.
 */
function isDistinctive(stem: string, entries: DatedEntry[]): boolean {
  const { df, total } = documentFrequency(entries);
  const seen = df.get(stem) ?? 0;
  return seen > 0 && seen <= Math.max(2, Math.floor(total * 0.12));
}

export type ParsedDate = { year: number; month: number | null; day: number | null };

/** Parse the date forms that actually appear in cards. */
export function parseClaimDate(token: string): ParsedDate | null {
  const t = token.trim();
  // "Oct 13 2025", "October 13, 2025", "Jul 16 2025"
  let m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2}|19\d{2})$/.exec(t);
  if (m) {
    const mi = MONTH_NAMES.findIndex((n) => n.startsWith(m![1].toLowerCase().slice(0, 3)));
    if (mi >= 0) return { year: Number(m[3]), month: mi + 1, day: Number(m[2]) };
  }
  // "March 2026"
  m = /^([A-Za-z]{3,9})\.?\s+(20\d{2}|19\d{2})$/.exec(t);
  if (m) {
    const mi = MONTH_NAMES.findIndex((n) => n.startsWith(m![1].toLowerCase().slice(0, 3)));
    if (mi >= 0) return { year: Number(m[2]), month: mi + 1, day: null };
  }
  // bare year
  m = /^(20\d{2}|19\d{2})$/.exec(t);
  if (m) return { year: Number(m[1]), month: null, day: null };
  return null;
}

function isoMonthOf(d: ParsedDate): string | null {
  return d.month ? `${d.year}-${String(d.month).padStart(2, '0')}` : null;
}

/** How many distinctive stems an entry shares with the claim's subject. */
function topicalScore(entry: DatedEntry, subjectStems: string[]): number {
  const entryStems = new Set(subjectTokens(`${entry.heading} ${entry.summary}`));
  return subjectStems.filter((s) => entryStems.has(s)).length;
}

/** Two shared distinctive stems. One is too easy; three is too strict in practice. */
const TOPICAL_THRESHOLD = 2;

/** How much text around a date literal counts as "its context". */
const PROSE_WINDOW = 260;

/**
 * The text immediately around `at`, clipped to the entry it sits in.
 *
 * Retained evidence joins one entry per line. Without clipping, a ±260 character
 * window reaches into NEIGHBOURING entries, and terms from an adjacent release
 * note can vouch for a match they have nothing to do with — AC-01's July 2025
 * match was picking up "CloudFormation" and "Tagging" from the entry above it.
 * A row must be identified by its own words.
 */
function entryWindow(text: string, at: number, len: number): string {
  const start = text.lastIndexOf('\n', at) + 1;
  const endAt = text.indexOf('\n', at + len);
  const end = endAt === -1 ? text.length : endAt;
  return text.slice(Math.max(start, at - PROSE_WINDOW), Math.min(end, at + len + PROSE_WINDOW));
}

const MONTH_ALT = MONTH_NAMES.map((n) => `${n.slice(0, 3)}(?:${n.slice(3)})?`).join('|');

/**
 * Every written form of a claimed date that AWS documentation actually uses.
 *
 * Deliberately does NOT include a bare month-and-year form for a claim that
 * names a day: "July 2026" must not attest "July 30, 2026". That is the whole
 * distinction the `partial` verdict exists to preserve.
 */
function dateLiteralPattern(d: ParsedDate): RegExp | null {
  const y = String(d.year);
  if (d.month !== null && d.day !== null) {
    const mn = MONTH_NAMES[d.month - 1];
    const name = `${mn.slice(0, 3)}(?:${mn.slice(3)})?`;
    const mm = String(d.month).padStart(2, '0');
    const dd = String(d.day).padStart(2, '0');
    return new RegExp(
      `\\b(?:${name}\\.?\\s+${d.day}(?:st|nd|rd|th)?,?\\s+${y}` +
        `|${d.day}(?:st|nd|rd|th)?\\s+${name}\\.?,?\\s+${y}` +
        `|${y}-${mm}-${dd})\\b`,
      'i',
    );
  }
  if (d.month !== null) {
    const mn = MONTH_NAMES[d.month - 1];
    const name = `${mn.slice(0, 3)}(?:${mn.slice(3)})?`;
    const mm = String(d.month).padStart(2, '0');
    return new RegExp(`\\b(?:${name}\\.?,?\\s+${y}|${y}-${mm})\\b`, 'i');
  }
  // Year precision. Require the year to sit in a date-ish context — next to a
  // month name, or introduced by a word that makes it a point in time. A bare
  // year loose in prose (a copyright line, a model name, a quota table) is not
  // an attestation of when something happened.
  return new RegExp(`\\b(?:(?:${MONTH_ALT})\\.?,?\\s+${y}|(?:launched|released|announced|since|in|from)\\s+${y})\\b`, 'i');
}

/**
 * Rank strongly-related entries so the one CITED is the one a human would cite.
 *
 * Getting the verdict right is not enough. AC-11 claims Policy went GA in March
 * 2026 and was verified — against "Browser and Code Interpreter: Chrome Policies
 * and Custom Root CA Support", because that entry happened to share more words.
 * "AgentCore Policy is now Generally Available" sat in the same month. A learner
 * following the citation would have landed on an unrelated note and concluded the
 * deck was making things up.
 *
 * Preference order: a distinctive term in the HEADING beats one buried in a body;
 * then more shared terms; then the entry whose heading is mostly about this
 * subject rather than mentioning it in passing.
 */
function rankEntries(entries: DatedEntry[], subject: string[], corpus: DatedEntry[]): DatedEntry[] {
  return entries
    .map((e) => {
      const headingStems = subjectTokens(e.heading);
      const headingSet = new Set(headingStems);
      const headingHits = subject.filter((s) => headingSet.has(s) && isDistinctive(s, corpus)).length;
      return {
        e,
        headingHits,
        bodyHits: topicalScore(e, subject),
        precision: headingHits / Math.max(1, headingStems.length),
      };
    })
    .sort((a, b) => b.headingHits - a.headingHits || b.bodyHits - a.bodyHits || b.precision - a.precision)
    .map((x) => x.e);
}

/**
 * How strongly a dated entry is about the same thing as the claim.
 *
 * Three signals, learned from three separate measured failures:
 *
 *   'none'    nothing shared, or only boilerplate. "available" (12.6% of the
 *             corpus) and "support" (34.4%) identify nothing.
 *   'weak'    shares generic terms only. Not enough to attest a date.
 *   'strong'  either a distinctive term appears in the entry's HEADING, or two
 *             terms are shared and at least one is distinctive.
 *
 * The heading rule exists because requiring two shared terms produced a false
 * NEGATIVE on a correct card: AC-11 claims Policy went GA in March 2026, the
 * release notes have "March 2026 — AgentCore Policy is now Generally Available",
 * and the only term they share is "policy" — which is the exactly right term. A
 * distinctive word in a heading is what an entry is ABOUT, so one is enough.
 * This is the same discipline src/lib/lifecycle.ts already applies by matching
 * headings only.
 */
function relatedness(entry: DatedEntry, subject: string[], entries: DatedEntry[]): 'none' | 'weak' | 'strong' {
  const headingStems = new Set(subjectTokens(entry.heading));
  const bodyStems = new Set([...headingStems, ...subjectTokens(entry.summary)]);
  const shared = subject.filter((s) => bodyStems.has(s));
  if (!shared.length) return 'none';
  const distinctive = shared.filter((s) => isDistinctive(s, entries));
  if (!distinctive.length) return 'weak';
  if (distinctive.some((s) => headingStems.has(s))) return 'strong';
  return shared.length >= TOPICAL_THRESHOLD ? 'strong' : 'weak';
}

/** The distinctive terms that justified a match, for the human-readable reason. */
function justification(entry: DatedEntry, subject: string[], entries: DatedEntry[]): string {
  const bodyStems = new Set([...subjectTokens(entry.heading), ...subjectTokens(entry.summary)]);
  return subject
    .filter((s) => bodyStems.has(s) && isDistinctive(s, entries))
    .slice(0, 4)
    .join(', ');
}

/**
 * Does an entry's own prose STATE this date?
 *
 * Distinct from the entry's row date. The Bedrock document history row dated
 * June 30 2026 says in its body "Amazon Bedrock Agents (launched November 2023)
 * … starting on July 30, 2026" — two dates attested by a source whose own date is
 * neither of them. That is the strongest evidence available for a historical
 * claim, and no other mechanism in this repo could see it.
 *
 * THE RELATEDNESS REQUIREMENT IS NOT OPTIONAL. Card AC-01 claims AgentCore
 * previewed on Jul 16 2025; the document history has three rows dated July 16
 * 2025, for Data Automation, Nova imports and custom model deployment. Matching
 * the date alone would have cited one of those. It shares only "available" with
 * the card, so it is correctly refused.
 */
function verifyDateInProse(claim: Claim, parsed: ParsedDate, ctx: VerifyContext, subject: string[]): ClaimResult | null {
  const pattern = dateLiteralPattern(parsed);
  if (!pattern) return null;

  for (const entry of rankEntries(ctx.datedEntries, subject, ctx.datedEntries)) {
    if (!pattern.test(`${entry.heading} ${entry.summary}`)) continue;
    if (relatedness(entry, subject, ctx.datedEntries) !== 'strong') continue;
    const why = justification(entry, subject, ctx.datedEntries);
    return {
      claim,
      verdict: 'verified',
      evidence: entry.url,
      reason: `The ${entry.month_label} entry "${entry.heading}" states this date in its own text (distinctive shared terms: ${why})`,
    };
  }
  return null;
}

/**
 * Verify a date or year claim against dated entries.
 *
 * Outcomes, in order of strength:
 *   verified      a source STATES this date near text about the same subject, or
 *                 a day-precision entry with this exact date is topically related,
 *                 or the claim is month-precision and a topical entry sits in it
 *   partial       the claim names a DAY and only month-precision sources reach it
 *   contradicted  related entries exist, but the claimed month is absent entirely
 *   unverifiable  no source is topically close enough to say anything
 */
function verifyDate(claim: Claim, ctx: VerifyContext): ClaimResult | null {
  const parsed = parseClaimDate(claim.token);
  if (!parsed || !ctx.datedEntries.length) return null;

  // Subject terms come from the claim's own sentence as well as the card, because
  // a lifecycle claim ("generally available Oct 13 2025") carries its own topic.
  const subject = [...new Set([...ctx.subjectStems, ...subjectTokens(claim.context)])];

  // Strongest first: a source that states the date in related prose.
  const inProse = verifyDateInProse(claim, parsed, ctx, subject);
  if (inProse) return inProse;

  const related = rankEntries(
    ctx.datedEntries.filter((e) => relatedness(e, subject, ctx.datedEntries) === 'strong'),
    subject,
    ctx.datedEntries,
  );
  const scored = related.map((e) => ({ e, score: topicalScore(e, subject) }));

  if (!scored.length) {
    return {
      claim,
      verdict: 'unverifiable',
      evidence: null,
      reason: `No release-notes entry is topically related to this claim, so its date cannot be attested. Needs a specific docs or What\u2019s New citation.`,
    };
  }

  const wantMonth = isoMonthOf(parsed);

  // Next strongest: a day-precision entry whose date IS the claimed date, and
  // which is about the same thing. Only reachable for a claim that names a day.
  if (parsed.day !== null && wantMonth) {
    const wantDate = `${wantMonth}-${String(parsed.day).padStart(2, '0')}`;
    const exact = scored.find((x) => x.e.precision === 'day' && x.e.iso_date === wantDate);
    if (exact) {
      return {
        claim,
        verdict: 'verified',
        evidence: exact.e.url,
        reason: `Day-precision documentation history entry dated ${wantDate}: "${exact.e.heading}"`,
      };
    }
  }

  const sameMonth = wantMonth ? scored.filter((x) => x.e.iso_month === wantMonth) : [];
  const sameYear = scored.filter((x) => x.e.iso_month.startsWith(String(parsed.year)));

  if (wantMonth && sameMonth.length) {
    const hit = sameMonth[0].e;
    if (parsed.day !== null) {
      // Say which sources were consulted, so "cannot attest the day" reads as a
      // property of the evidence rather than a shrug.
      const dayCapable = ctx.datedEntries.some((e) => e.precision === 'day' && e.iso_month === wantMonth);
      const extra = dayCapable
        ? ' A day-precision history covers this month but has no topically related entry on that day.'
        : ' No day-precision source reaches this month.';
      return {
        claim,
        verdict: 'partial',
        evidence: hit.url,
        reason: `${hit.month_label} confirmed by release notes ("${hit.heading}"), but this source is month-precision and cannot attest the day "${parsed.day}".${extra} Either drop to month precision or cite a dated What\u2019s New post.`,
      };
    }
    return {
      claim,
      verdict: 'verified',
      evidence: hit.url,
      reason: `${hit.month_label} release notes: "${hit.heading}"`,
    };
  }

  if (!wantMonth && sameYear.length) {
    const hit = sameYear[0].e;
    return {
      claim,
      verdict: 'verified',
      evidence: hit.url,
      reason: `${hit.month_label} release notes: "${hit.heading}" (claim is year-precision)`,
    };
  }

  /**
   * Contradiction is an accusation: it says the card is wrong. It therefore needs
   * much stronger evidence than confirmation does.
   *
   * The weak link is my own keyword matcher, not the source's dates. So a
   * contradiction is only asserted when the claimed month is ABSENT from the
   * source altogether AND a strongly related entry exists elsewhere. If the month
   * exists but nothing in it matched topically, the honest answer is "this source
   * cannot attest it" — the matcher failing to find a topic is not evidence that
   * the card is lying.
   */
  const monthPresent = wantMonth ? ctx.datedEntries.some((e) => e.iso_month === wantMonth) : true;
  const strong = scored.filter((x) => x.score >= 4);

  if (!monthPresent && strong.length) {
    const where = strong.slice(0, 3).map((x) => `${x.e.month_label} "${x.e.heading}"`).join('; ');
    return {
      claim,
      verdict: 'contradicted',
      evidence: strong[0].e.url,
      reason: `Card says ${claim.token}, but the release notes have no entries for that month at all, and the closely related entries are: ${where}`,
    };
  }

  const near = scored.slice(0, 2).map((x) => `${x.e.month_label} "${x.e.heading}"`).join('; ');
  return {
    claim,
    verdict: 'unverifiable',
    evidence: null,
    reason: monthPresent
      ? `Release notes cover ${wantMonth ?? String(parsed.year)} but no entry there is topically close enough to attest this claim. Nearest related: ${near}. Needs a direct docs or What\u2019s New citation.`
      : `Release notes have no entries for ${wantMonth ?? parsed.year}. Needs a direct docs or What\u2019s New citation.`,
  };
}

export type ClaimResult = {
  claim: Claim;
  verdict: Verdict;
  /** which fact id or source url settled it */
  evidence: string | null;
  reason: string;
};

export type CardVerdict = {
  card_id: string;
  tier: 'A' | 'B' | 'C';
  demoted: boolean;
  results: ClaimResult[];
  counts: Record<Verdict, number>;
  reason: string;
};

/** Digits only, so "$0.005" matches "0.0050000" and "1,000" matches "1000". */
function numeric(token: string): string | null {
  const m = token.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  // Trim trailing zeros so 0.0050000 and 0.005 compare equal.
  let s = m[0];
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/**
 * The unit noun a numeric claim is counting, if any: "18 AWS regions" -> "region".
 * Used to demand proximity, because a bare number appearing anywhere in any
 * source is coincidence, not verification.
 */
function unitOf(token: string): string | null {
  // A percentage's unit is the sign, which carries no letters.
  if (/\d\s*%\s*$/.test(token.trim())) return '%';
  const m = /([A-Za-z][A-Za-z-]{2,})\s*$/.exec(token.trim());
  if (!m) return null;
  return m[1].toLowerCase().replace(/s$/, '');
}

/**
 * The two endpoints of a RANGE claim, or null for a scalar.
 *
 * A range is not a number, and treating it as one is a way to verify something
 * the source never said: `numeric("30–70%")` returns "30", so a source mentioning
 * any 30 would have "confirmed" a claim of 30 to 70 per cent. Both endpoints have
 * to be there, in order, qualified by the unit.
 */
function rangeOf(token: string): { lo: string; hi: string } | null {
  const m = /^\s*(?:US)?\$?\s?(\d+(?:[.,]\d+)*)\s*[–—-]\s*(?:US)?\$?\s?(\d+(?:[.,]\d+)*)/.exec(token);
  if (!m) return null;
  return { lo: m[1].replace(/,/g, ''), hi: m[2].replace(/,/g, '') };
}

/** Does the text state this whole range, with its unit? */
function textContainsRange(text: string, lo: string, hi: string, unit: string | null): boolean {
  const esc = (s: string) => s.replace('.', '\\.');
  const tail = unit === '%' ? '\\s*%' : unit ? `(?:\\s+[\\w().,'-]+){0,3}\\s*${unit}` : '';
  const re = new RegExp(
    `(?<![\\w.])${esc(lo)}\\s*%?\\s*[–—-]\\s*\\$?\\s?${esc(hi)}${tail}`,
    'i',
  );
  return re.test(text.replace(/,/g, ''));
}

function numberMatchIndices(text: string, token: string, requireCurrency = false): number[] {
  const want = numeric(token);
  if (!want) return [];
  const haystack = text.replace(/,/g, '');
  const esc = want.replace('.', '\\.');

  /**
   * Two boundary rules, both learned from a real false positive: a claim of
   * "9 regions" verified against the string "P90" in the release notes.
   *
   *  - trailing zeros are allowed ONLY for decimals, where a source may write
   *    0.0050000 for 0.005. Allowing them for integers let "9" match "90".
   *  - a preceding letter is NOT a numeric boundary. "P90", "v2", "SHA256" and
   *    "us-east-1" must never satisfy a bare numeric claim.
   */
  const body = want.includes('.') ? `${esc}0*` : esc;
  /**
   * A money claim must match MONEY.
   *
   * "$1" carries no unit word, so without this the claim "under $1" would be
   * satisfied by the first standalone digit 1 anywhere in the retained corpus,
   * and the citation printed under the card would be whichever source happened
   * to be scanned first. Requiring the currency marker makes the match mean
   * what it says.
   */
  const prefix = requireCurrency ? '(?:US)?\\$\\s?' : '';
  const re = new RegExp(`${prefix}(?<![\\w.])${body}(?![\\d])(?!\\.\\d)`, 'g');

  /**
   * A number must be FOLLOWED by the thing it counts, the way the claim writes
   * it — not merely appear somewhere near it.
   *
   * A symmetric proximity window was not enough: a claim of "18 AWS regions"
   * verified against "…12-18% improvements" because the word "regions" happened
   * to sit 40 characters earlier in a latency note. Requiring the unit to follow
   * within a few words, and rejecting a number already qualified by a different
   * unit such as "%", removes that whole class of coincidence.
   *
   * "8 hours" still verifies against "default 1 hour up to 8 hours".
   */
  const unit = unitOf(token);
  const out: number[] = [];
  for (const m of haystack.matchAll(re)) {
    if (!unit) {
      out.push(m.index);
      continue;
    }
    const after = haystack.slice(m.index + m[0].length, m.index + m[0].length + 48).toLowerCase();
    // Already counting something else.
    if (/^\s*(?:%|percent)/.test(after) && !unit.startsWith('percent')) continue;
    if (new RegExp(`^(?:\\s+[\\w().,'-]+){0,3}\\s*${unit}`).test(after)) out.push(m.index);
  }
  return out;
}

function textContainsNumber(text: string, token: string): boolean {
  return numberMatchIndices(text, token).length > 0;
}

/** How many DIFFERENT values this text reports for the same unit. */
function distinctValuesForUnit(text: string, unit: string): number {
  const found = new Set<string>();
  const re = new RegExp(`(?<![\\w.])(\\d+(?:\\.\\d+)?)(?:\\s+[\\w().'-]+){0,3}\\s*${unit}`, 'gi');
  for (const m of text.replace(/,/g, '').matchAll(re)) found.add(String(Number(m[1])));
  return found.size;
}

/**
 * A test for whether a term actually identifies one row of a multi-row source.
 *
 * MEASURED FAILURE. Requiring "a shared term near the match" was not enough for
 * the feature × region matrix. AC-12's claim lists Sydney, Tokyo, Singapore,
 * Frankfurt and Ireland — and so does almost every other feature's row, because
 * features share regions. So the wrong row (Runtime Instances, 9 regions) shared
 * five terms with a claim about Evaluations and passed.
 *
 * A term is only identifying if it appears in FEW rows of the source. "sydney"
 * is in twelve of thirteen rows and identifies nothing; "evaluations" is in one.
 */
function rowDistinctiveIn(text: string): (stem: string) => boolean {
  const lines = text.split('\n').filter((l) => l.trim());
  const df = new Map<string, number>();
  for (const l of lines) for (const s of new Set(stemsOf(l))) df.set(s, (df.get(s) ?? 0) + 1);
  const limit = Math.max(1, Math.floor(lines.length * 0.34));
  return (stem: string) => {
    const seen = df.get(stem) ?? 0;
    return seen > 0 && seen <= limit;
  };
}

/**
 * Segments of a fact id that describe the MEASUREMENT rather than its subject.
 *
 * `agentcore.regions.count` is about regions generally, so it may answer a
 * generic region-count claim. `agentcore.feature-regions.runtime-instances.count`
 * names a specific feature, and may only answer a claim about that feature.
 */
const FACT_ID_STRUCTURAL = new Set(
  [
    'count', 'list', 'total', 'regions', 'region', 'month', 'months', 'date', 'dates',
    'entry', 'entries', 'precision', 'latest', 'earliest', 'fingerprint', 'schema',
    'surface', 'operation', 'operations', 'pricing', 'price', 'prices', 'title',
    'includes', 'feature', 'features', 'matrix', 'commercial', 'release', 'notes',
    'history', 'value', 'unit', 'units', 'name',
  ].map(stem),
);

/** The subject terms a fact id names. Empty means the fact is generic. */
export function factIdQualifiers(id: string): string[] {
  return [
    ...new Set(
      id
        .split('.')
        // A region code locates a measurement; it does not name its subject.
        .filter((seg) => !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(seg))
        .flatMap((seg) => stemsOf(seg.replace(/-/g, ' ')))
        .filter((s) => !FACT_ID_STRUCTURAL.has(s)),
    ),
  ];
}

/**
 * May this fact speak for this claim?
 *
 * MEASURED FAILURE THAT MADE THIS NECESSARY. The feature × region matrix
 * introduced thirteen region counts in one fact set. Card AC-12 claims
 * Evaluations is "GA in 9 regions". Evaluations is in 16 — but Runtime Instances
 * is in 9, so a plain value match verified a stale card against a different
 * feature's number and printed a docs link under it for a learner to trust.
 *
 * A number matching is not evidence when several facts share the number.
 */
function factCanSpeakFor(id: string, subject: Set<string>): boolean {
  const qualifiers = factIdQualifiers(id);
  if (!qualifiers.length) return true;
  return qualifiers.some((q) => subject.has(q));
}

/**
 * Verify one claim.
 *
 * Order of preference: a fact set that supplies the exact value is the strongest
 * evidence, because it is structured and hash-backed. Falling back to a text
 * match in retained source is weaker but still real. Anything else is not
 * verified, and the distinction between "no source exists" (unverifiable) and
 * "a source exists and disagrees" (contradicted) is kept, because they need
 * different human responses.
 */
export function verifyClaim(claim: Claim, ctx: VerifyContext): ClaimResult {
  const { store, evidenceTexts } = ctx;
  if (!isCheckable(claim.kind)) {
    return {
      claim,
      verdict: 'judgement',
      evidence: null,
      reason: 'Positioning or framing. Not checkable against a source; routed to Tier C by definition.',
    };
  }

  // Dates need their own path: a month-precision source cannot attest a day, and
  // a numeric match on "13" would be meaningless anyway.
  if (claim.kind === 'date' || claim.kind === 'year') {
    const dated = verifyDate(claim, ctx);
    if (dated) return dated;
  }

  // 1. A fact set that renders exactly this token.
  const subject = new Set([...ctx.subjectStems, ...stemsOf(claim.context)]);
  /**
   * A region id is not a number, even though it ends in one.
   *
   * Caught by the adversarial test for a fabricated region: "eu-south-9" was
   * reduced to the value 9, which the feature × region matrix happens to contain
   * ("available in 9 regions"), so an invented region verified against a region
   * COUNT. Numeric matching is only ever appropriate for numeric claims.
   */
  const numericKind = claim.kind === 'number' || claim.kind === 'money' || claim.kind === 'duration';
  /**
   * A RANGE claim is not a scalar. No single fact can answer it, and reducing it
   * to its lower bound would let an unrelated 30 verify "30–70%".
   */
  const range = numericKind ? rangeOf(claim.token) : null;
  for (const id of store.ids()) {
    const hit = store.get(id);
    if (!hit) continue;
    const rendered = safeFormat(id, hit.value);
    if (rendered === null) continue;
    /**
     * A numeric claim may only be answered by a NUMERIC fact.
     *
     * Caught by reading output: AC-17's "$1" verified against
     * `agentcore.regions.list`, because reducing a joined list of region codes to
     * a number found the 1 in "ap-southeast-1". A money claim was cited to a
     * region list. Comparing a claim's number against whatever number can be
     * scraped out of an arbitrary fact value is not verification.
     */
    const numericFact = hit.value.type === 'integer' || hit.value.type === 'money' || hit.value.type === 'number';
    if (numericKind && !range && numericFact && numeric(claim.token) !== null && numeric(rendered) === numeric(claim.token)) {
      if (!factCanSpeakFor(id, subject)) continue;
      return {
        claim,
        verdict: 'verified',
        evidence: id,
        reason: `Matches fact ${id} (${rendered}) from ${hit.set.source.url}`,
      };
    }
    if (claim.kind === 'region' && String(hit.value.value).includes(claim.token)) {
      if (!factCanSpeakFor(id, subject)) continue;
      return { claim, verdict: 'verified', evidence: id, reason: `Region present in fact ${id}` };
    }
    if (claim.kind === 'region' && Array.isArray(hit.value.value) && (hit.value.value as string[]).includes(claim.token)) {
      if (!factCanSpeakFor(id, subject)) continue;
      return { claim, verdict: 'verified', evidence: id, reason: `Region present in fact ${id}` };
    }
  }

  // 2. Literal presence in retained source text.
  for (const ev of evidenceTexts) {
    const grade = ev.url.startsWith('fact-unit:')
      ? `Value appears in the unit definition of ${ev.url.slice('fact-unit:'.length)} (deterministic, code-defined denominator \u2014 not an API result)`
      : 'Value appears in fetched source text';
    if (claim.kind === 'region' && ev.text.includes(claim.token)) {
      return { claim, verdict: 'verified', evidence: ev.url, reason: 'Region appears verbatim in fetched source' };
    }
    /**
     * A range must be present AS a range. Verifying "30–70%" by finding a 30 is
     * how a claim the source never made ends up with a citation under it.
     */
    if (range) {
      if (!textContainsRange(ev.text, range.lo, range.hi, unitOf(claim.token))) continue;
      return {
        claim,
        verdict: 'verified',
        evidence: ev.url,
        reason: `${grade}, as a complete range (${range.lo}\u2013${range.hi})`,
      };
    }
    const at = numericKind ? numberMatchIndices(ev.text, claim.token, claim.kind === 'money') : [];
    if (!at.length) continue;

    /**
     * If this source reports SEVERAL different values for the same unit, the
     * value appearing in it does not say the claim came from the right row. The
     * feature × region matrix is exactly this shape: thirteen region counts on
     * one page. Require the match to sit near text that identifies the claim's
     * subject specifically, not merely text the claim happens to share words with.
     */
    const unit = unitOf(claim.token);
    const spread = unit ? distinctValuesForUnit(ev.text, unit) : 1;
    if (spread > 1) {
      const identifying = rowDistinctiveIn(ev.text);
      let hitStems: string[] = [];
      const near = at.some((i) => {
        const window = entryWindow(ev.text, i, String(claim.token).length);
        hitStems = stemsOf(window).filter((s) => subject.has(s) && identifying(s));
        return hitStems.length > 0;
      });
      if (!near) continue;
      return {
        claim,
        verdict: 'verified',
        evidence: ev.url,
        reason: `${grade}, in the row identified by ${hitStems.slice(0, 3).join(', ')} (this source reports ${spread} different values for "${unit}", so the matching row had to be pinned down)`,
      };
    }
    return { claim, verdict: 'verified', evidence: ev.url, reason: grade };
  }

  // 3. Nothing supports it. Distinguish "governed but wrong" from "ungoverned".
  if (claim.fact_governed) {
    return {
      claim,
      verdict: 'contradicted',
      evidence: null,
      reason: `Claim sits in a fact-governed slot but no fact or source carries the value "${claim.token}" — the slot and its prose disagree`,
    };
  }
  const dated = claim.kind === 'year' || claim.kind === 'date';
  return {
    claim,
    verdict: dated ? 'unverifiable' : 'unsupported',
    evidence: null,
    reason: dated
      ? `Historical date with no deterministic source in this repo. Needs a What\u2019s New or docs citation (Tier C).`
      : `No fact set or fetched source contains "${claim.token}". Either govern it with a slot or cite a source.`,
  };
}

function safeFormat(id: string, value: Parameters<typeof formatFact>[1]): string | null {
  try {
    return formatFact(id, value);
  } catch {
    return null;
  }
}

/**
 * Verify a whole card and decide its tier.
 *
 * `contradicted` and `unsupported` demote. `unverifiable` also demotes, but is
 * reported separately because the fix is different: one needs a correction, the
 * other needs a citation.
 */
export function verifyCard(card: Card, claims: Claim[], ctx: VerifyContext): CardVerdict {
  const results = claims.map((c) => verifyClaim(c, ctx));
  const counts: Record<Verdict, number> = {
    verified: 0, partial: 0, unsupported: 0, contradicted: 0, unverifiable: 0, judgement: 0,
  };
  for (const r of results) counts[r.verdict]++;

  // `partial` demotes too. A day nobody can attest is still a claim a learner
  // could repeat wrongly — but it is reported separately because the fix is
  // cheap (drop to the month the source does confirm) rather than a correction.
  const failing = counts.contradicted + counts.unsupported + counts.unverifiable + counts.partial;
  const demoted = failing > 0;

  let reason: string;
  if (counts.contradicted) {
    reason = `${counts.contradicted} claim(s) contradict their own fact-governed slot — a correction is needed, not a citation`;
  } else if (counts.unsupported) {
    reason = `${counts.unsupported} claim(s) have no source at all`;
  } else if (counts.partial) {
    reason = `${counts.partial} date(s) confirmed to the month but not the day — drop to month precision or cite a dated post`;
  } else if (counts.unverifiable) {
    reason = `${counts.unverifiable} historical date(s) need a citation no deterministic source can provide`;
  } else if (counts.judgement && !counts.verified) {
    reason = 'Entirely judgement — no checkable claim to verify';
  } else {
    reason = `All ${counts.verified} checkable claim(s) verified against fetched sources`;
  }

  // A card of pure judgement is Tier C by definition, not by failure.
  const tier: 'A' | 'B' | 'C' = demoted || (counts.judgement > 0 && counts.verified === 0) ? 'C' : 'A';

  return { card_id: card.card_id, tier, demoted, results, counts, reason };
}

/**
 * Dated entries from month-precision sources. The URL is the page, not a
 * per-entry anchor, because the release notes do not give entries stable ids.
 */
export function datedEntriesFrom(sets: FactSet[]): DatedEntry[] {
  const out: DatedEntry[] = [];
  for (const s of sets) {
    if (s.source.kind === 'aws-docs-release-notes') {
      const rows = Array.isArray(s.evidence?.canonical) ? (s.evidence.canonical as Record<string, string>[]) : [];
      for (const r of rows) {
        if (!r.iso_month || !r.heading) continue;
        out.push({
          iso_month: String(r.iso_month),
          month_label: String(r.month_label ?? r.iso_month),
          iso_date: null,
          precision: 'month',
          heading: String(r.heading),
          summary: String(r.summary ?? ''),
          url: s.source.url,
        });
      }
      continue;
    }
    if (s.source.kind === 'aws-docs-doc-history') {
      const rows = Array.isArray(s.evidence?.canonical) ? (s.evidence.canonical as Record<string, string>[]) : [];
      for (const r of rows) {
        if (!r.iso_date || !r.heading) continue;
        out.push({
          iso_month: String(r.iso_month ?? String(r.iso_date).slice(0, 7)),
          month_label: String(r.month_label ?? r.date_label ?? r.iso_date),
          iso_date: String(r.iso_date),
          precision: 'day',
          heading: String(r.heading),
          summary: String(r.summary ?? ''),
          url: s.source.url,
        });
      }
    }
  }
  return out;
}

/** What a card is about, as distinctive stems, for topical date matching. */
export function subjectStemsOf(card: Card): string[] {
  // subjectTokens, not stemsOf: a card titled "AgentCore CLI" must be able to
  // match a heading that says CLI.
  return subjectTokens([card.title, card.tags.join(' '), card.service.replace(/-/g, ' ')].join(' '));
}

/** Pull every retained evidence text out of the fact sets. */
export function evidenceTextsFrom(sets: FactSet[]): { url: string; text: string }[] {
  const out = sets
    .filter((s) => s.evidence?.text)
    .map((s) => ({ url: s.source.url, text: s.evidence.text }));

  /**
   * Fact units and notes are evidence too, and a weaker grade of it.
   *
   * A price of "$0.25 per 1,000 events" contains two numbers with different
   * provenance: 0.25 comes from the Price List API, and 1,000 is the denominator
   * of a unit defined in the ingest job's own code. Both are deterministic — no
   * model authored either — but they are not the same strength of claim, so the
   * evidence source is labelled `fact-unit:` to keep the report honest rather
   * than silently presenting a code-defined divisor as an API result.
   */
  for (const s of sets) {
    const defs = Object.entries(s.facts)
      .map(([id, f]) => [id, [f.unit, f.note].filter(Boolean).join(' ')] as const)
      .filter(([, text]) => text);
    for (const [id, text] of defs) {
      out.push({ url: `fact-unit:${id}`, text });
    }
  }
  return out;
}
