/**
 * Lifecycle drift detector tests.
 *
 * Three of these are regressions for flaws the detector shipped with on its first
 * run, all found by reading its own output against the real deck rather than by
 * reasoning about it:
 *
 *   1. short acronyms were dropped, so "CLI" never matched — the detector missed
 *      the very card that prompted writing it
 *   2. a single match on a TAG token declared the Identity card wrong against a
 *      Browser feature ("Web Bot Auth")
 *   3. a same-month tie cited "Managed Knowledge Base" instead of "Harness"
 *
 * Run: node --test tests/lifecycle.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCards, paths } from '../src/lib/store.ts';
import { datedEntriesFrom, type DatedEntry } from '../src/lib/verifier.ts';
import { detectLifecycle, detectAll, cardSubject } from '../src/lib/lifecycle.ts';
import type { Card, FactSet } from '../src/lib/types.ts';

function factSets(): FactSet[] {
  if (!existsSync(paths.facts)) return [];
  return readdirSync(paths.facts).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(paths.facts, f), 'utf8')) as FactSet);
}

const ENTRIES = datedEntriesFrom(factSets());
const CARDS = loadCards().sort((a, b) => a.card_id.localeCompare(b.card_id));

function byId(id: string): Card {
  const c = CARDS.find((x) => x.card_id === id);
  assert.ok(c, `fixture card ${id} missing`);
  return c;
}
function clone(c: Card): Card {
  return JSON.parse(JSON.stringify(c)) as Card;
}
function entry(iso: string, heading: string): DatedEntry {
  return { iso_month: iso, month_label: iso, heading, summary: '', url: 'https://example.test/notes' };
}

describe('there is a dated source to detect against', () => {
  test('release-notes entries are loaded', () => {
    assert.ok(ENTRIES.length > 50, `expected the release-notes fact set, got ${ENTRIES.length} entries`);
  });
});

describe('the transitions it finds, and the cards now agreeing with them', () => {
  // These three drifted when the detector was written and have since been
  // corrected by src/ingest/apply-lifecycle.ts. The assertions now pin BOTH halves:
  // the source still reports GA, and the card agrees. A regression in either
  // direction fails.
  test('AC-16: the CLI reached GA in March 2026, and the card says ga', () => {
    const f = detectLifecycle(byId('AC-16'), ENTRIES);
    assert.equal(f.latest?.lifecycle, 'ga');
    assert.equal(f.latest?.iso_month, '2026-03');
    assert.match(f.latest!.heading, /CLI is now Generally Available/);
    assert.equal(f.card_lifecycle, 'ga');
    assert.equal(f.drift, false, f.reason);
  });

  test('AC-16: the February preview launch is still in the signal history', () => {
    const f = detectLifecycle(byId('AC-16'), ENTRIES);
    const preview = f.signals.find((s) => s.lifecycle === 'preview');
    assert.ok(preview, 'the Feb 2026 preview launch should be in the signal list');
    assert.equal(preview.iso_month, '2026-02');
  });

  test('AC-15: the harness reached GA in July 2026, and the card says ga', () => {
    const f = detectLifecycle(byId('AC-15'), ENTRIES);
    assert.equal(f.latest?.lifecycle, 'ga');
    assert.match(f.latest!.heading, /Harness is now Generally Available/);
    assert.equal(f.drift, false, f.reason);
  });

  test('AC-13: recommendations and batch evaluations reached GA in July 2026', () => {
    const f = detectLifecycle(byId('AC-13'), ENTRIES);
    assert.equal(f.latest?.lifecycle, 'ga');
    assert.equal(f.latest?.iso_month, '2026-07');
    assert.equal(f.drift, false, f.reason);
  });

  test('no card in the deck is currently drifting', () => {
    const drifted = detectAll(CARDS, ENTRIES).filter((f) => f.drift).map((f) => f.card_id);
    assert.deepEqual(drifted, [],
      `drift appeared on ${drifted.join(', ')}. Either a feature transitioned and the card needs apply-lifecycle, or the detector regressed.`);
  });

  test('the detector still catches drift if a card regresses', () => {
    // The corrections above must not be mistaken for the detector going quiet.
    const card = clone(byId('AC-16'));
    card.lifecycle = 'preview';
    const f = detectLifecycle(card, ENTRIES);
    assert.equal(f.drift, true, 'putting AC-16 back to preview must be caught again');
    assert.match(f.reason, /CLI is now Generally Available/);
  });

  test('the badge variant agrees with the corrected lifecycle', () => {
    for (const id of ['AC-13', 'AC-15', 'AC-16']) {
      const c = byId(id);
      assert.equal(c.lifecycle, 'ga', `${id} should be ga`);
      assert.notEqual(c.badge_variant, 'pv', `${id} still carries a preview badge variant`);
      assert.match(c.badge_text, /^GA /, `${id} badge text should lead with GA, got ${c.badge_text}`);
    }
  });
});

describe('regression: short acronyms must survive tokenisation', () => {
  test('CLI is a subject token even though it is three characters', () => {
    assert.ok(cardSubject(byId('AC-16')).includes('cli'),
      'the shared stemmer drops tokens under four chars, which made the detector blind to the CLI card');
  });

  test('MCP survives too', () => {
    assert.ok(cardSubject(byId('AC-03')).includes('mcp'));
  });

  test('the service name is still excluded, or every entry would match', () => {
    for (const c of CARDS) {
      assert.ok(!cardSubject(c).includes('agentcore'), `${c.card_id} would match every release-notes entry`);
    }
  });
});

describe('regression: a lone TAG match is not evidence', () => {
  test('AC-07 Identity is not declared wrong by a Browser feature', () => {
    // "Web Bot Auth (Preview)" matches the Identity card only on its "auth" TAG.
    // Web Bot Auth is a Browser feature and says nothing about Identity's state.
    const f = detectLifecycle(byId('AC-07'), ENTRIES);
    assert.equal(f.drift, false, `false positive returned: ${f.reason}`);
  });

  test('a single match from the TITLE is accepted', () => {
    const card = clone(byId('AC-15')); // title contains "harness"
    const f = detectLifecycle(card, [entry('2026-07', 'AgentCore Harness is now Generally Available')]);
    assert.equal(f.latest?.lifecycle, 'ga', 'a distinctive title token alone should carry a match');
  });

  test('a single match from a TAG alone is rejected', () => {
    const card = clone(byId('AC-15'));
    card.title = 'Something Unrelated';
    card.tags = ['harness'];
    const f = detectLifecycle(card, [entry('2026-07', 'AgentCore Harness is now Generally Available')]);
    assert.equal(f.latest, null, 'a tag-only match must not settle a lifecycle');
  });
});

describe('regression: same-month ties pick the entry that names the feature', () => {
  test('Harness GA beats Managed Knowledge Base GA for the harness card', () => {
    const f = detectLifecycle(byId('AC-15'), [
      entry('2026-07', 'Amazon Bedrock Managed Knowledge Base is now Generally Available'),
      entry('2026-07', 'AgentCore Harness is now Generally Available'),
    ]);
    assert.match(f.latest!.heading, /Harness is now Generally Available/,
      'the more specific heading must win, not whichever came last in the file');
  });

  test('order in the source does not change the answer', () => {
    const a = detectLifecycle(byId('AC-15'), [
      entry('2026-07', 'AgentCore Harness is now Generally Available'),
      entry('2026-07', 'Amazon Bedrock Managed Knowledge Base is now Generally Available'),
    ]);
    assert.match(a.latest!.heading, /Harness is now Generally Available/);
  });
});

describe('the detector stays in its lane', () => {
  test('a later GA supersedes an earlier preview', () => {
    const f = detectLifecycle(byId('AC-15'), [
      entry('2026-04', 'AgentCore harness is now in Public Preview'),
      entry('2026-07', 'AgentCore Harness is now Generally Available'),
    ]);
    assert.equal(f.latest?.lifecycle, 'ga');
  });

  test('an earlier GA does not override a later preview', () => {
    const f = detectLifecycle(byId('AC-15'), [
      entry('2026-01', 'AgentCore Harness is now Generally Available'),
      entry('2026-07', 'AgentCore harness is now in Public Preview'),
    ]);
    assert.equal(f.latest?.lifecycle, 'preview', 'the most recent transition wins, whichever direction it goes');
  });

  test('it does not second-guess deprecated, superseded or retired', () => {
    for (const lifecycle of ['deprecated', 'superseded', 'retired'] as const) {
      const card = clone(byId('AC-16'));
      card.lifecycle = lifecycle;
      const f = detectLifecycle(card, ENTRIES);
      assert.equal(f.drift, false, `${lifecycle} is a human judgement the detector must leave alone`);
      assert.match(f.reason, /human judgement/);
    }
  });

  test('no signal is reported as no signal, not as agreement', () => {
    const f = detectLifecycle(byId('AC-16'), [entry('2026-07', 'Something entirely unrelated ships')]);
    assert.equal(f.latest, null);
    assert.equal(f.drift, false);
    assert.match(f.reason, /No lifecycle transition/);
  });

  test('every finding cites the tokens it matched on, so a human can audit it', () => {
    for (const f of detectAll(CARDS, ENTRIES)) {
      if (!f.latest) continue;
      assert.ok(f.latest.matched.length > 0, `${f.card_id} matched with no recorded tokens`);
      assert.ok(f.latest.url, `${f.card_id} signal has no source url`);
    }
  });

  test('a heading with no lifecycle language produces no signal', () => {
    const f = detectLifecycle(byId('AC-16'), [entry('2026-07', 'AgentCore CLI: Resource Import and Bash Commands')]);
    assert.equal(f.latest, null, 'a feature-addition entry is not a lifecycle transition');
  });
});
