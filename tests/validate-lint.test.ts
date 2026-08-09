/**
 * Tests for L-NUMERIC's past-date exemption.
 *
 * The rule exists to catch numbers that will DRIFT — a price, a region count, a
 * quota — because a literal typed into prose cannot notice when it changes. A date
 * already in the past has nothing left to drift into, so it is exempt from
 * governance while remaining subject to `verify-claims`, which is stricter about
 * dates than this rule ever was.
 *
 * Every test below is about the exemption not over-reaching. Loosening a guardrail
 * is only safe if the thing it was actually protecting still fails.
 *
 * Run: node --test tests/validate-lint.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isPastDate, dateLiteralAt, NUMERIC_LITERAL_RE } from '../src/validate.ts';

/** Pinned, so these assertions do not change meaning as the real clock moves. */
const NOW = new Date('2026-08-09T00:00:00Z');

/** What the rule would report for one field of prose, or null if it stays quiet. */
function firstUngoverned(text: string, today = NOW): string | null {
  for (const m of text.matchAll(NUMERIC_LITERAL_RE)) {
    const literal = dateLiteralAt(text, m.index ?? 0, m[0]);
    if (isPastDate(literal, today)) continue;
    return m[0].trim();
  }
  return null;
}

describe('a date that has already passed cannot drift', () => {
  test('a past month-and-year is exempt', () => {
    assert.equal(isPastDate('Nov 2023', NOW), true);
    assert.equal(isPastDate('Apr 2026', NOW), true);
    assert.equal(isPastDate('July 2026', NOW), true);
  });

  test('a past day-precision date is exempt', () => {
    assert.equal(isPastDate('July 30, 2026', NOW), true);
    assert.equal(isPastDate('Aug 8 2026', NOW), true);
  });

  test('a year that is entirely over is exempt', () => {
    assert.equal(isPastDate('2025', NOW), true);
    assert.equal(isPastDate('2023', NOW), true);
  });
});

describe('the exemption does not over-reach', () => {
  test('a FUTURE date still warns', () => {
    // The whole point: a date that has not happened can still change.
    assert.equal(isPastDate('Dec 2026', NOW), false);
    assert.equal(isPastDate('Aug 30, 2026', NOW), false);
    assert.equal(isPastDate('2027', NOW), false);
  });

  test('today itself is not "already passed"', () => {
    assert.equal(isPastDate('Aug 9, 2026', NOW), false);
    assert.equal(isPastDate('August 2026', NOW), false, 'the current month is not over');
  });

  test('a bare CURRENT year is not exempt, because the year is not over', () => {
    /**
     * This is why AC-05's "Memory streaming (2026)" still warns, and should: a
     * bare current-year reference is imprecise prose, not a settled historical
     * fact. The release notes place it in March 2026 — writing that would both
     * satisfy the rule and tell the learner more.
     */
    assert.equal(isPastDate('2026', NOW), false);
  });

  test('a PRICE is never exempt, whatever dates surround it', () => {
    // A price is the archetypal drifting number. Nothing about a nearby date
    // should silence it.
    //
    // The reported literal is truncated ("$0", not "$0.005") because the money
    // branch of NUMERIC_LITERAL_RE is `\$\s?\d` — a PRESENCE detector, not an
    // extractor. It only has to prove an ungoverned price is in the prose; the
    // exact value is the slot's job once one exists.
    assert.equal(firstUngoverned('Since Nov 2023 it has cost $0.005 per call.'), '$0');
    assert.equal(firstUngoverned('Announced Apr 2026 at $12 per month.'), '$1');
  });

  test('a QUANTITY is never exempt', () => {
    assert.equal(firstUngoverned('Available in 19 regions since Nov 2023.'), '19 regions');
    assert.equal(firstUngoverned('Sessions run up to 8 hours, GA Oct 2025.'), '8 hours');
    assert.equal(firstUngoverned('Latency improved 30% in Apr 2026.'), '30%');
  });

  test('a past date no longer hides a live number after it', () => {
    /**
     * Regression for the shape of the old rule. It matched only the FIRST literal
     * in a field, so exempting that one would have silenced everything following.
     * The scan now continues.
     */
    assert.equal(firstUngoverned('Launched Nov 2023 and now serves 40 regions.'), '40 regions');
    assert.equal(firstUngoverned('GA July 2026. Costs $3.50 per GB.'), '$3');
  });

  test('prose with only past dates is silent', () => {
    assert.equal(firstUngoverned('Bedrock Agents launched Nov 2023 and closed July 30, 2026.'), null);
    assert.equal(firstUngoverned('Added at re:Invent 2025.'), null);
  });
});

describe('a year gets its month from the surrounding text', () => {
  test('a month immediately before the year is picked up', () => {
    const text = 'billed at S3 rates from Apr 2026';
    const at = text.indexOf('2026');
    assert.equal(dateLiteralAt(text, at, '2026'), 'Apr 2026');
  });

  test('a day-precision form is picked up whole', () => {
    const text = "closed to new customers after July 30, 2026.";
    const at = text.indexOf('2026');
    assert.equal(dateLiteralAt(text, at, '2026'), 'July 30, 2026');
  });

  test('a standalone year falls back to the bare match', () => {
    const text = 'Memory streaming (2026) reduces the lag';
    const at = text.indexOf('2026');
    assert.equal(dateLiteralAt(text, at, '2026'), '2026');
  });

  test('an unrelated month elsewhere in the field is not borrowed', () => {
    // "March" belongs to a different clause; the 2027 must stay a bare year, or a
    // future date could be exempted by a past month sitting nearby.
    const text = 'Shipped in March 2026; the cutoff is 2027';
    const at = text.lastIndexOf('2027');
    assert.equal(dateLiteralAt(text, at, '2027'), '2027');
    assert.equal(isPastDate('2027', NOW), false);
  });
});
