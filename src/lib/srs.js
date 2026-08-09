/**
 * Spaced repetition — SM-2, plus the bit this deck actually needs.
 *
 * WHY SM-2 AND NOT FSRS
 *
 * FSRS schedules better than SM-2; that is not in dispute. Two reasons it is
 * still the wrong choice *here*:
 *
 *   1. FSRS's advantage comes from its trained weights. Optimising them needs a
 *      few hundred reviews of personal history, which nobody has on day one, so
 *      the realistic comparison is SM-2 against FSRS-with-stock-weights — a much
 *      narrower gap than the headline.
 *   2. This project's whole premise is that its claims are checkable. FSRS's
 *      correctness rests on 19 magic constants and a power-law forgetting curve
 *      I cannot verify offline against reference vectors. Shipping an
 *      unverifiable scheduler into a deck built on verifiability would be a
 *      quiet contradiction. SM-2 is forty lines of arithmetic and every branch
 *      below is covered by a test.
 *
 * Revisit FSRS once there is a real review log to optimise against. Logged in
 * the spec, not silently skipped.
 *
 * WHAT NEITHER ALGORITHM HANDLES, AND THIS DECK MUST
 *
 * The cards change. When a Tier A ingest corrects a region count or a price, the
 * learner's memory of that card is now *wrong* — and a scheduler that says "next
 * review in 6 months" is actively teaching a stale fact. So every review records
 * a hash of the card's content, and a card whose content has moved since it was
 * last seen is pulled back into the queue no matter what its interval says.
 *
 * AND THE CARDS THAT BUILD ON THE ONE THAT CHANGED
 *
 * Cards depend on each other: AC-18 quotes Runtime's pricing, AC-21 leans on
 * eleven primitives. When AC-04 is corrected, AC-18 is not WRONG — its own claims
 * still verify — but the ground under it moved, and a learner who studied it a
 * month ago has no way to know. So a review also records a fingerprint of the
 * card's dependencies, and a card whose dependencies have since moved is pulled
 * forward too.
 *
 * The two signals stay distinct deliberately. "This card's answer changed" is a
 * correction; "something this card builds on changed" is context. Collapsing them
 * would either overstate the second or bury it.
 *
 * That is the interesting part of spaced repetition for a self-maintaining deck,
 * and it is the reason the scheduler lives here rather than being imported.
 *
 * Pure functions over a plain progress object; no localStorage, no Date.now()
 * unless passed in. That is what makes it testable.
 *
 * @typedef {{reps:number,lapses:number,ease:number,interval:number,
 *            due:string,last:string,chash:string,dhash:string}} CardProgress
 * @typedef {{v:1,reviews:Record<string,CardProgress>}} Progress
 */

export const GRADES = {
  again: 0,
  hard: 3,
  good: 4,
  easy: 5,
};

/** SM-2's floor. Below this, intervals stop growing meaningfully. */
export const MIN_EASE = 1.3;
export const DEFAULT_EASE = 2.5;
export const SCHEMA_VERSION = 1;

export function emptyProgress() {
  return { v: SCHEMA_VERSION, reviews: {} };
}

/**
 * Accept a stored blob, discarding anything from an incompatible version.
 * A silent schema mismatch would corrupt scheduling in ways a learner cannot
 * see, so an unknown version resets rather than being coerced.
 * @param {unknown} raw
 * @returns {Progress}
 */
export function normaliseProgress(raw) {
  if (!raw || typeof raw !== 'object') return emptyProgress();
  const p = /** @type {any} */ (raw);
  if (p.v !== SCHEMA_VERSION || !p.reviews || typeof p.reviews !== 'object') return emptyProgress();
  const reviews = {};
  for (const [id, r] of Object.entries(p.reviews)) {
    if (!r || typeof r !== 'object') continue;
    const rec = /** @type {any} */ (r);
    if (typeof rec.due !== 'string' || typeof rec.interval !== 'number') continue;
    reviews[id] = {
      reps: Number(rec.reps) || 0,
      lapses: Number(rec.lapses) || 0,
      ease: Number(rec.ease) || DEFAULT_EASE,
      interval: Number(rec.interval) || 0,
      due: rec.due,
      last: typeof rec.last === 'string' ? rec.last : rec.due,
      chash: typeof rec.chash === 'string' ? rec.chash : '',
      /**
       * Absent on records written before dependency tracking existed. Empty means
       * "unknown", never "changed" — treating an old record as stale would dump
       * every card with dependencies into the queue on upgrade, announcing a
       * change that never happened. SCHEMA_VERSION stays 1 because the field
       * degrades safely instead of corrupting scheduling.
       */
      dhash: typeof rec.dhash === 'string' ? rec.dhash : '',
    };
  }
  return { v: SCHEMA_VERSION, reviews };
}

