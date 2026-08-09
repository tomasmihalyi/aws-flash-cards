/**
 * Tier A ingest — service LIMITS from the Service Quotas API.
 *
 * WHY THIS SOURCE
 *
 * Card AC-04 claims Runtime executions run "up to 8 hours". That number was
 * verified only by appearing in release-notes prose, and `validate` kept warning
 * that it was an ungoverned literal — correct on both counts. A limit is the
 * archetypal drifting number: AWS raises them routinely, and a flashcard that
 * teaches last year's ceiling is teaching the wrong thing.
 *
 * The AgentCore devguide has no quotas page (quotas.html, service-quotas.html,
 * runtime-quotas.html and limits.html all 404), so the API is not merely the
 * better source, it is the only deterministic one.
 *
 * WHAT IT IS NOT
 *
 * `list-service-quotas` returns the values APPLIED TO THIS ACCOUNT, which for an
 * unmodified account are the AWS defaults. That distinction is recorded on every
 * fact: a card should only cite one of these where the default is what it means.
 * `Adjustable` is retained for the same reason — "8 hours, and you cannot raise
 * it" is a different teaching point from "8 hours by default".
 *
 * Read-only, and structurally so: `src/lib/aws.ts` allows
 * `service-quotas:list-service-quotas` and nothing else from this service, so
 * requesting an increase is not reachable from here.
 *
 * Usage: node src/ingest/service-quotas.ts [--service bedrock-agentcore]
 */

import { mkdirSync } from 'node:fs';
import { awsRead, commandLine } from '../lib/aws.ts';
import { hashPayload } from '../lib/hash.ts';
import { saveFactSet, loadFactSetFile, paths } from '../lib/store.ts';
import type { FactSet, FactValue } from '../lib/types.ts';

const GENERATOR = 'src/ingest/service-quotas.ts';
const DEFAULT_SERVICE = 'bedrock-agentcore';
const REGION = 'ap-southeast-2';

/**
 * The quotas a card actually cites, and the fact id each one becomes.
 *
 * An allow-list rather than "ingest all 179", because a fact set is a published
 * interface: dumping every quota would create 179 fact ids that nothing
 * references and that the `no fact id defined twice` guarantee then has to police
 * forever. Add an entry when a card needs it.
 */
const WANTED: { quota_name: string; fact: string; note: string }[] = [
  {
    quota_name: 'Asynchronous job maximum duration (in Hours)',
    fact: 'runtime.max-async-job-hours',
    note: 'Longest a single asynchronous AgentCore job may run. This is what a card means by "executions up to N hours".',
  },
  {
    quota_name: 'Streaming maximum duration (in Minutes)',
    fact: 'runtime.max-streaming-minutes',
    note: 'Longest a streaming response may remain open.',
  },
];

type Quota = {
  QuotaCode: string;
  QuotaName: string;
  Value: number;
  Unit: string;
  Adjustable: boolean;
  GlobalQuota?: boolean;
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * Collapse the duplicate rows the API returns for one named quota.
 *
 * "Asynchronous job maximum duration (in Hours)" comes back three times under
 * three quota codes (Runtime, Browser and Code Interpreter each carry their own),
 * all currently 8. Picking one arbitrarily would hide a future divergence, so
 * agreement is REQUIRED: if the codes ever disagree, this refuses rather than
 * publishing a number that is true of only one of them.
 */
export function collapse(quotas: Quota[], quotaName: string): { value: number; unit: string; adjustable: boolean; codes: string[] } | null {
  const rows = quotas.filter((q) => q.QuotaName === quotaName);
  if (!rows.length) return null;
  const values = [...new Set(rows.map((r) => r.Value))];
  if (values.length > 1) {
    throw new Error(
      `quota "${quotaName}" has ${values.length} different values across codes ` +
        `${rows.map((r) => `${r.QuotaCode}=${r.Value}`).join(', ')} — refusing to publish one of them as THE limit`,
    );
  }
  return {
    value: rows[0].Value,
    unit: rows[0].Unit,
    adjustable: rows.some((r) => r.Adjustable),
    codes: rows.map((r) => r.QuotaCode).sort(),
  };
}

async function main(): Promise<void> {
  const service = arg('service', DEFAULT_SERVICE);
  console.log(`service-quotas: reading applied quotas for ${service} in ${REGION} (read-only)`);

  const res = awsRead<{ Quotas: Quota[] }>('service-quotas', 'list-service-quotas', {
    region: REGION,
    args: ['--service-code', service, '--max-items', '400'],
  });
  const quotas = res.Quotas ?? [];
  if (quotas.length < 10) {
    console.error(`service-quotas: only ${quotas.length} quota(s) returned — refusing to write a fact set from a suspect read`);
    process.exit(1);
  }

  const factSetId = `agentcore.quotas`;
  const facts: Record<string, FactValue> = {};
  const canonical: Record<string, unknown>[] = [];

  for (const want of WANTED) {
    const got = collapse(quotas, want.quota_name);
    if (!got) {
      console.error(`service-quotas: quota "${want.quota_name}" not found — the API has renamed or removed it. Refusing to write.`);
      process.exit(1);
    }
    // Integers stay integers so a claim of "8 hours" compares cleanly against 8.
    const value = Number.isInteger(got.value) ? got.value : got.value;
    facts[`${factSetId}.${want.fact}`] = {
      type: Number.isInteger(value) ? 'integer' : 'number',
      value,
      note: `${want.note} Applied value for this account in ${REGION}; ${got.adjustable ? 'adjustable on request' : 'NOT adjustable'}. Quota code(s): ${got.codes.join(', ')}.`,
    };
    canonical.push({
      quota_name: want.quota_name,
      fact: `${factSetId}.${want.fact}`,
      value,
      unit: got.unit,
      adjustable: got.adjustable,
      quota_codes: got.codes,
    });
  }

  const fetchedAt = new Date().toISOString();
  const contentHash = hashPayload(canonical);
  const fileName = `${factSetId}.json`;
  const previous = loadFactSetFile(fileName);

  const set: FactSet = {
    schema_version: 1,
    fact_set_id: factSetId,
    tier: 'A',
    generator: GENERATOR,
    verified_at: fetchedAt,
    source: {
      kind: 'service-quotas-api',
      url: `https://${REGION}.console.aws.amazon.com/servicequotas/home/services/${service}/quotas`,
      fetched_at: fetchedAt,
      content_hash: contentHash,
      retrieved_by: commandLine('service-quotas', 'list-service-quotas', {
        region: REGION,
        args: ['--service-code', service],
      }),
    },
    evidence: {
      canonical,
      text: canonical
        .map((c) => `${c.quota_name}: ${c.value} ${c.unit} (${c.adjustable ? 'adjustable' : 'not adjustable'})`)
        .join('\n'),
    },
    facts,
    ...(previous ? { previous: Object.fromEntries(Object.entries(previous.facts).map(([k, v]) => [k.split('.').pop()!, v.value as number])) } : {}),
  };

  mkdirSync(paths.facts, { recursive: true });
  saveFactSet(fileName, set);

  console.log(`service-quotas: ${quotas.length} quota(s) available, ${canonical.length} ingested`);
  for (const c of canonical) {
    console.log(`  ${String(c.value).padStart(5)} ${String(c.unit).padEnd(8)} ${c.quota_name}  [${(c.quota_codes as string[]).length} code(s)]`);
  }
  console.log(`service-quotas: wrote facts/${fileName} (${contentHash})`);
  console.log('service-quotas: these are the values APPLIED TO THIS ACCOUNT, which for an unmodified account are the AWS defaults');
}

if (import.meta.filename === process.argv[1]) await main();
