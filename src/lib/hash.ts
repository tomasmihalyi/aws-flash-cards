/** Canonical JSON + sha256, used for every content hash in the system. */

import { createHash } from 'node:crypto';

/**
 * Deterministic serialisation: object keys sorted, arrays order-preserving.
 * Hashes are taken over THIS form of the payload actually returned by a source,
 * never over a pretty-printed file — so reformatting is not a false positive and
 * a value change cannot be a false negative.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function sha256(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashPayload(value: unknown): string {
  return sha256(canonical(value));
}
