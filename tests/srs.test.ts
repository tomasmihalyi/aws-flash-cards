/**
 * Spaced repetition tests.
 *
 * SM-2 is only worth choosing over FSRS if it is actually verified, so every
 * branch of the scheduler is covered here — including the part neither published
 * algorithm handles: a card whose content changed after the learner studied it.
 *
 * Run: node --test tests/srs.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRADES, MIN_EASE, DEFAULT_EASE, REASON,
  emptyProgress, normaliseProgress, review, cardStatus, studyQueue, studyCounts,
  describeSchedule, dayStamp, addDays, daysBetween,
  depsFingerprint, indexById, staleDependencies,
} from '../src/lib/srs.js';
import { loadCards, loadCategories } from '../src/lib/store.ts';
import { toLegacyShape, contentHash, authoredText } from '../src/lib/render.ts';

const TODAY = '2026-08-07';
/** Derived, because the deck grows and these tests are not about its size. */
const DECK_SIZE = (() => deck().length)();
function deck() {
  const cats = loadCategories();
  // Same exclusion build.ts and verify-parity.ts apply: a retired card is a
  // tombstone on disk (FR-9/FR-10, id never reused) but is never published,
  // so a learner's actual study deck never contains it either. Without this
  // filter, srs.test.ts's content-hash-uniqueness guarantee tests a
  // population the frontend never sees — caught 2026-08-20 when retiring
  // BR-07 (a content duplicate of AC-26) left it still counted here,
  // failing 'chash is present, stable and distinct per card' against a card
  // that build.ts had already correctly excluded.
  return loadCards()
    .filter((c) => c.lifecycle !== 'retired')
    .sort((a, b) => a.card_id.localeCompare(b.card_id))
    .map((c) => toLegacyShape(c, cats));
}

describe('date arithmetic is whole days and timezone-proof', () => {
  test('addDays and daysBetween are inverses', () => {
    assert.equal(addDays(TODAY, 6), '2026-08-13');
    assert.equal(daysBetween(TODAY, '2026-08-13'), 6);
    assert.equal(daysBetween('2026-08-13', TODAY), -6);
  });

  test('crossing a month boundary works', () => {
    assert.equal(addDays('2026-08-30', 3), '2026-09-02');
  });

  test('dayStamp drops the time component', () => {
    assert.equal(dayStamp('2026-08-07T23:59:59.999Z'), '2026-08-07');
  });
});

