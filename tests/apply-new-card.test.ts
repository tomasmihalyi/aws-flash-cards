/**
 * apply-new-card.ts unit tests for its two pure, exported helpers.
 *
 * The end-to-end path (main(): re-gate -> write cards/<ID>.json -> ledger ->
 * PR body file) was proven manually against a real coverage gap and a real
 * model call before this file existed — see the PR description for that
 * verification, including the guarantee-suite regression it caught (a new
 * card needs its OWN flag-review history entry, not just the import entry).
 * What belongs in CI is the deterministic logic: finding the right source
 * fact set, and building a PR body that actually carries every judgement
 * call the gate cannot make.
 *
 * Run: node --test tests/apply-new-card.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findSourceFactSet, prBody, type NewCardArtifact } from '../tools/apply-new-card.ts';
import type { FactSet } from '../src/lib/types.ts';
import type { NewCardVerdict } from '../src/lib/new-card-gate.ts';

function factSet(id: string, headings: string[]): FactSet {
  return {
    schema_version: 1,
    fact_set_id: id,
    tier: 'A',
    generator: 'src/ingest/docs-whats-new.ts',
    verified_at: '2026-08-19T00:00:00.000Z',
    source: {
      kind: 'ssm-public-parameter',
      url: `https://example.test/${id}`,
      fetched_at: '2026-08-19T00:00:00.000Z',
      content_hash: `sha256:${id}`,
    },
    evidence: {
      canonical: headings.map((h) => ({ heading: h, summary: `summary for ${h}` })),
      text: headings.join('\n'),
    },
    facts: {},
  };
}

describe('findSourceFactSet locates the real originating source', () => {
  test('finds the fact set whose evidence actually contains the heading', () => {
    const sets = [factSet('agentcore.whats-new', ['A', 'B']), factSet('bedrock.whats-new', ['C'])];
    assert.equal(findSourceFactSet('C', sets)?.fact_set_id, 'bedrock.whats-new');
  });

  test('returns null rather than guessing when no fact set matches', () => {
    const sets = [factSet('agentcore.whats-new', ['A'])];
    assert.equal(findSourceFactSet('does not exist', sets), null);
  });

  test('never returns a fact set merely because one exists — heading must match exactly', () => {
    const sets = [factSet('agentcore.whats-new', ['AgentCore payments GA'])];
    assert.equal(findSourceFactSet('AgentCore payments', sets), null);
  });
});

describe('prBody names every judgement call the gate cannot make', () => {
  const art: NewCardArtifact = {
    card_id: 'AC-99',
    generated_at: '2026-08-19T00:00:00.000Z',
    model: 'test-model',
    source_entry: { heading: 'Some new AgentCore capability', url: 'https://example.test/x', month_label: 'August 2026' },
    art: 'platform',
    verdict: { outcome: 'review', rejections: [], reason: 'ok' },
    draft: {
      card_id: 'AC-99',
      title: 'Some new capability',
      hook: 'What is it?',
      category: 'bedrock',
      service: 'bedrock-agentcore',
      tags: ['tag-a'],
      back: { lead: 'lead', hookline: 'hookline', kv: [{ k: 'k', v: 'v' }] },
    },
  };
  const verdict: NewCardVerdict = { outcome: 'review', rejections: [], reason: 'all checkable claims verified' };

  test('states there is no accept-and-merge path, in the body itself', () => {
    const body = prBody(art, verdict, null);
    assert.match(body, /no accept-and-merge/i);
  });

  test('flags category, kind/lifecycle/badge, and art as needing a human decision', () => {
    const body = prBody(art, verdict, null);
    assert.match(body, /category/i);
    assert.match(body, /kind, lifecycle, badge/i);
    assert.match(body, /\bart\b/i);
  });

  test('surfaces the drafted category value itself, not just the field name', () => {
    const body = prBody(art, verdict, null);
    assert.ok(body.includes(art.draft.category));
  });

  test('names the model and drafted timestamp for a reviewer to judge staleness', () => {
    const body = prBody(art, verdict, null);
    assert.ok(body.includes(art.model));
    assert.ok(body.includes(art.generated_at));
  });

  test('when no source fact set is found, the body warns rather than staying silent', () => {
    const body = prBody(art, verdict, null);
    assert.match(body, /not found on disk/i);
  });

  test('when a source fact set IS found, the body cites its id and hash', () => {
    const fs = factSet('agentcore.whats-new', [art.source_entry.heading]);
    const body = prBody(art, verdict, fs);
    assert.ok(body.includes('agentcore.whats-new'));
    assert.ok(body.includes(fs.source.content_hash));
  });

  test('lists every rejection when the gate did not cleanly pass', () => {
    const withRejections: NewCardVerdict = {
      outcome: 'review',
      rejections: [{ rule: 'NUMERAL_UNGROUNDED', field: 'hook', detail: '"19" not in source' }],
      reason: 'partial',
    };
    const body = prBody(art, withRejections, null);
    assert.ok(body.includes('NUMERAL_UNGROUNDED'));
    assert.ok(body.includes('"19" not in source'));
  });
});
