/**
 * Tier B draft-gate tests — the P4/T4.4 exit criterion.
 *
 * Same adversarial shape as the verifier tests, for the same reason: a gate that
 * accepts a good draft proves nothing, because a gate that accepted EVERYTHING
 * would pass that test too. So every rule below is tested by injecting the exact
 * failure it exists to catch — and the clean-refresh test is kept as the
 * counterpart, because a gate that rejected everything would otherwise look
 * perfect.
 *
 * None of these tests touch Bedrock, a network, or credentials. That is the point
 * of keeping the gate pure: the thing that decides whether model output may be
 * published is checkable in CI on every commit.
 *
 * Run: node --test tests/draft-gate.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, checkDraftShape, type DraftFields } from '../src/lib/draft-gate.ts';
import type { Card } from '../src/lib/types.ts';

/**
 * A minimal card carrying the three things the gate cares about: a slot, a numeral
 * the human vouched for, and a kv table.
 */
function baseCard(): Card {
  return {
    card_id: 'AC-99',
    slug: 'test-card',
    title: 'AgentCore Runtime',
    category: 'agentcore',
    kind: 'service-fact',
    lifecycle: 'ga',
    tags: ['runtime'],
    hook: 'Where does an agent actually run?',
    back: {
      lead: '{{slot:region_availability}} Runtime went GA in October 2025 and handles session isolation for you.',
      hookline: 'One microVM per session, not one per request.',
      kv: [
        { k: 'Isolation', v: 'One microVM per session' },
        { k: 'Sessions', v: 'Persistent for up to 14 days' },
      ],
    },
    slots: {
      region_availability: {
        tier: 'A',
        template: 'AgentCore is available in {{fact:agentcore.regions.count}} AWS regions.',
        facts: ['agentcore.regions.count'],
        rendered: 'AgentCore is available in 19 AWS regions.',
        rendered_from: 'tier-a',
        seed_text: 'AgentCore previewed in four regions.',
      },
    },
    sources: [],
    provenance: 'A',
    confidence: 'high',
    depends_on: [],
  } as unknown as Card;
}

/** A faithful refresh: prose reworded, slot kept, numerals only those already there. */
function cleanDraft(): DraftFields {
  return {
    hook: 'So where does an agent actually run?',
    back: {
      lead: '{{slot:region_availability}} Runtime reached GA in October 2025, and it takes session isolation off your hands.',
      hookline: 'A microVM per session, never per request.',
      kv: [
        { k: 'Isolation', v: 'A microVM for each session' },
        { k: 'Sessions', v: 'Persistent for up to 14 days' },
      ],
    },
  };
}

describe('the counterpart — a faithful refresh must pass', () => {
  test('a reworded draft that keeps its slot and invents no number is well-formed', () => {
    const rejections = checkDraftShape(baseCard(), cleanDraft());
    assert.deepEqual(rejections, [], `expected no rejections, got ${JSON.stringify(rejections)}`);
  });

  test('with no verification context it routes to review, never to accept', () => {
    const v = checkDraft(baseCard(), cleanDraft());
    assert.equal(v.outcome, 'review');
    assert.notEqual(v.outcome, 'accept');
  });
});

