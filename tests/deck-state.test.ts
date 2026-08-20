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
  createDeck, visibleIndices, currentCard, setFilter, setQuery, setTag, clearFilters, move, flip, shuffle,
  progress, faceState, makeRandom, scoreCard, tagIndex, toHash, fromHash, resolveCardRef, slugify,
} from '../src/lib/deck-state.js';
import { loadCards, loadCategories } from '../src/lib/store.ts';
import { toLegacyShape, provenanceLine, formatDate } from '../src/lib/render.ts';

/** The real deck, projected into the shape the state machine consumes. */
/**
 * The deck grows. Tests that only need "the whole deck" must derive its size,
 * or every content addition breaks assertions about search and filtering that
 * have nothing to do with the card count.
 */
const DECK_SIZE = (() => {
  const cats = loadCategories();
  // Same exclusion build.ts applies: a retired card is a tombstone on disk,
  // never published, so the state-machine tests that use DECK_SIZE to bound
  // navigation/filter counts must not count it either.
  return loadCards().filter((c) => c.lifecycle !== 'retired').length;
})();

function realDeck() {
  const cards = loadCards()
    .filter((c) => c.lifecycle !== 'retired')
    .sort((a, b) => a.card_id.localeCompare(b.card_id));
  const cats = loadCategories();
  return cards.map((c) => toLegacyShape(c, cats));
}

describe('search', () => {
  test('finds a card by a word in its title', () => {
    const s = setQuery(createDeck(realDeck(), { seed: 1 }), 'gateway');
    const ids = visibleIndices(s).map((i) => s.cards[i].id);
    assert.ok(ids.includes('AC-06'), `expected the Gateway card, got ${ids.join(',')}`);
    assert.equal(ids[0], 'AC-06', 'the card whose TITLE matches must rank first');
  });

  test('finds a card by its id', () => {
    const s = setQuery(createDeck(realDeck(), { seed: 1 }), 'ac-19');
    assert.equal(visibleIndices(s).map((i) => s.cards[i].id)[0], 'AC-19');
  });

  test('searches the back face, not just the front', () => {
    const s = setQuery(createDeck(realDeck(), { seed: 1 }), 'privatelink');
    const ids = visibleIndices(s).map((i) => s.cards[i].id);
    assert.ok(ids.length > 0, 'a term that only appears in back-face prose must still be findable');
  });

  test('multiple tokens are AND, not OR', () => {
    const deck = realDeck();
    const both = visibleIndices(setQuery(createDeck(deck, { seed: 1 }), 'memory pricing'));
    const justMemory = visibleIndices(setQuery(createDeck(deck, { seed: 1 }), 'memory'));
    assert.ok(both.length <= justMemory.length, 'adding a token must never widen the result set');
    for (const i of both) {
      const blob = deck[i].search;
      assert.ok(blob.includes('memory') && blob.includes('pricing'), `${deck[i].id} is missing a token`);
    }
  });

  test('a term nothing matches gives an empty result, not the whole deck', () => {
    const s = setQuery(createDeck(realDeck(), { seed: 1 }), 'kubernetes helm chart');
    assert.equal(visibleIndices(s).length, 0);
    assert.equal(currentCard(s), null);
  });

  test('search is case- and whitespace-insensitive', () => {
    const deck = realDeck();
    const a = visibleIndices(setQuery(createDeck(deck, { seed: 1 }), 'GATEWAY'));
    const b = visibleIndices(setQuery(createDeck(deck, { seed: 1 }), '  gateway  '));
    assert.deepEqual(a, b);
  });

  test('an empty query restores the full deck', () => {
    const s = createDeck(realDeck(), { seed: 1 });
    setQuery(s, 'gateway');
    setQuery(s, '');
    assert.equal(visibleIndices(s).length, DECK_SIZE);
  });

  test('results are ranked when searching but stay in deck order otherwise', () => {
    const deck = realDeck();
    const unsearched = visibleIndices(createDeck(deck, { seed: 1 }));
    assert.deepEqual(unsearched, [...Array(DECK_SIZE).keys()], 'no query means no reordering');
  });

  test('scoreCard returns 0 for a miss and a positive score for a hit', () => {
    const card = realDeck().find((d) => d.id === 'AC-06');
    assert.equal(scoreCard(card, ['nonexistentterm']), 0);
    assert.ok(scoreCard(card, ['gateway']) > 0);
    assert.ok(scoreCard(card, ['ac-06']) > scoreCard(card, ['tool']), 'an exact id match must outrank a body match');
  });
});

