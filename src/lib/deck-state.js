/**
 * Deck state machine — pure, no DOM.
 *
 * Extracted from the single-file SPA so the UX contract (filter, navigate,
 * flip, shuffle, progress) can be tested without a browser. This is what lets
 * the byte-for-byte DOM parity gate be retired: behaviour is pinned by tests
 * here, so the markup is free to improve.
 *
 * WHY PLAIN JS AND NOT TYPESCRIPT: this file is inlined verbatim into the
 * single-file offline HTML, which has no build step. Type annotations would be
 * a syntax error in the browser. JSDoc gives the same editor type-checking
 * without needing a transpile, so there is exactly one source of truth for the
 * state machine rather than a TS original and a shipped JS copy that can drift.
 *
 * @typedef {{c:number,id:string,b:string,bt:string,art:string,t:string,hook:string,
 *            back:{lead:string,kv:[string,string][],hookline:string}}} DeckCard
 * @typedef {{cards:DeckCard[],order:number[],filter:number,pos:number,
 *            flipped:boolean,rand:()=>number}} DeckState
 */

/**
 * Deterministic PRNG (mulberry32). Seeded so shuffle is reproducible in tests;
 * real use passes no seed and gets a time-based one.
 * @param {number} seed
 * @returns {() => number}
 */
export function makeRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {DeckCard[]} cards
 * @param {{seed?:number}} [opts]
 * @returns {DeckState}
 */
export function createDeck(cards, opts = {}) {
  return {
    cards,
    order: cards.map((_, i) => i),
    filter: -1,
    pos: 0,
    flipped: false,
    rand: makeRandom(opts.seed ?? (Date.now() & 0x7fffffff)),
  };
}

/**
 * Indices of cards the current filter admits, in deck order.
 * @param {DeckState} s
 * @returns {number[]}
 */
export function visibleIndices(s) {
  return s.filter < 0 ? s.order : s.order.filter((i) => s.cards[i].c === s.filter);
}

/**
 * The card on screen, or null when the filter admits nothing.
 * @param {DeckState} s
 * @returns {DeckCard|null}
 */
export function currentCard(s) {
  const v = visibleIndices(s);
  return v.length ? s.cards[v[s.pos]] : null;
}

/**
 * @param {DeckState} s
 * @param {number} categoryIndex -1 for "All"
 * @returns {DeckState}
 */
export function setFilter(s, categoryIndex) {
  s.filter = categoryIndex;
  s.pos = 0;
  s.flipped = false;
  return s;
}

/**
 * Move by delta, clamped. Clamping (rather than wrapping) is the legacy
 * behaviour and what the disabled Prev/Next buttons communicate.
 * @param {DeckState} s
 * @param {number} delta
 * @returns {DeckState}
 */
export function move(s, delta) {
  const total = visibleIndices(s).length;
  const next = Math.min(Math.max(s.pos + delta, 0), Math.max(total - 1, 0));
  if (next !== s.pos) {
    s.pos = next;
    // Turning to a new card always shows its front. A card that arrived
    // already flipped would leak the answer, which defeats a flashcard.
    s.flipped = false;
  }
  return s;
}

/**
 * @param {DeckState} s
 * @returns {DeckState}
 */
export function flip(s) {
  s.flipped = !s.flipped;
  return s;
}

/**
 * Fisher-Yates over the full order, then back to the first card.
 * @param {DeckState} s
 * @returns {DeckState}
 */
export function shuffle(s) {
  for (let i = s.order.length - 1; i > 0; i--) {
    const j = Math.floor(s.rand() * (i + 1));
    [s.order[i], s.order[j]] = [s.order[j], s.order[i]];
  }
  s.pos = 0;
  s.flipped = false;
  return s;
}

/**
 * @param {DeckState} s
 * @returns {{position:number,total:number,percent:number,label:string,
 *            atStart:boolean,atEnd:boolean}}
 */
export function progress(s) {
  const total = visibleIndices(s).length;
  const position = total ? s.pos + 1 : 0;
  return {
    position,
    total,
    percent: total ? (position / total) * 100 : 0,
    label: total ? `${position} / ${total}` : '0 / 0',
    atStart: s.pos === 0,
    atEnd: s.pos >= total - 1,
  };
}

/**
 * Accessibility state for the two faces. The legacy deck kept both faces in the
 * DOM at all times with no aria-hidden, so a screen reader read the answer
 * aloud while the question was still showing. Visibility is a 3D transform, so
 * the hidden face has to be marked explicitly — CSS backface-visibility means
 * nothing to assistive technology.
 * @param {DeckState} s
 * @returns {{front:{hidden:boolean},back:{hidden:boolean},label:string}}
 */
export function faceState(s) {
  const card = currentCard(s);
  const title = card ? card.t : '';
  return {
    front: { hidden: s.flipped },
    back: { hidden: !s.flipped },
    label: s.flipped
      ? `Flashcard: ${title}. Showing detail. Press to show the question.`
      : `Flashcard: ${title}. Showing the question. Press to reveal detail.`,
  };
}
