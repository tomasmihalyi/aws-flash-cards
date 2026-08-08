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
import {
  verifyCard, verifyClaim, evidenceTextsFrom, datedEntriesFrom, subjectStemsOf, subjectTokens,
  parseClaimDate, stemsOf, type VerifyContext,
} from '../src/lib/verifier.ts';
import type { Card, FactSet } from '../src/lib/types.ts';

function factSets(): FactSet[] {
  if (!existsSync(paths.facts)) return [];
  return readdirSync(paths.facts).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(paths.facts, f), 'utf8')) as FactSet);
}

const CATS = loadCategories();
const STORE = loadFactStore();
const EVIDENCE = evidenceTextsFrom(factSets());
const DATED = datedEntriesFrom(factSets());

function ctxFor(card: Card): VerifyContext {
  return { store: STORE, evidenceTexts: EVIDENCE, datedEntries: DATED, subjectStems: subjectStemsOf(card) };
}
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
  return verifyCard(card, decompose(card, resolved), ctxFor(card));
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

  test('a day-precision date is partial, never verified, when only month sources reach it', () => {
    // Constructed rather than read off a card: this is a property of the
    // VERIFIER, and pinning it to whatever AC-01 currently claims meant the test
    // broke the moment the card was corrected to month precision. The invariant
    // outlives the card text.
    const card = clone(byId('AC-01'));
    card.back.kv[1].v = 'Preview July 2025 \u2192 generally available Oct 13 2025.';
    const day = check(card).results.find((r) => r.claim.token === 'Oct 13 2025');
    assert.ok(day, 'day-precision claim not extracted');
    assert.equal(day.verdict, 'partial', `got ${day.verdict}: ${day.reason}`);
    assert.match(day.reason, /month-precision|cannot attest the day/);
    assert.match(day.reason, /October 2025/, 'the reason must cite the month it confirmed');
  });

  test('reducing a claim to month precision does not make it vaguer than the source', () => {
    // Regression, and a nasty one. The claim extractor had no month-precision
    // date pattern, so "generally available October 2025" was extracted as the
    // bare YEAR "2025" — which then verified against any related 2025 entry in
    // any month. Correcting a card to the precision its source supports was
    // silently WEAKENING the check.
    const card = clone(byId('AC-01'));
    card.back.kv[1].v = 'Generally available October 2025.';
    const results = check(card).results;
    const asDate = results.find((r) => r.claim.token === 'October 2025');
    assert.ok(asDate, `month-precision date not extracted as a date claim: ${results.map((r) => `${r.claim.kind}:${r.claim.token}`).join(', ')}`);
    assert.equal(asDate.claim.kind, 'date');
    assert.ok(!results.some((r) => r.claim.kind === 'year' && r.claim.token === '2025'),
      'a month-precision date must not also be extracted as a bare year');
  });

  test('a month-precision claim must match THAT month, not merely that year', () => {
    // "GA March 2026" must not be satisfied by a July 2026 entry.
    const card = clone(byId('AC-11'));
    card.back.kv[3].v = 'Preview at re:Invent (December 2025) \u2192 GA September 2026.';
    const sep = check(card).results.find((r) => r.claim.token === 'September 2026');
    assert.ok(sep, 'claim not extracted');
    assert.notEqual(sep.verdict, 'verified',
      `a wrong month must not verify off a right year: ${sep.reason}`);
  });

  test('a date literal in an unrelated entry is not attestation', () => {
    // Measured trap. The Bedrock document history has three entries dated
    // July 16 2025 — Data Automation region expansion, Nova model import, custom
    // model deployment — and AC-01 claims AgentCore previewed on Jul 16 2025.
    // Matching the date alone would cite a data-automation note as the source for
    // AgentCore's preview.
    const card = clone(byId('AC-01'));
    card.back.kv[1].v = 'Preview Jul 16 2025.';
    const jul = check(card).results.find((r) => r.claim.token === 'Jul 16 2025');
    assert.ok(jul, 'claim not extracted');
    assert.notEqual(jul.verdict, 'verified',
      `a same-day but unrelated entry must not attest this: ${jul.reason}`);
  });

  test('a contradiction is only asserted on strong evidence, never on a matcher miss', () => {
    const card = clone(byId('AC-01'));
    card.back.kv[1].v = 'Preview Jul 16 2025.';
    const jul = check(card).results.find((r) => r.claim.token === 'Jul 16 2025');
    assert.ok(jul, 'expected the preview date claim');
    assert.ok(jul.verdict !== 'contradicted',
      `a matcher miss must be "cannot attest", not an accusation. Got ${jul.verdict}: ${jul.reason}`);
  });

  test('a number must be followed by the unit it counts, not merely near it', () => {
    // Regression: "18 AWS regions" verified against "…12-18% improvements"
    // because the word "regions" sat 40 chars earlier in a latency note.
    const card = clone(byId('AC-19'));
    card.slots.region_availability.rendered = 'AgentCore is available in 18 AWS regions.';
    card.slots.sydney_availability.rendered = 'Sydney is in the list.';
    const bad = check(card).results.find((r) => r.claim.token === '18 AWS regions');
    assert.ok(bad, 'claim not extracted');
    assert.notEqual(bad.verdict, 'verified', `18 leaked through: ${bad.reason}`);
  });

  test('a percentage does not satisfy a claim counting something else', () => {
    const card = clone(byId('AC-19'));
    card.slots.region_availability.rendered = 'AgentCore is available in 12 AWS regions.';
    card.slots.sydney_availability.rendered = 'Sydney is in the list.';
    const bad = check(card).results.find((r) => r.claim.token === '12 AWS regions');
    assert.ok(bad, 'claim not extracted');
    assert.notEqual(bad.verdict, 'verified', `"12-18%" must not verify "12 regions": ${bad.reason}`);
  });

  test('a feature-level count is answered by that feature, never by a neighbour', () => {
    // AC-12's limit is closed: agentcore-regions.html is a feature x region
    // matrix, so Evaluations' region count is now deterministically governed.
    //
    // But that matrix introduced thirteen region counts at once, and the stale
    // card said "9 regions" — which is Runtime Instances' count. A plain value
    // match verified a wrong card against a different feature and cited the docs
    // under it. This test pins the fix.
    const live = check(byId('AC-12')).results.find((r) => /regions/.test(r.claim.token));
    assert.ok(live, 'the Evaluations region claim was not extracted');
    assert.equal(live.verdict, 'verified', `got ${live.verdict}: ${live.reason}`);
    assert.match(live.reason, /evaluations/, `must cite the Evaluations fact, not another feature: ${live.reason}`);

    const card = clone(byId('AC-12'));
    const slot = card.slots.evaluations_regions;
    // 9 is a real number in the matrix — for Runtime Instances, not Evaluations.
    slot.rendered = 'GA in 9 regions incl. Sydney and Tokyo.';
    slot.facts = [];
    const bad = check(card).results.find((r) => r.claim.token.includes('9 regions'));
    assert.ok(bad, 'claim not extracted');
    assert.notEqual(bad.verdict, 'verified',
      `another feature's region count must not verify this one: ${bad.reason}`);
  });

  test('a money claim is not satisfied by a number scraped out of a region list', () => {
    // Measured: AC-17's "$1" verified against agentcore.regions.list, because
    // reducing the joined region codes to a number found the 1 in
    // "ap-southeast-1". A price was cited to a region list.
    const live = check(byId('AC-17')).results.find((r) => r.claim.kind === 'money');
    assert.ok(live, 'no money claim on AC-17');
    assert.equal(live.verdict, 'verified', `got ${live.verdict}: ${live.reason}`);
    assert.ok(!/regions?\.list|global-infrastructure/.test(String(live.evidence ?? '') + live.reason),
      `a money claim must not cite a region list: ${live.evidence} / ${live.reason}`);
  });

  test('an invented price is still caught now that a payments source exists', () => {
    const card = clone(byId('AC-17'));
    card.slots.transaction_size.rendered = 'typically $7.40 per call';
    const bad = check(card).results.find((r) => r.claim.token.includes('7.40'));
    assert.ok(bad, 'claim not extracted');
    assert.notEqual(bad.verdict, 'verified', `invented price accepted: ${bad.reason}`);
  });

  test('a citation points at the entry a human would cite', () => {
    // Getting the verdict right is not enough. AC-11's Policy GA claim verified
    // against "Browser and Code Interpreter: Chrome Policies and Custom Root CA
    // Support" — same month, more shared words, wrong subject — while
    // "AgentCore Policy is now Generally Available" sat right next to it.
    const march = check(byId('AC-11')).results.find((r) => r.claim.token === 'March 2026');
    assert.ok(march, 'claim not extracted');
    assert.equal(march.verdict, 'verified');
    assert.match(march.reason, /AgentCore Policy is now Generally Available/,
      `cited the wrong entry in the right month: ${march.reason}`);
  });

  test('a short acronym can still identify a subject', () => {
    // stemsOf drops tokens under four characters, so CLI, MCP and SDK vanished.
    // The lifecycle detector had this exact bug on this exact card; the verifier
    // had it too, and cited AC-16's CLI GA date to "Code Interpreter: Node.js
    // Support" because no token in the right entry was matchable at all.
    assert.ok(subjectTokens('AgentCore CLI is now Generally Available').includes('cli'),
      'CLI must survive tokenisation');
    const ga = check(byId('AC-16')).results.find((r) => r.claim.token === 'March 2026');
    assert.ok(ga, 'claim not extracted');
    assert.match(ga.reason, /CLI is now Generally Available/,
      `the CLI GA entry should be the citation: ${ga.reason}`);
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
    const c = ctxFor(byId('AC-19'));
    const r1 = verifyClaim(claim, c);
    const r2 = verifyClaim(claim, c);
    assert.deepEqual(r1.verdict, r2.verdict);
    assert.deepEqual(r1.evidence, r2.evidence);
  });
});