describe('SM-2 interval sequence', () => {
  test('a new card graded Good goes 1 → 6 → interval × ease', () => {
    let r = review(undefined, GRADES.good, TODAY, 'h1');
    assert.equal(r.reps, 1);
    assert.equal(r.interval, 1);
    assert.equal(r.due, addDays(TODAY, 1));

    r = review(r, GRADES.good, r.due, 'h1');
    assert.equal(r.reps, 2);
    assert.equal(r.interval, 6);

    const third = review(r, GRADES.good, r.due, 'h1');
    assert.equal(third.reps, 3);
    assert.equal(third.interval, Math.round(6 * third.ease));
    assert.ok(third.interval > 6, 'the third interval must grow');
  });

  test('Easy raises ease, Hard lowers it', () => {
    const easy = review(undefined, GRADES.easy, TODAY, 'h');
    const good = review(undefined, GRADES.good, TODAY, 'h');
    const hard = review(undefined, GRADES.hard, TODAY, 'h');
    assert.ok(easy.ease > good.ease, `easy ${easy.ease} should exceed good ${good.ease}`);
    assert.ok(hard.ease < good.ease, `hard ${hard.ease} should be below good ${good.ease}`);
  });

  test('Hard grows the interval more slowly than Good', () => {
    let base = review(undefined, GRADES.good, TODAY, 'h');
    base = review(base, GRADES.good, base.due, 'h');   // interval 6
    const good = review(base, GRADES.good, base.due, 'h');
    const hard = review(base, GRADES.hard, base.due, 'h');
    assert.ok(hard.interval < good.interval, `hard ${hard.interval} must be under good ${good.interval}`);
  });

  test('ease never falls below the floor, however many lapses', () => {
    let r = review(undefined, GRADES.good, TODAY, 'h');
    for (let i = 0; i < 30; i++) r = review(r, GRADES.again, TODAY, 'h');
    assert.equal(r.ease, MIN_EASE, 'ease must clamp at the SM-2 floor');
  });

  test('a lapse resets repetitions and brings the card back tomorrow', () => {
    let r = review(undefined, GRADES.good, TODAY, 'h');
    r = review(r, GRADES.good, r.due, 'h');
    r = review(r, GRADES.good, r.due, 'h');
    assert.ok(r.interval > 6);
    const lapsed = review(r, GRADES.again, TODAY, 'h');
    assert.equal(lapsed.reps, 0);
    assert.equal(lapsed.interval, 1);
    assert.equal(lapsed.lapses, 1);
    assert.equal(lapsed.due, addDays(TODAY, 1));
  });

  test('the ease penalty from a lapse persists into recovery', () => {
    let clean = review(undefined, GRADES.good, TODAY, 'h');
    clean = review(clean, GRADES.good, clean.due, 'h');

    let lapsed = review(undefined, GRADES.good, TODAY, 'h');
    lapsed = review(lapsed, GRADES.again, TODAY, 'h');
    lapsed = review(lapsed, GRADES.good, TODAY, 'h');
    lapsed = review(lapsed, GRADES.good, TODAY, 'h');

    assert.ok(lapsed.ease < clean.ease, 'a card you have failed should keep shorter intervals');
  });

  test('intervals are always at least one day', () => {
    let r = { reps: 5, lapses: 4, ease: MIN_EASE, interval: 1, due: TODAY, last: TODAY, chash: 'h' };
    for (const g of [GRADES.hard, GRADES.good, GRADES.easy]) {
      assert.ok(review(r, g, TODAY, 'h').interval >= 1);
    }
  });

  test('an out-of-range grade is clamped rather than corrupting state', () => {
    const low = review(undefined, -5, TODAY, 'h');
    const high = review(undefined, 99, TODAY, 'h');
    assert.ok(low.interval >= 1 && Number.isFinite(low.ease));
    assert.ok(high.interval >= 1 && Number.isFinite(high.ease));
  });
});

describe('progress storage is defensive', () => {
  test('junk input yields an empty store instead of throwing', () => {
    for (const junk of [null, undefined, 0, 'nope', [], { nope: true }]) {
      assert.deepEqual(normaliseProgress(junk), emptyProgress());
    }
  });

  test('a future schema version is discarded, not coerced', () => {
    const future = { v: 99, reviews: { 'AC-01': { interval: 5, due: TODAY } } };
    assert.deepEqual(normaliseProgress(future), emptyProgress(),
      'silently reinterpreting a newer schema would corrupt scheduling invisibly');
  });

  test('a valid store round-trips through JSON', () => {
    const p = emptyProgress();
    p.reviews['AC-01'] = review(undefined, GRADES.good, TODAY, 'h1');
    const back = normaliseProgress(JSON.parse(JSON.stringify(p)));
    assert.deepEqual(back.reviews['AC-01'], p.reviews['AC-01']);
  });

  test('malformed individual records are dropped, good ones kept', () => {
    const p = {
      v: 1,
      reviews: {
        'AC-01': review(undefined, GRADES.good, TODAY, 'h'),
        'AC-02': { nonsense: true },
        'AC-03': { interval: 'six', due: TODAY },
      },
    };
    const back = normaliseProgress(p);
    assert.ok(back.reviews['AC-01']);
    assert.ok(!back.reviews['AC-02']);
    assert.ok(!back.reviews['AC-03']);
  });

  test('missing optional fields get sane defaults', () => {
    const back = normaliseProgress({ v: 1, reviews: { 'AC-01': { interval: 6, due: TODAY } } });
    assert.equal(back.reviews['AC-01'].ease, DEFAULT_EASE);
    assert.equal(back.reviews['AC-01'].reps, 0);
    assert.equal(back.reviews['AC-01'].chash, '');
  });
});

