/**
 * Tests for the two ingests added to close the claim gaps.
 *
 * Both parse documentation HTML/markdown into fact sets, and both are the sort of
 * code that fails silently: a docs layout change yields fewer rows rather than an
 * error, and a fact set that quietly shrinks makes claims "unverifiable" for
 * entirely the wrong reason. So the parsers are tested on their refusals as much
 * as on their successes.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDocHistory, parseHistoryDate } from '../src/ingest/docs-doc-history.ts';
import { parseFeatureRegions } from '../src/ingest/docs-feature-regions.ts';
import { collapse } from '../src/ingest/service-quotas.ts';

describe('document history ingest (day precision)', () => {
  const TABLE = [
    '| Change | Description | Date | ',
    '| --- | --- | --- | ',
    '| [Agents Classic is no longer open to new customers.](https://x/a.html) | Amazon Bedrock Agents (now Classic) is no longer open to new customers. | July 30, 2026 | ',
    '| [Agents Classic availability change](https://x/b.html) | Amazon Bedrock Agents (launched November 2023) is now Classic and will no longer be open to new customers starting on July 30, 2026. | June 30, 2026 | ',
    '| New model | Anthropic Claude Haiku 4.5 is available. | October 15, 2025 | ',
  ].join('\n');

  test('an exact calendar day is parsed, which is the whole point of this source', () => {
    const rows = parseDocHistory(TABLE);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].iso_date, '2026-07-30');
    assert.equal(rows[0].iso_month, '2026-07');
    assert.equal(rows[2].iso_date, '2025-10-15');
  });

  test('markdown links are reduced to their text so headings are matchable', () => {
    const rows = parseDocHistory(TABLE);
    assert.equal(rows[0].heading, 'Agents Classic is no longer open to new customers.');
    assert.ok(!rows[0].heading.includes('http'), 'a URL left in the heading would pollute topical matching');
  });

  test('a date stated inside the body is retained, not just the row date', () => {
    // This is the mechanism that verified AC-20's "Nov 2023" and "July 30 2026":
    // the row is dated June 30 2026 but its text attests both other dates.
    const row = parseDocHistory(TABLE).find((r) => r.iso_date === '2026-06-30');
    assert.ok(row);
    assert.match(row.summary, /launched November 2023/);
    assert.match(row.summary, /July 30, 2026/);
  });

  test('the header and separator rows are not mistaken for entries', () => {
    const rows = parseDocHistory(TABLE);
    assert.ok(!rows.some((r) => /^Change$/.test(r.heading)), 'header row leaked in');
    assert.ok(!rows.some((r) => /^-+$/.test(r.heading)), 'separator row leaked in');
  });

  test('a row with an unparseable date is dropped rather than guessed at', () => {
    const rows = parseDocHistory('| Something | Happened | sometime last year | ');
    assert.equal(rows.length, 0);
  });

  test('an impossible day is rejected', () => {
    assert.equal(parseHistoryDate('February 45, 2026'), null);
    assert.equal(parseHistoryDate('Smarch 3, 2026'), null);
    assert.deepEqual(parseHistoryDate('July 30, 2026'), {
      iso_date: '2026-07-30',
      iso_month: '2026-07',
      month_label: 'July 2026',
    });
  });
});

describe('feature x region matrix ingest', () => {
  const MATRIX = [
    '| Feature | US East (N. Virginia) | Europe (Milan) | Asia Pacific (Sydney) |  AWS GovCloud (US-West) | ',
    '| --- | --- | --- | --- | --- | ',
    '| AgentCore Gateway | \u2713 | \u2713 | \u2713 | \u2713 | ',
    '| AgentCore Evaluations | \u2713 |  | \u2713 | \u2713 | ',
    '| AgentCore payments (preview) | \u2713 |  | \u2713 |  | ',
    '|  AWS Agent Registry | \u2713 |  | \u2713 |  | ',
  ].join('\n');

  test('a blank cell means not available, and is never counted', () => {
    const { features } = parseFeatureRegions(MATRIX);
    const evals = features.find((f) => f.key === 'evaluations');
    assert.ok(evals);
    assert.equal(evals.count, 3);
    assert.ok(!evals.regions.includes('Europe (Milan)'));
  });

  test('per-feature counts differ, which is exactly why service-level data could not answer', () => {
    const { features } = parseFeatureRegions(MATRIX);
    const counts = new Map(features.map((f) => [f.key, f.count]));
    assert.equal(counts.get('gateway'), 4);
    assert.equal(counts.get('evaluations'), 3);
    assert.equal(counts.get('payments'), 2);
    assert.notEqual(counts.get('gateway'), counts.get('evaluations'));
  });

  test('fact-id slugs drop vendor prefixes and preview markers', () => {
    const { features } = parseFeatureRegions(MATRIX);
    const keys = features.map((f) => f.key);
    assert.deepEqual(keys, ['gateway', 'evaluations', 'payments', 'agent-registry']);
  });

  test('the GovCloud column is visible, because it explains a real disagreement', () => {
    // SSM reports 19 regions for bedrock-agentcore; this matrix has 20 columns.
    // The difference is the GovCloud partition, which the global-infrastructure
    // parameter path does not enumerate. Both numbers are right about different
    // questions, so the split has to be recoverable rather than reconciled away.
    const { regions } = parseFeatureRegions(MATRIX);
    assert.equal(regions.length, 4);
    assert.equal(regions.filter((r) => /GovCloud/i.test(r)).length, 1);
  });

  test('an unexpected cell value throws instead of being interpreted', () => {
    const odd = [
      '| Feature | US East (N. Virginia) | ',
      '| --- | --- | ',
      '| AgentCore Gateway | coming soon | ',
    ].join('\n');
    // "coming soon" is neither available nor unavailable. Guessing either way
    // would put an invented availability claim into a fact set.
    assert.throws(() => parseFeatureRegions(odd), /unexpected cell value/);
  });

  test('AWS\'s current cell format — "✓ Yes" / literal "No" — parses correctly', () => {
    // 2026-08-16: docs.aws.amazon.com/bedrock-agentcore/.../agentcore-regions.md
    // moved from a bare tick to "✓ Yes", and from a blank cell to a literal
    // "No", for every cell in the table. The bare-tick and blank-cell forms
    // stay supported above for whichever format shows up next.
    const CURRENT_FORMAT = [
      '| Feature | US East (N. Virginia) | Europe (Milan) | Asia Pacific (Sydney) |',
      '| --- | --- | --- | --- |',
      '| AgentCore harness | \u2713 Yes | No | \u2713 Yes |',
    ].join('\n');
    const { features } = parseFeatureRegions(CURRENT_FORMAT);
    const harness = features.find((f) => f.key === 'harness');
    assert.ok(harness);
    assert.equal(harness.count, 2);
    assert.ok(harness.regions.includes('US East (N. Virginia)'));
    assert.ok(!harness.regions.includes('Europe (Milan)'));
  });
});

describe('service quotas ingest', () => {
  const QUOTAS = [
    { QuotaCode: 'L-FDE792EE', QuotaName: 'Asynchronous job maximum duration (in Hours)', Value: 8, Unit: 'None', Adjustable: false },
    { QuotaCode: 'L-999E4864', QuotaName: 'Asynchronous job maximum duration (in Hours)', Value: 8, Unit: 'None', Adjustable: false },
    { QuotaCode: 'L-60CD4D60', QuotaName: 'Asynchronous job maximum duration (in Hours)', Value: 8, Unit: 'None', Adjustable: false },
    { QuotaCode: 'L-AAAAAAAA', QuotaName: 'Streaming maximum duration (in Minutes)', Value: 60, Unit: 'None', Adjustable: true },
  ];

  test('duplicate rows for one named quota collapse to a single agreed value', () => {
    // The API returns this quota three times, once per primitive that carries it.
    const got = collapse(QUOTAS, 'Asynchronous job maximum duration (in Hours)');
    assert.ok(got);
    assert.equal(got.value, 8);
    assert.equal(got.codes.length, 3);
    assert.equal(got.adjustable, false);
  });

  test('disagreement between quota codes is refused, not averaged or picked', () => {
    // If Runtime allows 8 hours and Browser allows 4, there is no single "the
    // limit" to teach, and silently publishing one would be wrong on the other.
    const diverged = [
      ...QUOTAS.slice(0, 2),
      { QuotaCode: 'L-60CD4D60', QuotaName: 'Asynchronous job maximum duration (in Hours)', Value: 4, Unit: 'None', Adjustable: false },
    ];
    assert.throws(() => collapse(diverged, 'Asynchronous job maximum duration (in Hours)'),
      /different values across codes/);
  });

  test('adjustability is retained, because it changes the teaching point', () => {
    // "8 hours and you cannot raise it" is a different fact from "8 by default".
    assert.equal(collapse(QUOTAS, 'Streaming maximum duration (in Minutes)').adjustable, true);
  });

  test('a missing quota returns null so the ingest can refuse loudly', () => {
    assert.equal(collapse(QUOTAS, 'Some Quota AWS Renamed'), null);
  });
});
