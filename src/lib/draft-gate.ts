/**
 * The Tier B gate — what a model is allowed to have written.
 *
 * Tier B is a model-drafted refresh of the PROSE around a card's slots. The slots
 * themselves stay exactly where the human put them, and every number keeps coming
 * from a Tier A fact set. The model rewrites explanation; it never writes a value.
 *
 * WHY THIS IS A SEPARATE GATE FROM L-NUMERIC
 *
 * `validate`'s L-NUMERIC rule asks one question: will this number drift? A date
 * already in the past cannot, so it is exempt — "Bedrock Agents launched in 2023"
 * is settled history and a slot re-rendering it would produce the same string
 * forever.
 *
 * That exemption is sound for prose a HUMAN wrote, because a human vouched for the
 * date. It is unsound here, because the question for a model is not drift, it is
 * FABRICATION — and a fabricated past date is the most plausible-looking error a
 * model can make. Same literal, different question, so a different rule.
 *
 * The rule this gate applies instead: **a model may preserve a numeral, never
 * introduce one.** A digit is permitted only where the identical digit span
 * already appears in the original field. That makes "keep what the human wrote"
 * legal and "add a number of your own" impossible, without needing to know whether
 * any particular number happens to be true.
 *
 * TWO KINDS OF FAILURE, DELIBERATELY NOT COLLAPSED
 *
 *   discard  the model broke the contract — invented a numeral, emitted a URL,
 *            dropped a slot, changed the card's shape. Touch nothing. Do NOT
 *            open a PR: showing a human a fabrication and asking them to spot it
 *            is how a fabrication gets merged.
 *
 *   review   the prose is well-formed but a checkable claim could not be verified
 *            against retained evidence. That is exactly what human review is for,
 *            so it becomes a PR at Tier C.
 *
 *   accept   well-formed AND every checkable claim verified. Writable as tier-b.
 *
 * Collapsing discard into review would mean a contract violation and an
 * unverifiable-but-honest rewrite arrive through the same door, and the reviewer
 * would have no way to tell which they were looking at.
 */

import type { Card } from './types.ts';
import type { VerifyContext } from './verifier.ts';
import { verifyCard, subjectStemsOf } from './verifier.ts';
import { decompose, isCheckable } from './claims.ts';
import { expandSlots } from './facts.ts';

/** The prose a drafter is allowed to return. No slots, no sources, no tiers. */
export type DraftFields = {
  hook: string;
  back: {
    lead: string;
    hookline: string;
    kv: { k: string; v: string }[];
  };
};

export type DraftRuleId =
  | 'NUMERAL_INTRODUCED'
  | 'SLOT_DROPPED'
  | 'SLOT_INVENTED'
  | 'URL_EMITTED'
  | 'FIELD_EMPTY'
  | 'FIELD_TOO_LONG'
  | 'KV_SHAPE_CHANGED'
  | 'CLAIM_UNVERIFIED'
  | 'STYLE_DRIFT';

export type DraftRejection = { rule: DraftRuleId; field: string; detail: string };

export type DraftOutcome = 'accept' | 'review' | 'discard';

export type DraftVerdict = {
  outcome: DraftOutcome;
  rejections: DraftRejection[];
  /**
   * House-style changes that are NOT blocking, listed so a reviewer sees them
   * named rather than having to spot them in a diff. Separate from `rejections`
   * because these do not decide the outcome — except when they are the only
   * change, which is handled in `checkDraft`.
   */
  styleDrift?: DraftRejection[];
  reason: string;
};

/** A slot reference as it appears in prose. */
const SLOT_RE = /\{\{slot:[a-z0-9_-]+\}\}/g;

/**
 * Any digit span, which is broader than L-NUMERIC on purpose.
 *
 * L-NUMERIC targets drift-prone forms (prices, counts with units, years) because
 * it is looking for ungoverned facts. Here the target is the model's hand: "three
 * ways" is fine and "3 ways" is a digit the model chose to type, so the detector
 * has to see plain integers too.
 */
