/**
 * Tier A ingest — API surface from botocore service models.
 *
 * botocore ships a normalised model of every AWS API. Diffing it detects added,
 * removed and renamed operations without reading a single announcement, which
 * makes it the earliest reliable signal that a service has moved. No network and
 * no AWS credentials are involved: the model is a local file.
 *
 * Two fingerprints, because the two questions are different:
 *   operations_fp  the sorted operation-name set — cheap add/remove/rename signal
 *   schema_fp      the canonical skeleton of every operation's inputs, outputs
 *                  and errors — catches a parameter change on an existing call
 * Documentation strings are stripped from both: a doc edit is noise, and treating
 * it as signal would train the maintainer to ignore the alerts.
 *
 * No card binds to these facts yet. Its consumer is the P5 rename/retire
 * detector; the snapshot committed here is what P5 diffs against, so the
 * baseline has to exist before the detector does.
 *
 * Usage: node src/ingest/botocore-diff.ts [--data-dir <path>]
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hashPayload, sha256 } from '../lib/hash.ts';
import { saveFactSet, loadFactSetFile, paths } from '../lib/store.ts';
import type { FactSet, FactValue } from '../lib/types.ts';

const GENERATOR = 'src/ingest/botocore-diff.ts';
const SERVICES = ['bedrock-agentcore', 'bedrock-agentcore-control'];
const SNAPSHOT_DIR = join(paths.tests, 'fixtures', 'api-surface');

type ServiceModel = {
  metadata: Record<string, string>;
  operations: Record<string, { name?: string; input?: { shape?: string }; output?: { shape?: string }; errors?: { shape: string }[] }>;
  shapes: Record<string, unknown>;
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function findDataDir(): string {
  const explicit = arg('data-dir', '');
  if (explicit) return explicit;
  try {
    const out = execFileSync(
      'python3',
      ['-c', 'import botocore, os; print(os.path.join(os.path.dirname(botocore.__file__), "data"))'],
      { encoding: 'utf8' },
    ).trim();
    if (out && existsSync(out)) return out;
  } catch {
    /* fall through to the error below */
  }
  throw new Error('botocore data directory not found. Pass --data-dir <path>.');
}