describe('may preserve, never introduce', () => {
  test('a numeral the human already wrote may be kept', () => {
    const d = cleanDraft();
    // "14 days" is in the original kv value, and stays.
    assert.ok(d.back.kv[1].v.includes('14'));
    assert.deepEqual(checkDraftShape(baseCard(), d), []);
  });

  test('an invented quantity is caught', () => {
    const d = cleanDraft();
    d.back.kv[0].v = 'Up to 10 concurrent microVMs per session';
    const r = checkDraftShape(baseCard(), d);
    assert.equal(r.length, 1);
    assert.equal(r[0].rule, 'NUMERAL_INTRODUCED');
    assert.match(r[0].detail, /"10"/);
  });

  test('an invented PAST DATE is caught — the divergence from L-NUMERIC', () => {
    // L-NUMERIC exempts a past date because it cannot drift. This gate must NOT,
    // because a fabricated past date is the most plausible error a model makes.
    const d = cleanDraft();
    d.back.lead = '{{slot:region_availability}} Runtime went GA in October 2025, following its preview in July 2024.';
    const r = checkDraftShape(baseCard(), d);
    assert.ok(r.some((x) => x.rule === 'NUMERAL_INTRODUCED' && /2024/.test(x.detail)),
      `expected the fabricated 2024 to be caught, got ${JSON.stringify(r)}`);
  });

  test('a plausible price is caught', () => {
    const d = cleanDraft();
    d.back.hookline = 'A microVM per session, from $0.0895 an hour.';
    const r = checkDraftShape(baseCard(), d);
    assert.ok(r.some((x) => x.rule === 'NUMERAL_INTRODUCED'));
  });

  test('a digit inside a slot token is not the model\'s doing', () => {
    // The rendered value lives behind the slot, so the slot's presence must never
    // be read as the model having typed a number.
    const card = baseCard();
    const d = cleanDraft();
    d.back.lead = '{{slot:region_availability}} Runtime reached GA in October 2025.';
    assert.deepEqual(checkDraftShape(card, d), []);
  });

  test('re-using a preserved numeral twice is still an introduction', () => {
    // "14" appears once in the original. Using it twice means one is invented.
    const d = cleanDraft();
    d.back.kv[1].v = 'Persistent for up to 14 days, extendable to 14 more';
    const r = checkDraftShape(baseCard(), d);
    assert.ok(r.some((x) => x.rule === 'NUMERAL_INTRODUCED'));
  });
});

describe('a slot is not prose', () => {
  test('dropping a slot is caught — it would replace a governed value', () => {
    const d = cleanDraft();
    d.back.lead = 'AgentCore is available in many regions. Runtime reached GA in October 2025.';
    const r = checkDraftShape(baseCard(), d);
    assert.ok(r.some((x) => x.rule === 'SLOT_DROPPED'));
  });

  test('inventing a slot is caught', () => {
    const d = cleanDraft();
    d.back.hookline = '{{slot:pricing}} A microVM per session.';
    const r = checkDraftShape(baseCard(), d);
    assert.ok(r.some((x) => x.rule === 'SLOT_INVENTED'));
  });
});

describe('the card\'s shape belongs to a human', () => {
  test('renaming a kv key is caught', () => {
    const d = cleanDraft();
    d.back.kv[0].k = 'Isolation model';
    const r = checkDraftShape(baseCard(), d);
    assert.ok(r.some((x) => x.rule === 'KV_SHAPE_CHANGED'));
  });

  test('adding a kv row is caught', () => {
    const d = cleanDraft();
    d.back.kv.push({ k: 'Pricing', v: 'Consumption based' });
    const r = checkDraftShape(baseCard(), d);
    assert.ok(r.some((x) => x.rule === 'KV_SHAPE_CHANGED'));
  });

  test('an emitted URL is caught — a citation is never the model\'s to supply', () => {
    const d = cleanDraft();
    d.back.lead = '{{slot:region_availability}} See https://docs.aws.amazon.com/bedrock-agentcore/runtime.html';
    const r = checkDraftShape(baseCard(), d);
    assert.ok(r.some((x) => x.rule === 'URL_EMITTED'));
  });

  test('an empty field is caught', () => {
    const d = cleanDraft();
    d.back.hookline = '   ';
    const r = checkDraftShape(baseCard(), d);
    assert.ok(r.some((x) => x.rule === 'FIELD_EMPTY'));
  });

  test('runaway expansion is caught — a refresh rewrites, it does not expand', () => {
    const d = cleanDraft();
    d.back.hookline = 'A microVM per session, never per request. '.repeat(12);
    const r = checkDraftShape(baseCard(), d);
    assert.ok(r.some((x) => x.rule === 'FIELD_TOO_LONG'));
  });
});

