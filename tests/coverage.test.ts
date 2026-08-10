/**
 * Coverage detector tests.
 *
 * This detector's failure mode is not being wrong about a fact — it never asserts
 * one. It is being UNTRUSTWORTHY: a report that sends you to write a card that
 * already exists gets ignored after two tries, and then the deck silently stops
 * noticing what AWS published. Every test below is about precision for that reason.
 *
 * Run: node --test tests/coverage.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectCoverage, coverageSummary, significanceOf } from '../src/lib/coverage.ts';
import type { DatedEntry } from '../src/lib/verifier.ts';
import type { Card } from '../src/lib/types.ts';
import { loadCards } from '../src/lib/store.ts';

const entry = (heading: string, iso_month = '2026-07', summary = ''): DatedEntry => ({
  iso_month,
  month_label: 'July 2026',
  iso_date: null,
  precision: 'month',
  heading,
  summary,
  url: 'https://docs.aws.amazon.com/x',
});

/** A minimal card, enough for subject matching. */
const card = (id: string, title: string, tags: string[] = [], verified_at: string | null = '2026-01-01T00:00:00Z') =>
  ({
    card_id: id, title, tags, verified_at,
    slots: {}, back: { lead: '', kv: [], hookline: '' }, hook: '',
  }) as unknown as Card;

describe('a card is credited when the heading names it', () => {
  test('a common word can still be the name of the thing', () => {
    /**
     * The regression that made the first run useless. "gatew" appears in 20 of 102
     * release-notes headings, so lifecycle's scorer gives it weight 1 and refuses a
     * single-token match — and AC-06, the Gateway card, failed to match
     * "Gateway: AgentCore Runtime targets are now generally available".
     *
     * Coverage is deliberately more permissive than lifecycle: a false NEGATIVE
     * here sends someone to duplicate an existing card, which is the expensive
     * error. A single token from the card's TITLE is enough.
     */
    const entries = Array.from({ length: 20 }, (_, i) => entry(`Gateway: change ${i}`));
    entries.push(entry('Gateway: AgentCore Runtime targets are now generally available'));
    // Verified AFTER the entries, so this test is about matching, not staleness.
    const f = detectCoverage([card('AC-06', 'AgentCore Gateway', ['tools'], '2026-12-01T00:00:00Z')], entries, []);
    const hit = f.find((x) => x.entry.heading.includes('Runtime targets'))!;
    assert.equal(hit.status, 'covered', hit.reason);
    assert.equal(hit.matches[0].card_id, 'AC-06');
  });

  test('a TAG-only match still needs the stricter score', () => {
    // Tags are loose associations. "Web Bot Auth" is a Browser feature and must not
    // be credited to an Identity card merely because it carries an `auth` tag.
    const f = detectCoverage([card('AC-07', 'AgentCore Identity', ['auth'])], [entry('Web Bot Auth (Preview)')], []);
    assert.notEqual(f[0].status, 'covered', f[0].reason);
  });
});

describe('a heading that names nothing is not a gap', () => {
  test('lifecycle language alone is unmatchable, never uncovered', () => {
    /**
     * The release notes really contain headings like "General Availability" and
     * "Initial release (preview)". Those describe a TRANSITION, not a subject, and
     * AC-01 covers both. Reporting them as missing cards would be a lie about the
     * deck rather than a fact about it.
     *
     * Frequency alone could not catch this: on 102 headings "gener" sits at df=12
     * against a 12.2 cap and was classed distinctive by a whisker.
     */
    for (const h of ['General Availability', 'Initial release (preview)', 'Additional Features']) {
      const f = detectCoverage([card('AC-01', 'What is AgentCore?')], [entry(h)], []);
      assert.equal(f[0].status, 'unmatchable', `"${h}" → ${f[0].status}: ${f[0].reason}`);
      assert.notEqual(f[0].status, 'uncovered');
    }
  });

  test('a real subject with no card IS reported', () => {
    const f = detectCoverage([card('AC-01', 'What is AgentCore?')], [entry('Failure Insights is now in Public Preview')], []);
    assert.equal(f[0].status, 'uncovered');
    assert.equal(f[0].significance, 'preview');
  });
});