describe('card status', () => {
  const cards = deck();

  test('an unseen card is new', () => {
    assert.equal(cardStatus(cards[0], emptyProgress(), TODAY).reason, REASON.new);
  });

  test('a card scheduled for the future is not in the queue', () => {
    const p = emptyProgress();
    p.reviews[cards[0].id] = review(undefined, GRADES.easy, TODAY, cards[0].chash);
    p.reviews[cards[0].id].due = addDays(TODAY, 30);
    assert.equal(cardStatus(cards[0], p, TODAY).reason, null);
  });

  test('a card due today or earlier is due', () => {
    const p = emptyProgress();
    p.reviews[cards[0].id] = { ...review(undefined, GRADES.good, TODAY, cards[0].chash), due: TODAY };
    assert.equal(cardStatus(cards[0], p, TODAY).reason, REASON.due);
    p.reviews[cards[0].id].due = addDays(TODAY, -9);
    const st = cardStatus(cards[0], p, TODAY);
    assert.equal(st.reason, REASON.due);
    assert.equal(st.overdueBy, 9);
  });
});

describe('the bit SM-2 and FSRS do not do: the card changed under the learner', () => {
  const cards = deck();

  test('a corrected card is resurfaced even when scheduled far in the future', () => {
    const card = cards.find((c) => c.id === 'AC-19');
    const p = emptyProgress();
    p.reviews['AC-19'] = { ...review(undefined, GRADES.easy, TODAY, 'the-hash-from-before-the-correction') };
    p.reviews['AC-19'].due = addDays(TODAY, 180);

    const st = cardStatus(card, p, TODAY);
    assert.equal(st.reason, REASON.changed,
      'a six-month interval must not keep teaching a fact that a deterministic source has since corrected');
  });

  test('an unchanged card with the same hash stays on its schedule', () => {
    const card = cards[0];
    const p = emptyProgress();
    p.reviews[card.id] = review(undefined, GRADES.easy, TODAY, card.chash);
    p.reviews[card.id].due = addDays(TODAY, 30);
    assert.equal(cardStatus(card, p, TODAY).reason, null);
  });

  test('grading a changed card clears the flag by storing the new hash', () => {
    const card = cards[0];
    const p = emptyProgress();
    p.reviews[card.id] = review(undefined, GRADES.good, TODAY, 'stale');
    p.reviews[card.id].due = addDays(TODAY, 90);
    assert.equal(cardStatus(card, p, TODAY).reason, REASON.changed);

    p.reviews[card.id] = review(p.reviews[card.id], GRADES.good, TODAY, card.chash);
    assert.notEqual(cardStatus(card, p, TODAY).reason, REASON.changed);
  });

  test('a learner with no stored hash is not spuriously flagged', () => {
    // Progress written before chash existed must not resurface the whole deck.
    const card = cards[0];
    const p = normaliseProgress({ v: 1, reviews: { [card.id]: { interval: 30, due: addDays(TODAY, 30) } } });
    assert.equal(cardStatus(card, p, TODAY).reason, null);
  });

  test('the hash tracks learnable content, not presentation', () => {
    const cats = loadCategories();
    const raw = loadCards()[0];
    const base = contentHash(authoredText(raw, cats));

    // A pictogram or badge change must NOT reset anyone's schedule.
    const repainted = { ...raw, art: 'map', badge_text: 'SOMETHING ELSE' };
    assert.equal(contentHash(authoredText(repainted, cats)), base, 'presentation must not invalidate progress');

    // A change to what the card teaches MUST.
    const reworded = { ...raw, back: { ...raw.back, lead: raw.back.lead + ' And one more thing.' } };
    assert.notEqual(contentHash(authoredText(reworded, cats)), base, 'a content change must invalidate progress');
  });

  test('the real AC-19 correction produces a different hash from its seed text', () => {
    const cats = loadCategories();
    const card = loadCards().find((c) => c.card_id === 'AC-19');
    const now = contentHash(authoredText(card, cats));
    const seeded = JSON.parse(JSON.stringify(card));
    for (const s of Object.values(seeded.slots)) s.rendered = s.seed_text;
    const before = contentHash(authoredText(seeded, cats));
    assert.notEqual(now, before,
      'the Tier A region correction must be visible to the scheduler, or nobody re-learns it');
  });
});

