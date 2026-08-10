/**
 * Tier A ingest — pricing from the AWS Price List Query API.
 *
 * Prices are the claim most likely to be wrong in a hand-authored deck and the
 * most damaging to get wrong in front of a customer, so they are read from the
 * billing system of record rather than from a blog post or from memory.
 *
 * Two deliberate constraints:
 *   - Usage types are matched by an EXACT declared suffix, never by a fuzzy
 *     search. A price silently attached to the wrong usage type is worse than a
 *     missing price, because it looks verified.
 *   - Derived rates (per-1,000 from per-unit) are computed here in code, so a
 *     number in prose is still a number from the API times an integer.
 *
 * Usage: node src/ingest/pricelist.ts [--region ap-southeast-2] [--profile NAME]
 */

import { awsRead, callerIdentity, commandLine } from '../lib/aws.ts';
import { hashPayload } from '../lib/hash.ts';
import { saveFactSet, loadFactSetFile, paths } from '../lib/store.ts';
import { mkdirSync } from 'node:fs';
import type { FactSet, FactValue } from '../lib/types.ts';

const GENERATOR = 'src/ingest/pricelist.ts';
const SERVICE_CODE = 'AmazonBedrockAgentCore';
/** Price List is only callable from these regions; it is not a global endpoint. */
const API_REGION = 'us-east-1';

/**
 * The price points this deck makes claims about. `usageTypeSuffix` is matched
 * exactly against the part of the usagetype after the region prefix, so adding a
 * claim requires naming the usage type — there is no wildcard path.
 */
const WANTED: {
  factId: string;
  usageTypeSuffix: string;
  /** multiply the API's per-unit price by this to get the quoted rate */
  multiplier: number;
  unit: string;
}[] = [
  {
    factId: 'gateway.api-invocations.usd-per-1k',
    usageTypeSuffix: 'Gateway:Consumption-based:API-Invocations',
    multiplier: 1000,
    unit: 'per 1,000 API invocations',
  },
  {
    factId: 'memory.short-term.usd-per-1k-events',
    usageTypeSuffix: 'Memory:Consumption-based:Short-Term-Memory',
    multiplier: 1000,
    unit: 'per 1,000 events',
  },
  {
    factId: 'runtime.vcpu.usd-per-vcpu-hour',
    usageTypeSuffix: 'Runtime:Consumption-based:vCPU',
    multiplier: 1,
    unit: 'per vCPU-hour',
  },
  {
    factId: 'runtime.memory.usd-per-gb-hour',
    usageTypeSuffix: 'Runtime:Consumption-based:Memory',
    multiplier: 1,
    unit: 'per GB-hour',
  },
];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

type PriceRecord = {
  product: { attributes: Record<string, string> };
  terms: {
    OnDemand?: Record<string, { priceDimensions: Record<string, { unit: string; description: string; pricePerUnit: Record<string, string> }> }>;
  };
};

