/**
 * Verifier tests, including the P4 exit criterion.
 *
 * The exit criterion is deliberately adversarial: a verifier that passes on
 * correct cards proves nothing, because a verifier that returns "verified" for
 * everything would pass that test too. The gate is that it CATCHES an injected
 * hallucination — a plausible-looking number that no fetched source supports.
 *
 * Run: node --test tests/verifier.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCards, loadCategories, loadFactStore, paths } from '../src/lib/store.ts';
import { authoredText } from '../src/lib/render.ts';
import { decompose, isCheckable, type Claim } from '../src/lib/claims.ts';
import { verifyCard, verifyClaim, evidenceTextsFrom } from '../src/lib/verifier.ts';
import type { Card, FactSet } from '../src/lib/types.ts';

function factSets(): FactSet[] {
  if (!existsSync(paths.facts)) return [];
  return readdirSync(paths.facts).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(paths.facts, f), 'utf8')) as FactSet);
}

const CATS = loadCategories();
const STORE = loadFactStore();
const EVIDENCE = evidenceTextsFrom(factSets());
const CARDS = loadCards().sort((a, b) => a.card_id.localeCompare(b.card_id));

function byId(id: string): Card {
  const c = CARDS.find((x) => x.card_id === id);
  assert.ok(c, `fixture card ${id} missing`);
  return c;
}

/** Deep-clone a card so a test can corrupt it without touching disk. */
function clone(card: Card): Card {
  return JSON.parse(JSON.stringify(card)) as Card;
}

function check(card: Card) {
  const resolved = authoredText(card, CATS);
  return verifyCard(card, decompose(card, resolved), STORE, EVIDENCE);
}

describe('the verifier has something to verify against', () => {
  test('fact sets retain their fetched evidence', () => {
    const sets = factSets();
    assert.ok(sets.length > 0, 'no fact sets — run the Tier A ingest');
    for (const s of sets) {
      assert.ok(s.evidence, `${s.fact_set_id} kept no evidence — nothing to string-match against`);
      assert.ok(s.evidence.text.trim().length > 0, `${s.fact_set_id} evidence.text is empty`);
    }
  });

  test('evidence is the payload the content hash was taken over', async () => {
    const { hashPayload } = await import('../src/lib/hash.ts');
    for (const s of factSets()) {
      assert.equal(hashPayload(s.evidence.canonical), s.source.content_hash,
        `${s.fact_set_id}: hash does not match its evidence, so its provenance is unverifiable`);
    }
  });
});

describe('claim decomposition', () => {
  test('separates checkable claims from judgement', () => {
    const card = byId('AC-19');
    const claims = decompose(card, authoredText(card, CATS));
    assert.ok(claims.length > 0);
    assert.ok(claims.some((c) => isCheckable(c.kind)), 'expected at least one checkable claim');
  });

  test('finds the region count and the region id in AC-19', () => {
    const card = byId('AC-19');
    const tokens = decompose(card, authoredText(card, CATS)).map((c) => c.token);
    assert.ok(tokens.some((t) => t.includes('19')), `no region count found in ${tokens.join(' | ')}`);
    assert.ok(tokens.includes('ap-southeast-2'), `no region id found in ${tokens.join(' | ')}`);
  });

  test('a price is one money claim, not also a bare number', () => {
    const card = byId('AC-18');
    const claims = decompose(card, authoredText(card, CATS));
    const money = claims.filter((c) => c.kind === 'money');
    assert.ok(money.length > 0, 'expected money claims on the pricing card');
    for (const m of money) assert.match(m.token, /^\$/, `money token ${m.token} lost its currency marker`);
  });

  test('claims carry the slot governing them', () => {
    const card = byId('AC-19');
    const claims = decompose(card, authoredText(card, CATS));
    assert.ok(claims.some((c) => c.slot && c.fact_governed),
      'a claim inside a fact-governed slot must know which slot it came from');
  });

  test('claim ids are unique within a card', () => {
    for (const card of CARDS) {
      const ids = decompose(card, authoredText(card, CATS)).map((c) => c.claim_id);
      assert.equal(new Set(ids).size, ids.length, `${card.card_id} produced duplicate claim ids`);
    }
  });

  test('every card decomposes without throwing', () => {
    for (const card of CARDS) {
      assert.doesNotThrow(() => decompose(card, authoredText(card, CATS)), `${card.card_id} failed to decompose`);
    }
  });
});

