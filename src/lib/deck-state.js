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
 *            back:{lead:string,kv:[string,string][],hookline:string},
 *            tags?:string[],slug?:string,aliases?:string[],search?:string}} DeckCard
 * @typedef {{cards:DeckCard[],order:number[],filter:number,tag:string|null,
 *            query:string,pos:number,flipped:boolean,rand:()=>number,
 *            categories:{id:string,label:string}[]}} DeckState
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
 * @param {{seed?:number,categories?:{id:string,label:string}[]}} [opts]
 * @returns {DeckState}
 */
export function createDeck(cards, opts = {}) {
  return {
    cards,
    order: cards.map((_, i) => i),
    filter: -1,
    tag: null,
    query: '',
    pos: 0,
    flipped: false,
    rand: makeRandom(opts.seed ?? (Date.now() & 0x7fffffff)),
    categories: opts.categories ?? [],
  };
}

/** Everything a card can be matched on, lowercased once. */
export function searchBlob(card) {
  if (card.search) return card.search;
  return [
    card.id, card.t, card.hook, card.back.lead, card.back.hookline,
    ...card.back.kv.flatMap((r) => r),
    ...(card.tags ?? []),
    ...(card.aliases ?? []),
  ].join(' \u00b7 ').toLowerCase();
}

/**
 * Relevance score for a query against one card, or 0 for no match.
 *
 * Every token must appear somewhere (AND, not OR) — with 200+ cards, an OR
 * search returns the whole deck and is worse than no search at all. Where a
 * token appears then decides the ranking.
 *
 * @param {DeckCard} card
 * @param {string[]} tokens lowercased
 * @returns {number}
 */
export function scoreCard(card, tokens) {
  if (!tokens.length) return 1;
  const title = card.t.toLowerCase();
  const tags = (card.tags ?? []).join(' ').toLowerCase();
  const hook = card.hook.toLowerCase();
  const blob = searchBlob(card);
  let score = 0;
  for (const tok of tokens) {
    if (!blob.includes(tok)) return 0;
    if (card.id.toLowerCase() === tok) score += 10;
    if (title.includes(tok)) score += 4;
    if (tags.includes(tok)) score += 3;
    if (hook.includes(tok)) score += 2;
    score += 1;
  }
  return score;
}

export function tokenise(query) {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Indices the current category, tag and query all admit.
 *
 * When a query is present the result is ranked by relevance; otherwise it stays
 * in deck order (which shuffle may have permuted). Sorting only when searching
 * matters: a learner working through a category expects a stable sequence.
 *
 * @param {DeckState} s
 * @returns {number[]}
 */
export function visibleIndices(s) {
  const tokens = tokenise(s.query);
  const scored = [];
  for (const i of s.order) {
    const card = s.cards[i];
    if (s.filter >= 0 && card.c !== s.filter) continue;
    if (s.tag && !(card.tags ?? []).includes(s.tag)) continue;
    const score = scoreCard(card, tokens);
    if (score === 0) continue;
    scored.push([i, score]);
  }
  if (tokens.length) scored.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return scored.map(([i]) => i);
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
 * @param {DeckState} s
 * @param {string} query
 * @returns {DeckState}
 */
export function setQuery(s, query) {
  s.query = query ?? '';
  s.pos = 0;
  s.flipped = false;
  return s;
}

/**
 * @param {DeckState} s
 * @param {string|null} tag null clears it
 * @returns {DeckState}
 */
export function setTag(s, tag) {
  s.tag = tag || null;
  s.pos = 0;
  s.flipped = false;
  return s;
}

/** Clear category, tag and query in one go. */
export function clearFilters(s) {
  s.filter = -1;
  s.tag = null;
  s.query = '';
  s.pos = 0;
  s.flipped = false;
  return s;
}

/** Every tag in the deck with its card count, most common first. */
export function tagIndex(cards) {
  const counts = new Map();
  for (const c of cards) for (const t of c.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Resolve a URL reference to a card index.
 *
 * Accepts the card's own slug OR any alias it has ever been known by, which is
 * what makes a shared link survive a rename (FR-9). Aliases are additive and
 * never removed, so a link posted in Slack two years ago still lands on the
 * right card even after the underlying service was renamed.
 *
 * @param {DeckCard[]} cards
 * @param {string} ref
 * @returns {number} index, or -1
 */
export function resolveCardRef(cards, ref) {
  if (!ref) return -1;
  const want = slugify(ref);
  let i = cards.findIndex((c) => (c.slug ?? slugify(c.id)) === want);
  if (i >= 0) return i;
  i = cards.findIndex((c) => (c.aliases ?? []).some((a) => slugify(a) === want));
  return i;
}

export function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Serialise the shareable part of the state to a URL hash.
 *
 * Card position is expressed as a card SLUG, never an index: an index would
 * silently point at a different card as soon as the deck grows or is shuffled,
 * which is the fastest way to make shared links quietly wrong.
 *
 * @param {DeckState} s
 * @returns {string}
 */
export function toHash(s) {
  const card = currentCard(s);
  const params = new URLSearchParams();
  if (s.filter >= 0 && s.categories[s.filter]) params.set('cat', s.categories[s.filter].id);
  if (s.tag) params.set('tag', s.tag);
  if (s.query) params.set('q', s.query);
  const qs = params.toString();
  const path = card ? `/card/${card.slug ?? slugify(card.id)}` : '/';
  return `#${path}${qs ? '?' + qs : ''}`;
}

/**
 * Apply a URL hash to the state. Unknown categories, tags and card refs are
 * ignored rather than throwing — a stale or hand-edited link should degrade to
 * the full deck, not a blank page.
 *
 * @param {DeckState} s
 * @param {string} hash
 * @returns {DeckState}
 */
export function fromHash(s, hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  const [path, qs] = raw.split('?');
  const params = new URLSearchParams(qs ?? '');

  const cat = params.get('cat');
  const catIndex = cat ? s.categories.findIndex((c) => c.id === cat) : -1;
  s.filter = catIndex;

  const tag = params.get('tag');
  s.tag = tag && s.cards.some((c) => (c.tags ?? []).includes(tag)) ? tag : null;

  s.query = params.get('q') ?? '';
  s.flipped = false;
  s.pos = 0;

  const m = /^\/card\/(.+)$/.exec(path ?? '');
  if (m) {
    const idx = resolveCardRef(s.cards, m[1]);
    if (idx >= 0) {
      // The card must be reachable under the filters the same link carries;
      // if it is not, the filters lose — the link named a card, so show it.
      let vis = visibleIndices(s);
      if (!vis.includes(idx)) {
        clearFilters(s);
        vis = visibleIndices(s);
      }
      const at = vis.indexOf(idx);
      if (at >= 0) s.pos = at;
    }
  }
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