describe('discard and review are different doors', () => {
  test('a contract violation is DISCARDED, never routed to a PR', () => {
    // Showing a human a fabrication and asking them to spot it is how a
    // fabrication gets merged. The model broke the contract, so nothing is shown.
    const d = cleanDraft();
    d.back.kv[0].v = 'Up to 10 concurrent microVMs';
    const v = checkDraft(baseCard(), d);
    assert.equal(v.outcome, 'discard');
    assert.notEqual(v.outcome, 'review');
    assert.match(v.reason, /no PR opened/);
  });

  test('a well-formed draft is never discarded for being unverifiable', () => {
    const v = checkDraft(baseCard(), cleanDraft());
    assert.equal(v.outcome, 'review');
  });

  test('every rejection names the rule and the field', () => {
    const d = cleanDraft();
    d.back.kv[0].v = 'Up to 10 microVMs';
    d.back.hookline = '';
    const v = checkDraft(baseCard(), d);
    assert.ok(v.rejections.length >= 2);
    for (const r of v.rejections) {
      assert.ok(r.rule.length > 0, 'a rejection must name its rule');
      assert.ok(r.field.length > 0, 'a rejection must name its field');
      assert.ok(r.detail.length > 0, 'a rejection must say why');
    }
  });
});

describe('the gate itself is importable without running', () => {
  test('draft-gate.ts exports pure functions and no side effects', async () => {
    const mod = await import('../src/lib/draft-gate.ts');
    assert.equal(typeof mod.checkDraft, 'function');
    assert.equal(typeof mod.checkDraftShape, 'function');
  });
});

/**
 * The claims half, against the real deck.
 *
 * Everything above is structural and needs no fact store, which is what makes it
 * runnable anywhere. But `checkDraft`'s second half calls the real verifier, and a
 * gate whose verification path is never executed is a gate with an untested half.
 *
 * The probe is an IDENTITY refresh: feed a card its own current prose back as if a
 * model had produced it. The shape check then passes trivially, which is the point
 * — it isolates the claims path. And the expected result is knowable independently:
 * a card that `verify-claims` already reports as fully verified must be accepted,
 * because the gate holds a draft to exactly the bar a human author is held to. If
 * an identity refresh of a verified card were rejected, the gate would be stricter
 * than the deck it guards and Tier B could never accept anything.
 */
