/**
 * Draft a BRAND-NEW card from a coverage-detector gap.
 *
 * WHERE THIS SITS
 *
 *   check-coverage.ts finds a gap (an uncovered What's-New entry)
 *     -> this drafts a full new card from that entry's own text
 *     -> new-card-gate.ts verifies every claim against that same text
 *     -> review outcome -> tools/apply-new-card.ts writes cards/<ID>.json
 *        and opens a PR requesting the maintainer as reviewer
 *
 * There is no `--write-everything` mode, same reason draft.ts refuses a
 * "draft everything" mode: --entry <heading> is required, one gap at a time,
 * so a bad day for AWS's What's New feed cannot flood the repo with drafts
 * in one run. The daily refresh caps how many entries it drafts per run
 * (see tools/apply-new-card.ts's MAX_PER_RUN).
 *
 * WHY THIS PRODUCES A DIFFERENT SHAPE THAN draft.ts
 *
 * draft.ts rewrites the prose AROUND an existing card's slots -- the model
 * never invents structure, only wording. A new card has no slots and no
 * prior structure at all: the model has to propose a title, a hook, a
 * category and a small kv table, grounded entirely in the one gap entry
 * it was given. new-card-gate.ts's job is checking that grounding; this
 * file's job is asking for it in a way the gate can actually check.
 *
 * Usage:
 *   node src/ingest/draft-new-card.ts --entry "<exact heading>"
 *   node src/ingest/draft-new-card.ts --entry "<exact heading>" --write
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFactStore, loadIdLedger, paths, ROOT } from '../lib/store.ts';
import { datedEntriesFrom, type DatedEntry, type VerifyContext } from '../lib/verifier.ts';
import { checkNewCard, type NewCardDraft } from '../lib/new-card-gate.ts';
import { invokeModel, DEFAULT_MODEL_ID } from '../lib/bedrock.ts';
import type { FactSet } from '../lib/types.ts';

const DRAFT_DIR = join(ROOT, 'drafts');
const DEFAULT_ART = 'platform'; // a safe, always-present pictogram key -- see art.json

const NEW_CARD_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short card title, e.g. "AgentCore payments (GA)". No trailing punctuation.' },
    hook: { type: 'string', description: 'The question on the front of the card. One sentence, ends in "?".' },
    category: {
      type: 'string',
      description: 'MUST be exactly one of the ids listed under ALLOWED CATEGORIES below. Never invent a new one.',
    },
    tags: {
      type: 'array',
      items: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
      description: '2-5 lowercase-hyphen tags for search/filtering.',
    },
    back: {
      type: 'object',
      properties: {
        lead: { type: 'string', description: 'The main explanation, 1-2 sentences. Every number in it MUST already appear in the SOURCE ENTRY text below.' },
        hookline: { type: 'string', description: 'One memorable line.' },
        kv: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: {
            type: 'object',
            properties: { k: { type: 'string' }, v: { type: 'string' } },
            required: ['k', 'v'],
          },
        },
      },
      required: ['lead', 'hookline', 'kv'],
    },
  },
  required: ['title', 'hook', 'category', 'tags', 'back'],
} as const;

const SYSTEM = [
  'You draft a NEW flashcard for an AWS reference deck, from a single dated announcement. You are not a source of facts.',
  '',
  'HARD RULES, each mechanically enforced after you answer:',
  '1. Every digit you write (a count, a price, a year, a date) MUST appear verbatim in the',
  '   SOURCE ENTRY text below the "SOURCE ENTRY (...)" header line -- not the header line',
  '   itself, which only tells you the month for your own orientation. If a number is not',
  '   already in the announcement text, leave it out entirely rather than composing, rounding,',
  '   or restating a bare year from the header.',
  '2. category MUST be exactly one of the ids listed under ALLOWED CATEGORIES. Copy it',
  '   character for character. Never invent a category id.',
  '3. Never write a URL. Citations come from the fact set / dated entry, never from you.',
  '4. Say only what the SOURCE ENTRY text supports. If it does not support a point, leave it',
  '   out rather than reaching for general AWS knowledge you may have.',
  '5. One idea per card. back.kv has at most 3 rows.',
  '6. HOUSE STYLE. This deck is written in Australian English with deliberate punctuation.',
  '     · -ise, -isation, not -ize, -ization  (organise, specialise, optimisation)',
  '     · -our, not -or  (behaviour, colour, favour)',
  '     · -re, not -er  (centre, metre)  ·  -wards, not -ward  (afterwards, towards)',
  '     · an em dash keeps its spaces: "a — b", never "a—b"',
  '',
  'A response breaking rules 1-3 is discarded whole, so a cautious, minimal draft that only',
  'restates what the source says is always better than an ambitious one.',
].join('\n');

function factSets(): FactSet[] {
  if (!existsSync(paths.facts)) return [];
  return readdirSync(paths.facts).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(paths.facts, f), 'utf8')) as FactSet);
}

function loadCategories(): Set<string> {
  const p = join(paths.content, 'categories.json');
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  return new Set((raw.categories ?? []).map((c: { id: string }) => c.id));
}

export function buildPrompt(entry: DatedEntry, categories: Set<string>): string {
  return [
    `SOURCE ENTRY (from ${entry.url}):`,
    entry.heading,
    entry.summary,
    '',
    `ALLOWED CATEGORIES (copy the id exactly): ${[...categories].join(', ')}`,
    '',
    'Draft one new flashcard entirely from the source entry above. Do not restate its month',
    'or year anywhere in the card unless that exact digit sequence already appears in the',
    'heading or summary text above.',
  ].join('\n');
}

/** Next id for a given 2-4 letter prefix, e.g. "AC" -> "AC-26". Never reuses a retired id. */
export function nextCardId(prefix: string, ledger: string[]): string {
  const nums = ledger
    .filter((id) => id.startsWith(`${prefix}-`))
    .map((id) => Number(id.slice(prefix.length + 1)))
    .filter((n) => Number.isFinite(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}-${String(next).padStart(2, '0')}`;
}

/** service -> the id prefix already established by the existing cards for it. */
const SERVICE_PREFIX: Record<string, string> = {
  'bedrock-agentcore': 'AC',
  bedrock: 'BR',
  strands: 'ST',
  kiro: 'CA', // coding-agents prefix, matches existing CA-xx cards
  quick: 'QK',
};

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main(): void {
  const heading = argOf('--entry');
  const write = process.argv.includes('--write');
  const profile = argOf('--profile');
  const region = argOf('--region');
  const serviceArg = argOf('--service');

  if (!heading) {
    console.error('draft-new-card: --entry "<exact heading>" is required (there is no "draft everything" mode on purpose)');
    process.exit(2);
  }

  const sets = factSets();
  const store = loadFactStore();
  const entries = datedEntriesFrom(sets);
  const entry = entries.find((e) => e.heading === heading);
  if (!entry) {
    console.error(`draft-new-card: no dated entry with heading exactly "${heading}"`);
    process.exit(2);
  }

  const service = serviceArg ?? entry.service ?? undefined;
  if (!service || !SERVICE_PREFIX[service]) {
    console.error(`draft-new-card: entry has no usable service ("${entry.service ?? 'none'}") -- pass --service explicitly from {${Object.keys(SERVICE_PREFIX).join(', ')}}`);
    process.exit(2);
  }

  const categories = loadCategories();
  console.log(`draft-new-card: "${entry.heading}" (${entry.month_label}) · model ${DEFAULT_MODEL_ID}`);

  const res = invokeModel({
    system: SYSTEM,
    prompt: buildPrompt(entry, categories),
    schema: NEW_CARD_SCHEMA as unknown as Record<string, unknown>,
    toolName: 'emit_new_card',
    profile,
    region,
  });

  if (!res.ok) {
    console.error(`draft-new-card: no draft produced — ${res.error}`);
    process.exit(1);
  }

  const raw = res.value as {
    title: string; hook: string; category: string; tags: string[];
    back: { lead: string; hookline: string; kv: { k: string; v: string }[] };
  };

  const ledger = loadIdLedger();
  const cardId = nextCardId(SERVICE_PREFIX[service], ledger);

  const draft: NewCardDraft = {
    card_id: cardId,
    title: raw.title,
    hook: raw.hook,
    category: raw.category,
    service,
    tags: raw.tags,
    back: raw.back,
  };

  const ctx: VerifyContext = {
    store,
    evidenceTexts: [{ url: entry.url, text: `${entry.heading}\n${entry.summary}` }],
    datedEntries: entries,
    subjectStems: [],
  };

  const verdict = checkNewCard(draft, ctx, categories);

  console.log('');
  console.log(`outcome: ${verdict.outcome.toUpperCase()} (candidate id ${cardId})`);
  console.log(`  ${verdict.reason}`);
  for (const r of verdict.rejections) console.log(`  · ${r.rule} at ${r.field}: ${r.detail}`);
  console.log('');

  if (!write) {
    console.log('draft-new-card: report only (pass --write to act on this outcome)');
    process.exit(verdict.outcome === 'discard' ? 1 : 0);
  }

  if (verdict.outcome === 'discard') {
    console.error('draft-new-card: contract broken — nothing written, and deliberately no PR');
    process.exit(1);
  }

  // Same rule as draft.ts's accept/review split: this writes an ARTIFACT for
  // a human to apply, never the card itself. tools/apply-new-card.ts is the
  // only thing that ever creates cards/<ID>.json.
  mkdirSync(DRAFT_DIR, { recursive: true });
  const out = join(DRAFT_DIR, `${cardId}.new-card.json`);
  writeFileSync(
    out,
    `${JSON.stringify({
      card_id: cardId,
      generated_at: new Date().toISOString(),
      model: DEFAULT_MODEL_ID,
      source_entry: { heading: entry.heading, url: entry.url, month_label: entry.month_label },
      art: DEFAULT_ART,
      verdict,
      draft,
    }, null, 2)}\n`,
  );
  console.log(`draft-new-card: wrote ${out}`);
}

if (import.meta.filename === process.argv[1]) main();
