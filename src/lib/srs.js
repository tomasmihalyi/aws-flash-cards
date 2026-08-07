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
 * That is the interesting part of spaced repetition for a self-maintaining deck,
 * and it is the reason the scheduler lives here rather than being imported.
 *
 * Pure functions over a plain progress object; no localStorage, no Date.now()
 * unless passed in. That is what makes it testable.
 *
 * @typedef {{reps:number,lapses:number,ease:number,interval:number,
 *            due:string,last:string,chash:string}} CardProgress
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
 * @returns {CardProgress}
 */
export function review(prev, grade, today, chash) {
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
  };
}

/** Why a card is in the queue. Order matters: `changed` outranks `due`. */
export const REASON = {
  changed: 'changed',
  new: 'new',
  due: 'due',
};

/**
 * Classify one card against the progress store.
 * @returns {{reason:string|null,record:CardProgress|undefined,overdueBy:number}}
 */
export function cardStatus(card, progress, today) {
  const rec = progress.reviews[card.id];
  if (!rec) return { reason: REASON.new, record: undefined, overdueBy: 0 };
  // A card whose content moved since it was last studied is teaching a stale
  // fact. That beats any interval.
  if (rec.chash && card.chash && rec.chash !== card.chash) {
    return { reason: REASON.changed, record: rec, overdueBy: daysBetween(rec.due, today) };
  }
  const overdueBy = daysBetween(rec.due, today);
  if (overdueBy >= 0) return { reason: REASON.due, record: rec, overdueBy };
  return { reason: null, record: rec, overdueBy };
}

/**
 * The study queue: corrected cards first, then new, then due by how overdue.
 *
 * Corrected-first is the whole point — if a price changed this morning, that is
 * the card to see, not the one whose six-month interval happens to elapse today.
 *
 * @param {any[]} cards
 * @param {Progress} progress
 * @param {string} today
 * @returns {{card:any,reason:string,overdueBy:number}[]}
 */
export function studyQueue(cards, progress, today) {
  const rank = { [REASON.changed]: 0, [REASON.new]: 1, [REASON.due]: 2 };
  const out = [];
  for (const card of cards) {
    const { reason, overdueBy } = cardStatus(card, progress, today);
    if (!reason) continue;
    out.push({ card, reason, overdueBy });
  }
  out.sort((a, b) => rank[a.reason] - rank[b.reason] || b.overdueBy - a.overdueBy);
  return out;
}

/**
 * Counts for the study UI.
 * @returns {{changed:number,new:number,due:number,total:number,scheduled:number}}
 */
export function studyCounts(cards, progress, today) {
  const c = { changed: 0, new: 0, due: 0, total: 0, scheduled: 0 };
  for (const card of cards) {
    const { reason } = cardStatus(card, progress, today);
    if (reason === REASON.changed) c.changed++;
    else if (reason === REASON.new) c.new++;
    else if (reason === REASON.due) c.due++;
    else c.scheduled++;
  }
  c.total = c.changed + c.new + c.due;
  return c;
}

/** Human-readable next-review hint for a card's back face. */
export function describeSchedule(card, progress, today) {
  const { reason, record } = cardStatus(card, progress, today);
  if (reason === REASON.changed) return 'This card changed since you last studied it';
  if (reason === REASON.new || !record) return 'Not studied yet';
  if (reason === REASON.due) {
    const late = daysBetween(record.due, today);
    return late === 0 ? 'Due today' : `Due ${late} day${late === 1 ? '' : 's'} ago`;
  }
  const inDays = -daysBetween(record.due, today);
  return `Next review in ${inDays} day${inDays === 1 ? '' : 's'}`;
}