const DIGIT_SPAN_RE = /\d[\d,.]*/g;

/** Prose is capped relative to what the human wrote, not at an absolute length. */
const LENGTH_TOLERANCE = 1.6;

/**
 * HOUSE STYLE, ENFORCED RATHER THAN REQUESTED.
 *
 * The drafter's system prompt asks for Australian English and deliberate
 * punctuation. A prompt is advisory: the first two real drafts changed
 * `afterwards` → `afterward` and stripped the spaces around an em dash, and both
 * passed every gate — correctly, because neither is a fact and the verifier has no
 * opinion about spelling.
 *
 * That is the exact shape of a problem this repository has hit before: prose in a
 * prompt does not bind, a deterministic check does. Across a few hundred cards
 * those substitutions are a slow Americanisation of the deck's voice that nobody
 * chose, and each individual instance is too small to notice in review.
 *
 * So the drift is detected and NAMED. Two consequences, deliberately different:
 *
 *   some changes are style, some are real  →  report the style ones in the PR body
 *                                            so a reviewer sees them called out
 *                                            instead of hunting them in a diff
 *
 *   EVERY change is style               →  discard. A rewrite that alters nothing
 *                                            but spelling has not earned a review,
 *                                            and spending a human read on it is
 *                                            how a review queue stops being read.
 *
 * The pair list is deliberately short and observed rather than exhaustive: a full
 * US/UK dictionary would be a dependency and a maintenance burden, and the goal is
 * to catch the systematic substitutions a model actually makes.
 */
const STYLE_PAIRS: [RegExp, string][] = [
  [/\b(\w+?)ization\b/gi, '$1isation'],
  [/\b(\w+?)ize\b/gi, '$1ise'],
  [/\b(\w+?)izes\b/gi, '$1ises'],
  [/\b(\w+?)ized\b/gi, '$1ised'],
  [/\b(\w+?)izing\b/gi, '$1ising'],
  [/\b(\w+?)or\b/gi, '$1our'],
  [/\bafterward\b/gi, 'afterwards'],
  [/\btoward\b/gi, 'towards'],
  [/\bcenter\b/gi, 'centre'],
  [/\bmeter\b/gi, 'metre'],
];

/**
 * Reduce a string to a form where only SUBSTANTIVE differences survive.
 *
 * Spelling variants are normalised to one side, em-dash spacing is regularised and
 * runs of whitespace collapse. If two strings match after this, whatever changed
 * between them was style.
 */