/** Date-only ISO string, so intervals are whole days in any timezone. */
export function dayStamp(date) {
  return new Date(date).toISOString().slice(0, 10);
}

export function addDays(dayStr, days) {
  const d = new Date(dayStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/**
 * A fingerprint of everything this card depends on, as it stands right now.
 *
 * Plain concatenation rather than a hash: it is only ever compared for equality,
 * the strings are short, and a readable value is one a human can debug straight
 * out of localStorage. Sorted, so the fingerprint does not depend on the order
 * dependencies were authored in.
 *
 * A dependency missing from the deck contributes an empty hash rather than being
 * skipped, so REMOVING a card that a learner had studied still registers as the
 * ground moving.
 *
 * @param {any} card projected card, carrying `deps`
 * @param {Record<string, any>} byId every card in the deck, keyed by id
 * @returns {string}
 */
export function depsFingerprint(card, byId) {
  const ids = card && Array.isArray(card.deps) ? card.deps.slice().sort() : [];
  if (!ids.length) return '';
  return ids.map((id) => id + ':' + ((byId && byId[id] && byId[id].chash) || '')).join(',');
}

/** Index a deck by card id, so dependencies can be looked up. */
export function indexById(cards) {
  const byId = {};
  for (const c of cards) byId[c.id] = c;
  return byId;
}

/**
 * One review. Returns the next progress record for the card.
 *
 * SM-2 as published, with the interval sequence 1 → 6 → interval × ease.
 * A grade below 3 is a lapse: repetitions reset and the card comes back
 * tomorrow, but the ease penalty persists so a repeatedly-missed card keeps
 * shorter intervals.
 *
 * @param {CardProgress|undefined} prev
 * @param {number} grade one of GRADES
 * @param {string} today day stamp
 * @param {string} chash the card's current content hash
 * @param {string} [dhash] fingerprint of the card's dependencies at review time
 * @returns {CardProgress}
 */
export function review(prev, grade, today, chash, dhash) {
  const q = Math.max(0, Math.min(5, grade));
  let { reps, lapses, ease } = prev ?? { reps: 0, lapses: 0, ease: DEFAULT_EASE };
  ease = Number(ease) || DEFAULT_EASE;

  // SM-2 ease update, applied on every grade including lapses.
  ease = Math.max(MIN_EASE, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));

  let interval;
  if (q < 3) {
    lapses += 1;
    reps = 0;
    interval = 1;
  } else {
    reps += 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 6;
    else interval = Math.max(1, Math.round((prev?.interval ?? 1) * ease));
    // "Hard" should not grow the interval as fast as "Good".
    if (q === 3 && reps > 2) interval = Math.max(1, Math.round((prev?.interval ?? 1) * 1.2));
  }

  return {
    reps,
    lapses,
    ease: Math.round(ease * 1000) / 1000,
    interval,
    due: addDays(today, interval),
    last: today,
    chash,
    dhash: typeof dhash === 'string' ? dhash : '',
  };
}

/**
 * Why a card is in the queue, strongest signal first.
 *
 * `context` sits between `changed` and `new` on purpose. A context-stale card is
 * one the learner already believes something about, partly on the basis of a card
 * that has since been corrected — an active risk of holding a stale belief, which
 * is worse than simply not having seen a card yet. It ranks below `changed`
 * because the card itself is not wrong: its own claims still verify.
 */
export const REASON = {
  changed: 'changed',
  context: 'context',
  new: 'new',
  due: 'due',
};

/**
 * Classify one card against the progress store.
 *
 * `byId` is optional. Without it, dependency staleness cannot be computed and the
 * function behaves exactly as it did before dependencies existed — a caller that
 * has not been updated degrades to the old behaviour rather than throwing.
 *
 * @returns {{reason:string|null,record:CardProgress|undefined,overdueBy:number,
 *            staleDeps:string[]}}
 */
export function cardStatus(card, progress, today, byId) {
  const rec = progress.reviews[card.id];
  if (!rec) return { reason: REASON.new, record: undefined, overdueBy: 0, staleDeps: [] };
  // A card whose own content moved since it was last studied is teaching a stale
  // fact. That beats any interval.
  if (rec.chash && card.chash && rec.chash !== card.chash) {
    return { reason: REASON.changed, record: rec, overdueBy: daysBetween(rec.due, today), staleDeps: [] };
  }
  // Next: a card this one builds on has moved. Only when a fingerprint was
  // actually recorded — an empty one means "not known", not "nothing changed".
  const staleDeps = staleDependencies(card, rec, byId);
  if (staleDeps.length) {
    return { reason: REASON.context, record: rec, overdueBy: daysBetween(rec.due, today), staleDeps };
  }
  const overdueBy = daysBetween(rec.due, today);
  if (overdueBy >= 0) return { reason: REASON.due, record: rec, overdueBy, staleDeps: [] };
  return { reason: null, record: rec, overdueBy, staleDeps: [] };
}

/**
 * Which of a card's dependencies have moved since this card was last reviewed.
 *
 * Named rather than inlined because the UI needs the list: telling a learner
 * "something changed" without saying WHAT is not much better than saying nothing,
 * and the honest version of this banner cites the card that moved.
 *
 * @returns {string[]} dependency ids whose content hash differs from the recorded one
 */
export function staleDependencies(card, rec, byId) {
  if (!rec || !rec.dhash || !byId) return [];
  const current = depsFingerprint(card, byId);
  if (!current || current === rec.dhash) return [];
  /** @type {Record<string,string>} */
  const was = {};
  for (const pair of rec.dhash.split(',')) {
    const i = pair.indexOf(':');
    if (i > 0) was[pair.slice(0, i)] = pair.slice(i + 1);
  }
  const out = [];
  for (const id of card.deps || []) {
    const now = (byId[id] && byId[id].chash) || '';
    // A dependency absent from the old fingerprint was added since the last
    // review, which is a change to what this card rests on.
    if (!(id in was) || was[id] !== now) out.push(id);
  }
  return out;
}

/**
 * The study queue: corrected cards first, then cards whose context moved, then
 * new, then due by how overdue.
 *
 * Corrected-first is the whole point — if a price changed this morning, that is
 * the card to see, not the one whose six-month interval happens to elapse today.
 *
 * @param {any[]} cards
 * @param {Progress} progress
 * @param {string} today
 * @param {Record<string, any>} [byId] the whole deck by id, for dependency checks
 * @returns {{card:any,reason:string,overdueBy:number,staleDeps:string[]}[]}
 */
export function studyQueue(cards, progress, today, byId) {
  const rank = { [REASON.changed]: 0, [REASON.context]: 1, [REASON.new]: 2, [REASON.due]: 3 };
  const out = [];
  for (const card of cards) {
    const { reason, overdueBy, staleDeps } = cardStatus(card, progress, today, byId);
    if (!reason) continue;
    out.push({ card, reason, overdueBy, staleDeps });
  }
  out.sort((a, b) => rank[a.reason] - rank[b.reason] || b.overdueBy - a.overdueBy);
  return out;
}

/**
 * Counts for the study UI.
 * @returns {{changed:number,context:number,new:number,due:number,total:number,scheduled:number}}
 */
export function studyCounts(cards, progress, today, byId) {
  const c = { changed: 0, context: 0, new: 0, due: 0, total: 0, scheduled: 0 };
  for (const card of cards) {
    const { reason } = cardStatus(card, progress, today, byId);
    if (reason === REASON.changed) c.changed++;
    else if (reason === REASON.context) c.context++;
    else if (reason === REASON.new) c.new++;
    else if (reason === REASON.due) c.due++;
    else c.scheduled++;
  }
  c.total = c.changed + c.context + c.new + c.due;
  return c;
}

/** Human-readable next-review hint for a card's back face. */
export function describeSchedule(card, progress, today, byId) {
  const { reason, record } = cardStatus(card, progress, today, byId);
  if (reason === REASON.changed) return 'This card changed since you last studied it';
  if (reason === REASON.context) return 'A card this one builds on changed since you last studied it';
  if (reason === REASON.new || !record) return 'Not studied yet';
  if (reason === REASON.due) {
    const late = daysBetween(record.due, today);
    return late === 0 ? 'Due today' : `Due ${late} day${late === 1 ? '' : 's'} ago`;
  }
  const inDays = -daysBetween(record.due, today);
  return `Next review in ${inDays} day${inDays === 1 ? '' : 's'}`;
}
