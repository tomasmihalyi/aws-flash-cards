/**
 * Tier A ingest — documentation prose for services the deck describes.
 *
 * WHY THIS EXISTS
 *
 * The deck is expanding past AgentCore, and the rule has not changed: no card
 * publishes without a citation to a source actually fetched. Without this ingest
 * the only way to write a card about Amazon Quick or Kiro would be to type what I
 * believe about them, which is precisely the failure the whole repo is built to
 * prevent. So the vendor's own "what is" page is fetched, retained as evidence,
 * and cited by the cards that describe it.
 *
 * WHAT IT DOES AND DOES NOT ESTABLISH
 *
 * It establishes what a vendor SAYS a product is. It cannot establish a boundary
 * judgement — "this use case belongs in Kiro, not Quick" is positioning, stays
 * Tier C, and is human-gated no matter how many doc pages are fetched.
 *
 * AWS docs serve a markdown rendering at the same path with a .md extension,
 * which parses far more cleanly than the HTML. Non-AWS pages fall back to tag
 * stripping.
 *
 * Read-only, no credentials, no AWS resource touched.
 *
 * Usage: node src/ingest/docs-pages.ts [--only <id>]
 */

import { mkdirSync } from 'node:fs';
import { hashPayload } from '../lib/hash.ts';
import { saveFactSet, loadFactSetFile, paths } from '../lib/store.ts';
import type { FactSet, FactValue } from '../lib/types.ts';

const GENERATOR = 'src/ingest/docs-pages.ts';

type PageSpec = {
  /** fact-set id, also the file name */
  id: string;
  /** page a human should open */
  url: string;
  /** what to actually fetch — AWS docs have a .md twin */
  fetch: string;
  kind: 'aws-docs' | 'vendor-docs';
  /** a phrase that must appear, or the fetch is judged wrong */
  expect: string;
  /**
   * Where the page's real body starts. An HTML docs site puts its entire
   * navigation tree in the text, and citing navigation as evidence is noise the
   * verifier would then try to match numbers against.
   */
  bodyStartsAt?: string;
  /** Human-facing title, taken from the vendor's own heading. */
  title: string;
};

const PAGES: PageSpec[] = [
  {
    id: 'quick.what-is',
    url: 'https://docs.aws.amazon.com/quicksuite/latest/userguide/what-is.html',
    fetch: 'https://docs.aws.amazon.com/quicksuite/latest/userguide/what-is.md',
    kind: 'aws-docs',
    expect: 'Amazon Quick',
    bodyStartsAt: 'What is Amazon Quick?',
    title: 'What is Amazon Quick?',
  },
  {
    id: 'q-developer.what-is',
    url: 'https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/what-is.html',
    fetch: 'https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/what-is.md',
    kind: 'aws-docs',
    expect: 'Amazon Q Developer',
    bodyStartsAt: 'What is Amazon Q Developer?',
    title: 'What is Amazon Q Developer?',
  },
  {
    id: 'kiro.docs',
    url: 'https://kiro.dev/docs/',
    fetch: 'https://kiro.dev/docs/',
    kind: 'vendor-docs',
    expect: 'Kiro',
    bodyStartsAt: 'Kiro is an AI-powered development environment',
    title: 'Kiro Documentation',
  },
];

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

/** Strip markup and collapse whitespace, so the text is stable to match against. */
function toPlainText(body: string, isMarkdown: boolean): string {
  let t = body;
  if (!isMarkdown) {
    t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    t = t.replace(/<[^>]+>/g, ' ');
  }
  t = t
    .replace(/<a name="[^"]*"><\/a>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/[*_`>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

async function fetchPage(spec: PageSpec): Promise<string> {
  const res = await fetch(spec.fetch, { headers: { accept: 'text/markdown,text/html,*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${spec.fetch}`);
  const body = await res.text();
  // A redirect stub is ~1KB of meta-refresh. Several Bedrock coding-agent paths
  // return exactly that, which is how we know those pages do not exist.
  if (body.length < 1500) throw new Error(`only ${body.length} bytes — looks like a redirect stub, not a page`);
  const text = toPlainText(body, spec.fetch.endsWith('.md'));
  if (!text.includes(spec.expect)) {
    throw new Error(`fetched page does not contain the expected phrase ${JSON.stringify(spec.expect)}`);
  }
  if (spec.bodyStartsAt) {
    const at = text.indexOf(spec.bodyStartsAt);
    if (at < 0) throw new Error(`body marker ${JSON.stringify(spec.bodyStartsAt)} not found — the page layout has changed`);
    return text.slice(at).trim();
  }
  return text;
}

async function main(): Promise<void> {
  const only = arg('only');
  mkdirSync(paths.facts, { recursive: true });
  let failures = 0;

  for (const spec of PAGES) {
    if (only && spec.id !== only) continue;
    const fileName = `${spec.id}.json`;
    let text: string;
    try {
      text = await fetchPage(spec);
    } catch (e) {
      // Refuse to write anything from a failed fetch: a fact set is a provenance
      // record, and a provenance record for a page we did not read is a lie.
      console.error(`docs-pages: ${spec.id} FAILED — ${(e as Error).message}`);
      failures++;
      continue;
    }

    const fetchedAt = new Date().toISOString();
    const contentHash = hashPayload(text);
    const previous = loadFactSetFile(fileName);
    const prevHash = previous?.source.content_hash;

    // The title is the one genuine scalar fact a "what is" page yields. The value
    // of this set is its evidence, not its facts.
    const title = spec.title;

    const facts: Record<string, FactValue> = {
      [`${spec.id}.title`]: { type: 'string', value: title, note: 'Page title as published by the vendor.' },
    };

    const set: FactSet = {
      schema_version: 1,
      fact_set_id: spec.id,
      tier: 'A',
      generator: GENERATOR,
      verified_at: fetchedAt,
      source: {
        kind: spec.kind,
        url: spec.url,
        fetched_at: fetchedAt,
        content_hash: contentHash,
        retrieved_by: `GET ${spec.fetch}`,
      },
      evidence: { canonical: text, text },
      facts,
      ...(prevHash ? { previous: { content_hash: prevHash } } : {}),
    };

    saveFactSet(fileName, set);
    const state = !prevHash ? 'first observation' : prevHash === contentHash ? 'unchanged' : 'CHANGED';
    console.log(`docs-pages: ${spec.id} · ${text.length} chars · ${state}`);
    console.log(`            "${title}" → facts/${fileName}`);
  }

  if (failures) {
    console.error(`\ndocs-pages: ${failures} page(s) could not be fetched — no fact set was written for them`);
    process.exit(1);
  }
}

await main();
