/**
 * Tier A ingest — DAY-precision dated history from AWS documentation "Document
 * history" pages.
 *
 * WHY THIS EXISTS ALONGSIDE docs-release-notes.ts
 *
 * The release-notes ingest is organised by month, and says so. It can attest
 * "AgentCore went GA in October 2025" and refuses to attest "on October 13".
 * That refusal is correct, but it left ten claims in the deck unverifiable for
 * want of a source that can see days at all.
 *
 * A "Document history" page is a three-column table — Change | Description |
 * Date — where the Date cell is an exact calendar day. That makes it the first
 * day-precision dated source in this repo.
 *
 * THE TRAP THIS SOURCE SETS, WHICH IS WORSE THAN THE GAP IT CLOSES
 *
 * A day-precision source invites the reasoning "the card says July 16 2025, the
 * source contains July 16 2025, therefore verified". That is wrong, and it is
 * wrong in the most dangerous direction: it manufactures a citation.
 *
 * Measured, not hypothesised: card AC-01 claims AgentCore previewed on
 * Jul 16 2025. This page has three rows dated July 16, 2025 — Bedrock Data
 * Automation region expansion, Nova model import, and custom model on-demand
 * deployment. None has anything to do with AgentCore. A bare date match would
 * have "verified" the preview date against a data-automation region expansion
 * and printed a source link under it for a learner to trust.
 *
 * So the verifier requires TOPICAL relatedness as well as date equality, and
 * AC-01's preview date is still reported unverifiable after this ingest ran.
 * Closing a gap is worth nothing if the way it closes is by lying.
 *
 * Read-only, no credentials, no AWS resource touched.
 *
 * Usage: node src/ingest/docs-doc-history.ts [--page <key>]
 */

import { mkdirSync } from 'node:fs';
import { hashPayload } from '../lib/hash.ts';
import { saveFactSet, loadFactSetFile, paths } from '../lib/store.ts';
import type { FactSet, FactValue } from '../lib/types.ts';

const GENERATOR = 'src/ingest/docs-doc-history.ts';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * The pages worth ingesting.
 *
 * `bedrock` is here because AgentCore's own devguide has no document-history
 * page (probed: /bedrock-agentcore/latest/devguide/doc-history.html and
 * document-history.html both 404). The Bedrock user guide is where the
 * Bedrock Agents Classic lifecycle is actually recorded, which is what card
 * AC-20 is about.
 */
const PAGES: Record<string, { md: string; html: string; factSetId: string }> = {
  bedrock: {
    md: 'https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-ug-doc-history.md',
    html: 'https://docs.aws.amazon.com/bedrock/latest/userguide/doc-history.html',
    factSetId: 'bedrock.doc-history',
  },
};

export type HistoryEntry = {
  /** "2026-07-30" — this source's whole point: it can see the day */
  iso_date: string;
  iso_month: string;
  month_label: string;
  date_label: string;
  heading: string;
  summary: string;
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Strip markdown links and inline noise, keeping the human-readable text. */
function plain(cell: string): string {
  return cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<a name="[^"]*"><\/a>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "July 30, 2026" → { iso_date, iso_month, month_label }. */
export function parseHistoryDate(cell: string): Pick<HistoryEntry, 'iso_date' | 'iso_month' | 'month_label'> | null {
  const m = /^([A-Z][a-z]+)\s+(\d{1,2}),?\s+(20\d{2}|19\d{2})$/.exec(cell.trim());
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1]);
  if (mi < 0) return null;
  const day = Number(m[2]);
  if (day < 1 || day > 31) return null;
  const isoMonth = `${m[3]}-${String(mi + 1).padStart(2, '0')}`;
  return {
    iso_date: `${isoMonth}-${String(day).padStart(2, '0')}`,
    iso_month: isoMonth,
    month_label: `${m[1]} ${m[3]}`,
  };
}

/** Parse a documentation history markdown table into day-precision entries. */
export function parseDocHistory(md: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    // Drop the leading and trailing pipe, then split. Descriptions can contain
    // bracketed links but not raw pipes, so a plain split is safe here.
    const cells = line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|');
    if (cells.length < 3) continue;
    const dated = parseHistoryDate(plain(cells[cells.length - 1]));
    if (!dated) continue; // header row, separator row, or a malformed date
    const heading = plain(cells[0]);
    const summary = plain(cells.slice(1, cells.length - 1).join(' '));
    if (!heading) continue;
    out.push({ ...dated, date_label: plain(cells[cells.length - 1]), heading, summary: summary.slice(0, 600) });
  }
  return out;
}

async function main(): Promise<void> {
  const key = arg('page', 'bedrock');
  const page = PAGES[key];
  if (!page) {
    console.error(`docs-doc-history: unknown page "${key}". Known: ${Object.keys(PAGES).join(', ')}`);
    process.exit(1);
  }

  console.log(`docs-doc-history: fetching ${page.md} (public GET, no credentials)`);
  const res = await fetch(page.md, { headers: { accept: 'text/markdown,text/plain,*/*' } });
  if (!res.ok) {
    console.error(`docs-doc-history: HTTP ${res.status} — refusing to write a fact set from a failed fetch`);
    process.exit(1);
  }
  const md = await res.text();
  if (md.length < 5000) {
    console.error(`docs-doc-history: response was only ${md.length} bytes — looks like a redirect stub, not a history table`);
    process.exit(1);
  }

  const entries = parseDocHistory(md);
  if (entries.length < 20) {
    // A parse that silently yields little would quietly narrow the deck's
    // evidence base instead of failing loudly.
    console.error(`docs-doc-history: parsed only ${entries.length} entries — the table structure has changed. Refusing to write.`);
    process.exit(1);
  }

  const dates = entries.map((e) => e.iso_date).sort();
  const fetchedAt = new Date().toISOString();
  const contentHash = hashPayload(entries);

  const fileName = `${page.factSetId}.json`;
  const previous = loadFactSetFile(fileName);
  const prevCount = previous?.facts[`${page.factSetId}.entry-count`]?.value as number | undefined;

  const facts: Record<string, FactValue> = {
    [`${page.factSetId}.entry-count`]: {
      type: 'integer',
      value: entries.length,
      note: 'Dated change entries parsed from the documentation history table.',
    },
    [`${page.factSetId}.earliest-date`]: { type: 'string', value: dates[0] },
    [`${page.factSetId}.latest-date`]: { type: 'string', value: dates[dates.length - 1] },
    [`${page.factSetId}.precision`]: {
      type: 'string',
      value: 'day',
      note: 'This source records an exact calendar day per entry, unlike the month-precision release notes.',
    },
  };

  const set: FactSet = {
    schema_version: 1,
    fact_set_id: page.factSetId,
    tier: 'A',
    generator: GENERATOR,
    verified_at: fetchedAt,
    source: {
      kind: 'aws-docs-doc-history',
      url: page.html,
      fetched_at: fetchedAt,
      content_hash: contentHash,
      retrieved_by: `GET ${page.md}`,
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
  console.log(`docs-doc-history: ${entries.length} entries (${dates[0]} → ${dates[dates.length - 1]}) · ${state}`);
  console.log(`docs-doc-history: wrote facts/${fileName} (${contentHash})`);
  console.log('docs-doc-history: precision is DAY — but a date match alone is not attestation; the verifier also requires topical relatedness');
}

if (import.meta.filename === process.argv[1]) await main();