describe('study queue', () => {
  const cards = deck();

  test('corrected cards come before new ones, and new before due', () => {
    const p = emptyProgress();
    // AC-01 corrected, AC-05 due, AC-19 left new.
    p.reviews['AC-01'] = { ...review(undefined, GRADES.good, TODAY, 'stale'), due: addDays(TODAY, 60) };
    p.reviews['AC-05'] = { ...review(undefined, GRADES.good, TODAY, cards.find((c) => c.id === 'AC-05').chash), due: TODAY };

    const q = studyQueue(cards, p, TODAY);
    const reasons = q.map((x) => x.reason);
    assert.equal(q[0].card.id, 'AC-01');
    assert.equal(reasons[0], REASON.changed);
    assert.ok(reasons.indexOf(REASON.new) < reasons.lastIndexOf(REASON.due), 'new must precede due');
  });

  test('within due cards, the most overdue comes first', () => {
    const p = emptyProgress();
    for (const [id, daysLate] of [['AC-01', 2], ['AC-02', 20], ['AC-03', 9]] as const) {
      const c = cards.find((x) => x.id === id);
      p.reviews[id] = { ...review(undefined, GRADES.good, TODAY, c.chash), due: addDays(TODAY, -daysLate) };
    }
    // Give every other card a future date so only these three are due.
    for (const c of cards) {
      if (p.reviews[c.id]) continue;
      p.reviews[c.id] = { ...review(undefined, GRADES.good, TODAY, c.chash), due: addDays(TODAY, 99) };
    }
    const q = studyQueue(cards, p, TODAY);
    assert.deepEqual(q.map((x) => x.card.id), ['AC-02', 'AC-03', 'AC-01']);
  });

  test('a fully-scheduled deck yields an empty queue', () => {
    const p = emptyProgress();
    for (const c of cards) {
      p.reviews[c.id] = { ...review(undefined, GRADES.easy, TODAY, c.chash), due: addDays(TODAY, 45) };
    }
    assert.equal(studyQueue(cards, p, TODAY).length, 0);
  });

  test('a fresh learner sees the whole deck as new', () => {
    const q = studyQueue(cards, emptyProgress(), TODAY);
    assert.equal(q.length, DECK_SIZE);
    assert.ok(q.every((x) => x.reason === REASON.new));
  });
});

describe('study counts', () => {
  const cards = deck();

  test('counts partition the deck exactly', () => {
    const p = emptyProgress();
    p.reviews['AC-01'] = { ...review(undefined, GRADES.good, TODAY, 'stale'), due: addDays(TODAY, 60) };
    p.reviews['AC-02'] = { ...review(undefined, GRADES.good, TODAY, cards.find((c) => c.id === 'AC-02').chash), due: TODAY };
    p.reviews['AC-03'] = { ...review(undefined, GRADES.easy, TODAY, cards.find((c) => c.id === 'AC-03').chash), due: addDays(TODAY, 40) };

    const c = studyCounts(cards, p, TODAY);
    assert.equal(c.changed, 1);
    assert.equal(c.due, 1);
    assert.equal(c.scheduled, 1);
    assert.equal(c.new, DECK_SIZE - 3, 'the rest of the deck is unseen');
    assert.equal(c.changed + c.new + c.due + c.scheduled, DECK_SIZE, 'every card must be in exactly one bucket');
    assert.equal(c.total, c.changed + c.new + c.due);
  });
});

describe('schedule descriptions are honest', () => {
  const cards = deck();

  test('each state gets its own wording', () => {
    const card = cards[0];
    assert.match(describeSchedule(card, emptyProgress(), TODAY), /Not studied yet/);

    const p = emptyProgress();
    p.reviews[card.id] = { ...review(undefined, GRADES.good, TODAY, 'stale'), due: addDays(TODAY, 30) };
    assert.match(describeSchedule(card, p, TODAY), /changed since you last studied/);

    p.reviews[card.id] = { ...review(undefined, GRADES.good, TODAY, card.chash), due: TODAY };
    assert.match(describeSchedule(card, p, TODAY), /Due today/);

    p.reviews[card.id].due = addDays(TODAY, -3);
    assert.match(describeSchedule(card, p, TODAY), /Due 3 days ago/);

    p.reviews[card.id].due = addDays(TODAY, 5);
    assert.match(describeSchedule(card, p, TODAY), /Next review in 5 days/);

    p.reviews[card.id].due = addDays(TODAY, 1);
    assert.match(describeSchedule(card, p, TODAY), /in 1 day$/, 'singular day, not "1 days"');
  });
});

