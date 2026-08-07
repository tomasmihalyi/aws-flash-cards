/**
 * Behavioural tests for the deck UX contract.
 *
 * These exist to REPLACE the byte-for-byte DOM parity gate. That gate pinned the
 * generated HTML to the original hand-authored file, which was the right check
 * while the only goal was "lose nothing in the migration" — but it also froze
 * the markup, blocking the accessibility fix and every frontend improvement.
 *
 * Pinning behaviour instead of markup is the trade: the deck must keep doing
 * what it did (filter, navigate, flip, shuffle, progress, clamping) while the
 * DOM is free to get better.
 *
 * Run: node --test tests/
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeck, visibleIndices, currentCard, setFilter, move, flip, shuffle, progress, faceState, makeRandom,
} from '../src/lib/deck-state.js';
import { loadCards, loadCategories } from '../src/lib/store.ts';
import { toLegacyShape, provenanceLine, formatDate } from '../src/lib/render.ts';

/** The real deck, projected into the shape the state machine consumes. */
function realDeck() {
  const cards = loadCards().sort((a, b) => a.card_id.localeCompare(b.card_id));
  const cats = loadCategories();
  return cards.map((c) => toLegacyShape(c, cats));
}

describe('provenance is visible to the learner (FR-11)', () => {
  test('a verified card shows its verification date and source', () => {
    const cards = loadCards();
    const verified = cards.find((c) => c.verified_at && c.sources.length);
    assert.ok(verified, 'expected at least one verified card after the Tier A ingest');
    const line = provenanceLine(verified);
    assert.match(line, /Verified/);
    assert.match(line, /Source/);
  });

  test('a card with an unverifiable claim says so rather than looking verified', () => {
    const withSeed = loadCards().find((c) => Object.values(c.slots).some((s) => s.rendered_from === 'seed'));
    assert.ok(withSeed, 'expected AC-12 to still carry its unresolvable seed slot');
    const line = provenanceLine(withSeed);
    assert.match(line, /Unverified/);
    assert.match(line, /no deterministic source exists/);
  });

  test('an http source becomes a link; a non-http one stays plain text', () => {
    const priced = loadCards().find((c) => c.sources.some((s) => s.url.startsWith('http')));
    if (priced) assert.match(provenanceLine(priced), /<a href="http/);
    const ssm = loadCards().find((c) => c.sources.some((s) => s.url.startsWith('ssm:')));
    if (ssm) {
      const line = provenanceLine(ssm);
      assert.match(line, /AWS global-infrastructure \(SSM\)/);
      assert.ok(!line.includes('<a href="ssm:'), 'an ssm: url is not a clickable link');
    }
  });

  test('dates render in a fixed format so the build stays deterministic', () => {
    assert.equal(formatDate('2026-08-06T12:59:23.166Z'), '6 Aug 2026');
    assert.equal(formatDate('2026-01-31T00:00:00.000Z'), '31 Jan 2026');
  });
});

describe('deck state — construction', () => {
  test('starts on the first card, unflipped, unfiltered', () => {
    const s = createDeck(realDeck(), { seed: 1 });
    assert.equal(s.pos, 0);
    assert.equal(s.flipped, false);
    assert.equal(s.filter, -1);
    assert.equal(visibleIndices(s).length, s.cards.length);
  });

  test('the real deck has 21 cards and every one carries a category in range', () => {
    const deck = realDeck();
    assert.equal(deck.length, 21);
    const catCount = loadCategories().length;
    for (const d of deck) {
      assert.ok(d.c >= 0 && d.c < catCount, `${d.id} category index ${d.c} out of range`);
    }
  });
});

describe('deck state — navigation', () => {
  test('next advances, prev retreats', () => {
    const s = createDeck(realDeck(), { seed: 1 });
    move(s, 1);
    assert.equal(progress(s).label, '2 / 21');
    move(s, -1);
    assert.equal(progress(s).label, '1 / 21');
  });

  test('clamps at both ends instead of wrapping', () => {
    const s = createDeck(realDeck(), { seed: 1 });
    move(s, -5);
    assert.equal(s.pos, 0, 'must not wrap past the start');
    move(s, 999);
    assert.equal(s.pos, 20, 'must not wrap past the end');
    assert.equal(progress(s).atEnd, true);
  });

  test('turning to a new card always shows its front', () => {
    const s = createDeck(realDeck(), { seed: 1 });
    flip(s);
    assert.equal(s.flipped, true);
    move(s, 1);
    assert.equal(s.flipped, false, 'a card arriving pre-flipped would leak the answer');
  });

  test('a move that changes nothing leaves the flip state alone', () => {
    const s = createDeck(realDeck(), { seed: 1 });
    flip(s);
    move(s, -1); // already at position 0
    assert.equal(s.flipped, true);
  });
});

describe('deck state — filtering', () => {
  test('each category filter admits only its own cards', () => {
    const deck = realDeck();
    const cats = loadCategories();
    let covered = 0;
    for (let ci = 0; ci < cats.length; ci++) {
      const s = setFilter(createDeck(deck, { seed: 1 }), ci);
      const vis = visibleIndices(s);
      assert.ok(vis.length > 0, `category ${cats[ci].id} has no cards`);
      for (const i of vis) assert.equal(deck[i].c, ci);
      covered += vis.length;
    }
    assert.equal(covered, deck.length, 'every card must be reachable through exactly one filter');
  });

  test('filtering resets position and flip', () => {
    const s = createDeck(realDeck(), { seed: 1 });
    move(s, 5);
    flip(s);
    setFilter(s, 1);
    assert.equal(s.pos, 0);
    assert.equal(s.flipped, false);
  });

  test('All restores the full deck', () => {
    const s = createDeck(realDeck(), { seed: 1 });
    setFilter(s, 2);
    setFilter(s, -1);
    assert.equal(visibleIndices(s).length, 21);
  });

  test('progress is relative to the filter, not the whole deck', () => {
    const s = setFilter(createDeck(realDeck(), { seed: 1 }), 1);
    const p = progress(s);
    assert.equal(p.position, 1);
    assert.ok(p.total < 21 && p.total > 0);
    assert.equal(p.label, `1 / ${p.total}`);
  });

  test('an empty filter degrades safely rather than throwing', () => {
    // Category index 99 admits nothing — the "No cards in this filter" path.
    const s = setFilter(createDeck(realDeck(), { seed: 1 }), 99);
    assert.equal(visibleIndices(s).length, 0);
    assert.equal(currentCard(s), null);
    assert.deepEqual(progress(s), {
      position: 0, total: 0, percent: 0, label: '0 / 0', atStart: true, atEnd: true,
    });
    move(s, 1); // must not throw or produce a negative position
    assert.equal(s.pos, 0);
  });
});

describe('deck state — shuffle', () => {
  test('permutes without losing or duplicating a card', () => {
    const s = createDeck(realDeck(), { seed: 42 });
    shuffle(s);
    assert.equal(s.order.length, 21);
    assert.equal(new Set(s.order).size, 21, 'no duplicates');
    assert.deepEqual([...s.order].sort((a, b) => a - b), [...Array(21).keys()], 'no losses');
  });

  test('actually reorders', () => {
    const s = createDeck(realDeck(), { seed: 42 });
    const before = [...s.order];
    shuffle(s);
    assert.notDeepEqual(s.order, before);
  });

  test('same seed gives the same permutation', () => {
    const a = createDeck(realDeck(), { seed: 7 });
    const b = createDeck(realDeck(), { seed: 7 });
    shuffle(a);
    shuffle(b);
    assert.deepEqual(a.order, b.order);
  });

  test('returns to the first card, unflipped', () => {
    const s = createDeck(realDeck(), { seed: 7 });
    move(s, 4);
    flip(s);
    shuffle(s);
    assert.equal(s.pos, 0);
    assert.equal(s.flipped, false);
  });

  test('the PRNG is uniform enough not to be obviously broken', () => {
    const r = makeRandom(123);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 10000; i++) buckets[Math.floor(r() * 10)]++;
    for (const b of buckets) assert.ok(b > 700 && b < 1300, `bucket ${b} outside expected range`);
  });
});

