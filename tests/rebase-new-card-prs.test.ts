/**
 * rebase-new-card-prs.ts unit tests for its two pure, exported helpers.
 *
 * The git/gh orchestration (main(): list conflicting PRs, rebase each,
 * resolve, push) needs a real repo with real conflicting branches to
 * exercise meaningfully, and was proven by hand twice this session before
 * this tool existed (PR #27 and #28 both conflicted on the ledger after
 * #26 merged, resolved identically to what mergeLedgerIssued() now
 * automates). What belongs in CI is the one piece of logic that decides
 * WHAT the resolved content should be, and whether a conflict is safe to
 * auto-resolve at all.
 *
 * Run: node --test tests/rebase-new-card-prs.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLedgerIssued, isLedgerOnlyConflict } from '../tools/rebase-new-card-prs.ts';

describe('mergeLedgerIssued matches saveIdLedger()\'s own union-and-sort convention', () => {
  test('unions two non-overlapping id lists and sorts the result', () => {
    const ours = ['AC-01', 'BR-01', 'BR-02', 'BR-03', 'BR-04'];
    const theirs = ['AC-01', 'BR-01', 'BR-02', 'BR-03', 'BR-05'];
    assert.deepEqual(mergeLedgerIssued(ours, theirs), ['AC-01', 'BR-01', 'BR-02', 'BR-03', 'BR-04', 'BR-05']);
  });

  test('a fully identical pair of lists produces no duplicates', () => {
    const list = ['AC-01', 'BR-01'];
    assert.deepEqual(mergeLedgerIssued(list, [...list]), list);
  });

  test('handles three or more new ids from the same batch, each side seeing a different subset', () => {
    // Mirrors the real scenario: PR #26 (BR-04) merges first, so PR #27's
    // "theirs" already has BR-04 that "ours" (PR #27's own branch) does not,
    // while "ours" has BR-05 that "theirs" does not yet.
    const ours = ['BR-01', 'BR-02', 'BR-03', 'BR-05'];
    const theirs = ['BR-01', 'BR-02', 'BR-03', 'BR-04'];
    assert.deepEqual(mergeLedgerIssued(ours, theirs), ['BR-01', 'BR-02', 'BR-03', 'BR-04', 'BR-05']);
  });

  test('a retired id present on only one side is still kept — union never drops an id', () => {
    // FR-9: an id is NEVER reused or removed, even after retirement. The
    // merge must never silently drop an id that one side has and the other
    // does not, whatever the reason for the difference.
    assert.deepEqual(mergeLedgerIssued(['BR-03'], []), ['BR-03']);
  });
});

describe('isLedgerOnlyConflict refuses anything broader than the one known-safe shape', () => {
  test('true when the ledger is the only conflicted path', () => {
    assert.equal(isLedgerOnlyConflict(['content/card-id-ledger.json']), true);
  });

  test('false when a card file is also conflicted — never auto-resolve that', () => {
    assert.equal(isLedgerOnlyConflict(['content/card-id-ledger.json', 'cards/BR-04.json']), false);
  });

  test('false when the conflict list is empty (nothing to resolve, not a safe case to claim)', () => {
    assert.equal(isLedgerOnlyConflict([]), false);
  });

  test('false when some entirely different file conflicts, even alone', () => {
    assert.equal(isLedgerOnlyConflict(['README.md']), false);
  });
});
