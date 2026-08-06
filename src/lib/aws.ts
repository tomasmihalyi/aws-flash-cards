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
]);

export type AwsOptions = {
  profile?: string;
  region?: string;
  /** Extra CLI args. Validated: must not contain another subcommand. */
  args?: string[];
};

export class AwsWriteRefused extends Error {}

export function awsRead<T = unknown>(service: string, operation: string, opts: AwsOptions = {}): T {
  const key = `${service}:${operation}`;
  if (!ALLOWED.has(key)) {
    throw new AwsWriteRefused(
      `refusing "${key}": not on the read-only allow-list in src/lib/aws.ts. ` +
        'This pipeline must never create, modify or delete an AWS resource.',
    );
  }

  const profile = opts.profile ?? process.env.AWS_PROFILE ?? 'default';
  const region = opts.region ?? 'us-east-1';
  const argv = [service, operation, '--profile', profile, '--region', region, '--output', 'json', ...(opts.args ?? [])];

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
  const profile = opts.profile ?? process.env.AWS_PROFILE ?? 'default';
  const region = opts.region ?? 'us-east-1';
  return ['aws', service, operation, ...(opts.args ?? []), '--profile', profile, '--region', region].join(' ');
}
