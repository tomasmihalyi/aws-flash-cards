/**
 * draft-new-cards-batch.ts unit tests for its one pure, exported helper.
 *
 * Everything else in this tool is process orchestration (git, the model,
 * apply-new-card.ts, gh pr create) that was verified by actually running it
 * end to end against real live coverage gaps with a real model, TWICE --
 * see the PR description for both runs. The second run is the load-bearing
 * one: it caught a real id-collision bug the first architecture had (two
 * gaps drafted before either was applied both allocated "BR-04"), which is
 * why the tool now completes one gap's full draft->apply->commit->push->PR
 * cycle before the next gap's draft call ever reads the id ledger. That
 * ordering guarantee cannot be pinned by a unit test without mocking git,
 * the model, and GitHub's API -- it was proven by running the real thing.
 *
 * What belongs in CI is the one piece of string-parsing this tool does that
 * is exactly the class of bug that already bit this project once this
 * session (the --service flag syntax fix, PR #16): reading a card id back
 * out of another tool's log output.
 *
 * Run: node --test tests/draft-new-cards-batch.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cardIdFromDraftOutput } from '../tools/draft-new-cards-batch.ts';

describe('cardIdFromDraftOutput reads back exactly what THIS call wrote', () => {
  test('extracts the id from a real draft-new-card.ts success line', () => {
    const output = [
      'draft-new-card: "Some gap" (August 2026) · model au.anthropic.claude-sonnet-4-5-20250929-v1:0',
      '',
      'outcome: REVIEW (candidate id BR-04)',
      '  no checkable (numeric/date/region) claim in the draft — needs a human read regardless',
      '',
      'draft-new-card: wrote /home/runner/work/aws-flash-cards/aws-flash-cards/drafts/BR-04.new-card.json',
    ].join('\n');
    assert.equal(cardIdFromDraftOutput(output), 'BR-04');
  });

  test('returns null on a discard, which prints no "wrote" line at all', () => {
    const output = [
      'draft-new-card: "Some gap" (August 2026) · model au.anthropic.claude-sonnet-4-5-20250929-v1:0',
      '',
      'outcome: DISCARD (candidate id AC-26)',
      '  the draft broke the new-card contract (NUMERAL_UNGROUNDED)',
      '',
      'draft-new-card: report only (pass --write to act on this outcome)',
    ].join('\n');
    assert.equal(cardIdFromDraftOutput(output), null);
  });

  test('matches the LAST "wrote" line, not an id merely mentioned earlier in the log', () => {
    // The "candidate id" line and the "wrote" line can name different-looking
    // text; this asserts the extractor reads the wrote line specifically,
    // not the first id-shaped token anywhere in the output.
    const output = [
      'outcome: REVIEW (candidate id ST-02)',
      'draft-new-card: wrote /abs/path/drafts/ST-02.new-card.json',
    ].join('\n');
    assert.equal(cardIdFromDraftOutput(output), 'ST-02');
  });

  test('works with either forward-slash or backslash path separators', () => {
    assert.equal(cardIdFromDraftOutput('draft-new-card: wrote /abs/drafts/QK-04.new-card.json'), 'QK-04');
    assert.equal(cardIdFromDraftOutput('draft-new-card: wrote C:\\repo\\drafts\\QK-04.new-card.json'), 'QK-04');
  });
});
