/**
 * draft-new-card.ts unit tests for its two pure, exported helpers.
 *
 * The model-invocation path (main()) is exercised manually against a real
 * gap before it is ever wired into automation -- see the PR description for
 * that verification. What belongs in CI is the deterministic logic around
 * it: id allocation must never collide or reuse a retired id, and the
 * prompt must actually carry the constraint the model is held to.
 *
 * Run: node --test tests/draft-new-card.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { nextCardId, buildPrompt } from '../src/ingest/draft-new-card.ts';
import type { DatedEntry } from '../src/lib/verifier.ts';

describe('nextCardId never collides or reuses', () => {
  test('picks one past the highest existing number for that prefix', () => {
    assert.equal(nextCardId('AC', ['AC-01', 'AC-02', 'AC-17', 'AC-23']), 'AC-24');
  });

  test('a retired id (still on the ledger) is never reused', () => {
    // The ledger is append-only and never drops a retired id (FR-9), so the
    // allocator seeing it there is exactly what stops a collision.
    assert.equal(nextCardId('QK', ['QK-01', 'QK-02', 'QK-03']), 'QK-04');
  });

  test('an empty prefix starts at 01', () => {
    assert.equal(nextCardId('ZZ', ['AC-01', 'BR-01']), 'ZZ-01');
  });

  test('numbers are padded to at least two digits', () => {
    assert.equal(nextCardId('AC', ['AC-09']), 'AC-10');
    assert.equal(nextCardId('AC', []), 'AC-01');
  });

  test('a ledger id from an unrelated prefix never influences the count', () => {
    assert.equal(nextCardId('ST', ['AC-99', 'BR-50', 'ST-01']), 'ST-02');
  });
});

describe('the prompt actually carries the grounding constraint', () => {
  const entry: DatedEntry = {
    iso_month: '2026-08',
    month_label: 'August 2026',
    iso_date: '2026-08-18',
    precision: 'day',
    heading: 'AgentCore payments is now generally available in Amazon Bedrock AgentCore',
    summary: 'AgentCore payments integrates with Coinbase and Stripe Privy wallets. It is available in 19 AWS regions.',
    url: 'https://aws.amazon.com/about-aws/whats-new/2026/08/bedrock-agentcore-payments-ga/',
    service: 'bedrock-agentcore',
  };
  const categories = new Set(['operate-adopt', 'new-in-2026']);

  test('the source heading and summary both appear in the prompt verbatim', () => {
    const prompt = buildPrompt(entry, categories);
    assert.ok(prompt.includes(entry.heading));
    assert.ok(prompt.includes(entry.summary));
  });

  test('every allowed category id is listed, so the model has nothing to guess', () => {
    const prompt = buildPrompt(entry, categories);
    for (const c of categories) assert.ok(prompt.includes(c), `missing category ${c}`);
  });

  test('the source url is present, so the drafted card can eventually cite it', () => {
    const prompt = buildPrompt(entry, categories);
    assert.ok(prompt.includes(entry.url));
  });
});
