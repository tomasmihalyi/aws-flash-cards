/**
 * T4.6 — turn a Tier B draft into something a human can actually review.
 *
 * WHY THIS EXISTS AS A SEPARATE STEP
 *
 * `src/ingest/draft.ts` writes `drafts/<CARD>.draft.json` when the gate returns
 * `review`. That file is a JSON blob containing the model's prose, and asking
 * someone to review prose by reading JSON is asking them not to review it. What a
 * reviewer needs is a git diff of the card: the old sentence above, the new one
 * below, in the file the deck is actually built from.
 *
 * So this applies the draft to the card and lets `git diff` do the explaining.
 *
 * THE GATE RUNS AGAIN HERE, AND THAT IS THE POINT
 *
 * The draft artifact is a file on disk. Between the drafter writing it and this
 * applying it, it can be edited — by a human, by a bad merge, by a script. If the
 * gate ran only at generation time then the file, not the gate, would be the thing
 * authorising a card change.
 *
 * So `checkDraft` runs again against the card's CURRENT state. A draft that no
 * longer passes is refused, whatever the recorded verdict in the artifact says.
 * The recorded verdict is treated as a claim about the past, never as permission.
 *
 * WHAT GETS WRITTEN, AND WHY IT LOOKS UNFINISHED ON PURPOSE
 *
 * The card is written with `needs_review: true`, `provenance.tier: 'C'` and
 * `authored_by: 'model'`. That is deliberate even for a draft the gate ACCEPTED:
 *
 *   The verifier proves no fabricated FACT. It cannot prove the prose is GOOD.
 *
 * A rewrite can be entirely true and still be worse — vaguer, less memorable, or
 * subtly off-message about a positioning boundary. That judgement has no
 * deterministic source, which by this repository's own rule makes it Tier C. So a
 * Tier B accept still arrives as a pull request; it just arrives with a much
 * shorter review burden, and the PR body says which kind it is.
 *
 * The consequence worth stating: if one of these branches were ever merged without
 * being read, the card renders as "needs review" rather than passing itself off as
 * verified. Marking it Tier C is the defence that survives a careless merge.
 *
 * Usage:
 *   node tools/apply-draft.ts --card AC-19               # apply + write a PR body
 *   node tools/apply-draft.ts --card AC-19 --dry-run     # show, write nothing
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadCards, saveCard, loadFactStore, paths, ROOT } from '../src/lib/store.ts';
import {
  evidenceTextsFrom, datedEntriesFrom, subjectStemsOf, type VerifyContext,
} from '../src/lib/verifier.ts';
import { checkDraft, type DraftFields, type DraftVerdict } from '../src/lib/draft-gate.ts';
import { deriveConfidence } from '../src/lib/provenance.ts';
import { readdirSync } from 'node:fs';
import type { Card, FactSet, HistoryEntry, ReviewReason } from '../src/lib/types.ts';

const GENERATOR = 'tools/apply-draft.ts';
const DRAFT_DIR = join(ROOT, 'drafts');

export type DraftArtifact = {
  card_id: string;
  generated_at: string;
  model: string;
  verdict: DraftVerdict;
  draft: DraftFields;
};

function factSets(): FactSet[] {
  if (!existsSync(paths.facts)) return [];
  return readdirSync(paths.facts).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(paths.facts, f), 'utf8')) as FactSet);
}

/**
 * Refuse to write model prose onto main.
 *
 * The workflow always creates a branch first, so this only ever fires for a local
 * run — which is exactly when it matters, because the mistake it prevents (staging
 * unverified model prose on main and forgetting) leaves no trace until publish.
 */
function assertNotOnMain(force: boolean): void {
  if (force) return;
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    if (branch === 'main' || branch === 'master') {
      console.error(
        `apply-draft: refusing to write model-drafted prose on "${branch}".\n` +
        '  A Tier B/C draft belongs on a branch that a human merges deliberately.\n' +
        '  Create one first:  git checkout -b draft/<card>\n' +
        '  Or pass --force if you genuinely mean to write here.',
      );
      process.exit(2);
    }
  } catch {
    // Not a git repo, or git unavailable. Nothing to protect.
  }
}

