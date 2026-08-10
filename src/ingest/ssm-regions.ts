/**
 * Tier A ingest — region availability from SSM public parameters.
 *
 * AWS publishes its global-infrastructure data as SSM public parameters. A
 * region list read from there is authoritative and requires no interpretation,
 * which is exactly what makes it Tier A: no model is involved, and there is
 * nothing for one to disagree with.
 *
 * Usage: node src/ingest/ssm-regions.ts [--service bedrock-agentcore] [--profile NAME]
 */

import { awsRead, callerIdentity, commandLine } from '../lib/aws.ts';
import { hashPayload } from '../lib/hash.ts';
import { saveFactSet, loadFactSetFile, paths } from '../lib/store.ts';
import { mkdirSync } from 'node:fs';
import type { FactSet, FactValue } from '../lib/types.ts';

const GENERATOR = 'src/ingest/ssm-regions.ts';
const REGION_OF_INTEREST = 'ap-southeast-2';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

type SsmResponse = { Parameters: { Name: string; Value: string }[]; NextToken?: string };

function main(): void {
  const service = arg('service', 'bedrock-agentcore');
  // Empty means "let the credential chain decide" — a runner has no named
  // profiles, and the CLI already falls back to `default` locally.
  const profile = arg('profile', '') || undefined;
  const path = `/aws/service/global-infrastructure/services/${service}/regions`;
  const factSetId = `${shortName(service)}.regions`;
  const fileName = `${factSetId}.json`;

  const who = callerIdentity(profile);
  console.log(`ssm-regions: reading ${path} (account ${who.Account}, read-only)`);

  const res = awsRead<SsmResponse>('ssm', 'get-parameters-by-path', {
    profile,
    region: 'us-east-1',
    args: ['--path', path],
  });

  const regions = res.Parameters.map((p) => p.Value).sort();
  if (!regions.length) {
    // A service code that returns nothing is almost always a wrong code, not a
    // service with no regions. Writing an empty fact set would quietly assert
    // "available nowhere", so refuse instead.
    console.error(`ssm-regions: ${path} returned no regions. Wrong service code? Refusing to write an empty fact set.`);
    process.exit(1);
  }

  const fetchedAt = new Date().toISOString();
  const contentHash = hashPayload(regions);

  const previousSet = loadFactSetFile(fileName);
  const prevRegions = previousSet?.facts[`${factSetId}.list`]?.value as string[] | undefined;
  const changed = !prevRegions || hashPayload(prevRegions) !== contentHash;

  const facts: Record<string, FactValue> = {
    [`${factSetId}.count`]: { type: 'integer', value: regions.length, note: `Regions where ${service} is available, per AWS global-infrastructure data.` },
    [`${factSetId}.list`]: { type: 'region_list', value: regions },
    [`${factSetId}.includes.${REGION_OF_INTEREST}`]: {
      type: 'boolean',
      value: regions.includes(REGION_OF_INTEREST),
      note: `Sydney availability — the ANZ data-residency question, answered from the source rather than from memory.`,
    },
  };

  const set: FactSet = {
    schema_version: 1,
    fact_set_id: factSetId,
    tier: 'A',
    generator: GENERATOR,
    verified_at: fetchedAt,
    source: {
      kind: 'ssm-public-parameter',
      url: `ssm:/${path}`,
      fetched_at: fetchedAt,
      content_hash: contentHash,
      retrieved_by: commandLine('ssm', 'get-parameters-by-path', { profile, region: 'us-east-1', args: ['--path', path] }),
      aws_region: 'us-east-1',
    },
    // Keep the payload the hash was taken over, so the claim "19 regions,
    // including ap-southeast-2" can be checked against its source later.
    evidence: {
      canonical: regions,
      text: `${service} is available in ${regions.length} AWS regions: ${regions.join(', ')}.`,
    },
    facts,
    ...(prevRegions ? { previous: { list: prevRegions, count: prevRegions.length } } : {}),
  };

  mkdirSync(paths.facts, { recursive: true });
  saveFactSet(fileName, set);

  console.log(`ssm-regions: ${regions.length} regions · ${REGION_OF_INTEREST} ${regions.includes(REGION_OF_INTEREST) ? 'present' : 'ABSENT'} · ${changed ? (prevRegions ? `CHANGED from ${prevRegions.length}` : 'first observation') : 'unchanged'}`);
  console.log(`ssm-regions: wrote facts/${fileName} (${contentHash})`);
}

/** bedrock-agentcore → agentcore, so fact ids read naturally in prose templates. */
function shortName(service: string): string {
  return service.replace(/^bedrock-/, '');
}

main();