describe('the verifier verifies what is real', () => {
  test('AC-19 passes: both its claims trace to SSM', () => {
    const v = check(byId('AC-19'));
    assert.equal(v.tier, 'A', v.reason);
    assert.equal(v.demoted, false);
    assert.equal(v.counts.verified, 3, 'lead region count, region id, and the kv region count');
    assert.equal(v.counts.contradicted, 0);
    assert.equal(v.counts.unsupported, 0);
  });

  test('a verified claim names the fact or source that settled it', () => {
    const v = check(byId('AC-19'));
    for (const r of v.results.filter((x) => x.verdict === 'verified')) {
      assert.ok(r.evidence, `${r.claim.claim_id} verified with no evidence recorded`);
    }
  });

  test('the region price on AC-18 traces to the Price List API', () => {
    const v = check(byId('AC-18'));
    const money = v.results.filter((r) => r.claim.kind === 'money' && r.verdict === 'verified');
    assert.ok(money.length > 0, 'no price verified on the pricing card');
    assert.ok(money.some((r) => r.evidence?.includes('pricing') || r.evidence?.includes('gateway') || r.evidence?.includes('runtime')),
      `price evidence looks wrong: ${money.map((r) => r.evidence).join(', ')}`);
  });
});

describe('EXIT CRITERION: the verifier catches an injected hallucination', () => {
  test('a fabricated region count is caught', () => {
    const card = clone(byId('AC-19'));
    // The kind of error a model makes: plausible, wrong, and confident.
    card.slots.region_availability.rendered =
      'AgentCore is available in 31 AWS regions, including Asia Pacific (Sydney).';

    const v = check(card);
    assert.equal(v.demoted, true, 'a fabricated region count must demote the card');
    assert.equal(v.tier, 'C');
    const bad = v.results.find((r) => r.claim.token.includes('31'));
    assert.ok(bad, 'the fabricated number was not even extracted as a claim');
    assert.notEqual(bad.verdict, 'verified', `the verifier accepted a fabricated count: ${bad.reason}`);
    assert.equal(bad.verdict, 'contradicted',
      'a wrong number inside a fact-governed slot is a contradiction, not merely unsupported');
  });

  test('a fabricated price is caught', () => {
    const card = clone(byId('AC-18'));
    card.slots.gateway_price.rendered =
      'Per tool invocation \u2014 $0.049 per 1,000 API invocations in Asia Pacific (Sydney).';

    const v = check(card);
    assert.equal(v.demoted, true);
    const bad = v.results.find((r) => r.claim.token.includes('0.049'));
    assert.ok(bad, 'the fabricated price was not extracted');
    assert.notEqual(bad.verdict, 'verified', `the verifier accepted an invented price: ${bad.reason}`);
  });

  test('a fabricated region id is caught', () => {
    const card = clone(byId('AC-19'));
    card.slots.sydney_availability.rendered =
      'eu-south-9 is in the current bedrock-agentcore region list.';

    const v = check(card);
    const bad = v.results.find((r) => r.claim.token === 'eu-south-9');
    assert.ok(bad, 'the fabricated region id was not extracted');
    assert.notEqual(bad.verdict, 'verified', 'a region that does not exist must not verify');
  });

  test('a plausible-but-wrong number is caught even when the real one is nearby', () => {
    // 19 is correct and IS in the sources. 18 is not. A verifier doing fuzzy or
    // "does this look about right" matching would wave 18 through.
    const card = clone(byId('AC-19'));
    card.slots.region_availability.rendered =
      'AgentCore is available in 18 AWS regions, including Asia Pacific (Sydney).';
    const v = check(card);
    card.slots.sydney_availability.rendered = 'Sydney is in the list.';
    const bad = check(card).results.find((r) => r.claim.token === '18 AWS regions');
    assert.ok(bad, 'off-by-one fabrication not extracted');
    assert.notEqual(bad.verdict, 'verified', 'an off-by-one number must not pass');
  });

  test('substring collisions do not create false passes', () => {
    // 9 is a digit inside the correct value 19, and digits litter the region
    // names in the source text. A naive indexOf would wave this through.
    const card = clone(byId('AC-19'));
    card.slots.region_availability.rendered = 'AgentCore is available in 9 AWS regions.';
    // Neutralise the other slot so no legitimate "19" claim remains to confuse
    // the assertion (an earlier version of this test matched it by substring).
    card.slots.sydney_availability.rendered = 'Sydney is in the list.';
    const v = check(card);
    const nine = v.results.find((r) => r.claim.token === '9 AWS regions');
    assert.ok(nine, `claim not extracted from ${v.results.map((r) => r.claim.token).join(' | ')}`);
    assert.notEqual(nine.verdict, 'verified',
      '9 must not verify just because it is a digit inside 19 or a region name');
  });

  test('the whole card demotes, not just the failing claim', () => {
    const card = clone(byId('AC-19'));
    card.slots.region_availability.rendered =
      'AgentCore is available in 31 AWS regions, including Asia Pacific (Sydney).';
    const v = check(card);
    assert.ok(v.counts.verified > 0, 'the other claim on this card is still fine');
    assert.equal(v.tier, 'C',
      'one bad number must demote the whole card \u2014 partial publication ships a confidently-wrong artefact');
  });

  test('the correct card still passes, so the gate is not simply always-fail', () => {
    // The counterpart to every test above: a verifier that demoted everything
    // would satisfy all of them and be useless.
    assert.equal(check(byId('AC-19')).tier, 'A');
  });
});