function botocoreVersion(): string {
  try {
    return execFileSync('python3', ['-c', 'import botocore; print(botocore.__version__)'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * The botocore version the committed baseline was generated from.
 *
 * Read from the snapshot rather than kept in a separate pin file, so the version
 * and the baseline it describes cannot drift apart. Null on a first run, when no
 * baseline exists yet.
 */
export function pinnedVersion(snapshotDir = SNAPSHOT_DIR): string | null {
  if (!existsSync(snapshotDir)) return null;
  for (const f of readdirSync(snapshotDir).filter((f) => f.endsWith('.operations.json'))) {
    const snap = JSON.parse(readFileSync(join(snapshotDir, f), 'utf8')) as { botocore_version?: string };
    if (snap.botocore_version) return snap.botocore_version;
  }
  return null;
}

/**
 * Refuse to diff against a botocore the baseline was not built from.
 *
 * WHY THIS IS A CORRECTNESS GATE, NOT A CONVENIENCE CHECK
 *
 * This ingest exists to answer "did the API surface change" by diffing the live
 * model against a committed snapshot. That question is only meaningful if the
 * ONLY thing that moved is AWS's model. Let the botocore version float and the
 * diff measures the version gap instead: a scheduled run on GitHub's ubuntu image
 * found botocore 1.34.46 — a system package predating `bedrock-agentcore`
 * entirely — against a baseline built from 1.43.3. Nine minor versions of drift
 * would have reported hundreds of operations added or removed, all of them
 * artefacts, and a rename detector fed from that output would have been noise.
 *
 * Failing loudly is the honest behaviour. The version is a declared input to the
 * comparison, so bumping it is a deliberate baseline refresh (re-run with
 * --allow-version-drift, commit the new snapshots), not something a runner image
 * update should be able to do silently.
 */
export function assertVersionMatchesBaseline(actual: string, pinned: string | null, allowDrift: boolean): void {
  if (pinned === null || allowDrift || actual === pinned) return;
  throw new Error(
    `botocore ${actual} does not match the baseline in tests/fixtures/api-surface/ (${pinned}).\n` +
      'The API-surface diff is only meaningful when the model is the only thing that moved — ' +
      'a version gap would report its own artefacts as AWS API changes.\n' +
      `Install the pinned version (pip install "botocore==${pinned}"), or accept a new baseline ` +
      'with --allow-version-drift and commit the regenerated snapshots.',
  );
}

/** Load a model, handling both the gzipped on-disk form and a plain checkout. */
function loadModel(dataDir: string, service: string): { model: ServiceModel; path: string; apiVersion: string } {
  const svcDir = join(dataDir, service);
  if (!existsSync(svcDir)) throw new Error(`botocore model not found for "${service}" in ${dataDir}`);
  // Latest api-version directory wins.
  const versions = readdirSync(svcDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const apiVersion = versions.at(-1);
  if (!apiVersion) throw new Error(`no api-version directory under ${svcDir}`);
  const gz = join(svcDir, apiVersion, 'service-2.json.gz');
  const plain = join(svcDir, apiVersion, 'service-2.json');
  const path = existsSync(gz) ? gz : plain;
  if (!existsSync(path)) throw new Error(`no service-2.json[.gz] under ${join(svcDir, apiVersion)}`);
  const buf = readFileSync(path);
  const text = path.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  return { model: JSON.parse(text) as ServiceModel, path, apiVersion };
}

/** Operation names, sorted. The coarse signal. */
function operationNames(m: ServiceModel): string[] {
  return Object.keys(m.operations ?? {}).sort();
}

/**
 * Canonical skeleton of one operation: what it takes, what it returns, what it
 * can fail with. Documentation is excluded by construction — only these keys are
 * read — so a doc rewrite cannot register as an API change.
 */
function operationSkeleton(m: ServiceModel, name: string): unknown {
  const op = m.operations[name];
  return {
    input: op.input?.shape ? shapeSkeleton(m, op.input.shape, 0) : null,
    output: op.output?.shape ? shapeSkeleton(m, op.output.shape, 0) : null,
    errors: (op.errors ?? []).map((e) => e.shape).sort(),
  };
}

function shapeSkeleton(m: ServiceModel, shapeName: string, depth: number): unknown {
  if (depth > 4) return `<depth:${shapeName}>`;
  const s = m.shapes?.[shapeName] as
    | { type?: string; members?: Record<string, { shape: string }>; member?: { shape: string }; required?: string[]; enum?: string[] }
    | undefined;
  if (!s) return `<missing:${shapeName}>`;
  if (s.type === 'structure') {
    return {
      type: 'structure',
      required: [...(s.required ?? [])].sort(),
      members: Object.fromEntries(
        Object.keys(s.members ?? {})
          .sort()
          .map((k) => [k, shapeSkeleton(m, s.members![k].shape, depth + 1)]),
      ),
    };
  }
  if (s.type === 'list') return { type: 'list', member: s.member ? shapeSkeleton(m, s.member.shape, depth + 1) : null };
  return { type: s.type ?? 'unknown', ...(s.enum ? { enum: [...s.enum].sort() } : {}) };
}

function main(): void {
  const dataDir = findDataDir();
  const version = botocoreVersion();
  assertVersionMatchesBaseline(version, pinnedVersion(), process.argv.includes('--allow-version-drift'));
  console.log(`botocore-diff: data dir ${dataDir} (botocore ${version})`);
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  mkdirSync(paths.facts, { recursive: true });

  const fetchedAt = new Date().toISOString();
  const facts: Record<string, FactValue> = {};
  const sourcePayload: Record<string, unknown> = {};
  let anyChange = false;

  for (const service of SERVICES) {
    const { model, path, apiVersion } = loadModel(dataDir, service);
    // Identify by uid: bedrock-agentcore and bedrock-agentcore-control share a
    // signingName, so keying on that would silently conflate two APIs.
    const uid = model.metadata.uid ?? `${service}-${apiVersion}`;
    const ops = operationNames(model);
    const skeletons = Object.fromEntries(ops.map((o) => [o, operationSkeleton(model, o)]));
    const operationsFp = hashPayload(ops);
    const schemaFp = hashPayload(skeletons);

    const key = `agentcore.api-surface.${service}`;
    facts[`${key}.operation-count`] = { type: 'integer', value: ops.length, note: `Operations in botocore model ${uid}.` };
    facts[`${key}.operations-fingerprint`] = { type: 'string', value: operationsFp, note: 'Sorted operation-name set. Changes on add/remove/rename only.' };
    facts[`${key}.schema-fingerprint`] = { type: 'string', value: schemaFp, note: 'Canonical input/output/error skeletons. Changes on parameter or shape edits; unaffected by documentation.' };

    sourcePayload[service] = { uid, apiVersion, operationsFp, schemaFp, operationCount: ops.length };

    // ---- diff against the committed snapshot ----
    const snapPath = join(SNAPSHOT_DIR, `${service}.operations.json`);
    const prev = existsSync(snapPath)
      ? (JSON.parse(readFileSync(snapPath, 'utf8')) as { uid: string; operations: string[]; skeleton_hashes: Record<string, string> })
      : null;

    if (!prev) {
      console.log(`botocore-diff: ${service} — ${ops.length} operations, first snapshot (uid ${uid})`);
    } else {
      const added = ops.filter((o) => !prev.operations.includes(o));
      const removed = prev.operations.filter((o) => !ops.includes(o));
      const changed = ops.filter(
        (o) => prev.skeleton_hashes[o] && prev.skeleton_hashes[o] !== sha256(hashPayload(skeletons[o])),
      );
      // Rename, not add+remove, only when the two shapes are structurally
      // identical. Otherwise it is a removal (human-gated) plus an addition.
      const renames: { from: string; to: string }[] = [];
      for (const r of removed) {
        for (const a of added) {
          if (prev.skeleton_hashes[r] && prev.skeleton_hashes[r] === sha256(hashPayload(skeletons[a]))) {
            renames.push({ from: r, to: a });
          }
        }
      }
      if (added.length || removed.length || changed.length) {
        anyChange = true;
        console.log(`botocore-diff: ${service} — CHANGED: +${added.length} -${removed.length} ~${changed.length}`);
        if (added.length) console.log(`  added:   ${added.join(', ')}`);
        if (removed.length) console.log(`  removed: ${removed.join(', ')}`);
        if (changed.length) console.log(`  shape-changed: ${changed.join(', ')}`);
        if (renames.length) console.log(`  rename candidates (identical shapes): ${renames.map((r) => `${r.from} → ${r.to}`).join(', ')}`);
        const ambiguous = removed.filter((r) => !renames.some((x) => x.from === r));
        if (ambiguous.length) {
          console.log(`  removals with no shape-identical successor (human-gated in P5): ${ambiguous.join(', ')}`);
        }
      } else {
        console.log(`botocore-diff: ${service} — ${ops.length} operations, unchanged`);
      }
    }

    writeFileSync(
      snapPath,
      JSON.stringify(
        {
          comment:
            'Committed API-surface snapshot. The P5 rename/retire detector diffs the live botocore model against this file. Regenerate only via src/ingest/botocore-diff.ts.',
          service,
          uid,
          api_version: apiVersion,
          botocore_version: version,
          // Relative to the botocore package root, so the snapshot is meaningful
          // in someone else's checkout. An absolute home path was both a leak and
          // a fixture nobody but its author could interpret.
          model_path: `botocore/data/${service}/${apiVersion}/service-2.json.gz`,
          operations_fingerprint: operationsFp,
          schema_fingerprint: schemaFp,
          operations: ops,
          skeleton_hashes: Object.fromEntries(ops.map((o) => [o, sha256(hashPayload(skeletons[o]))])),
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  }

  const factSetId = 'agentcore.api-surface';
  const fileName = `${factSetId}.json`;
  const contentHash = hashPayload(sourcePayload);
  const previousSet = loadFactSetFile(fileName);

  const set: FactSet = {
    schema_version: 1,
    fact_set_id: factSetId,
    tier: 'A',
    generator: GENERATOR,
    verified_at: fetchedAt,
    source: {
      kind: 'botocore-model',
      /**
       * A package coordinate, not a filesystem path.
       *
       * This used to record `file:///Users/<me>/Library/.../botocore/data`, which
       * is a citation nobody else can follow — in a system whose whole claim is
       * that every fact names a checkable source, a source that resolves only on
       * one laptop is a defect, not untidiness. `botocore 1.43.3` plus the data
       * path RELATIVE to the package root is reproducible: anyone can install that
       * version and read the same file.
       */
      url: `pkg:pypi/botocore@${version}#botocore/data · ${SERVICES.join(', ')}`,
      fetched_at: fetchedAt,
      content_hash: contentHash,
      retrieved_by: `gunzip + parse botocore/data/{${SERVICES.join(',')}}/<api-version>/service-2.json.gz from botocore ${version}`,
    },
    evidence: {
      canonical: sourcePayload,
      text: Object.entries(sourcePayload)
        .map(([svc, meta]) => {
          const m = meta as { uid: string; apiVersion: string; operationCount: number };
          return `${svc} (${m.uid}, api-version ${m.apiVersion}) exposes ${m.operationCount} operations.`;
        })
        .join('\n'),
    },
    facts,
    ...(previousSet ? { previous: Object.fromEntries(Object.entries(previousSet.facts).map(([k, v]) => [k, v.value])) } : {}),
  };

  saveFactSet(fileName, set);
  console.log(`botocore-diff: wrote facts/${fileName} (${contentHash})${anyChange ? ' — API surface moved' : ''}`);
  console.log('botocore-diff: snapshots in tests/fixtures/api-surface/ — the baseline the P5 detector will diff against');
}

// FOURTH TIME IN THIS REPO. apply.ts, apply-rename.ts and validate.ts all shipped
// with a bare main() call and all three had to be guarded after an import executed
// them — apply-rename.ts wrote to cards/ during a test import, which produced the
// CORRECT result and is the dangerous kind of accident.
//
// This one was exposed by adding a test that imports assertVersionMatchesBaseline:
// the import ran the whole ingest, hit the new version guard, and failed the gate
// in the publish job while passing in refresh — because refresh had pip-installed
// the pinned botocore and publish had not. A test that silently depends on which
// job it runs in is worse than a failing one.
if (import.meta.filename === process.argv[1]) {
  main();
}
