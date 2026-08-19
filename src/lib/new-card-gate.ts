/**
 * The Tier B gate for a BRAND-NEW card — no prior state to diff against.
 *
 * draft-gate.ts's checkDraftShape() is a DIFF gate: every one of its rules
 * (SLOT_DROPPED, NUMERAL_INTRODUCED, KV_SHAPE_CHANGED) is phrased as "does the
 * draft deviate from what the card already said". A brand-new card has no
 * `original` to deviate from, so that gate's contract is not merely
 * inapplicable here, it is meaningless: there is nothing to preserve.
 *
 * The equivalent contract for new-card creation is the one the rest of this
 * repo already uses for INGESTING a fact: a number is legal only where it
 * appears verbatim in the retained SOURCE evidence (the coverage gap's own
 * dated entry), never merely because the model wrote something plausible.
 * "May preserve, never introduce" becomes "may cite, never invent".
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not decide whether a gap is WORTH a card, how to frame one, or what
 * category it belongs in — those are judgement calls with no source that can
 * settle them, so the drafted card always carries needs_review: true and a
 * `[NEEDS REVIEW]`-tagged open question in its PR body (see
 * src/ingest/draft-new-card.ts). This gate only decides whether the draft's
 * CLAIMS are grounded. Grounded-but-unreviewed is the only outcome a new card
 * can ever reach; there is no `accept`-without-review door here, unlike the
 * update path's Tier B accept.
 */

import type { Card } from './types.ts';
import { decompose, isCheckable } from './claims.ts';
import { verifyCard, type VerifyContext } from './verifier.ts';

export type NewCardDraft = {
  card_id: string;
  title: string;
  hook: string;
  category: string;
  service: string;
  tags: string[];
  back: { lead: string; hookline: string; kv: { k: string; v: string }[] };
};

export type NewCardRuleId =
  | 'FIELD_EMPTY'
  | 'URL_EMITTED'
  | 'NUMERAL_UNGROUNDED'
  | 'TOO_FEW_KV'
  | 'TOO_MANY_KV'
  | 'UNKNOWN_CATEGORY'
  | 'FIELD_TOO_LONG'
  | 'CLAIM_UNVERIFIED';

export type NewCardRejection = { rule: NewCardRuleId; field: string; detail: string };

export type NewCardVerdict = {
  outcome: 'review' | 'discard';
  rejections: NewCardRejection[];
  reason: string;
};

const DIGIT_SPAN_RE = /\d[\d,.]*/g;
const MAX_FIELD_LEN = 400;
const MIN_KV = 1;
const MAX_KV = 4;

/** Every digit span appearing verbatim in the source evidence text. */
function groundedNumerals(evidenceTexts: { text: string }[]): Set<string> {
  const pool = new Set<string>();
  for (const { text } of evidenceTexts) {
    for (const m of text.matchAll(DIGIT_SPAN_RE)) pool.add(m[0].replace(/[.,]$/, ''));
  }
  return pool;
}

/**
 * Structural contract for a new card. No source is consulted here — a
 * malformed draft is rejected before any evidence is looked at, same
 * ordering as draft-gate.ts.
 */