describe('tag filtering', () => {
  test('the tag index is derived from the cards and ordered by frequency', () => {
    const tags = tagIndex(realDeck());
    assert.ok(tags.length > 5, 'expected a real taxonomy');
    for (let i = 1; i < tags.length; i++) {
      assert.ok(tags[i - 1].count >= tags[i].count, 'tags must be ordered by count');
    }
    /**
     * DERIVED, not asserted. This used to pin agentcore at exactly 21 — a proxy
     * for "the index is computed from the cards" that broke the moment ST-02
     * legitimately carried the agentcore tag while being a Strands card. Counting
     * the cards that actually hold the tag tests the same property and survives
     * content growth, which is the whole point of a derived index.
     */
    const deck = realDeck();
    for (const { tag, count } of tags) {
      const actual = deck.filter((c) => c.tags.includes(tag)).length;
      assert.equal(count, actual, `tag "${tag}" reports ${count} but ${actual} cards carry it`);
    }
    assert.equal(tags[0].count, Math.max(...tags.map((x) => x.count)), 'the leading tag must be the most frequent');
  });

  test('a tag filter admits only cards carrying that tag', () => {
    const s = setTag(createDeck(realDeck(), { seed: 1 }), 'pricing');
    const vis = visibleIndices(s);
    assert.ok(vis.length > 0);
    for (const i of vis) assert.ok(s.cards[i].tags.includes('pricing'), `${s.cards[i].id} lacks the tag`);
  });

  test('tag and category compose rather than replacing each other', () => {
    const deck = realDeck();
    const s = createDeck(deck, { seed: 1 });
    setTag(s, 'agentcore');           // every card
    setFilter(s, 1);                  // core services only
    const vis = visibleIndices(s);
    assert.ok(vis.length > 0 && vis.length < DECK_SIZE);
    for (const i of vis) {
      assert.equal(deck[i].c, 1);
      assert.ok(deck[i].tags.includes('agentcore'));
    }
  });

  test('tag, category and query all compose', () => {
    const s = createDeck(realDeck(), { seed: 1 });
    setTag(s, 'agentcore');
    setFilter(s, 5);
    setQuery(s, 'regions');
    const ids = visibleIndices(s).map((i) => s.cards[i].id);
    assert.ok(ids.includes('AC-19'), `expected AC-19, got ${ids.join(',') || '(none)'}`);
  });

  test('an unknown tag yields nothing rather than everything', () => {
    const s = setTag(createDeck(realDeck(), { seed: 1 }), 'not-a-real-tag');
    assert.equal(visibleIndices(s).length, 0);
  });

  test('clearFilters resets category, tag and query together', () => {
    const s = createDeck(realDeck(), { seed: 1 });
    setFilter(s, 2); setTag(s, 'pricing'); setQuery(s, 'gateway');
    clearFilters(s);
    assert.equal(visibleIndices(s).length, DECK_SIZE);
    assert.equal(s.filter, -1);
    assert.equal(s.tag, null);
    assert.equal(s.query, '');
  });
});

