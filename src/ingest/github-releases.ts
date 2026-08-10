/**
 * Tier A ingest — GitHub release feeds, for projects with no curated changelog.
 *
 * WHY STRANDS NEEDS THIS AND WHY IT IS NOT PRODUCT NEWS
 *
 * Strands publishes no changelog: `strandsagents.com/latest/changelog/` and the
 * repo's `CHANGELOG.md` both 404. Its only dated surface is the GitHub releases
 * feed, and that feed is honest about what it is — every body opens "Auto-drafted
 * from commits in <range>, grouped by conventional-commit type".
 *
 * So this source can answer "when did version X ship" and it cannot answer "what
 * was announced". Its entry titles are version tags — `typescript/v1.12.0` — which
 * contain no subject a flashcard could be matched against, and its bodies are
 * forty `feat(middleware): …` lines apiece.
 *
 * That is why `check-coverage` excludes `github-releases` from its news corpus.
 * Admitting it would repeat the Bedrock document-history mistake exactly: a large
 * number of rows, none of them a thing a human would write a card about. The
 * distinction is recorded in both places rather than in one, because the next
 * person to add a source will read one or the other.
 *
 * What it IS good for: a version claim on ST-01 can be dated against a real
 * release, and a release that stops appearing is a signal the project moved.
 *
 * THE REDIRECT, WHICH IS THE REASON THIS TAKES A --repo
 *
 * `strands-agents/sdk-python` redirects to `strands-agents/harness-sdk` — the SDK
 * became a monorepo. Both URLs resolve today, and citing the one that only works
 * while GitHub honours a redirect would pin the deck to someone else's kindness.
 * The canonical repo is the default and the source URL records it.
 *
 * Read-only, no credentials, no AWS resource touched.
 *
 * Usage: node src/ingest/github-releases.ts [--repo owner/name] [--id <fact set id>]
 */

import { mkdirSync } from 'node:fs';
import { hashPayload } from '../lib/hash.ts';
import { saveFactSet, loadFactSetFile, paths } from '../lib/store.ts';
import { parseAtom, type AtomEntry } from '../lib/atom.ts';
import type { FactSet, FactValue } from '../lib/types.ts';

