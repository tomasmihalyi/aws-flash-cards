/**
 * Tier A ingest — Kiro changelog, the deck's first NON-AWS-docs product news feed.
 *
 * WHY THIS MATTERS MORE THAN ANOTHER AWS SOURCE
 *
 * `check-coverage` answers "did something ship that no card covers", and until now
 * it read exactly one source: the AgentCore release notes. So the detector was
 * blind to four of the five services in the deck's stated scope — a Kiro release
 * could not be noticed at all. Kiro is the highest-priority service in that scope
 * and had 3 cards, with nothing watching it.
 *
 * WHY THE ATOM FEED AND NOT THE PAGE
 *
 * `kiro.dev/changelog/` paginates client-side at 8 entries. `feed.atom` is a
 * declared interface carrying 25 with explicit day-precision dates, which is both
 * more data and a more stable contract than markup.
 *
 * THE LIMIT: A ROLLING WINDOW, NOT AN ARCHIVE
 *
 * The feed holds a fixed number of recent entries — about five weeks at Kiro's
 * release cadence. It is the right shape for "what shipped that I have not written
 * about", and the wrong shape for "when did feature X first appear": once an entry
 * falls off the window this source can no longer attest it. The fact set records
 * the window's bounds so a claim outside them reports as unattested rather than
 * being quietly contradicted by a feed that simply no longer remembers.
 *
 * TWO KINDS OF NOISE, BOTH REMOVED BY MEASUREMENT
 *
 *  - a per-build entry whose title is the same sentence every release (10 of 25)
 *  - a versioned duplicate of a curated entry on the same day (1 of the remaining)
 *
 * Both are dropped by `src/lib/atom.ts` using frequency and same-day identity
 * rather than a hard-coded title, so a reworded template is still caught. 25
 * entries becomes 14 announcements.
 *
 * Read-only, no credentials, no AWS resource touched.
 *
 * Usage: node src/ingest/kiro-changelog.ts [--url <atom url>]
 */

import { mkdirSync } from 'node:fs';
import { hashPayload } from '../lib/hash.ts';
import { saveFactSet, loadFactSetFile, paths } from '../lib/store.ts';
import { parseAtom, templateTitles, normaliseTitle, dedupeSameDay, type AtomEntry } from '../lib/atom.ts';
import type { FactSet, FactValue } from '../lib/types.ts';