export function styleNormalise(text: string): string {
  let s = text.toLowerCase();
  for (const [re, to] of STYLE_PAIRS) s = s.replace(re, to);
  s = s.replace(/\s*—\s*/g, ' — ');   // em dash always spaced
  s = s.replace(/\s*–\s*/g, ' – ');   // en dash likewise
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** True when the only difference between two strings is house style. */
export function isStyleOnlyChange(before: string, after: string): boolean {
  return before !== after && styleNormalise(before) === styleNormalise(after);
}

function slotsIn(text: string): string[] {
  return (text.match(SLOT_RE) ?? []).slice().sort();
}

/** Digit spans OUTSIDE slot tokens — a slot's own name never contains digits we own. */
function digitSpansOutsideSlots(text: string): string[] {
  const withoutSlots = text.replace(SLOT_RE, ' ');
  return (withoutSlots.match(DIGIT_SPAN_RE) ?? []).map((s) => s.replace(/[.,]$/, ''));
}

function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * The field-level contract. Structural only — nothing here consults a source.
 *
 * Kept separate from the claim check so that a malformed draft is rejected before
 * any evidence is consulted: there is no point asking whether an invented number
 * is supported.
 */
export function checkDraftShape(original: Card, draft: DraftFields): DraftRejection[] {
  const out: DraftRejection[] = [];

  const pairs: [string, string, string][] = [
    ['hook', original.hook, draft.hook],
    ['back.lead', original.back.lead, draft.back.lead],
    ['back.hookline', original.back.hookline, draft.back.hookline],
  ];

  // The model may rewrite a kv VALUE. It may not add, drop or rename a key: the
  // keys are the card's shape, and reshaping a card is a Tier C decision.
  const origKeys = original.back.kv.map((r) => r.k);
  const draftKeys = draft.back.kv.map((r) => r.k);
  if (origKeys.length !== draftKeys.length || origKeys.some((k, i) => k !== draftKeys[i])) {
    out.push({
      rule: 'KV_SHAPE_CHANGED',
      field: 'back.kv',
      detail: `keys must be preserved exactly: expected [${origKeys.join(', ')}], got [${draftKeys.join(', ')}]`,
    });
  } else {
    original.back.kv.forEach((r, i) => {
      pairs.push([`back.kv[${i}].v`, r.v, draft.back.kv[i].v]);
    });
  }

  for (const [field, before, after] of pairs) {
    if (typeof after !== 'string' || after.trim() === '') {
      out.push({ rule: 'FIELD_EMPTY', field, detail: 'a drafted field may not be empty' });
      continue;
    }

    if (/https?:\/\//i.test(after)) {
      out.push({
        rule: 'URL_EMITTED',
        field,
        detail: 'a citation comes from a fact set, never from the model — a drafted URL cannot be trusted to exist',
      });
    }

    const beforeSlots = slotsIn(before);
    const afterSlots = slotsIn(after);
    if (!sameMultiset(beforeSlots, afterSlots)) {
      const dropped = beforeSlots.filter((s) => !afterSlots.includes(s));
      const invented = afterSlots.filter((s) => !beforeSlots.includes(s));
      if (dropped.length) {
        out.push({
          rule: 'SLOT_DROPPED',
          field,
          detail: `dropping ${dropped.join(', ')} would replace a governed value with prose`,
        });
      }
      if (invented.length) {
        out.push({
          rule: 'SLOT_INVENTED',
          field,
          detail: `${invented.join(', ')} is not a slot this card declares`,
        });
      }
    }

    // "May preserve, never introduce."
    const allowed = digitSpansOutsideSlots(before);
    const used = digitSpansOutsideSlots(after);
    const pool = allowed.slice();
    for (const span of used) {
      const at = pool.indexOf(span);
      if (at === -1) {
        out.push({
          rule: 'NUMERAL_INTRODUCED',
          field,
          detail: `${JSON.stringify(span)} does not appear in the original field — a number must come from a slot, not from the model`,
        });
      } else {
        pool.splice(at, 1);
      }
    }

    if (after.length > Math.ceil(before.length * LENGTH_TOLERANCE) + 40) {
      out.push({
        rule: 'FIELD_TOO_LONG',
        field,
        detail: `${after.length} chars against ${before.length} original — a refresh rewrites, it does not expand`,
      });
    }
  }

  return out;
}

/**
 * The whole gate. Shape first, then claims.
 *
 * `ctx` is optional so the structural half is testable with no fact store, which
 * is also how CI checks it without credentials.
 */
export function checkDraft(original: Card, draft: DraftFields, ctx?: VerifyContext): DraftVerdict {
  const rejections = checkDraftShape(original, draft);

  if (rejections.length > 0) {
    return {
      outcome: 'discard',
      rejections,
      reason: `the draft broke the Tier B contract (${rejections.map((r) => r.rule).join(', ')}) — nothing written, no PR opened`,
    };
  }

  // House style. Runs before the claim check because a rewrite that changed nothing
  // but spelling should not cost an evidence pass, let alone a human read.
  const fieldPairs: [string, string, string][] = [
    ['hook', original.hook, draft.hook],
    ['back.lead', original.back.lead, draft.back.lead],
    ['back.hookline', original.back.hookline, draft.back.hookline],
    ...original.back.kv.map(
      (r, i) => [`back.kv[${i}].v`, r.v, draft.back.kv[i]?.v ?? r.v] as [string, string, string],
    ),
  ];

  const changed = fieldPairs.filter(([, b, a]) => b !== a);
  const styleOnly = changed.filter(([, b, a]) => isStyleOnlyChange(b, a));
  const substantive = changed.filter(([, b, a]) => !isStyleOnlyChange(b, a));

  const styleDrift: DraftRejection[] = styleOnly.map(([field]) => ({
    rule: 'STYLE_DRIFT' as const,
    field,
    detail: 'this field changed only by spelling or punctuation variant — house style is Australian English with spaced em dashes',
  }));

  if (changed.length > 0 && substantive.length === 0) {
    return {
      outcome: 'discard',
      rejections: styleDrift,
      styleDrift,
      reason: `every changed field differs only by house style (${styleOnly.length} field(s)) — a rewrite that alters nothing but spelling has not earned a review`,
    };
  }

  if (changed.length === 0) {
    return {
      outcome: 'discard',
      rejections: [],
      reason: 'the draft is identical to the card — nothing to review',
    };
  }

  if (!ctx) {
    return {
      outcome: 'review',
      rejections,
      styleDrift: styleDrift.length ? styleDrift : undefined,
      reason: 'well-formed, but no verification context was supplied — cannot claim verified, so it routes to review',
    };
  }

  // Verify the drafted prose the way any card is verified: decompose into claims
  // and string-match each against retained source text. The drafter gets no
  // special treatment; it is held to the same bar as a human author.
  //
  // SLOTS MUST BE EXPANDED FIRST. Found by running it: the first real invocation
  // reported "ACCEPT — every checkable claim verified (0)". Zero. The draft's prose
  // still contained the literal token `{{slot:region_availability}}`, so the number
  // it renders to was not in the text being decomposed, so there was nothing
  // numeric to claim and nothing to check. The gate was passing a draft it had not
  // examined, and saying "verified" while doing it.
  const expand = (t: string) => expandSlots(t, original);
  const resolved = {
    t: expand(original.title),
    hook: expand(draft.hook),
    back: {
      lead: expand(draft.back.lead),
      kv: draft.back.kv.map((r) => [r.k, expand(r.v)] as [string, string]),
      hookline: expand(draft.back.hookline),
    },
  };

  const claims = decompose(original, resolved);
  const verdict = verifyCard(original, claims, { ...ctx, subjectStems: ctx.subjectStems ?? subjectStemsOf(original) });

  const checkable = verdict.results.filter((r) => isCheckable(r.claim.kind));
  const unverified = checkable.filter((r) => r.verdict !== 'verified');

  if (unverified.length > 0) {
    return {
      outcome: 'review',
      rejections: unverified.map((r) => ({
        rule: 'CLAIM_UNVERIFIED' as const,
        field: r.claim.field,
        detail: `${r.verdict}: ${r.reason}`,
      })),
      styleDrift: styleDrift.length ? styleDrift : undefined,
      reason: `${unverified.length} of ${checkable.length} checkable claim(s) could not be verified — demoted to Tier C and routed to a PR`,
    };
  }

  // NOTHING CHECKED IS NOT THE SAME AS CHECKED AND CORRECT.
  //
  // A draft with no checkable claims — pure explanation, no number, no date —
  // trivially satisfies "no claim failed", and an earlier version of this function
  // read that as acceptance. But if nothing could be verified then there is no
  // evidence the rewrite is faithful to its source, which is the same error as
  // stamping a fresh verified_at on a claim whose fact failed to fetch.
  //
  // So acceptance requires at least one claim that actually passed. Prose carrying
  // no checkable claim is a judgement rewrite, and a judgement goes to a human.
  if (checkable.length === 0) {
    return {
      outcome: 'review',
      rejections: [],
      styleDrift: styleDrift.length ? styleDrift : undefined,
      reason: 'no checkable claim in the draft, so nothing was verified — a rewrite that cannot be checked goes to review, never straight in',
    };
  }

  return {
    outcome: 'accept',
    rejections: [],
    styleDrift: styleDrift.length ? styleDrift : undefined,
    reason: `well-formed and all ${checkable.length} checkable claim(s) verified — writable as tier-b`,
  };
}