const GENERATOR = 'src/ingest/github-releases.ts';
const DEFAULT_REPO = 'strands-agents/harness-sdk';
const DEFAULT_ID = 'strands.releases';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export type ReleaseRow = {
  iso_date: string;
  iso_month: string;
  month_label: string;
  date_label: string;
  /** the release tag, e.g. "typescript/v1.12.0" — a version, NOT an announcement */
  heading: string;
  summary: string;
  /** "typescript" for a monorepo tag of the form <package>/vX.Y.Z, else "" */
  package: string;
  version: string;
  url: string;
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * Split a release tag into package and version.
 *
 * A monorepo tags `typescript/v1.12.0`; a single-package repo tags `v1.12.0`.
 * Both shapes occur across the projects this deck cites, so both are handled and
 * an unrecognised tag keeps the whole string as the version rather than being
 * dropped — losing a release because its tag was unusual would be a silent gap.
 */
export function splitTag(tag: string): { package: string; version: string } {
  const m = /^(.+)\/(v?\d[\w.\-+]*)$/.exec(tag.trim());
  if (m) return { package: m[1], version: m[2] };
  return { package: '', version: tag.trim() };
}

export function toReleaseRows(entries: AtomEntry[]): ReleaseRow[] {
  return entries.map((e) => {
    const [y, mo, d] = e.iso_date.split('-');
    const monthName = MONTHS[Number(mo) - 1] ?? mo;
    const { package: pkg, version } = splitTag(e.title);
    return {
      iso_date: e.iso_date,
      iso_month: e.iso_month,
      month_label: `${monthName} ${y}`,
      date_label: `${monthName} ${Number(d)}, ${y}`,
      heading: e.title,
      summary: e.summary,
      package: pkg,
      version,
      url: e.link,
    };
  });
}

async function main(): Promise<void> {
  const repo = arg('repo', DEFAULT_REPO);
  const factSetId = arg('id', DEFAULT_ID);
  const url = `https://github.com/${repo}/releases.atom`;
  const htmlUrl = `https://github.com/${repo}/releases`;
  console.log(`github-releases: fetching ${url} (public GET, no credentials)`);

  const res = await fetch(url, { headers: { accept: 'application/atom+xml,application/xml,*/*' } });
  if (!res.ok) {
    console.error(`github-releases: HTTP ${res.status} from ${url} — refusing to write a fact set from a failed fetch`);
    process.exit(1);
  }
  const xml = await res.text();

  const parsed = parseAtom(xml);
  if (!parsed.length) {
    console.error(`github-releases: parsed zero entries from ${xml.length} bytes — the feed shape has changed. Refusing to write.`);
    process.exit(1);
  }
  const rows = toReleaseRows(parsed);

  const dates = rows.map((r) => r.iso_date).sort();
  const packages = [...new Set(rows.map((r) => r.package).filter(Boolean))].sort();
  const fetchedAt = new Date().toISOString();
  const contentHash = hashPayload(rows);

  const fileName = `${factSetId}.json`;
  const previous = loadFactSetFile(fileName);
  const prevLatest = previous?.facts[`${factSetId}.latest-version`]?.value as string | undefined;

  // The newest release per package, since a monorepo versions each independently
  // and a single "latest version" across all of them would be meaningless.
  const latestByPackage: Record<string, string> = {};
  for (const r of [...rows].sort((a, b) => a.iso_date.localeCompare(b.iso_date))) {
    latestByPackage[r.package || '(root)'] = r.version;
  }

  const facts: Record<string, FactValue> = {
    [`${factSetId}.release-count`]: {
      type: 'integer',
      value: rows.length,
      note: 'Releases in the feed\'s rolling window. NOT product announcements — bodies are auto-drafted from commits.',
    },
    [`${factSetId}.packages`]: {
      type: 'string_list',
      value: packages,
      note: 'Independently versioned packages seen in release tags (monorepo).',
    },
    [`${factSetId}.latest-version`]: {
      type: 'string',
      value: rows[0]?.version ?? '',
      note: 'Most recent release in the window, across all packages.',
    },
    [`${factSetId}.latest-by-package`]: {
      type: 'string_list',
      value: Object.entries(latestByPackage).map(([p, v]) => `${p}=${v}`).sort(),
      note: 'Latest version per package. A monorepo versions each package separately.',
    },
    [`${factSetId}.window-earliest`]: {
      type: 'string',
      value: dates[0],
      note: 'ROLLING WINDOW — this feed does not archive and cannot attest a release older than this.',
    },
    [`${factSetId}.window-latest`]: { type: 'string', value: dates[dates.length - 1] },
  };

  const set: FactSet = {
    schema_version: 1,
    fact_set_id: factSetId,
    tier: 'A',
    generator: GENERATOR,
    verified_at: fetchedAt,
    source: {
      kind: 'github-releases',
      url: htmlUrl,
      fetched_at: fetchedAt,
      content_hash: contentHash,
      retrieved_by: `GET ${url}`,
    },
    evidence: {
      canonical: rows,
      text: rows.map((r) => `${r.date_label} — ${r.heading}: ${r.summary}`).join('\n'),
    },
    facts,
    ...(prevLatest !== undefined ? { previous: { 'latest-version': prevLatest } } : {}),
  };

  mkdirSync(paths.facts, { recursive: true });
  saveFactSet(fileName, set);

  const state = prevLatest === undefined ? 'first observation' : prevLatest === rows[0].version ? 'unchanged' : `CHANGED from ${prevLatest}`;
  console.log(`github-releases: ${rows.length} releases (${dates[0]} → ${dates[dates.length - 1]}) · latest ${rows[0].version} · ${state}`);
  console.log(`github-releases: packages ${packages.join(', ') || '(single package)'}`);
  console.log(`github-releases: wrote facts/${fileName} (${contentHash})`);
  console.log('github-releases: DATING source only — deliberately excluded from the check-coverage news corpus, see src/check-coverage.ts');
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