export function checkNewCardShape(
  draft: NewCardDraft,
  evidenceTexts: { text: string }[],
  knownCategories: Set<string>,
): NewCardRejection[] {
  const out: NewCardRejection[] = [];

  const fields: [string, string][] = [
    ['title', draft.title],
    ['hook', draft.hook],
    ['back.lead', draft.back.lead],
    ['back.hookline', draft.back.hookline],
    ...draft.back.kv.map((r, i) => [`back.kv[${i}].v`, r.v] as [string, string]),
  ];

  if (!knownCategories.has(draft.category)) {
    out.push({
      rule: 'UNKNOWN_CATEGORY',
      field: 'category',
      detail: `"${draft.category}" is not in content/categories.json — a category id must not be invented`,
    });
  }

  if (draft.back.kv.length < MIN_KV) {
    out.push({ rule: 'TOO_FEW_KV', field: 'back.kv', detail: `${draft.back.kv.length} entries, need at least ${MIN_KV}` });
  }
  if (draft.back.kv.length > MAX_KV) {
    out.push({ rule: 'TOO_MANY_KV', field: 'back.kv', detail: `${draft.back.kv.length} entries, at most ${MAX_KV} — one idea per card` });
  }

  const grounded = groundedNumerals(evidenceTexts);

  for (const [field, text] of fields) {
    if (typeof text !== 'string' || text.trim() === '') {
      out.push({ rule: 'FIELD_EMPTY', field, detail: 'a drafted field may not be empty' });
      continue;
    }
    if (/https?:\/\//i.test(text)) {
      out.push({
        rule: 'URL_EMITTED',
        field,
        detail: 'a citation comes from the fact set / dated entry, never typed by the model',
      });
    }
    if (text.length > MAX_FIELD_LEN) {
      out.push({ rule: 'FIELD_TOO_LONG', field, detail: `${text.length} chars, over the ${MAX_FIELD_LEN}-char cap for a new field` });
    }
    for (const m of text.matchAll(DIGIT_SPAN_RE)) {
      const span = m[0].replace(/[.,]$/, '');
      if (!grounded.has(span)) {
        out.push({
          rule: 'NUMERAL_UNGROUNDED',
          field,
          detail: `${JSON.stringify(span)} does not appear verbatim in the source evidence — a number must be cited, not composed`,
        });
      }
    }
  }

  return out;
}

/**
 * The whole new-card gate: shape, then claim verification.
 *
 * There is no `accept` outcome. Even a draft whose every checkable claim
 * verifies still needs a human to confirm the card is worth having and
 * correctly framed — that is why every path through this function returns
 * `review`, never `accept`.
 */
export function checkNewCard(
  draft: NewCardDraft,
  ctx: VerifyContext,
  knownCategories: Set<string>,
): NewCardVerdict {
  const shapeRejections = checkNewCardShape(draft, ctx.evidenceTexts, knownCategories);
  if (shapeRejections.length > 0) {
    return {
      outcome: 'discard',
      rejections: shapeRejections,
      reason: `the draft broke the new-card contract (${shapeRejections.map((r) => r.rule).join(', ')}) — nothing written, no PR opened`,
    };
  }

  // Build a minimal Card shape sufficient for decompose()/verifyCard(), which
  // are already general-purpose pure functions over any Card, not restricted
  // to loadCards(). Slots are intentionally empty: a freshly drafted card has
  // no fact-governed slot yet, so every numeral in it must instead be grounded
  // directly in the source text (checked above) and every claim must verify
  // against retained evidence (checked below).
  const asCard = {
    card_id: draft.card_id,
    title: draft.title,
    hook: draft.hook,
    category: draft.category,
    service: draft.service,
    tags: draft.tags,
    slots: {},
    back: { lead: draft.back.lead, hookline: draft.back.hookline, kv: draft.back.kv },
  } as unknown as Card;

  const claims = decompose(asCard, {
    t: draft.title,
    hook: draft.hook,
    back: {
      lead: draft.back.lead,
      kv: draft.back.kv.map((r) => [r.k, r.v] as [string, string]),
      hookline: draft.back.hookline,
    },
  });

  const verdict = verifyCard(asCard, claims, ctx);
  const checkable = verdict.results.filter((r) => isCheckable(r.claim.kind));
  const unverified = checkable.filter((r) => r.verdict !== 'verified');

  if (unverified.length > 0) {
    return {
      outcome: 'discard',
      rejections: unverified.map((r) => ({
        rule: 'CLAIM_UNVERIFIED' as const,
        field: r.claim.field,
        detail: `${r.verdict}: ${r.reason}`,
      })),
      reason: `${unverified.length} of ${checkable.length} checkable claim(s) could not be verified against the source entry — nothing written, no PR opened`,
    };
  }

  return {
    outcome: 'review',
    rejections: [],
    reason: checkable.length
      ? `all ${checkable.length} checkable claim(s) verified against the source entry — still needs a human to confirm the card is worth having and well-framed`
      : 'no checkable (numeric/date/region) claim in the draft — needs a human read regardless',
  };
}
