/**
 * Tier B — a model-drafted refresh of a card's PROSE, gated deterministically.
 *
 * WHAT THIS IS ALLOWED TO CHANGE
 *
 * The explanation around a card's slots: the hook, the lead, the "why it matters"
 * line, the kv values. Nothing else. Every number keeps coming from a Tier A fact
 * set through a slot the model must reproduce verbatim, so this job cannot move a
 * value even if the model tries.
 *
 * WHERE THE MODEL SITS
 *
 *   evidence (retained excerpts)  →  model  →  DETERMINISTIC GATE  →  three doors
 *
 * The model is inside the gate, never in place of it. draft-gate.ts decides, it is
 * pure, and its rules are tested adversarially in CI without credentials — so the
 * thing that says "this may be published" never depends on a model being honest.
 *
 * THE THREE DOORS, AND WHY THE THIRD IS NOT A PR
 *
 *   accept   well-formed and every checkable claim verified → written as tier-b
 *   review   well-formed but something could not be verified → PR at Tier C
 *   discard  the contract was broken (a numeral invented, a slot dropped, a URL
 *            emitted) → nothing written, NO PR
 *
 * A discard deliberately produces no pull request. Handing a reviewer a draft that
 * contains a fabricated number and relying on them to notice is how a fabricated
 * number gets merged — the review would be reading well-formed, confident prose.
 * If the model broke the contract, the correct output is silence and a non-zero
 * exit.
 *
 * Usage:
 *   node src/ingest/draft.ts --card AC-19            # draft, gate, report only
 *   node src/ingest/draft.ts --card AC-19 --write    # also act on the outcome
 *   node src/ingest/draft.ts --card AC-19 --profile demo
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCards, loadFactStore, paths, ROOT } from '../lib/store.ts';
import { evidenceTextsFrom, datedEntriesFrom, subjectStemsOf, type VerifyContext } from '../lib/verifier.ts';
import { checkDraft, type DraftFields } from '../lib/draft-gate.ts';
import { invokeModel, DEFAULT_MODEL_ID } from '../lib/bedrock.ts';
import type { Card, FactSet } from '../lib/types.ts';

const DRAFT_DIR = join(ROOT, 'drafts');

/** The shape the model is forced into. Prose only — no tiers, sources or slots. */
const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    hook: { type: 'string', description: 'The question on the front of the card. One sentence.' },
    back: {
      type: 'object',
      properties: {
        lead: { type: 'string', description: 'The main explanation. Preserve every {{slot:name}} token exactly.' },
        hookline: { type: 'string', description: 'One memorable line.' },
        kv: {
          type: 'array',
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
  required: ['hook', 'back'],
} as const;

const SYSTEM = [
  'You rewrite flashcard prose for an AWS reference deck. You are not a source of facts.',
  '',
  'HARD RULES, each mechanically enforced after you answer:',
  '1. NEVER write a digit. Not a count, not a price, not a year, not a date. If a number',
  '   belongs in a sentence it is already inside a {{slot:name}} token — reproduce that',
  '   token character for character and let it supply the value.',
  '2. Reproduce EVERY {{slot:name}} token from the original, exactly once each. Do not',
  '   invent a slot name that the original does not contain.',
  '3. Never write a URL. Citations come from the fact sets, not from you.',
  '4. Keep every kv key exactly as given. You may rewrite a value; you may not rename,',
  '   add or remove a key.',
  '5. Say only what the supplied source excerpts support. If they do not support a point,',
  '   leave it out rather than reaching for general knowledge.',
  '6. Rewrite for clarity at roughly the original length. This is a refresh, not an essay.',
  '',
  'A response breaking any of these is discarded whole, so a cautious rewrite that keeps',
  'the original meaning is always better than an ambitious one.',
].join('\n');

function factSets(): FactSet[] {
  if (!existsSync(paths.facts)) return [];
  return readdirSync(paths.facts).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(paths.facts, f), 'utf8')) as FactSet);
}

/**
 * The grounding. Only excerpts from fact sets this card actually cites, so the
 * model is not handed the whole corpus and invited to find something interesting
 * in a neighbouring product.
 */
function evidenceFor(card: Card, sets: FactSet[]): { url: string; text: string }[] {
  const wanted = new Set<string>();
  for (const slot of Object.values(card.slots)) for (const f of slot.facts) wanted.add(f.split('.').slice(0, 2).join('.'));
  const relevant = sets.filter((s) => [...wanted].some((w) => s.fact_set_id?.startsWith(w) ?? false));
  return evidenceTextsFrom(relevant.length ? relevant : sets);
}