describe('honesty of verdicts', () => {
  test('judgement is never reported as verified', () => {
    for (const card of CARDS) {
      for (const r of check(card).results) {
        if (r.claim.kind === 'judgement') {
          assert.equal(r.verdict, 'judgement', 'positioning must never be scored as a verified fact');
        }
      }
    }
  });

  test('a historical date is unverifiable, not unsupported', () => {
    // The distinction matters: unsupported means "govern it or cite it";
    // unverifiable means "no deterministic source can ever settle this".
    const v = check(byId('AC-01'));
    const dates = v.results.filter((r) => r.claim.kind === 'date' || r.claim.kind === 'year');
    assert.ok(dates.length > 0, 'AC-01 carries GA/preview dates');
    for (const d of dates) {
      if (d.verdict === 'verified') continue;
      assert.equal(d.verdict, 'unverifiable', `${d.claim.token} should be unverifiable, got ${d.verdict}`);
    }
  });

  test('AC-12 is unsupported, matching the limit already recorded on the card', () => {
    // The "9 regions" Evaluations claim: service-level SSM cannot substantiate a
    // feature-level count. The card says so; the verifier must agree.
    const v = check(byId('AC-12'));
    const nine = v.results.find((r) => r.claim.token.includes('9 regions'));
    assert.ok(nine, 'the Evaluations region claim was not extracted');
    assert.notEqual(nine.verdict, 'verified');
    assert.equal(v.tier, 'C');
    const card = byId('AC-12');
    assert.equal(card.needs_review, true, 'the card already admits this limit');
  });

  test('every result carries a reason a human can act on', () => {
    for (const card of CARDS) {
      for (const r of check(card).results) {
        assert.ok(r.reason.length > 20, `${r.claim.claim_id} has a uselessly short reason: ${r.reason}`);
      }
    }
  });
});

describe('verifier determinism', () => {
  test('the same card verifies identically twice', () => {
    const a = check(byId('AC-19'));
    const b = check(byId('AC-19'));
    assert.deepEqual(a.counts, b.counts);
    assert.deepEqual(a.results.map((r) => [r.claim.claim_id, r.verdict]), b.results.map((r) => [r.claim.claim_id, r.verdict]));
  });

  test('no model is involved: verifyClaim is pure over its inputs', () => {
    const claim: Claim = {
      claim_id: 'T:x#0', card_id: 'T', field: 'hook', kind: 'number',
      token: '19 regions', context: 'nineteen regions', slot: null, fact_governed: false,
    };
    const r1 = verifyClaim(claim, STORE, EVIDENCE);
    const r2 = verifyClaim(claim, STORE, EVIDENCE);
    assert.deepEqual(r1.verdict, r2.verdict);
    assert.deepEqual(r1.evidence, r2.evidence);
  });
});