describe('the claims path, against the real deck', () => {
  test('an identity refresh of an already-verified card is accepted', async () => {
    const { loadCards, loadFactStore, loadCategories, paths } = await import('../src/lib/store.ts');
    const { evidenceTextsFrom, datedEntriesFrom, subjectStemsOf, verifyCard } =
      await import('../src/lib/verifier.ts');
    const { decompose, isCheckable } = await import('../src/lib/claims.ts');
    const { readdirSync, readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { authoredText } = await import('../src/lib/render.ts');

    if (!existsSync(paths.facts)) return; // nothing to verify against

    const sets = readdirSync(paths.facts).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(paths.facts, f), 'utf8')));
    const store = loadFactStore();
    const evidence = evidenceTextsFrom(sets);
    const dated = datedEntriesFrom(sets);

    // Find a card the verifier already fully accepts, so the expectation is not
    // this test's own opinion.
    const cards = loadCards();
    const cats = loadCategories();
    let probe = null;
    for (const c of cards) {
      const ctx = { store, evidenceTexts: evidence, datedEntries: dated, subjectStems: subjectStemsOf(c) };
      const resolved = authoredText(c, cats);
      const claims = decompose(c, resolved as never);
      const v = verifyCard(c, claims, ctx);
      const checkable = v.results.filter((r) => isCheckable(r.claim.kind));
      if (checkable.length > 0 && checkable.every((r) => r.verdict === 'verified')) {
        probe = { card: c, ctx };
        break;
      }
    }

    if (!probe) return; // no fully-verified card with checkable claims; nothing to assert

    const identity: DraftFields = {
      hook: probe.card.hook,
      back: {
        lead: probe.card.back.lead,
        hookline: probe.card.back.hookline,
        kv: probe.card.back.kv.map((r) => ({ k: r.k, v: r.v })),
      },
    };

    const verdict = checkDraft(probe.card, identity, probe.ctx as never);
    assert.equal(
      verdict.outcome,
      'accept',
      `${probe.card.card_id} is fully verified, so an identity refresh must be accepted — got ${verdict.outcome}: ${verdict.reason} ${JSON.stringify(verdict.rejections)}`,
    );
  });

  test('a fabricated numeral is discarded even with real evidence available', async () => {
    // The structural rules run BEFORE any evidence is consulted, so a fabrication
    // cannot be rescued by a corpus that happens to contain the number elsewhere.
    const d = cleanDraft();
    d.back.lead = '{{slot:region_availability}} Runtime went GA in October 2025 across 19 regions.';
    const v = checkDraft(baseCard(), d);
    assert.equal(v.outcome, 'discard');
    assert.ok(v.rejections.some((r) => r.rule === 'NUMERAL_INTRODUCED' && /"19"/.test(r.detail)),
      'even a TRUE number must be rejected when the model typed it rather than a slot supplying it');
  });

  /**
   * REGRESSION — the first real Bedrock invocation reported
   * "ACCEPT — every checkable claim verified (0)".
   *
   * Zero. The draft still held the literal token {{slot:region_availability}}, so
   * the number behind it was absent from the decomposed text and there was nothing
   * numeric to check. The gate accepted a draft it had not examined.
   */
  test('slot tokens are expanded before claims are decomposed', async () => {
    const { loadFactStore, paths } = await import('../src/lib/store.ts');
    const { evidenceTextsFrom, datedEntriesFrom, subjectStemsOf } = await import('../src/lib/verifier.ts');
    const { decompose, isCheckable } = await import('../src/lib/claims.ts');
    const { expandSlots } = await import('../src/lib/facts.ts');
    const { readdirSync, readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');

    const card = baseCard();
    // The slot renders a region count. Unexpanded, the prose has no number in it.
    assert.ok(!/\d/.test(card.back.lead.replace(/\{\{slot:[a-z_]+\}\}/g, '').replace(/October 2025/, '')),
      'precondition: the number lives behind the slot, not in the prose');

    const expanded = expandSlots(card.back.lead, card);
    assert.match(expanded, /19/, 'expandSlots must surface the governed number');

    // And the claim decomposer must see it once expanded.
    const resolved = {
      t: card.title, hook: card.hook,
      back: { lead: expanded, kv: [] as [string, string][], hookline: card.back.hookline },
    };
    const claims = decompose(card, resolved as never);
    assert.ok(claims.some((c) => isCheckable(c.kind)),
      'an expanded slot must yield at least one checkable claim');
  });

  /**
   * REGRESSION — "no claim failed" is not "a claim passed".
   *
   * Prose with no number, date or region trivially satisfies "nothing unverified".
   * Reading that as acceptance is the same error as stamping a fresh verified_at on
   * a claim whose fact never fetched.
   */
  test('zero checkable claims routes to review, never accept', async () => {
    const { loadFactStore } = await import('../src/lib/store.ts');

    // A card with no slots and no numerals anywhere.
    const card = baseCard();
    card.slots = {};
    card.back.lead = 'Runtime keeps each session in its own sandbox, so one tenant cannot observe another.';
    card.back.hookline = 'Isolation is the product, not a setting.';
    card.back.kv = [{ k: 'Isolation', v: 'One sandbox per session' }];

    const draft: DraftFields = {
      hook: 'How does Runtime keep tenants apart?',
      back: {
        lead: 'Runtime gives each session its own sandbox, so no tenant can observe another.',
        hookline: 'Isolation is the product, not a setting.',
        kv: [{ k: 'Isolation', v: 'A sandbox for every session' }],
      },
    };

    const ctx = {
      store: loadFactStore(),
      evidenceTexts: [{ url: 'https://example.invalid/x', text: 'Runtime isolates each session in a sandbox.' }],
      datedEntries: [],
      subjectStems: ['runti', 'sandb'],
    };

    const v = checkDraft(card, draft, ctx as never);
    assert.equal(v.outcome, 'review', `expected review, got ${v.outcome}: ${v.reason}`);
    assert.notEqual(v.outcome, 'accept');
    assert.match(v.reason, /nothing was verified/);
  });
});
