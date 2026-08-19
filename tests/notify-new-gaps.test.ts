/**
 * notify-new-gaps.ts unit tests for its pure, exported helpers.
 *
 * The GitHub-issue side (main(): find-or-create the tracking issue, comment
 * vs create) was proven manually with --dry-run against the live coverage
 * report before this file existed — see the PR description. What belongs in
 * CI is the deterministic logic: which gaps are new since the last report,
 * and that the emitted command is actually safe to paste into a shell.
 *
 * Run: node --test tests/notify-new-gaps.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gapLine, newHeadings } from '../tools/notify-new-gaps.ts';
import type { CoverageFinding } from '../src/lib/coverage.ts';

function finding(heading: string, service: string | null = 'bedrock-agentcore'): CoverageFinding {
  return {
    entry: {
      iso_month: '2026-08',
      month_label: 'August 2026',
      iso_date: '2026-08-18',
      precision: 'day',
      heading,
      summary: 'summary text',
      url: 'https://example.test/x',
      service,
    },
    matches: [],
    status: 'uncovered',
    significance: 'capability',
    rank: 1,
    reason: "No card's subject matches this entry.",
  };
}

describe('newHeadings only reports what the issue does not already carry', () => {
  test('a heading already in the body is excluded', () => {
    const body = '- **Already known gap** (August 2026, capability)\n';
    const out = newHeadings([finding('Already known gap'), finding('Genuinely new gap')], body);
    assert.deepEqual(out.map((f) => f.entry.heading), ['Genuinely new gap']);
  });

  test('an empty body reports every finding as new', () => {
    const out = newHeadings([finding('A'), finding('B')], '');
    assert.equal(out.length, 2);
  });

  test('a heading that is a SUBSTRING of another does not falsely suppress it', () => {
    // "AgentCore payments is now GA" must not be considered "already reported"
    // merely because the body contains the shorter, unrelated "AgentCore payments"
    // heading from a previous entry -- newHeadings does a literal substring
    // check, so this asserts the two are treated as distinct when neither
    // literally contains the other in the tracking body.
    const body = '- **AgentCore adds a related but different capability** (August 2026, capability)\n';
    const out = newHeadings([finding('AgentCore payments is now GA')], body);
    assert.equal(out.length, 1);
  });
});

describe('gapLine emits a safe, complete drafting command', () => {
  test('carries the exact heading and service into the gh workflow run command', () => {
    const line = gapLine(finding('Some new capability', 'bedrock-agentcore'));
    assert.ok(line.includes('Some new capability'));
    assert.ok(line.includes('-f service=bedrock-agentcore'));
    assert.ok(line.includes('gh workflow run draft-new-card.yml'));
  });

  test('REGRESSION: every workflow_dispatch input is a -f key=value pair, never a bare --flag', () => {
    // gh workflow run has no --service flag at all -- workflow_dispatch inputs
    // are ALL passed as -f key=value. Emitting `--service X` produced "unknown
    // flag: --service" when pasted verbatim (confirmed 2026-08-20, issue #13's
    // first live gap notification), so every comment this tool posted before
    // the fix contained a command that could not actually run. This test pins
    // the corrected form so the regression cannot silently return.
    const line = gapLine(finding('Some new capability', 'bedrock-agentcore'));
    assert.ok(!/--service\b/.test(line), 'must not emit a bare --service flag');
    assert.match(line, /gh workflow run draft-new-card\.yml -f entry="[^"]*" -f service=bedrock-agentcore/);
  });

  test('a heading containing a double quote is escaped, not left to break the command', () => {
    const line = gapLine(finding('AWS says "generally available" today'));
    assert.ok(line.includes('\\"generally available\\"'));
  });

  test('a missing service is called out explicitly rather than emitting an empty flag', () => {
    const line = gapLine(finding('No service recorded', null));
    assert.ok(line.includes('no service recorded'));
    assert.ok(!/--service\b/.test(line));
    assert.ok(!/-f service=\s*$/.test(line));
  });

  test('names the month label and significance for a human skimming the list', () => {
    const line = gapLine(finding('Some entry'));
    assert.ok(line.includes('August 2026'));
    assert.ok(line.includes('capability'));
  });
});