function main(): void {
  const region = arg('region', 'ap-southeast-2');
  // Empty means "let the credential chain decide" — a runner has no named
  // profiles, and the CLI already falls back to `default` locally.
  const profile = arg('profile', '') || undefined;
  const factSetId = `agentcore.pricing.${region}`;
  const fileName = `${factSetId}.json`;

  const who = callerIdentity(profile);
  console.log(`pricelist: reading ${SERVICE_CODE} for ${region} via the Price List API in ${API_REGION} (account ${who.Account}, read-only)`);

  const cliArgs = [
    '--service-code',
    SERVICE_CODE,
    '--filters',
    `Type=TERM_MATCH,Field=regionCode,Value=${region}`,
  ];
  // PriceList is a list of JSON *strings*, each one a whole product document.
  const res = awsRead<{ PriceList: string[] }>('pricing', 'get-products', {
    profile,
    region: API_REGION,
    args: cliArgs,
  });
  const records = res.PriceList.map((s) => JSON.parse(s) as PriceRecord);
  console.log(`pricelist: ${records.length} product records returned`);

  const fetchedAt = new Date().toISOString();
  const facts: Record<string, FactValue> = {};
  const matchedSource: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const want of WANTED) {
    const hits = records.filter((r) => {
      const ut = r.product.attributes.usagetype ?? '';
      // usagetype is "<REGIONPREFIX>-<suffix>"; match the suffix exactly.
      const dash = ut.indexOf('-');
      return dash > 0 && ut.slice(dash + 1) === want.usageTypeSuffix;
    });

    if (hits.length !== 1) {
      missing.push(`${want.usageTypeSuffix} (${hits.length} matches, expected exactly 1)`);
      continue;
    }

    const dim = firstPriceDimension(hits[0]);
    if (!dim) {
      missing.push(`${want.usageTypeSuffix} (no OnDemand price dimension)`);
      continue;
    }

    const perUnit = Number(dim.pricePerUnit.USD);
    if (!Number.isFinite(perUnit)) {
      missing.push(`${want.usageTypeSuffix} (USD price not numeric: ${String(dim.pricePerUnit.USD)})`);
      continue;
    }

    const value = round(perUnit * want.multiplier);
    facts[`${factSetId}.${want.factId}`] = {
      type: 'money',
      value,
      currency: 'USD',
      unit: want.unit,
      note: `Price List usagetype ${hits[0].product.attributes.usagetype}; API unit ${dim.unit} at ${dim.pricePerUnit.USD} USD, quoted ${want.unit}.`,
    };
    matchedSource[want.usageTypeSuffix] = {
      usagetype: hits[0].product.attributes.usagetype,
      unit: dim.unit,
      pricePerUnitUSD: dim.pricePerUnit.USD,
      description: dim.description,
    };
  }

  if (missing.length) {
    // Half a fact set is worse than a stale one: a card would gain a fresh
    // verified_at while still carrying an unverified claim.
    console.error('pricelist: could not resolve these price points, refusing to write a partial fact set:');
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }

  const contentHash = hashPayload(matchedSource);
  const previousSet = loadFactSetFile(fileName);
  const prevValues = previousSet
    ? Object.fromEntries(Object.entries(previousSet.facts).map(([k, v]) => [k, v.value]))
    : undefined;

  const set: FactSet = {
    schema_version: 1,
    fact_set_id: factSetId,
    tier: 'A',
    generator: GENERATOR,
    verified_at: fetchedAt,
    source: {
      kind: 'price-list-api',
      url: `https://api.pricing.${API_REGION}.amazonaws.com/ · GetProducts ServiceCode=${SERVICE_CODE} regionCode=${region}`,
      fetched_at: fetchedAt,
      content_hash: contentHash,
      retrieved_by: commandLine('pricing', 'get-products', { profile, region: API_REGION, args: cliArgs }),
      aws_region: API_REGION,
    },
    // The matched price records verbatim, so a "$0.005 per 1,000" claim can be
    // string-matched back to the API response that produced it.
    evidence: {
      canonical: matchedSource,
      text: Object.entries(matchedSource)
        .map(([usageType, rec]) => {
          const r = rec as { usagetype: string; unit: string; pricePerUnitUSD: string; description: string };
          return `${usageType}: ${r.pricePerUnitUSD} USD per ${r.unit} \u2014 ${r.description}`;
        })
        .join('\n'),
    },
    facts,
    ...(prevValues ? { previous: prevValues } : {}),
  };

  mkdirSync(paths.facts, { recursive: true });
  saveFactSet(fileName, set);

  for (const [id, f] of Object.entries(facts)) {
    const prev = prevValues?.[id];
    const state = prev === undefined ? 'first observation' : prev === f.value ? 'unchanged' : `CHANGED from ${String(prev)}`;
    console.log(`pricelist: ${id} = $${f.value} ${f.unit} · ${state}`);
  }
  console.log(`pricelist: wrote facts/${fileName} (${contentHash})`);
}

function firstPriceDimension(r: PriceRecord) {
  for (const term of Object.values(r.terms.OnDemand ?? {})) {
    for (const dim of Object.values(term.priceDimensions)) return dim;
  }
  return null;
}

/** Kill float artefacts from the multiply without inventing precision. */
function round(n: number): number {
  return Number(n.toPrecision(12));
}

if (import.meta.filename === process.argv[1]) main();
