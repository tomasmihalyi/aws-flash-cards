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

/** A dated entry from a month-precision source (documentation release notes). */
export type DatedEntry = {
  iso_month: string;
  month_label: string;
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
        .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
        .map(stem)
        .filter(Boolean),
    ),
  ];
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
  const entryStems = new Set(stemsOf(`${entry.heading} ${entry.summary}`));
  return subjectStems.filter((s) => entryStems.has(s)).length;
}

/** Two shared distinctive stems. One is too easy; three is too strict in practice. */
const TOPICAL_THRESHOLD = 2;

/**
 * Verify a date or year claim against month-precision dated entries.
 *
 * Three honest outcomes:
 *   verified      the claim's precision is month-or-coarser and a topically
 *                 related entry exists in that month
 *   partial       the claim names a DAY. The month and the subject are attested,
 *                 the day is not — this source cannot see days at all
 *   contradicted  related entries exist, but in a different month
 */
function verifyDate(claim: Claim, ctx: VerifyContext): ClaimResult | null {
  const parsed = parseClaimDate(claim.token);
  if (!parsed || !ctx.datedEntries.length) return null;

  // Subject terms come from the claim's own sentence as well as the card, because
  // a lifecycle claim ("generally available Oct 13 2025") carries its own topic.
  const subject = [...new Set([...ctx.subjectStems, ...stemsOf(claim.context)])];

  const scored = ctx.datedEntries
    .map((e) => ({ e, score: topicalScore(e, subject) }))
    .filter((x) => x.score >= TOPICAL_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return {
      claim,
      verdict: 'unverifiable',
      evidence: null,
      reason: `No release-notes entry is topically related to this claim, so its date cannot be attested. Needs a specific docs or What\u2019s New citation.`,
    };
  }

  const wantMonth = isoMonthOf(parsed);
  const sameMonth = wantMonth ? scored.filter((x) => x.e.iso_month === wantMonth) : [];
  const sameYear = scored.filter((x) => x.e.iso_month.startsWith(String(parsed.year)));

  if (wantMonth && sameMonth.length) {
    const hit = sameMonth[0].e;
    if (parsed.day !== null) {
      return {
        claim,
        verdict: 'partial',
        evidence: hit.url,
        reason: `${hit.month_label} confirmed by release notes ("${hit.heading}"), but this source is month-precision and cannot attest the day "${parsed.day}". Either drop to month precision or cite a dated What\u2019s New post.`,
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
  const m = /([A-Za-z][A-Za-z-]{2,})\s*$/.exec(token.trim());
  if (!m) return null;
  return m[1].toLowerCase().replace(/s$/, '');
}

function textContainsNumber(text: string, token: string): boolean {
  const want = numeric(token);
  if (!want) return false;
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
  const re = new RegExp(`(?<![\\w.])${body}(?![\\d])(?!\\.\\d)`, 'g');

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
  for (const m of haystack.matchAll(re)) {
    if (!unit) return true;
    const after = haystack.slice(m.index + m[0].length, m.index + m[0].length + 48).toLowerCase();
    // Already counting something else.
    if (/^\s*(?:%|percent)/.test(after) && !unit.startsWith('percent')) continue;
    if (new RegExp(`^(?:\\s+[\\w().,'-]+){0,3}\\s*${unit}`).test(after)) return true;
  }
  return false;
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
  for (const id of store.ids()) {
    const hit = store.get(id);
    if (!hit) continue;
    const rendered = safeFormat(id, hit.value);
    if (rendered === null) continue;
    if (numeric(claim.token) !== null && numeric(rendered) === numeric(claim.token)) {
      return {
        claim,
        verdict: 'verified',
        evidence: id,
        reason: `Matches fact ${id} (${rendered}) from ${hit.set.source.url}`,
      };
    }
    if (claim.kind === 'region' && String(hit.value.value).includes(claim.token)) {
      return { claim, verdict: 'verified', evidence: id, reason: `Region present in fact ${id}` };
    }
    if (claim.kind === 'region' && Array.isArray(hit.value.value) && (hit.value.value as string[]).includes(claim.token)) {
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
    if (textContainsNumber(ev.text, claim.token)) {
      return { claim, verdict: 'verified', evidence: ev.url, reason: grade };
    }
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
    if (s.source.kind !== 'aws-docs-release-notes') continue;
    const rows = Array.isArray(s.evidence?.canonical) ? (s.evidence.canonical as Record<string, string>[]) : [];
    for (const r of rows) {
      if (!r.iso_month || !r.heading) continue;
      out.push({
        iso_month: String(r.iso_month),
        month_label: String(r.month_label ?? r.iso_month),
        heading: String(r.heading),
        summary: String(r.summary ?? ''),
        url: s.source.url,
      });
    }
  }
  return out;
}

/** What a card is about, as distinctive stems, for topical date matching. */
export function subjectStemsOf(card: Card): string[] {
  return stemsOf([card.title, card.tags.join(' '), card.service.replace(/-/g, ' ')].join(' '));
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