describe('every card in the deck carries a content hash', () => {
  test('chash is present, stable and distinct per card', () => {
    const cards = deck();
    const seen = new Set<string>();
    for (const c of cards) {
      assert.match(c.chash, /^[0-9a-f]{16}$/, `${c.id} has no usable content hash`);
      seen.add(c.chash);
    }
    assert.equal(seen.size, cards.length, 'two cards sharing a hash would cross-invalidate progress');
  });

  test('the hash is deterministic across builds', () => {
    assert.deepEqual(deck().map((c) => c.chash), deck().map((c) => c.chash));
  });
});

describe('a card whose DEPENDENCIES moved is resurfaced too (T5.8)', () => {
  /**
   * The gap this closes: `chash` only ever saw the card in front of you. AC-18
   * quotes Runtime's pricing and depends on AC-04, so a correction to AC-04 left
   * AC-18 sitting on whatever interval it had — the learner holding a belief
   * built partly on a card that had since moved, with nothing to tell them.
   */
  const cats = loadCategories();
  const raw = loadCards().sort((a, b) => a.card_id.localeCompare(b.card_id));
  const cards = raw.map((c) => toLegacyShape(c, cats));
  const byId = indexById(cards);

  /** A card with real dependencies, and one of the cards it depends on. */
  const dependent = cards.find((c) => c.deps.length > 0)!;
  const dependency = byId[dependent.deps[0]];

  test('depends_on reaches the client at all', () => {
    // It lived in cards/*.json and dist/deck.json but never in the page, so the
    // scheduler could not see a single edge.
    assert.ok(dependent, 'no card carries dependencies');
    assert.ok(Array.isArray(dependent.deps) && dependent.deps.length > 0);
    assert.ok(dependency, `${dependent.id} depends on a card that is not in the deck`);
  });

  test('the fingerprint is order-independent and names each dependency', () => {
    const fp = depsFingerprint(dependent, byId);
    assert.match(fp, new RegExp(`${dependent.deps[0]}:`));
    const shuffled = { ...dependent, deps: [...dependent.deps].reverse() };
    assert.equal(depsFingerprint(shuffled, byId), fp, 'authoring order must not change the fingerprint');
  });

  test('a card with no dependencies has an empty fingerprint and is never context-stale', () => {
    const leaf = cards.find((c) => c.deps.length === 0)!;
    assert.equal(depsFingerprint(leaf, byId), '');
    const p = emptyProgress();
    p.reviews[leaf.id] = review(undefined, GRADES.easy, TODAY, leaf.chash, depsFingerprint(leaf, byId));
    assert.notEqual(cardStatus(leaf, p, TODAY, byId).reason, REASON.context);
  });

  test('a dependency changing pulls the dependent forward, and names it', () => {
    const p = emptyProgress();
    // Studied today with a long interval: nothing about time should resurface it.
    p.reviews[dependent.id] = review(
      { reps: 9, lapses: 0, ease: 2.5, interval: 3650, due: TODAY, last: TODAY, chash: dependent.chash, dhash: '' },
      GRADES.easy, TODAY, dependent.chash, depsFingerprint(dependent, byId),
    );
    assert.equal(cardStatus(dependent, p, TODAY, byId).reason, null, 'should be scheduled far out');

    // Now a source corrects the dependency. The dependent's own text is untouched.
    const moved = { ...byId, [dependency.id]: { ...dependency, chash: 'deadbeefdeadbeef' } };
    const st = cardStatus(dependent, p, TODAY, moved);
    assert.equal(st.reason, REASON.context, `expected context-stale, got ${st.reason}`);
    assert.deepEqual(st.staleDeps, [dependency.id], 'the banner needs to name which card moved');
  });

  test('a context-stale card ranks after a changed card and before a new one', () => {
    const p = emptyProgress();
    p.reviews[dependent.id] = review(undefined, GRADES.easy, TODAY, dependent.chash, depsFingerprint(dependent, byId));
    p.reviews[dependency.id] = review(undefined, GRADES.easy, TODAY, dependency.chash, depsFingerprint(dependency, byId));

    // The dependency itself changed: it is `changed`, the dependent is `context`,
    // and everything else is `new`.
    const moved = { ...byId, [dependency.id]: { ...dependency, chash: 'ffffffffffffffff' } };
    const movedCards = cards.map((c) => (c.id === dependency.id ? moved[dependency.id] : c));
    const q = studyQueue(movedCards, p, TODAY, moved);

    const reasons = q.map((x) => x.reason);
    assert.equal(reasons[0], REASON.changed, `changed must lead: ${reasons.slice(0, 4).join(', ')}`);
    assert.equal(q[0].card.id, dependency.id);
    const ctxAt = reasons.indexOf(REASON.context);
    const newAt = reasons.indexOf(REASON.new);
    assert.ok(ctxAt > -1, 'the dependent should be queued as context-stale');
    assert.ok(ctxAt < newAt, `context (${ctxAt}) must outrank new (${newAt})`);
  });

  test('counts report context separately and total includes it', () => {
    const p = emptyProgress();
    p.reviews[dependent.id] = review(undefined, GRADES.easy, TODAY, dependent.chash, depsFingerprint(dependent, byId));
    const moved = { ...byId, [dependency.id]: { ...dependency, chash: 'aaaaaaaaaaaaaaaa' } };
    const c = studyCounts(cards, p, TODAY, moved);
    assert.equal(c.context, 1);
    assert.equal(c.total, c.changed + c.context + c.new + c.due);
  });

  test('the schedule hint distinguishes context from a correction', () => {
    const p = emptyProgress();
    p.reviews[dependent.id] = review(undefined, GRADES.easy, TODAY, dependent.chash, depsFingerprint(dependent, byId));
    const moved = { ...byId, [dependency.id]: { ...dependency, chash: 'bbbbbbbbbbbbbbbb' } };
    const hint = describeSchedule(dependent, p, TODAY, moved);
    assert.match(hint, /builds on/);
    assert.ok(!/^This card changed/.test(hint), 'must not claim the card itself changed');
  });

  test("the card's OWN change still outranks a dependency change", () => {
    // Both moved. The stronger, more actionable signal must win, or the learner
    // is told the context shifted when the answer itself is wrong.
    const p = emptyProgress();
    p.reviews[dependent.id] = review(undefined, GRADES.easy, TODAY, dependent.chash, depsFingerprint(dependent, byId));
    const moved = { ...byId, [dependency.id]: { ...dependency, chash: 'cccccccccccccccc' } };
    const selfMoved = { ...dependent, chash: 'dddddddddddddddd' };
    assert.equal(cardStatus(selfMoved, p, TODAY, moved).reason, REASON.changed);
  });

  test('an upgrade does not invent changes: a record with no dhash is never context-stale', () => {
    /**
     * The migration hazard. Records written before this feature have no
     * fingerprint, and reading "absent" as "different" would have dumped every
     * card with dependencies into the queue announcing a correction that never
     * happened.
     */
    const legacy = normaliseProgress({
      v: 1,
      reviews: {
        [dependent.id]: { reps: 3, lapses: 0, ease: 2.5, interval: 30, due: addDays(TODAY, 30), last: TODAY, chash: dependent.chash },
      },
    });
    assert.equal(legacy.reviews[dependent.id].dhash, '', 'missing dhash must normalise to empty');
    assert.equal(cardStatus(dependent, legacy, TODAY, byId).reason, null,
      'a legacy record must stay scheduled, not be re-queued as context-stale');
  });

  test('a dependency that disappears from the deck still counts as movement', () => {
    // Retirement is aliasing, not deletion — but a card genuinely absent from the
    // built deck means what this card rests on is gone, which the learner should see.
    const p = emptyProgress();
    p.reviews[dependent.id] = review(undefined, GRADES.easy, TODAY, dependent.chash, depsFingerprint(dependent, byId));
    const without = { ...byId };
    delete without[dependency.id];
    assert.deepEqual(staleDependencies(dependent, p.reviews[dependent.id], without), [dependency.id]);
  });

  test('cardStatus without a deck index behaves exactly as it did before', () => {
    // Callers that predate dependencies must degrade, not throw.
    const p = emptyProgress();
    p.reviews[dependent.id] = review(undefined, GRADES.easy, TODAY, dependent.chash, depsFingerprint(dependent, byId));
    assert.doesNotThrow(() => cardStatus(dependent, p, TODAY));
    assert.equal(cardStatus(dependent, p, TODAY).reason, null);
  });
});
