/**
 * Tier A ingest — dated feature history from AWS documentation release notes.
 *
 * WHY THIS SOURCE AND NOT WHAT'S NEW
 *
 * The obvious source for "when did X ship" is the AWS What's New feed. Both of
 * its forms were tried and neither works for this deck:
 *
 *   - the recent RSS feed (aws.amazon.com/about-aws/whats-new/recent/feed/)
 *     carries only ~100 items, about 11 days. It cannot reach a 2025 date.
 *   - the searchable archive behind the What's New page returns 16,281 items but
 *     its newest entry is 2024-05-17, so it cannot reach a 2025 date either.
 *
 * The service's own documentation release-notes page covers July 2025 to the
 * present, is authoritative, and is a plain public GET. It is the right source.
 *
 * THE LIMIT, WHICH MATTERS MORE THAN THE CAPABILITY
 *
 * Release notes are organised by MONTH, not by day. This source can substantiate
 * "AgentCore went GA in October 2025". It cannot substantiate "on October 13".
 * The verifier is told the precision explicitly so it reports a day-precision
 * claim as partially attested rather than rounding a month up to a day — which
 * would be exactly the quiet overreach this whole system exists to prevent.
 *
 * Read-only, no credentials, no AWS resource touched.
 *
 * Usage: node src/ingest/docs-release-notes.ts [--url <markdown url>]
 */

import { mkdirSync } from 'node:fs';
import { hashPayload } from '../lib/hash.ts';
import { saveFactSet, loadFactSetFile, paths } from '../lib/store.ts';
import type { FactSet, FactValue } from '../lib/types.ts';

const GENERATOR = 'src/ingest/docs-release-notes.ts';
const DEFAULT_URL = 'https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/release-notes.md';
const HTML_URL = 'https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/release-notes.html';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export type ReleaseEntry = {
  /** "2025-10" — month precision is the honest granularity of this source */
  iso_month: string;
  month_label: string;
  heading: string;
  /** first ~400 chars of the entry body, enough to match a claim against */
  summary: string;
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Parse the release-notes markdown into dated entries. */
export function parseReleaseNotes(md: string): ReleaseEntry[] {
  const entries: ReleaseEntry[] = [];
  // Month sections are "## <Month> <Year>"; features are "### <heading>".
  const sections = md.split(/\n##\s+/).slice(1);
  for (const section of sections) {
    const label = section.split('\n')[0].trim();
    const m = /^([A-Z][a-z]+)\s+(20\d{2})$/.exec(label);
    if (!m) continue;
    const monthIndex = MONTHS.indexOf(m[1]);
    if (monthIndex < 0) continue;
    const isoMonth = `${m[2]}-${String(monthIndex + 1).padStart(2, '0')}`;

    const featureBlocks = section.split(/\n###\s+/).slice(1);
    for (const block of featureBlocks) {
      const lines = block.split('\n');
      const heading = lines[0].trim();
      const body = lines
        .slice(1)
        .join(' ')
        // Strip the anchor markers and markdown noise the page carries.
        .replace(/<a name="[^"]*"><\/a>/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*_`>#]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!heading) continue;
      entries.push({ iso_month: isoMonth, month_label: label, heading, summary: body.slice(0, 400) });
    }
  }
  return entries;
}

async function main(): Promise<void> {
  const url = arg('url', DEFAULT_URL);
  console.log(`docs-release-notes: fetching ${url} (public GET, no credentials)`);

  const res = await fetch(url, { headers: { accept: 'text/markdown,text/plain,*/*' } });
  if (!res.ok) {
    console.error(`docs-release-notes: HTTP ${res.status} from ${url} — refusing to write a fact set from a failed fetch`);
    process.exit(1);
  }
  const md = await res.text();
  if (md.length < 2000) {
    console.error(`docs-release-notes: response was only ${md.length} bytes — looks like a redirect stub, not the release notes`);
    process.exit(1);
  }

  const entries = parseReleaseNotes(md);
  if (!entries.length) {
    // A parse that silently yields nothing would produce an empty fact set that
    // makes every date claim "unverifiable" for the wrong reason.
    console.error('docs-release-notes: parsed zero entries — the page structure has changed. Refusing to write.');
    process.exit(1);
  }

  const months = [...new Set(entries.map((e) => e.iso_month))].sort();
  const fetchedAt = new Date().toISOString();
  // Hash the parsed entries, not the raw page: navigation chrome and unrelated
  // copy edits would otherwise churn the hash on every docs deploy.
  const contentHash = hashPayload(entries);

  const factSetId = 'agentcore.release-notes';
  const fileName = `${factSetId}.json`;
  const previous = loadFactSetFile(fileName);
  const prevCount = previous?.facts[`${factSetId}.entry-count`]?.value as number | undefined;

  const facts: Record<string, FactValue> = {
    [`${factSetId}.entry-count`]: {
      type: 'integer',
      value: entries.length,
      note: 'Dated feature entries parsed from the AgentCore documentation release notes.',
    },
    [`${factSetId}.months`]: {
      type: 'string_list',
      value: months,
      note: 'Months the release notes cover, ISO year-month. This source is MONTH precision only — it cannot attest a day.',
    },
    [`${factSetId}.earliest-month`]: { type: 'string', value: months[0] },
    [`${factSetId}.latest-month`]: { type: 'string', value: months[months.length - 1] },
  };

  const set: FactSet = {
    schema_version: 1,
    fact_set_id: factSetId,
    tier: 'A',
    generator: GENERATOR,
    verified_at: fetchedAt,
    source: {
      kind: 'aws-docs-release-notes',
      url: HTML_URL,
      fetched_at: fetchedAt,
      content_hash: contentHash,
      retrieved_by: `GET ${url}`,
    },
    evidence: {
      // The entries themselves are the evidence, so the verifier can match a
      // claimed month against a real section AND check the entry is topically
      // related rather than merely contemporaneous.
      canonical: entries,
      text: entries.map((e) => `${e.month_label} — ${e.heading}: ${e.summary}`).join('\n'),
    },
    facts,
    ...(prevCount !== undefined ? { previous: { 'entry-count': prevCount } } : {}),
  };

  mkdirSync(paths.facts, { recursive: true });
  saveFactSet(fileName, set);

  const state = prevCount === undefined ? 'first observation' : prevCount === entries.length ? 'unchanged' : `CHANGED from ${prevCount}`;
  console.log(`docs-release-notes: ${entries.length} entries across ${months.length} months (${months[0]} → ${months[months.length - 1]}) · ${state}`);
  console.log(`docs-release-notes: wrote facts/${fileName} (${contentHash})`);
  console.log('docs-release-notes: precision is MONTH — a day-precision claim can only be partially attested from this source');
}

await main();