describe('accessibility — the defect the original deck shipped with', () => {
  test('exactly one face is exposed to assistive technology at a time', () => {
    const s = createDeck(realDeck(), { seed: 1 });
    let f = faceState(s);
    assert.equal(f.front.hidden, false);
    assert.equal(f.back.hidden, true, 'the answer must not be readable while the question shows');

    flip(s);
    f = faceState(s);
    assert.equal(f.front.hidden, true);
    assert.equal(f.back.hidden, false);
  });

  test('the two faces are never both hidden or both exposed', () => {
    const s = createDeck(realDeck(), { seed: 1 });
    for (let i = 0; i < 6; i++) {
      const f = faceState(s);
      assert.notEqual(f.front.hidden, f.back.hidden, 'exactly one face must be hidden');
      if (i % 2 === 0) flip(s); else move(s, 1);
    }
  });

  test('the control label states the current side and what pressing does', () => {
    const s = createDeck(realDeck(), { seed: 1 });
    const front = faceState(s).label;
    assert.match(front, /Showing the question/);
    assert.match(front, /reveal detail/);
    flip(s);
    const back = faceState(s).label;
    assert.match(back, /Showing detail/);
    assert.match(back, /show the question/);
    assert.notEqual(front, back, 'a static label leaves a screen-reader user unable to tell which side is up');
  });

  test('the label names the card, so the control is not just "button"', () => {
    const s = createDeck(realDeck(), { seed: 1 });
    const card = currentCard(s);
    assert.ok(faceState(s).label.includes(card.t));
  });
});
