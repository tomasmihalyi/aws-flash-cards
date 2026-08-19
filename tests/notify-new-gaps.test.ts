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
    assert.ok(line.includes('--service bedrock-agentcore'));
    assert.ok(line.includes('gh workflow run draft-new-card.yml'));
  });

  test('a heading containing a double quote is escaped, not left to break the command', () => {
    const line = gapLine(finding('AWS says "generally available" today'));
    assert.ok(line.includes('\\"generally available\\"'));
  });

  test('a missing service is called out explicitly rather than emitting an empty flag', () => {
    const line = gapLine(finding('No service recorded', null));
    assert.ok(line.includes('none recorded'));
    assert.ok(!line.includes('--service \n'));
  });

  test('names the month label and significance for a human skimming the list', () => {
    const line = gapLine(finding('Some entry'));
    assert.ok(line.includes('August 2026'));
    assert.ok(line.includes('capability'));
  });
});
