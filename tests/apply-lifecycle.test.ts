/**
 * apply-lifecycle.ts tests.
 *
 * Regression for a real defect caught by the full test suite on 19 Aug 2026,
 * not by reasoning about the code: applying a lifecycle transition to AC-17
 * (already `high` confidence from an earlier sign-off) silently downgraded it
 * to `medium`. The applier was hand-computing confidence with
 * `needs_review ? 'medium' : ...`, which never checks whether the card is
 * actually fully verified -- it just defensively downgrades any corrected
 * card. That is exactly the "sign-off is endorsement, never verification"
 * invariant tests/guarantees.test.ts already protects everywhere else in the
 * repo; this applier had simply never been routed through the same shared
 * `deriveConfidence` every other writer uses.
 *
 * Run: node --test tests/apply-lifecycle.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyLifecycleToCard } from '../src/ingest/apply-lifecycle.ts';
import { deriveConfidence } from '../src/lib/provenance.ts';
import type { Card, FactSet } from '../src/lib/types.ts';
import type { LifecycleFinding } from '../src/lib/lifecycle.ts';

const NOW = '2026-08-19T00:00:00.000Z';

function fullyVerifiedCard(overrides: Partial<Card> = {}): Card {
  return {
    card_id: 'AC-99',
    title: 'Test card',
    hook: 'A test hook',
    lifecycle: 'preview',
    badge_variant: 'pv',
    badge_text: 'NEW',
    back: { lead: 'lead text', hookline: 'hookline text', kv: [] },
    slots: {},
    facts_used: [],
    sources: [
      { url: 'https://example.test/existing', title: 'existing', kind: 'aws-docs', fetched_at: '2026-06-01T00:00:00.000Z', content_hash: 'sha256:x' },
    ],
    verified_at: '2026-06-01T00:00:00.000Z',
    confidence: 'high',
    depends_on: [],
    aka: [],
    superseded_by: null,
    supersedes: [],
    needs_review: false,
    review_reasons: [],
    provenance: { tier: 'A', authored_by: 'model', history: [] },
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    signed_off: { by: 'Test User', at: '2026-06-01T00:00:00.000Z' },
    ...overrides,
  } as unknown as Card;
}

function gaFinding(url = 'https://example.test/whats-new'): LifecycleFinding {
  return {
    card_id: 'AC-99',
    card_lifecycle: 'preview',
    drift: true,
    reason: 'test',
    signals: [],
    latest: {
      lifecycle: 'ga',
      iso_month: '2026-08',
      month_label: 'August 2026',
      heading: 'Test feature is now generally available',
      matched: ['test'],
      url,
    },
  } as unknown as LifecycleFinding;
}

const noSource = () => undefined as FactSet | undefined;

describe('confidence is derived, never hand-computed', () => {
  test('a card that was already high confidence stays high after a clean lifecycle correction', () => {
    const card = fullyVerifiedCard();
    const result = applyLifecycleToCard(card, gaFinding(), noSource, NOW);
    assert.equal(result.changed, true);
    assert.equal(card.lifecycle, 'ga');
    assert.equal(card.confidence, 'high',
      'a genuinely fully-verified, signed-off card must not be downgraded merely because its lifecycle also transitioned');
    assert.equal(card.confidence, deriveConfidence(card), 'confidence must always equal deriveConfidence(card)');
  });

  test('a card that is missing verified_at correctly derives to medium, not by assertion', () => {
    const card = fullyVerifiedCard({ verified_at: null, sources: [] });
    applyLifecycleToCard(card, gaFinding(), noSource, NOW);
    assert.equal(card.confidence, 'medium');
    assert.equal(card.confidence, deriveConfidence(card));
  });

  test('a card with a seed slot still derives to low after a lifecycle correction', () => {
    const card = fullyVerifiedCard({
      slots: { some_slot: { tier: 'A', rendered_from: 'seed', rendered: 'seed text', template: '', facts: [] } },
    });
    applyLifecycleToCard(card, gaFinding(), noSource, NOW);
    assert.equal(card.confidence, 'low');
    assert.equal(card.confidence, deriveConfidence(card));
  });

  test('stale "preview" prose surviving a GA transition flags review and drops confidence to medium', () => {
    const card = fullyVerifiedCard({ hook: 'This is still in preview.' });
    const result = applyLifecycleToCard(card, gaFinding(), noSource, NOW);
    assert.equal(card.needs_review, true);
    assert.ok(result.stale.includes('hook'));
    assert.equal(card.confidence, 'medium', 'a card correctly flagged for review must never read as high');
    assert.equal(card.confidence, deriveConfidence(card));
  });
});

describe('what it touches, and only that', () => {
  test('lifecycle, badge_variant and badge_text all move together', () => {
    const card = fullyVerifiedCard();
    const result = applyLifecycleToCard(card, gaFinding(), noSource, NOW);
    assert.equal(card.lifecycle, 'ga');
    assert.equal(card.badge_variant, 'ga');
    assert.equal(card.badge_text, 'GA AUG 2026');
    assert.equal(result.changes.length, 3);
  });

  test('a card already agreeing with the source is left untouched', () => {
    const card = fullyVerifiedCard({ lifecycle: 'ga', badge_variant: 'ga', badge_text: 'GA AUG 2026' });
    const before = JSON.parse(JSON.stringify(card));
    const result = applyLifecycleToCard(card, gaFinding(), noSource, NOW);
    assert.equal(result.changed, false);
    assert.deepEqual(card, before, 'nothing should be mutated when there is nothing to correct');
  });

  test('prose is never rewritten, even when it is stale', () => {
    const card = fullyVerifiedCard({ hook: 'Still in preview, unchanged wording.' });
    applyLifecycleToCard(card, gaFinding(), noSource, NOW);
    assert.equal(card.hook, 'Still in preview, unchanged wording.', 'prose rewriting is a Tier C judgement call, not this applier\'s job');
  });

  test('the new source is cited once, and verified_at reflects the oldest source', () => {
    const set: FactSet = {
      schema_version: 1,
      fact_set_id: 'test.whats-new',
      tier: 'A',
      generator: 'src/ingest/docs-whats-new.ts',
      verified_at: '2026-08-19T00:00:00.000Z',
      source: { kind: 'aws-docs-doc-history', url: 'https://example.test/whats-new', fetched_at: '2026-08-19T00:00:00.000Z', content_hash: 'sha256:y' },
      evidence: { canonical: [], text: '' },
      facts: {},
    };
    const card = fullyVerifiedCard();
    applyLifecycleToCard(card, gaFinding(), () => set, NOW);
    assert.equal(card.sources.filter((s) => s.url === 'https://example.test/whats-new').length, 1);
    // The existing source (2026-06-01) is older than the new one (2026-08-19),
    // so verified_at must stay the OLDER date -- a card is only as fresh as its
    // stalest input.
    assert.equal(card.verified_at, '2026-06-01T00:00:00.000Z');
  });
});
