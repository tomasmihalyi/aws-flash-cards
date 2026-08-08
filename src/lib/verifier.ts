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

export type Verdict = 'verified' | 'unsupported' | 'contradicted' | 'unverifiable' | 'judgement';

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

function textContainsNumber(text: string, token: string): boolean {
  const want = numeric(token);
  if (!want) return false;
  const haystack = text.replace(/,/g, '');
  // Match the number with optional trailing zeros, not as part of a longer number.
  const re = new RegExp(`(?<![\\d.])${want.replace('.', '\\.')}0*(?![\\d])`);
  return re.test(haystack);
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
export function verifyClaim(claim: Claim, store: FactStore, evidenceTexts: { url: string; text: string }[]): ClaimResult {
  if (!isCheckable(claim.kind)) {
    return {
      claim,
      verdict: 'judgement',
      evidence: null,
      reason: 'Positioning or framing. Not checkable against a source; routed to Tier C by definition.',
    };
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
export function verifyCard(
  card: Card,
  claims: Claim[],
  store: FactStore,
  evidenceTexts: { url: string; text: string }[],
): CardVerdict {
  const results = claims.map((c) => verifyClaim(c, store, evidenceTexts));
  const counts: Record<Verdict, number> = {
    verified: 0, unsupported: 0, contradicted: 0, unverifiable: 0, judgement: 0,
  };
  for (const r of results) counts[r.verdict]++;

  const failing = counts.contradicted + counts.unsupported + counts.unverifiable;
  const demoted = failing > 0;

  let reason: string;
  if (counts.contradicted) {
    reason = `${counts.contradicted} claim(s) contradict their own fact-governed slot — a correction is needed, not a citation`;
  } else if (counts.unsupported) {
    reason = `${counts.unsupported} claim(s) have no source at all`;
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