const GENERATOR = 'src/ingest/kiro-changelog.ts';
const DEFAULT_URL = 'https://kiro.dev/changelog/feed.atom';
const HTML_URL = 'https://kiro.dev/changelog/';
const FACT_SET_ID = 'kiro.changelog';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export type ChangelogEntry = {
  iso_date: string;
  iso_month: string;
  month_label: string;
  date_label: string;
  heading: string;
  summary: string;
  /** the vendor's own IDE / CLI / Models / General classification */
  product: string;
  url: string;
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function labelFor(isoDate: string): { month: string; day: string } {
  const [y, m, d] = isoDate.split('-');
  const monthName = MONTHS[Number(m) - 1] ?? m;
  return { month: `${monthName} ${y}`, day: `${monthName} ${Number(d)}, ${y}` };
}

/**
 * Feed entries to dated announcements, template and duplicate noise removed.
 *
 * Exported so the filtering is testable without a network call — the two noise
 * classes above are the whole value of this function and both were found by
 * looking at real output, not by reading the feed spec.
 */
export function toAnnouncements(entries: AtomEntry[]): ChangelogEntry[] {
  const templates = templateTitles(entries.map((e) => e.title));
  const curated = dedupeSameDay(entries.filter((e) => !templates.has(normaliseTitle(e.title))));
  return curated.map((e) => {
    const labels = labelFor(e.iso_date);
    return {
      iso_date: e.iso_date,
      iso_month: e.iso_month,
      month_label: labels.month,
      date_label: labels.day,
      // The title carries a "IDE: " / "CLI: " prefix duplicating the category.
      // Kept as published: the heading a coverage report shows should be the
      // heading the vendor wrote, and the prefix is genuinely part of the subject.
      heading: e.title,
      summary: e.summary,
      product: e.categories[0] ?? '',
      url: e.link || HTML_URL,
    };
  });
}

async function main(): Promise<void> {
  const url = arg('url', DEFAULT_URL);
  console.log(`kiro-changelog: fetching ${url} (public GET, no credentials)`);

  const res = await fetch(url, { headers: { accept: 'application/atom+xml,application/xml,*/*' } });
  if (!res.ok) {
    console.error(`kiro-changelog: HTTP ${res.status} from ${url} — refusing to write a fact set from a failed fetch`);
    process.exit(1);
  }
  const xml = await res.text();

  const raw = parseAtom(xml);
  if (!raw.length) {
    // A silent empty parse looks exactly like a quiet week, which is the one
    // failure mode that would let the coverage report go stale unnoticed.
    console.error(`kiro-changelog: parsed zero entries from ${xml.length} bytes — the feed shape has changed. Refusing to write.`);
    process.exit(1);
  }

  const entries = toAnnouncements(raw);
  if (!entries.length) {
    console.error('kiro-changelog: every entry was filtered as template or duplicate — refusing to write an empty news source.');
    process.exit(1);
  }

  const dates = entries.map((e) => e.iso_date).sort();
  const products = [...new Set(entries.map((e) => e.product).filter(Boolean))].sort();
  const fetchedAt = new Date().toISOString();
  // Hash the parsed announcements, not the raw feed: a <updated> timestamp bump
  // on an unchanged entry would otherwise churn the hash on every run.
  const contentHash = hashPayload(entries);

  const fileName = `${FACT_SET_ID}.json`;
  const previous = loadFactSetFile(fileName);
  const prevCount = previous?.facts[`${FACT_SET_ID}.entry-count`]?.value as number | undefined;

  const facts: Record<string, FactValue> = {
    [`${FACT_SET_ID}.entry-count`]: {
      type: 'integer',
      value: entries.length,
      note: `Curated announcements in the Kiro changelog feed's rolling window (${raw.length} feed entries before template and duplicate filtering).`,
    },
    [`${FACT_SET_ID}.products`]: {
      type: 'string_list',
      value: products,
      note: "The feed's own <category term> classification, not inferred from titles.",
    },
    [`${FACT_SET_ID}.window-earliest`]: {
      type: 'string',
      value: dates[0],
      note: 'ROLLING WINDOW. This feed cannot attest anything before this date — it does not archive.',
    },
    [`${FACT_SET_ID}.window-latest`]: { type: 'string', value: dates[dates.length - 1] },
  };

  const set: FactSet = {
    schema_version: 1,
    fact_set_id: FACT_SET_ID,
    tier: 'A',
    generator: GENERATOR,
    verified_at: fetchedAt,
    source: {
      kind: 'vendor-changelog',
      url: HTML_URL,
      fetched_at: fetchedAt,
      content_hash: contentHash,
      retrieved_by: `GET ${url}`,
    },
    evidence: {
      canonical: entries,
      text: entries.map((e) => `${e.date_label} — ${e.heading}: ${e.summary}`).join('\n'),
    },
    facts,
    ...(prevCount !== undefined ? { previous: { 'entry-count': prevCount } } : {}),
  };

  mkdirSync(paths.facts, { recursive: true });
  saveFactSet(fileName, set);

  const state = prevCount === undefined ? 'first observation' : prevCount === entries.length ? 'unchanged' : `CHANGED from ${prevCount}`;
  console.log(`kiro-changelog: ${raw.length} feed entries → ${entries.length} announcements (${dates[0]} → ${dates[dates.length - 1]}) · ${state}`);
  console.log(`kiro-changelog: products ${products.join(', ')}`);
  console.log(`kiro-changelog: wrote facts/${fileName} (${contentHash})`);
  console.log('kiro-changelog: precision is DAY, but the window is ROLLING — this source cannot attest an entry that has scrolled off it');
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
