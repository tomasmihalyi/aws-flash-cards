/**
 * T4.6 tests — the Tier C review path.
 *
 * The defect these exist to prevent was found by running the gate, not by reading
 * the code: applying a model-drafted prose rewrite failed the PARITY gate with
 * "authored text differs with no recorded field correction to explain it" — even
 * though the correction WAS recorded.
 *
 * The cause was that `originalProjection` inverted a recorded field with a flat
 * assignment, `clone[field] = before`. That works for every field corrected up to
 * now (`lifecycle`, `badge_variant`, `badge_text`, `title` — all top level) and
 * silently creates a junk `"back.lead"` property for a nested one, leaving the real
 * prose uninverted. The recorded reason existed and the gate could not see it.
 *
 * Run: node --test tests/apply-draft.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { originalProjection } from '../src/lib/provenance.ts';
import type { Card } from '../src/lib/types.ts';

function cardWithHistory(entries: Record<string, unknown>[]): Card {
  return {
    card_id: 'AC-99',
    title: 'Runtime',
    hook: 'NEW hook',
    back: {
      lead: 'NEW lead',
      hookline: 'NEW hookline',
      kv: [{ k: 'Isolation', v: 'NEW kv value' }],
    },
    slots: {},
    lifecycle: 'ga',
    provenance: { tier: 'C', authored_by: 'model', history: entries },
  } as unknown as Card;
}

const correction = (field: string, before: string) => ({
  at: '2026-08-11T00:00:00.000Z',
  tier: 'C',
  action: 'correct',
  generator: 'tools/apply-draft.ts',
  field,
  before,
  after: 'NEW',
  reason: 'test',
});

describe('a recorded correction is inverted wherever the field lives', () => {
  test('a top-level field still inverts — the pre-existing behaviour', () => {
    const c = cardWithHistory([correction('hook', 'OLD hook')]);
    assert.equal(originalProjection(c).hook, 'OLD hook');
  });

  test('a NESTED field inverts — the defect', () => {
    const c = cardWithHistory([correction('back.lead', 'OLD lead')]);
    const projected = originalProjection(c);
    assert.equal(projected.back.lead, 'OLD lead');
    // And no junk top-level property was created instead.
    assert.equal((projected as unknown as Record<string, unknown>)['back.lead'], undefined);
  });

  test('an INDEXED field inverts', () => {
    const c = cardWithHistory([correction('back.kv[0].v', 'OLD kv value')]);
    assert.equal(originalProjection(c).back.kv[0].v, 'OLD kv value');
  });

  test('several fields on one card all invert together', () => {
    const c = cardWithHistory([
      correction('hook', 'OLD hook'),
      correction('back.lead', 'OLD lead'),
      correction('back.hookline', 'OLD hookline'),
      correction('back.kv[0].v', 'OLD kv value'),
    ]);
    const p = originalProjection(c);
    assert.equal(p.hook, 'OLD hook');
    assert.equal(p.back.lead, 'OLD lead');
    assert.equal(p.back.hookline, 'OLD hookline');
    assert.equal(p.back.kv[0].v, 'OLD kv value');
  });

  test('the EARLIEST entry per field wins — history is append-only', () => {
    const c = cardWithHistory([
      correction('back.lead', 'ORIGINAL lead'),
      correction('back.lead', 'INTERMEDIATE lead'),
    ]);
    assert.equal(originalProjection(c).back.lead, 'ORIGINAL lead');
  });

  test('a path that cannot be walked changes nothing rather than corrupting the card', () => {
    const c = cardWithHistory([correction('back.nope.deeper', 'OLD')]);
    const p = originalProjection(c);
    assert.equal(p.back.lead, 'NEW lead');
    assert.equal((p as unknown as Record<string, unknown>)['back.nope.deeper'], undefined);
  });

  test('an entry naming no field inverts nothing — which is why one blob entry failed parity', () => {
    const c = cardWithHistory([
      { at: 'x', tier: 'C', action: 'correct', generator: 'g', before: 'OLD lead', after: 'NEW lead' },
    ]);
    assert.equal(originalProjection(c).back.lead, 'NEW lead');
  });

  test('a verify entry is not a correction and inverts nothing', () => {
    const c = cardWithHistory([
      { ...correction('back.lead', 'OLD lead'), action: 'verify' },
    ]);
    assert.equal(originalProjection(c).back.lead, 'NEW lead');
  });
});

describe('the review path never claims verification it does not have', () => {
  test('the PR body says why an ACCEPT is still a pull request', async () => {
    const { prBody } = await import('../tools/apply-draft.ts');
    const card = cardWithHistory([]);
    const art = {
      card_id: 'AC-99',
      generated_at: '2026-08-11T00:00:00.000Z',
      model: 'test-model',
      verdict: { outcome: 'accept' as const, rejections: [], reason: 'ok' },
      draft: { hook: 'h', back: { lead: 'l', hookline: 'k', kv: [] } },
    };
    const body = prBody(art, { outcome: 'accept', rejections: [], reason: 'ok' }, card);

    assert.match(body, /VERIFIED/, 'an accept must say the facts verified');
    assert.match(body, /cannot prove the prose is/, 'and must say what verification does NOT cover');
    assert.match(body, /needs_review/, 'and must state the card is marked for review');
    assert.match(body, /sign-off\.ts/, 'and must name how to accept it');
  });

  test('a REVIEW body lists what could not be verified', async () => {
    const { prBody } = await import('../tools/apply-draft.ts');
    const card = cardWithHistory([]);
    const art = {
      card_id: 'AC-99',
      generated_at: '2026-08-11T00:00:00.000Z',
      model: 'test-model',
      verdict: { outcome: 'review' as const, rejections: [], reason: 'x' },
      draft: { hook: 'h', back: { lead: 'l', hookline: 'k', kv: [] } },
    };
    const body = prBody(
      art,
      {
        outcome: 'review',
        rejections: [{ rule: 'CLAIM_UNVERIFIED', field: 'back.lead', detail: 'unsupported: no source' }],
        reason: '1 claim unverified',
      },
      card,
    );

    assert.match(body, /could NOT be verified/);
    assert.match(body, /CLAIM_UNVERIFIED at back\.lead/);
  });
});
