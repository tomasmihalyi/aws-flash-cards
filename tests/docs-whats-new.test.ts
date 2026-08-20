/**
 * docs-whats-new.ts unit tests for entriesForScope(), the fix for a real
 * duplicate-drafting bug.
 *
 * Root cause, confirmed live 2026-08-20: every AgentCore announcement's
 * title contains "Amazon Bedrock AgentCore", which is ALSO a substring
 * match for bedrock's own "amazon bedrock" keyword. The same entry was
 * written into BOTH agentcore.whats-new.json and bedrock.whats-new.json,
 * and the coverage detector then drafted two near-identical cards for the
 * same announcement (AC-26 and BR-07 — BR-07 had to be retired as a content
 * duplicate). content/service-scope.json's new 'excludes' field and this
 * function are the fix: an entry matching a more specific service's
 * keywords is dropped from a broader, overlapping service's fact set.
 *
 * Run: node --test tests/docs-whats-new.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { entriesForScope, type ServiceScope, type WhatsNewEntry } from '../src/ingest/docs-whats-new.ts';

function entry(heading: string, url = 'https://aws.amazon.com/about-aws/whats-new/2026/08/x/'): WhatsNewEntry {
  return {
    iso_date: '2026-08-18',
    iso_month: '2026-08',
    month_label: 'August 2026',
    date_label: 'August 18, 2026',
    heading,
    summary: 'summary',
    url,
  };
}

const AGENTCORE: ServiceScope = { service: 'agentcore', keywords: ['agentcore', 'bedrock agentcore'], depth: 'comprehensive' };
const BEDROCK: ServiceScope = {
  service: 'bedrock',
  keywords: ['amazon bedrock', 'aws bedrock'],
  depth: 'comprehensive',
  excludes: ['agentcore'],
};
const STRANDS: ServiceScope = { service: 'strands', keywords: ['strands agents'], depth: 'comprehensive' };

describe('entriesForScope resolves the AgentCore/Bedrock keyword overlap', () => {
  test('an AgentCore announcement is excluded from Bedrock\'s fact set', () => {
    const e = entry('AgentCore payments is now generally available in Amazon Bedrock AgentCore');
    const all = [e];
    assert.deepEqual(entriesForScope(all, AGENTCORE, [AGENTCORE, BEDROCK]), [e], 'still belongs to agentcore');
    assert.deepEqual(entriesForScope(all, BEDROCK, [AGENTCORE, BEDROCK]), [], 'must NOT also belong to bedrock');
  });

  test('a genuine Bedrock-only announcement is unaffected by the exclusion', () => {
    const e = entry('Amazon Bedrock expands IAM principal cost allocation to the bedrock-mantle endpoint');
    const all = [e];
    assert.deepEqual(entriesForScope(all, BEDROCK, [AGENTCORE, BEDROCK]), [e], 'a real bedrock-only entry must still surface');
    assert.deepEqual(entriesForScope(all, AGENTCORE, [AGENTCORE, BEDROCK]), [], 'and must not falsely belong to agentcore');
  });

  test('a service with no excludes field behaves exactly as before (no regression)', () => {
    const e = entry('Strands Agents SDK v2.0 released');
    assert.deepEqual(entriesForScope([e], STRANDS, [AGENTCORE, BEDROCK, STRANDS]), [e]);
  });

  test('a heading matching neither service surfaces for neither', () => {
    const e = entry('Amazon Quick Suite adds a new connector');
    assert.deepEqual(entriesForScope([e], AGENTCORE, [AGENTCORE, BEDROCK]), []);
    assert.deepEqual(entriesForScope([e], BEDROCK, [AGENTCORE, BEDROCK]), []);
  });

  test('the real duplicate pair this bug produced (AC-26/BR-07) is now attributed once, not twice', () => {
    // The exact heading that produced two near-identical cards live.
    const e = entry('Web Search in Amazon Bedrock AgentCore adds domain and published date filtering, expands to Europe and Asia Pacific');
    const agentcoreResult = entriesForScope([e], AGENTCORE, [AGENTCORE, BEDROCK]);
    const bedrockResult = entriesForScope([e], BEDROCK, [AGENTCORE, BEDROCK]);
    assert.equal(agentcoreResult.length, 1, 'agentcore should still see it');
    assert.equal(bedrockResult.length, 0, 'bedrock must not ALSO see it — this is the bug this test pins');
  });
});
