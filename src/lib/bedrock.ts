/**
 * Bedrock invocation, without adding a dependency.
 *
 * WHY THE CLI AND NOT THE SDK
 *
 * This repository has no dependencies, no lockfile and no node_modules — NFR-1.
 * That is not minimalism for its own sake: it is why TypeScript runs directly on
 * Node's type stripping, why there is no supply chain to audit, and why a refresh
 * cannot break because a transitive package changed. Adding
 * @aws-sdk/client-bedrock-runtime to reach one API would spend all of that.
 *
 * The AWS CLI is already present on the runner and already used by the publish
 * job, so invoking through it keeps the guarantee intact. The cost is a process
 * spawn per call, which is irrelevant at this volume.
 *
 * WHY OUTPUT IS SCHEMA-FORCED RATHER THAN PARSED HOPEFULLY
 *
 * Asking for JSON in a prompt and then parsing it means a malformed response is
 * indistinguishable from a refusal, an apology, or prose wrapped in a fence. Using
 * tool-use with `tool_choice` makes the shape the model's only legal move, so a
 * parse failure means something genuinely went wrong rather than the model being
 * chatty. The draft gate still re-checks everything — this only removes a class of
 * noise before the real checking starts.
 *
 * This module deliberately contains NO judgement about the content it returns.
 * Everything that decides whether output may be published lives in draft-gate.ts,
 * which is pure and tested without credentials.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Inference profile / model id. Overridable so a cheaper model can be used in dev.
 *
 * The `au.` prefix is not cosmetic and was not guessable. The documented examples
 * use `apac.` for Asia Pacific, and that default failed here with a validation
 * error naming a model that does not exist in this account:
 * `aws bedrock list-inference-profiles` reports `au.` and `global.` and no `apac.`.
 * Ask the account which profiles it has rather than inferring one from the region.
 */
export const DEFAULT_MODEL_ID =
  process.env.FLASHCARDS_MODEL_ID ?? 'au.anthropic.claude-sonnet-4-5-20250929-v1:0';

export type InvokeOptions = {
  prompt: string;
  system: string;
  /** JSON Schema the response MUST match. */
  schema: Record<string, unknown>;
  toolName: string;
  modelId?: string;
  region?: string;
  /** Optional: a runner has no named profiles, so this stays optional end to end. */
  profile?: string;
  maxTokens?: number;
};

export type InvokeResult =
  | { ok: true; value: unknown; stopReason: string }
  | { ok: false; error: string };

/**
 * One call. Returns a discriminated result rather than throwing, because a model
 * being unavailable is an expected operating condition for a nightly job, not an
 * exception — and the caller's correct response is to leave the card alone.
 */
export function invokeModel(opts: InvokeOptions): InvokeResult {
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID;
  const region = opts.region ?? process.env.AWS_REGION ?? 'ap-southeast-2';

  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: opts.maxTokens ?? 1500,
    // Temperature 0: a refresh is not a creative act, and a reproducible draft is
    // reviewable in a way a differently-worded one on every run is not.
    temperature: 0,
    system: opts.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: opts.prompt }] }],
    tools: [{ name: opts.toolName, description: 'Return the drafted prose.', input_schema: opts.schema }],
    tool_choice: { type: 'tool', name: opts.toolName },
  };

  const dir = mkdtempSync(join(tmpdir(), 'flashcards-draft-'));
  const bodyPath = join(dir, 'body.json');
  const outPath = join(dir, 'out.json');

  try {
    writeFileSync(bodyPath, JSON.stringify(body), 'utf8');

    const args = [
      'bedrock-runtime', 'invoke-model',
      '--model-id', modelId,
      '--region', region,
      '--content-type', 'application/json',
      '--accept', 'application/json',
      // A file, not an inline string: a prompt containing quotes or newlines is
      // otherwise at the mercy of shell quoting, and the retained source excerpts
      // this sends are full of both.
      '--body', `fileb://${bodyPath}`,
      outPath,
    ];
    if (opts.profile) args.push('--profile', opts.profile);

    const run = spawnSync('aws', args, { encoding: 'utf8' });

    if (run.error) return { ok: false, error: `could not run the aws CLI: ${run.error.message}` };
    if (run.status !== 0) {
      return { ok: false, error: `aws bedrock-runtime invoke-model exited ${run.status}: ${(run.stderr || '').trim()}` };
    }

    const raw = JSON.parse(readFileSync(outPath, 'utf8')) as {
      content?: { type: string; name?: string; input?: unknown }[];
      stop_reason?: string;
    };

    const toolUse = (raw.content ?? []).find((c) => c.type === 'tool_use' && c.name === opts.toolName);
    if (!toolUse || toolUse.input === undefined) {
      return {
        ok: false,
        error: `the model did not use the forced tool (stop_reason=${raw.stop_reason ?? 'unknown'}) — treated as no draft rather than parsed loosely`,
      };
    }

    return { ok: true, value: toolUse.input, stopReason: raw.stop_reason ?? 'tool_use' };
  } catch (e) {
    return { ok: false, error: `invoke failed: ${(e as Error).message}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Is a model reachable at all? Used to skip cleanly rather than fail a refresh. */
export function modelAvailable(profile?: string, region?: string): boolean {
  const args = ['bedrock', 'list-foundation-models', '--region', region ?? process.env.AWS_REGION ?? 'ap-southeast-2', '--query', 'length(modelSummaries)', '--output', 'text'];
  if (profile) args.push('--profile', profile);
  const run = spawnSync('aws', args, { encoding: 'utf8' });
  return run.status === 0;
}