describe('deep links', () => {
  const cats = loadCategories();
  const mk = () => createDeck(realDeck(), { seed: 1, categories: cats });

  test('a card is addressable by its slug', () => {
    const s = fromHash(mk(), '#/card/ac-19');
    assert.equal(currentCard(s).id, 'AC-19');
  });

  test('the slug is case-insensitive and tolerates a stray form', () => {
    assert.equal(currentCard(fromHash(mk(), '#/card/AC-19')).id, 'AC-19');
    assert.equal(currentCard(fromHash(mk(), '/card/ac-19')).id, 'AC-19');
  });

  test('a link round-trips through toHash and back', () => {
    const s = mk();
    setFilter(s, 5); setTag(s, 'regions'); setQuery(s, 'sydney');
    const before = currentCard(s).id;
    const hash = toHash(s);
    const restored = fromHash(mk(), hash);
    assert.equal(currentCard(restored).id, before);
    assert.equal(restored.filter, 5);
    assert.equal(restored.tag, 'regions');
    assert.equal(restored.query, 'sydney');
  });

  test('the hash names a card slug, never an index', () => {
    const s = mk();
    move(s, 3);
    const hash = toHash(s);
    assert.match(hash, /^#\/card\/ac-\d+/, hash);
    assert.ok(!/\/card\/\d+$/.test(hash), 'an index would point at a different card once the deck grows');
  });

  test('an unknown card ref degrades to the deck instead of a blank page', () => {
    const s = fromHash(mk(), '#/card/ac-999');
    assert.equal(visibleIndices(s).length, DECK_SIZE);
    assert.equal(s.pos, 0);
  });

  test('an unknown category or tag in a stale link is ignored', () => {
    const s = fromHash(mk(), '#/?cat=no-such-category&tag=no-such-tag');
    assert.equal(s.filter, -1);
    assert.equal(s.tag, null);
    assert.equal(visibleIndices(s).length, DECK_SIZE);
  });

  test('a link naming a card the filters would hide still shows the card', () => {
    // AC-19 is in operate-adopt; the link also asks for core-services.
    const s = fromHash(mk(), '#/card/ac-19?cat=core-services');
    assert.equal(currentCard(s).id, 'AC-19', 'the link named a card, so the filters must yield');
  });

  test('a card is reachable by an old name it was renamed from (FR-9)', () => {
    const deck = realDeck();
    // Simulate a rename: the card keeps its id and gains an alias.
    deck[0] = { ...deck[0], aliases: ['Bedrock Agents Runtime'] };
    const s = createDeck(deck, { seed: 1, categories: cats });
    const idx = resolveCardRef(deck, 'bedrock-agents-runtime');
    assert.equal(idx, 0, 'an alias must resolve to the card that superseded the old name');
    assert.equal(currentCard(fromHash(s, '#/card/bedrock-agents-runtime')).id, deck[0].id);
  });

  test('the current slug wins over an alias when both could match', () => {
    const deck = realDeck();
    deck[1] = { ...deck[1], aliases: ['AC-01'] }; // alias collides with card 0's real id
    assert.equal(resolveCardRef(deck, 'ac-01'), 0, 'a real slug must take precedence over another card\u2019s alias');
  });

  test('an empty hash is harmless', () => {
    for (const h of ['', '#', '#/']) {
      const s = fromHash(mk(), h);
      assert.equal(visibleIndices(s).length, DECK_SIZE);
    }
  });

  test('slugify is stable and URL-safe', () => {
    assert.equal(slugify('Bedrock Agents Classic'), 'bedrock-agents-classic');
    assert.equal(slugify('  AC-19  '), 'ac-19');
    assert.equal(slugify('Quick Suite / Quick Desktop'), 'quick-suite-quick-desktop');
  });
});

describe('provenance is visible to the learner (FR-11)', () => {
  test('a verified card shows its verification date and source', () => {
    const cards = loadCards();
    const verified = cards.find((c) => c.verified_at && c.sources.length);
    assert.ok(verified, 'expected at least one verified card after the Tier A ingest');
    const line = provenanceLine(verified);
    assert.match(line, /Verified/);
    assert.match(line, /Source/);
  });

  test('an unsourced card says so rather than looking verified', () => {
    /**
     * Previously this test looked for a slot still on its seed value, and AC-12
     * was the one that qualified. AC-12 has since been resolved from a real
     * feature-level source, so no card carries a seed slot any more — a good
     * outcome that would have quietly deleted this test's coverage if it kept
     * asserting on whichever card happened to be broken.
     *
     * The property being protected is about the RENDERER, not about any card: a
     * card with nothing behind it must never render like a verified one. The
     * boundary cards QK-02 and QK-03 are unsourced permanently and by design,
     * because no document can settle a positioning judgement.
     */
    const unsourced = loadCards().filter((c) => !c.sources.length);
    assert.ok(unsourced.length, 'expected at least one deliberately unsourced card');
    for (const c of unsourced) {
      const line = provenanceLine(c);
      assert.ok(!/Verified/.test(line), `${c.card_id} renders as verified with no source: ${line}`);
      assert.match(line, /Unsourced|Unverified/, `${c.card_id} says nothing about lacking a source: ${line}`);
    }
  });

  test('a card still on a seed value admits it, whenever one exists', () => {
    // No card is in this state today. The renderer must still handle it, because
    // the next ingest that cannot resolve a slot puts a card straight back here.
    const seeded = loadCards().find((c) => Object.values(c.slots).some((s) => s.rendered_from === 'seed'));
    if (!seeded) return;
    const line = provenanceLine(seeded);
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

  test('the deck only grows, and every card carries a category in range', () => {
    const deck = realDeck();
    assert.ok(deck.length >= 21, `the deck must never shrink below the 21 migrated cards, got ${deck.length}`);
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
    assert.equal(progress(s).label, `2 / ${DECK_SIZE}`);
    move(s, -1);
    assert.equal(progress(s).label, `1 / ${DECK_SIZE}`);
  });

  test('clamps at both ends instead of wrapping', () => {
    const s = createDeck(realDeck(), { seed: 1 });
    move(s, -5);
    assert.equal(s.pos, 0, 'must not wrap past the start');
    move(s, 999);
    assert.equal(s.pos, DECK_SIZE - 1, 'must not wrap past the end');
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
    assert.equal(visibleIndices(s).length, DECK_SIZE);
  });

  test('progress is relative to the filter, not the whole deck', () => {
    const s = setFilter(createDeck(realDeck(), { seed: 1 }), 1);
    const p = progress(s);
    assert.equal(p.position, 1);
    assert.ok(p.total < DECK_SIZE && p.total > 0);
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
    assert.equal(s.order.length, DECK_SIZE);
    assert.equal(new Set(s.order).size, DECK_SIZE, 'no duplicates');
    assert.deepEqual([...s.order].sort((a, b) => a - b), [...Array(DECK_SIZE).keys()], 'no losses');
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