function buildPrompt(card: Card, evidence: { url: string; text: string }[]): string {
  const excerpts = evidence
    .map((e, i) => `--- SOURCE ${i + 1} (${e.url}) ---\n${e.text.slice(0, 4000)}`)
    .join('\n\n');

  return [
    `CARD ${card.card_id} — ${card.title}`,
    `Subject: ${card.category} / ${card.kind}, lifecycle ${card.lifecycle}`,
    '',
    'THE CURRENT PROSE, which you are rewriting:',
    JSON.stringify(
      {
        hook: card.hook,
        back: { lead: card.back.lead, hookline: card.back.hookline, kv: card.back.kv },
      },
      null,
      2,
    ),
    '',
    `SLOT TOKENS YOU MUST REPRODUCE EXACTLY: ${Object.keys(card.slots).map((s) => `{{slot:${s}}}`).join(', ') || '(none)'}`,
    '',
    'SOURCE EXCERPTS — the only facts you may rely on:',
    excerpts || '(no excerpts retained for this card)',
  ].join('\n');
}

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main(): void {
  const cardId = argOf('--card');
  const write = process.argv.includes('--write');
  const profile = argOf('--profile');
  const region = argOf('--region');

  if (!cardId) {
    console.error('draft: --card <CARD_ID> is required (there is no "draft everything" mode on purpose)');
    process.exit(2);
  }

  const cards = loadCards();
  const card = cards.find((c) => c.card_id === cardId);
  if (!card) {
    console.error(`draft: no card ${cardId}`);
    process.exit(2);
  }

  const sets = factSets();
  const store = loadFactStore();
  const evidence = evidenceFor(card, sets);

  if (!evidence.length) {
    // No retained excerpt means the verifier could not check a single claim, so a
    // draft could only ever reach `review`. Refusing here is cheaper and honest.
    console.error(`draft: ${cardId} has no retained source excerpts — nothing to ground a draft against`);
    process.exit(1);
  }

  console.log(`draft: ${cardId} · model ${DEFAULT_MODEL_ID} · ${evidence.length} source excerpt(s)`);

  const res = invokeModel({
    system: SYSTEM,
    prompt: buildPrompt(card, evidence),
    schema: DRAFT_SCHEMA as unknown as Record<string, unknown>,
    toolName: 'emit_draft',
    profile,
    region,
  });

  if (!res.ok) {
    // A model being unreachable is an operating condition, not a defect in the
    // deck. The card is left exactly as it was.
    console.error(`draft: no draft produced — ${res.error}`);
    process.exit(1);
  }

  const draft = res.value as DraftFields;

  const ctx: VerifyContext = {
    store,
    evidenceTexts: evidence,
    datedEntries: datedEntriesFrom(sets),
    subjectStems: subjectStemsOf(card),
  };

  const verdict = checkDraft(card, draft, ctx);

  console.log('');
  console.log(`outcome: ${verdict.outcome.toUpperCase()}`);
  console.log(`  ${verdict.reason}`);
  for (const r of verdict.rejections) console.log(`  · ${r.rule} at ${r.field}: ${r.detail}`);
  console.log('');

  if (!write) {
    console.log('draft: report only (pass --write to act on this outcome)');
    process.exit(verdict.outcome === 'discard' ? 1 : 0);
  }

  if (verdict.outcome === 'discard') {
    console.error('draft: contract broken — nothing written, and deliberately no PR');
    process.exit(1);
  }

  // ACCEPT AND REVIEW BOTH WRITE AN ARTIFACT, NEVER A CARD.
  //
  // This job used to write the card itself on `accept`. That made two things able
  // to modify drafted prose — this and tools/apply-draft.ts — and "only one thing
  // may write X" is the property the rest of this repository is built on (only an
  // applier writes a slot; only ingest writes a fact).
  //
  // It was also wrong on the merits. The gate accepting means no fabricated FACT
  // survived. It does not mean the prose is better: a rewrite can be entirely true
  // and still vaguer, less memorable, or subtly off about a positioning boundary.
  // That is a judgement, judgements have no deterministic source, and this repo
  // routes judgements to a human. So `accept` lowers the review burden rather than
  // removing the review.
  mkdirSync(DRAFT_DIR, { recursive: true });
  const out = join(DRAFT_DIR, `${card.card_id}.draft.json`);
  writeFileSync(
    out,
    `${JSON.stringify({ card_id: card.card_id, generated_at: new Date().toISOString(), model: DEFAULT_MODEL_ID, verdict, draft }, null, 2)}\n`,
    'utf8',
  );

  console.log(`draft: wrote ${out}`);
  console.log('       the card itself is untouched — apply it with:');
  console.log(`         node tools/apply-draft.ts --card ${card.card_id}`);
  console.log(
    verdict.outcome === 'accept'
      ? '       (verdict ACCEPT: facts verified, so the review is about prose quality only)'
      : '       (verdict REVIEW: read the facts as well as the prose)',
  );
  process.exit(0);
}

if (import.meta.filename === process.argv[1]) main();
