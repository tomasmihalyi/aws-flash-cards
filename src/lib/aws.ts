/**
 * Read-only AWS access.
 *
 * This module is the only place the ingest pipeline touches AWS, and it accepts
 * an explicit allow-list of (service, operation) pairs. Anything not on the list
 * is refused before the process is spawned — so "the ingest cannot create,
 * modify or delete an AWS resource" is a property of this file rather than a
 * promise about the code that calls it.
 *
 * The allow-list is pairs, not a "starts with describe/list/get" heuristic,
 * because that heuristic is wrong in general (`get-session-token` mutates
 * nothing but `delete-*` is not the only mutating prefix, and some services put
 * writes behind innocuous verbs). An explicit list cannot be fooled.
 */

import { execFileSync } from 'node:child_process';

const ALLOWED: ReadonlySet<string> = new Set([
  'ssm:get-parameters-by-path',
  'ssm:get-parameter',
  'pricing:describe-services',
  'pricing:get-products',
  'sts:get-caller-identity',
  // Service Quotas is the authoritative source for a service LIMIT, which is
  // exactly the kind of number that drifts and that no docs page reliably
  // states. list-service-quotas reads the account's applied values; it cannot
  // request or change one (that is request-service-quota-increase, absent here).
  'service-quotas:list-service-quotas',
]);

export type AwsOptions = {
  profile?: string;
  region?: string;
  /** Extra CLI args. Validated: must not contain another subcommand. */
  args?: string[];
};

export class AwsWriteRefused extends Error {}

/**
 * The AWS profile to use, or undefined to let the standard credential chain
 * resolve it.
 *
 * WHY THIS IS OPTIONAL RATHER THAN DEFAULTING TO 'default'
 *
 * It used to default to the literal profile name `default`, which worked on one
 * laptop and failed everywhere else. The scheduled refresh died on its first real
 * run with "The config profile (default) could not be found": a GitHub runner has
 * no named profiles at all — `configure-aws-credentials` exports environment
 * credentials, and passing `--profile` makes the CLI ignore them and go looking
 * for a config file that does not exist.
 *
 * Omitting the flag is correct in both places. Locally the CLI already falls back
 * to the `default` profile when none is given, so nothing changes; in CI the
 * environment credentials are found. Set AWS_PROFILE, or pass --profile
 * explicitly, when a specific identity is wanted.
 *
 * This is the third instance of one underlying mistake in this repo: provenance
 * and tooling encoding the author's local environment. The others were a
 * `file:///Users/<me>/…` citation in the botocore fact set and an absolute home
 * path in a committed test fixture.
 */
function resolveProfile(explicit?: string): string | undefined {
  const p = explicit ?? process.env.AWS_PROFILE;
  return p && p.length ? p : undefined;
}

export function awsRead<T = unknown>(service: string, operation: string, opts: AwsOptions = {}): T {
  const key = `${service}:${operation}`;
  if (!ALLOWED.has(key)) {
    throw new AwsWriteRefused(
      `refusing "${key}": not on the read-only allow-list in src/lib/aws.ts. ` +
        'This pipeline must never create, modify or delete an AWS resource.',
    );
  }

  const profile = resolveProfile(opts.profile);
  const region = opts.region ?? 'us-east-1';
  const argv = [
    service,
    operation,
    ...(profile ? ['--profile', profile] : []),
    '--region',
    region,
    '--output',
    'json',
    ...(opts.args ?? []),
  ];

  // Guard against an argument smuggling a second command through.
  for (const a of opts.args ?? []) {
    if (a.includes(';') || a.includes('&&') || a.includes('`') || a.includes('$(')) {
      throw new AwsWriteRefused(`refusing argument ${JSON.stringify(a)}: shell metacharacters`);
    }
  }

  // execFileSync, not exec: no shell, so no interpolation of any kind.
  const out = execFileSync('aws', argv, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(out) as T;
}

export function callerIdentity(profile?: string): { Account: string; Arn: string; UserId: string } {
  return awsRead('sts', 'get-caller-identity', { profile });
}

/** The exact command line, recorded in every fact set so a human can reproduce it. */
export function commandLine(service: string, operation: string, opts: AwsOptions = {}): string {
  const profile = resolveProfile(opts.profile);
  const region = opts.region ?? 'us-east-1';
  // No --profile when none was resolved: a recorded command that names a profile
  // only present on the machine that ran it is not reproducible, which is the
  // whole point of recording it.
  return [
    'aws',
    service,
    operation,
    ...(opts.args ?? []),
    ...(profile ? ['--profile', profile] : []),
    '--region',
    region,
  ].join(' ');
}