describe('ranking makes the list usable', () => {
  test('a launch outranks a capability, which outranks an expansion', () => {
    assert.ok(significanceOf('Policy launches', '').weight > significanceOf('Gateway now supports X', '').weight);
    assert.ok(significanceOf('Gateway now supports X', '').weight > significanceOf('Region Expansion: Sydney', '').weight);
  });

  test('documentation housekeeping is minor and never actionable', () => {
    for (const h of [
      'Observability: UI Enhancements for Trace and Trajectory',
      'Latency Improvements in Runtime',
      'Added documentation for the Policy feature',
      'Updated list of models supported for service tiers',
    ]) {
      assert.equal(significanceOf(h, '').kind, 'minor', h);
    }
    const f = detectCoverage([card('ZZ-01', 'Nothing')], [entry('Latency Improvements in Runtime')], []);
    assert.equal(coverageSummary(f).actionable, 0, 'housekeeping must not reach the actionable queue');
  });

  test('the ranking is deterministic across runs', () => {
    const cards = [card('AC-01', 'What is AgentCore?')];
    const entries = [entry('Policy launches', '2026-03'), entry('Memory now supports X', '2026-05'), entry('Failure Insights is now in Public Preview', '2026-07')];
    const a = detectCoverage(cards, entries, []).map((f) => f.entry.heading);
    const b = detectCoverage(cards, entries, []).map((f) => f.entry.heading);
    assert.deepEqual(a, b);
  });
});

describe('suppression keeps the signal alive', () => {
  test('an ignored entry is marked skipped, not uncovered, and carries its reason', () => {
    const f = detectCoverage(
      [card('AC-01', 'What is AgentCore?')],
      [entry('AgentCore is generally available in AWS GovCloud (US-West)')],
      [{ heading: 'AgentCore is generally available in AWS GovCloud (US-West)', reason: 'GovCloud is out of scope for this deck.' }],
    );
    assert.equal(f[0].status, 'ignored');
    assert.match(f[0].reason, /out of scope/);
    assert.equal(coverageSummary(f).actionable, 0);
  });

  test('suppression is by exact heading, so a reworded entry resurfaces', () => {
    // A stale ignore rule must not silently swallow a changed announcement.
    const f = detectCoverage(
      [card('AC-01', 'What is AgentCore?')],
      [entry('Failure Insights is now Generally Available')],
      [{ heading: 'Failure Insights is now in Public Preview', reason: 'preview, revisit at GA' }],
    );
    assert.equal(f[0].status, 'uncovered', 'the GA rewording must reappear');
  });
});

describe('a card that exists may still not know about a change', () => {
  test('an entry newer than the card it matches is a candidate UPDATE, not a gap', () => {
    /**
     * The more valuable of the two signals and the easier to miss. "Gateway:
     * Configurable rate limits" needs no new card — it needs the Gateway card to
     * mention rate limits.
     */
    const f = detectCoverage(
      [card('AC-06', 'AgentCore Gateway', [], '2026-01-15T00:00:00Z')],
      [entry('Gateway: Configurable rate limits', '2026-08')],
      [],
    );
    assert.equal(f[0].status, 'stale');
    assert.match(f[0].reason, /AC-06/);
    assert.match(f[0].reason, /UPDATE/);
    assert.equal(coverageSummary(f).actionable, 1);
  });

  test('an entry older than its card is simply covered', () => {
    const f = detectCoverage(
      [card('AC-06', 'AgentCore Gateway', [], '2026-08-01T00:00:00Z')],
      [entry('Gateway: Configurable rate limits', '2026-03')],
      [],
    );
    assert.equal(f[0].status, 'covered');
  });
});

describe('against the real deck', () => {
  test('it never reports a gap for a card that plainly exists', () => {
    // A spot check on the live deck: the primitives each have a card, so their
    // own headings must not appear as candidate NEW cards.
    const cards = loadCards();
    const entries = [
      entry('Gateway: HTTP passthrough targets'),
      entry('Memory: Record Streaming'),
      entry('AgentCore Policy is now Generally Available'),
      entry('AgentCore Evaluations is now Generally Available'),
    ];
    for (const f of detectCoverage(cards, entries, [])) {
      assert.notEqual(f.status, 'uncovered', `${f.entry.heading} → ${f.reason}`);
    }
  });

  test('coverage never fails a build on its own', () => {
    // It is a to-do list. The only non-zero exit is behind --strict, which lives in
    // the CLI, not here — detectCoverage has no failure mode at all.
    const f = detectCoverage(loadCards(), [entry('Something entirely new launches')], []);
    assert.equal(f.length, 1);
    assert.ok(['uncovered', 'stale', 'covered', 'ignored', 'unmatchable'].includes(f[0].status));
  });
});
