/**
 * Tests for the refresh outcome branch — the decision a scheduled job makes
 * before it is allowed to write anything.
 *
 * The load-bearing case is FRESHNESS_ONLY. Measured on a real refresh: 17 files
 * dirty, 7 cards rewritten, and not one byte of deck content changed. A daily job
 * that read "dirty" as "commit" would push that noise 365 times a year and bury
 * the one day a price actually moved.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { diffCard, diffFact, decideOutcome, type CardChange } from '../tools/refresh-outcome.ts';
import type { Card, FactSet, HistoryEntry } from '../src/lib/types.ts';

function card(over: Partial<Card> = {}): Card {
  return {
    schema_version: 1,
    card_id: 'AC-19',
    slug: 'regions',
    kind: 'service-fact',
    lifecycle: 'ga',
    service: 'bedrock-agentcore',
    category: 'foundations',
    tags: [],
    badge_variant: 'ga',
    badge_text: 'GA',
    art: 'x',
    title: 'Regions',
    hook: 'h',
    front: { question: 'q' },
    back: { lead: 'l', kv: [], hookline: '' },
    slots: {},
    facts_used: [],
    sources: [],
    verified_at: '2026-08-01T00:00:00Z',
    confidence: 'high',
    depends_on: [],
    aka: [],
    superseded_by: null,
    supersedes: [],
    needs_review: false,
    review_reasons: [],
    provenance: { tier: 'A', history: [] },
    ...(over as object),
  } as Card;
}

function slot(rendered: string, from = 'tier-a') {
  return { tier: 'A' as const, template: 't', facts: ['f'], rendered, rendered_from: from as never, seed_text: 'seed' };
}

function hist(over: Partial<HistoryEntry>): HistoryEntry {
  return { at: '2026-08-10T00:00:00Z', tier: 'A', action: 'verify', generator: 'g', ...over } as HistoryEntry;
}

function factSet(hash: string, fetched = '2026-08-10T00:00:00Z'): FactSet {
  return {
    schema_version: 1,
    fact_set_id: 'agentcore.regions',
    tier: 'A',
    generator: 'g',
    verified_at: fetched,
    source: { kind: 'ssm-public-parameter', url: 'u', fetched_at: fetched, content_hash: hash },
    evidence: { canonical: [], text: '' },
    facts: {},
  } as FactSet;
}

describe('freshness is not a change', () => {
  test('a re-verified card with identical text is NOT a change', () => {
    // This is the daily case. apply() rewrites verified_at on every card it
    // re-verified, so the file is dirty while the deck says the same thing.
    const before = card({ slots: { r: slot('19 regions') }, verified_at: '2026-08-01T00:00:00Z' });
    const after = card({
      slots: { r: slot('19 regions') },
      verified_at: '2026-08-10T00:00:00Z',
      provenance: { tier: 'A', history: [hist({ action: 'verify' })] },
    });
    assert.equal(diffCard(before, after), null);
  });

  test('a fact set re-fetched with the same content_hash is NOT a change', () => {
    assert.equal(diffFact(factSet('sha256:aaa', '2026-08-01T00:00:00Z'), factSet('sha256:aaa', '2026-08-10T00:00:00Z')), null);
  });

  test('a seed → tier-a promotion with identical text is NOT a content change', () => {
    // The claim did not move; only its provenance did. Committing this as a
    // correction would misreport what happened.
    const before = card({ slots: { r: slot('19 regions', 'seed') } });
    const after = card({ slots: { r: slot('19 regions', 'tier-a') } });
    assert.equal(diffCard(before, after), null);
  });

  test('dirty files with no semantic change classify as FRESHNESS_ONLY', () => {
    assert.equal(decideOutcome([], [], 17), 'FRESHNESS_ONLY');
  });

  test('a clean tree is NO_CHANGE', () => {
    assert.equal(decideOutcome([], [], 0), 'NO_CHANGE');
  });
});

describe('a real correction is never swallowed', () => {
  test('changed slot text is reported with before and after', () => {
    const before = card({ slots: { r: slot('19 regions') } });
    const after = card({
      slots: { r: slot('20 regions') },
      provenance: { tier: 'A', history: [hist({ action: 'correct', slot: 'r' })] },
    });
    const d = diffCard(before, after)!;
    assert.deepEqual(d.slots, [{ slot: 'r', before: '19 regions', after: '20 regions' }]);
    assert.equal(decideOutcome([d], [], 3), 'TIER_A');
  });

  test('a corrected card FIELD counts, not just a slot', () => {
    const d = diffCard(card({ lifecycle: 'preview' }), card({ lifecycle: 'ga' }))!;
    assert.deepEqual(d.fields, [{ field: 'lifecycle', before: 'preview', after: 'ga' }]);
  });

  test('a fact set whose content moved is reported', () => {
    const d = diffFact(factSet('sha256:aaa'), factSet('sha256:bbb'))!;
    assert.equal(d.before_hash, 'sha256:aaa');
    assert.equal(d.after_hash, 'sha256:bbb');
  });

  test('a correction that restores the card to what HEAD said still registers', () => {
    // Drift corrected back to the committed value: no text diff against HEAD, but
    // a correction happened. Reporting TIER_A with "0 corrections" was a real
    // defect — the ledger is the authoritative count, not the text diff.
    const before = card({ slots: { r: slot('19 regions') } });
    const after = card({
      slots: { r: slot('19 regions') },
      provenance: { tier: 'A', history: [hist({ action: 'correct', slot: 'r' })] },
    });
    const d = diffCard(before, after);
    assert.notEqual(d, null, 'a correct entry must not be discarded as freshness');
    assert.equal(d!.slots.length, 0);
    assert.equal(d!.newHistory.filter((e) => e.action === 'correct').length, 1);
  });
});

describe('a judgement never rides along unattended', () => {
  test('needs_review flipping true forces NEEDS_REVIEW', () => {
    const before = card({ needs_review: false });
    const after = card({
      needs_review: true,
      review_reasons: [{ reason: 'Tier C prose rewritten', raised_at: '2026-08-10T00:00:00Z' }],
    });
    const d = diffCard(before, after)!;
    assert.equal(d.reviewRaised, true);
    assert.equal(decideOutcome([d], [], 1), 'NEEDS_REVIEW');
  });

  test('a Tier C provenance entry forces NEEDS_REVIEW even with no text diff', () => {
    const d = diffCard(
      card(),
      card({ provenance: { tier: 'C', history: [hist({ tier: 'C', action: 'correct' })] } }),
    )!;
    assert.equal(decideOutcome([d], [], 1), 'NEEDS_REVIEW');
  });

  test('a rename forces NEEDS_REVIEW — a product NAME is not a number', () => {
    const d = diffCard(
      card({ title: 'Agent Registry' }),
      card({ title: 'AWS Agent Registry', provenance: { tier: 'A', history: [hist({ action: 'rename', field: 'title' })] } }),
    )!;
    assert.equal(decideOutcome([d], [], 1), 'NEEDS_REVIEW');
  });

  test('review BEATS correction when a run produces both', () => {
    // The safe half does not license the unsafe half to ride along.
    const safe: CardChange = {
      card_id: 'AC-19', slots: [{ slot: 'r', before: '19', after: '20' }],
      newHistory: [hist({ action: 'correct' })], reviewRaised: false, reviewReasons: [], fields: [],
    };
    const unsafe: CardChange = {
      card_id: 'AC-14', slots: [], newHistory: [], reviewRaised: true,
      reviewReasons: ['renamed'], fields: [],
    };
    assert.equal(decideOutcome([safe, unsafe], [], 4), 'NEEDS_REVIEW');
    assert.equal(decideOutcome([safe], [], 4), 'TIER_A');
  });
});
