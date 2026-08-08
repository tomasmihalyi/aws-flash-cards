/**
 * Tier A ingest — per-FEATURE region availability from the AgentCore docs.
 *
 * WHAT THIS RESOLVES
 *
 * Card AC-12 (Evaluations) claims "GA in 9 regions". Its slot has carried this
 * refusal since P2:
 *
 *   "Feature-level region availability. SSM /aws/service/global-infrastructure
 *    exposes service-level regions for bedrock-agentcore only; it cannot
 *    substantiate the region list for the Evaluations feature specifically.
 *    Needs a Tier C source (What's New post or docs page) before this claim can
 *    be verified."
 *
 * That was the correct call — mapping a service-level region list onto a
 * feature-level claim is exactly the quiet overreach this repo exists to
 * prevent. But it was a refusal pending a source, not a permanent limit, and
 * the source exists: agentcore-regions.html is a feature × region matrix.
 *
 * The refusal being written down as a slot reason is what made it findable and
 * closeable later. That is the argument for recording limits precisely instead
 * of rounding them off to "not verifiable".
 *
 * WHAT IT FOUND, WHICH IS NOT WHAT THE CARD SAID
 *
 * Evaluations is in 16 regions, not 9. The card was stale, not merely uncited.
 *
 * A NOTE ON THE TOTAL, BECAUSE TWO SOURCES DISAGREE
 *
 * SSM reports 19 regions for bedrock-agentcore; this matrix has 20 columns. The
 * extra column is AWS GovCloud (US-West) — a separate partition that the
 * global-infrastructure parameter path does not enumerate. Both numbers are
 * right about different questions, so this ingest records the matrix count and
 * the partition split rather than picking a winner.
 *
 * Read-only, no credentials, no AWS resource touched.
 *
 * Usage: node src/ingest/docs-feature-regions.ts
 */

import { mkdirSync } from 'node:fs';
import { hashPayload } from '../lib/hash.ts';
import { saveFactSet, loadFactSetFile, paths } from '../lib/store.ts';
import type { FactSet, FactValue } from '../lib/types.ts';

const GENERATOR = 'src/ingest/docs-feature-regions.ts';
const MD_URL = 'https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.md';
const HTML_URL = 'https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html';

const FACT_SET_ID = 'agentcore.feature-regions';

export type FeatureAvailability = {
  /** the docs' own label, e.g. "AgentCore Evaluations" */
  feature: string;
  /** slug used in fact ids, e.g. "evaluations" */
  key: string;
  regions: string[];
  count: number;
};

/** Docs label → fact-id slug. Kept explicit so a docs rename is visible in a diff. */
function slugify(feature: string): string {
  return feature
    .toLowerCase()
    .replace(/\(preview\)/g, '')
    .replace(/^\s*(aws|amazon)\s+/g, '')
    .replace(/^agentcore\s+/, '')
    .replace(/\s+in\s+agentcore$/, '')
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Parse the markdown feature × region matrix. */
export function parseFeatureRegions(md: string): { regions: string[]; features: FeatureAvailability[] } {
  const rows = md
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'))
    .map((l) => l.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()));

  if (!rows.length) return { regions: [], features: [] };

  const header = rows[0];
  // First column is the feature label; the rest are region names.
  const regions = header.slice(1).map((r) => r.replace(/\s+/g, ' ').trim()).filter(Boolean);

  const features: FeatureAvailability[] = [];
  for (const row of rows.slice(1)) {
    // Skip the |---|---| separator row.
    if (row.every((c) => /^-{2,}$/.test(c) || c === '')) continue;
    const feature = row[0].replace(/\s+/g, ' ').trim();
    if (!feature) continue;
    const marks = row.slice(1);
    const available: string[] = [];
    for (let i = 0; i < regions.length; i++) {
      // A tick means supported; an empty cell means not. Anything else is
      // unexpected and must not be guessed at.
      const cell = (marks[i] ?? '').trim();
      if (cell === '') continue;
      if (cell === '\u2713' || cell === '\u2714' || cell.toLowerCase() === 'yes') available.push(regions[i]);
      else throw new Error(`unexpected cell value ${JSON.stringify(cell)} for ${feature} / ${regions[i]}`);
    }
    features.push({ feature, key: slugify(feature), regions: available, count: available.length });
  }
  return { regions, features };
}

async function main(): Promise<void> {
  console.log(`docs-feature-regions: fetching ${MD_URL} (public GET, no credentials)`);
  const res = await fetch(MD_URL, { headers: { accept: 'text/markdown,text/plain,*/*' } });
  if (!res.ok) {
    console.error(`docs-feature-regions: HTTP ${res.status} — refusing to write a fact set from a failed fetch`);
    process.exit(1);
  }
  const md = await res.text();

  const { regions, features } = parseFeatureRegions(md);
  if (regions.length < 5 || features.length < 5) {
    console.error(`docs-feature-regions: parsed ${features.length} features across ${regions.length} regions — the table structure has changed. Refusing to write.`);
    process.exit(1);
  }

  const govcloud = regions.filter((r) => /GovCloud/i.test(r));
  const commercial = regions.filter((r) => !/GovCloud/i.test(r));

  const fetchedAt = new Date().toISOString();
  const contentHash = hashPayload({ regions, features });

  const fileName = `${FACT_SET_ID}.json`;
  const previous = loadFactSetFile(fileName);

  const facts: Record<string, FactValue> = {
    [`${FACT_SET_ID}.matrix-region-count`]: {
      type: 'integer',
      value: regions.length,
      note: `Region columns in the docs matrix, including ${govcloud.length} GovCloud partition region(s). SSM's global-infrastructure path reports commercial regions only, so the two counts differ legitimately.`,
    },
    [`${FACT_SET_ID}.commercial-region-count`]: { type: 'integer', value: commercial.length },
    [`${FACT_SET_ID}.feature-count`]: { type: 'integer', value: features.length },
  };

  for (const f of features) {
    facts[`${FACT_SET_ID}.${f.key}.count`] = {
      type: 'integer',
      value: f.count,
      note: `Regions where the docs matrix marks "${f.feature}" as supported.`,
    };
    facts[`${FACT_SET_ID}.${f.key}.regions`] = { type: 'string_list', value: f.regions };
  }

  const set: FactSet = {
    schema_version: 1,
    fact_set_id: FACT_SET_ID,
    tier: 'A',
    generator: GENERATOR,
    verified_at: fetchedAt,
    source: {
      kind: 'aws-docs',
      url: HTML_URL,
      fetched_at: fetchedAt,
      content_hash: contentHash,
      retrieved_by: `GET ${MD_URL}`,
    },
    evidence: {
      canonical: { regions, features },
      text: features.map((f) => `${f.feature}: available in ${f.count} regions — ${f.regions.join(', ')}`).join('\n'),
    },
    facts,
    ...(previous ? { previous: { 'feature-count': previous.facts[`${FACT_SET_ID}.feature-count`]?.value as number } } : {}),
  };

  mkdirSync(paths.facts, { recursive: true });
  saveFactSet(fileName, set);

  console.log(`docs-feature-regions: ${features.length} features across ${regions.length} regions (${commercial.length} commercial + ${govcloud.length} GovCloud)`);
  for (const f of features) console.log(`  ${String(f.count).padStart(2)} regions  ${f.key.padEnd(20)} ${f.feature}`);
  console.log(`docs-feature-regions: wrote facts/${fileName} (${contentHash})`);
}

if (import.meta.filename === process.argv[1]) await main();