/** The PR body. Separated from the writing so it can be asserted in tests. */
export function prBody(art: DraftArtifact, regated: DraftVerdict, card: Card): string {
  const kind = regated.outcome === 'accept'
    ? 'every checkable claim in this rewrite VERIFIED against retained source text'
    : 'at least one checkable claim could NOT be verified';

  const lines: string[] = [
    `## Tier B draft for ${art.card_id} — ${card.title}`,
    '',
    `A model rewrote this card's prose. The deterministic gate then found: **${kind}**.`,
    '',
    '### What the model was structurally unable to do',
    '',
    '- write a number, date or price — every numeral is checked against the original field, so it can only preserve, never introduce',
    '- move a value — slot tokens must be reproduced verbatim and are checked',
    '- invent a citation — a URL in the output is rejected outright',
    '- reshape the card — kv keys are compared exactly',
    '',
    `### Why this is a pull request and not a commit`,
    '',
    'The verifier proves there is no fabricated **fact**. It cannot prove the prose is',
    '**good** — clearer, still memorable, still right about positioning. That judgement',
    'has no deterministic source, which makes it Tier C by this repo\'s own rule.',
    '',
    `So the card on this branch is marked \`needs_review: true\` and \`tier: C\`. If this`,
    'branch were merged without being read, the card would render as needing review',
    'rather than looking verified.',
    '',
  ];

  if (regated.rejections.length) {
    lines.push('### What could not be verified', '', '```');
    for (const r of regated.rejections) lines.push(`${r.rule} at ${r.field}: ${r.detail}`);
    lines.push('```', '');
  }

  lines.push(
    '### Reviewing it',
    '',
    'Read the diff, not this description. If you accept it:',
    '',
    '```bash',
    `node tools/sign-off.ts --by "<your name>" --card ${art.card_id}`,
    '```',
    '',
    `Model: \`${art.model}\` · drafted ${art.generated_at} · re-gated at apply time`,
    '',
  );

  return lines.join('\n');
}

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main(): void {
  const cardId = argOf('--card');
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');

  if (!cardId) {
    console.error('apply-draft: --card <CARD_ID> is required');
    process.exit(2);
  }

  const artPath = join(DRAFT_DIR, `${cardId}.draft.json`);
  if (!existsSync(artPath)) {
    console.error(`apply-draft: no draft at ${artPath} — run: node src/ingest/draft.ts --card ${cardId} --write`);
    process.exit(2);
  }

  const art = JSON.parse(readFileSync(artPath, 'utf8')) as DraftArtifact;
  const card = loadCards().find((c) => c.card_id === cardId);
  if (!card) {
    console.error(`apply-draft: no card ${cardId}`);
    process.exit(2);
  }
  if (art.card_id !== card.card_id) {
    console.error(`apply-draft: artifact is for ${art.card_id}, not ${cardId}`);
    process.exit(2);
  }

  // RE-GATE. The recorded verdict is a claim about the past, not permission.
  const sets = factSets();
  const ctx: VerifyContext = {
    store: loadFactStore(),
    evidenceTexts: evidenceTextsFrom(sets),
    datedEntries: datedEntriesFrom(sets),
    subjectStems: subjectStemsOf(card),
  };
  const regated = checkDraft(card, art.draft, ctx);

  console.log(`apply-draft: ${cardId}`);
  console.log(`  recorded at draft time : ${art.verdict.outcome}`);
  console.log(`  re-gated now           : ${regated.outcome}`);
  console.log(`  ${regated.reason}`);

  if (regated.outcome === 'discard') {
    console.error('');
    console.error('apply-draft: the draft does not pass the gate now, so it is not applied.');
    for (const r of regated.rejections) console.error(`  · ${r.rule} at ${r.field}: ${r.detail}`);
    process.exit(1);
  }

  if (art.verdict.outcome !== regated.outcome) {
    // Not fatal, but the reviewer needs to know the world moved under the draft.
    console.log(`  NOTE: the verdict CHANGED since drafting (${art.verdict.outcome} → ${regated.outcome}).`);
    console.log('        A source or the card moved in between. Review with that in mind.');
  }

  assertNotOnMain(force || dryRun);

  const now = new Date().toISOString();

  /**
   * ONE RECORDED CORRECTION PER FIELD, EACH NAMING ITS PATH AND ITS `before`.
   *
   * Not one entry for the whole card. The parity gate's guarantee is "nothing
   * changed without a recorded reason", and it enforces that by INVERTING each
   * recorded field correction back to its `before` and requiring the result to
   * equal the original deck. An entry that names no field inverts nothing, so a
   * prose rewrite recorded as a single blob reads to the gate as an unexplained
   * change — which is exactly what it did on the first run of this tool.
   */
  const changes: { field: string; before: string; after: string }[] = [];
  const note = (field: string, before: string, after: string) => {
    if (before !== after) changes.push({ field, before, after });
  };

  note('hook', card.hook, art.draft.hook);
  note('back.lead', card.back.lead, art.draft.back.lead);
  note('back.hookline', card.back.hookline, art.draft.back.hookline);
  card.back.kv.forEach((row, i) => {
    const incoming = art.draft.back.kv[i];
    if (incoming) note(`back.kv[${i}].v`, row.v, incoming.v);
  });

  if (!changes.length) {
    console.log('');
    console.log('apply-draft: the draft is identical to the card — nothing to apply.');
    process.exit(0);
  }


  card.hook = art.draft.hook;
  card.back.lead = art.draft.back.lead;
  card.back.hookline = art.draft.back.hookline;
  card.back.kv = art.draft.back.kv;

  // Tier C even when the gate accepted — prose quality is a judgement, and a
  // judgement has no deterministic source.
  card.provenance.tier = 'C';
  card.provenance.authored_by = 'model';
  card.needs_review = true;

  const reason: ReviewReason = {
    reason:
      regated.outcome === 'accept'
        ? `Model-drafted prose refresh. Every checkable claim verified, but prose quality is a judgement no source settles — needs a human read. Model ${art.model}.`
        : `Model-drafted prose refresh with ${regated.rejections.length} unverified claim(s). Needs a human read of both the facts and the prose. Model ${art.model}.`,
    raised_at: now,
    raised_by: GENERATOR,
  };
  card.review_reasons = [...(card.review_reasons ?? []), reason];

  for (const c of changes) {
    card.provenance.history.push({
      at: now,
      tier: 'C',
      action: 'correct',
      generator: GENERATOR,
      field: c.field,
      before: c.before,
      after: c.after,
      reason: `${reason.reason} Re-gated at apply time: ${regated.reason}`,
    } as HistoryEntry);
  }

  card.updated_at = now;
  card.confidence = deriveConfidence(card);
  // Sign-off is per-change: a previous human's approval says nothing about prose
  // written after it.
  card.signed_off = null;

  const body = prBody(art, regated, card);
  const bodyPath = join(DRAFT_DIR, `${cardId}.pr.md`);

  if (dryRun) {
    console.log('\n--- PR body (dry run, nothing written) ---\n');
    console.log(body);
    process.exit(0);
  }

  saveCard(card);
  writeFileSync(bodyPath, body, 'utf8');
  console.log('');
  console.log(`  wrote  cards/${cardId}.json  (tier C, needs_review)`);
  console.log(`  wrote  drafts/${cardId}.pr.md`);
  console.log('');
  console.log('  git diff will now show the prose change a reviewer should read.');
  process.exit(0);
}

if (import.meta.filename === process.argv[1]) main();
