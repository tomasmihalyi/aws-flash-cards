/**
 * Turn a `drafts/<ID>.new-card.json` artifact (from src/ingest/draft-new-card.ts)
 * into cards/<ID>.json and a PR body, the same shape apply-draft.ts already
 * proved out for the card-UPDATE path — see that file's header for why this is
 * a separate step from drafting (a reviewer needs a git diff, not a JSON blob)
 * and why the gate runs AGAIN here rather than trusting the recorded verdict.
 *
 * WHAT IS DIFFERENT FROM apply-draft.ts
 *
 * apply-draft.ts patches four fields on an EXISTING card and diffs against it.
 * There is no existing card here — this constructs a complete Card object from
 * scratch, so every schema-required field the drafter never asked the model for
 * (kind, lifecycle, badge_variant, badge_text, sources[]) is filled in with a
 * conservative, always-safe default rather than a model guess:
 *
 *   kind            'service-fact'  — the model described a capability, not a
 *                                     practice/distillation/mental-model; a human
 *                                     can recategorise on review, never silently
 *   lifecycle       'ga'            — coverage gaps come from a "what's new"
 *                                     feed; if the entry said "preview" the human
 *                                     reviewer sees the actual heading in the PR
 *                                     body and corrects it before merging
 *   badge_variant   'ga'            — paired with the lifecycle default above
 *   sources[]       the ORIGINATING fact set's own url + content_hash — never
 *                     invented, re-derived by finding which fact set actually
 *                     contains this heading (see findSourceFactSet below)
 *
 * None of these are judgements the verifier can settle, which is exactly why
 * `needs_review: true` and an explicit `[NEEDS REVIEW]` line in the PR body name
 * every one of them for a human to confirm or correct.
 *
 * There is still no `accept`-and-auto-merge branch. A regated `discard` refuses
 * to write, same as the drafter; a regated `review` writes to a fresh branch and
 * leaves merging to a human via the PR.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  loadCards, loadCategories, loadFactStore, loadIdLedger, saveIdLedger, saveCard, paths, ROOT,
} from '../src/lib/store.ts';
import { datedEntriesFrom, type VerifyContext } from '../src/lib/verifier.ts';
import { checkNewCard, type NewCardDraft, type NewCardVerdict } from '../src/lib/new-card-gate.ts';
import type { Card, FactSet, HistoryEntry } from '../src/lib/types.ts';

const DRAFT_DIR = join(ROOT, 'drafts');
const GENERATOR = 'tools/apply-new-card.ts';

export type NewCardArtifact = {
  card_id: string;
  generated_at: string;
  model: string;
  source_entry: { heading: string; url: string; month_label: string };
  art: string;
  verdict: NewCardVerdict;
  draft: NewCardDraft;
};

function factSets(): FactSet[] {
  if (!existsSync(paths.facts)) return [];
  return readdirSync(paths.facts).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(paths.facts, f), 'utf8')) as FactSet);
}

/**
 * The fact set that actually contains this heading, so the new card's citation
 * is the real source's url + content_hash — never a value the model wrote and
 * never a hash computed for the occasion. Falls back to the artifact's own
 * recorded url if no fact set matches (e.g. it was pruned since drafting); that
 * fallback carries no content_hash, which is itself a signal worth surfacing
 * rather than papering over with a fabricated one.
 */
export function findSourceFactSet(heading: string, sets: FactSet[]): FactSet | null {
  for (const s of sets) {
    const rows = Array.isArray(s.evidence?.canonical) ? (s.evidence.canonical as Record<string, unknown>[]) : [];
    if (rows.some((r) => r.heading === heading)) return s;
  }
  return null;
}

function assertNotOnMain(force: boolean): void {
  if (force) return;
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    if (branch === 'main' || branch === 'master') {
      console.error(
        `apply-new-card: refusing to write a model-drafted card on "${branch}".\n` +
        '  A new card belongs on a branch that a human merges deliberately.\n' +
        '  Create one first:  git checkout -b new-card/<id>\n' +
        '  Or pass --force if you genuinely mean to write here.',
      );
      process.exit(2);
    }
  } catch {
    // Not a git repo, or git unavailable. Nothing to protect.
  }
}

/** The PR body. Separated from the writing so it can be asserted in tests. */
export function prBody(art: NewCardArtifact, regated: NewCardVerdict, factSet: FactSet | null): string {
  const lines: string[] = [
    `## New card ${art.card_id} — ${art.draft.title}`,
    '',
    `Drafted from a coverage gap: **"${art.source_entry.heading}"** (${art.source_entry.month_label}).`,
    '',
    '### Why this is a pull request and never a commit',
    '',
    'A new card has no prior state, so there is nothing the deterministic gate can',
    'merely CONFIRM — every claim in it is new. The gate proves each checkable claim',
    'is grounded in the source entry\'s own text (never invented, never composed).',
    'It cannot and does not decide whether this gap is worth a card, whether the',
    'framing is right, or whether the category fits. **There is no accept-and-merge',
    'path for a new card, ever** — this PR is the only way one reaches the deck.',
    '',
    `### Gate result: ${regated.outcome.toUpperCase()}`,
    '',
    regated.reason,
    '',
  ];

  if (regated.rejections.length) {
    lines.push('```', ...regated.rejections.map((r) => `${r.rule} at ${r.field}: ${r.detail}`), '```', '');
  }

  lines.push(
    '### [NEEDS REVIEW] Judgement calls the gate cannot make',
    '',
    '- **Is this gap actually worth a card?** The model was only asked to draft, not to triage.',
    `- **category**: drafted as \`${art.draft.category}\` — read the source and confirm this is right, not merely valid.`,
    "- **kind, lifecycle, badge**: defaulted to `service-fact` / `ga` / `ga` — the drafter was never asked to judge positioning, and this default is a placeholder, not a claim. If the source entry says \"preview\", fix `lifecycle` and `badge_variant` before merging.",
    '- **art**: defaulted to a generic pictogram key — pick a more fitting one from `content/art.json` if you like.',
    '',
    '### Reviewing it',
    '',
    'Read the new file, not this description. It is exactly what would ship if this PR merges.',
    '',
    `Model: \`${art.model}\` · drafted ${art.generated_at} · re-gated at apply time`,
    factSet
      ? `Source fact set: \`${factSet.fact_set_id}\` (${factSet.source.content_hash})`
      : '⚠ Source fact set not found on disk at apply time — citation falls back to the recorded URL with no content_hash. Re-run the ingest before merging.',
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
    console.error('apply-new-card: --card <CARD_ID> is required');
    process.exit(2);
  }

  const artPath = join(DRAFT_DIR, `${cardId}.new-card.json`);
  if (!existsSync(artPath)) {
    console.error(`apply-new-card: no artifact at ${artPath} — run: node src/ingest/draft-new-card.ts --entry "<heading>" --write`);
    process.exit(2);
  }

  const art = JSON.parse(readFileSync(artPath, 'utf8')) as NewCardArtifact;
  if (art.card_id !== cardId) {
    console.error(`apply-new-card: artifact is for ${art.card_id}, not ${cardId}`);
    process.exit(2);
  }

  if (loadCards().some((c) => c.card_id === cardId)) {
    console.error(`apply-new-card: ${cardId} already exists in cards/ — a card id is never reused (FR-9), so this artifact is stale`);
    process.exit(2);
  }

  const ledger = loadIdLedger();
  if (ledger.includes(cardId)) {
    console.error(`apply-new-card: ${cardId} is already on the id ledger but has no card file — investigate before writing (possible retirement or a stale artifact)`);
    process.exit(2);
  }

  const sets = factSets();
  const categories = new Set(loadCategories().map((c) => c.id));

  // RE-GATE. The recorded verdict is a claim about the past, not permission —
  // the source fact set may have changed (or vanished) since drafting.
  const ctx: VerifyContext = {
    store: loadFactStore(),
    evidenceTexts: [{ url: art.source_entry.url, text: `${art.source_entry.heading}\n${sourceSummaryOf(art, sets)}` }],
    datedEntries: datedEntriesFrom(sets),
    subjectStems: [],
  };
  const regated = checkNewCard(art.draft, ctx, categories);

  console.log(`apply-new-card: ${cardId}`);
  console.log(`  recorded at draft time : ${art.verdict.outcome}`);
  console.log(`  re-gated now           : ${regated.outcome}`);
  console.log(`  ${regated.reason}`);

  if (regated.outcome === 'discard') {
    console.error('');
    console.error('apply-new-card: the draft does not pass the gate now, so it is not written. No PR.');
    for (const r of regated.rejections) console.error(`  · ${r.rule} at ${r.field}: ${r.detail}`);
    process.exit(1);
  }

  assertNotOnMain(force || dryRun);

  const now = new Date().toISOString();
  const factSet = findSourceFactSet(art.source_entry.heading, sets);

  const card: Card = {
    schema_version: 1,
    card_id: art.card_id,
    kind: 'service-fact',
    lifecycle: 'ga',
    service: art.draft.service,
    category: art.draft.category,
    tags: art.draft.tags,
    badge_variant: 'ga',
    badge_text: 'GA',
    art: art.art,
    title: art.draft.title,
    hook: art.draft.hook,
    back: {
      lead: art.draft.back.lead,
      hookline: art.draft.back.hookline,
      kv: art.draft.back.kv,
    },
    slots: {},
    facts_used: [],
    sources: [
      factSet
        ? {
          url: factSet.source.url,
          kind: 'aws-whats-new',
          fetched_at: factSet.source.fetched_at,
          content_hash: factSet.source.content_hash,
        }
        : {
          url: art.source_entry.url,
          kind: 'aws-whats-new',
          fetched_at: art.generated_at,
          content_hash: '',
        },
    ],
    verified_at: null, // no slot has been TIER-A verified; the gate checked claims, not slots
    confidence: 'medium',
    depends_on: [],
    aka: [],
    superseded_by: null,
    supersedes: [],
    needs_review: true,
    review_reasons: [
      {
        reason:
          `New card drafted from coverage gap "${art.source_entry.heading}". ` +
          `Every checkable claim verified against the source entry, but a new card's category, ` +
          `kind, lifecycle and framing are judgement calls no source can settle. Model ${art.model}.`,
        raised_at: now,
        raised_by: GENERATOR,
      },
    ],
    provenance: {
      tier: 'C',
      authored_by: 'model',
      history: [
        {
          at: now,
          tier: 'C',
          action: 'import',
          generator: GENERATOR,
          reason: `Drafted from coverage gap "${art.source_entry.heading}" (${art.source_entry.month_label}). ${regated.reason}`,
        } as HistoryEntry,
        // A SEPARATE flag-review entry, not folded into the import above.
        //
        // The guarantee this repo enforces (see apply-draft.ts and
        // tests/guarantees.test.ts) is "a raised review flag is recorded in the
        // history, not only on the card" — needs_review is a live field that
        // tools/sign-off.ts clears on approval, so if the ONLY record of why it
        // was raised lived in that field, signing off would erase it. The
        // append-only history has to carry the raise, independently of the
        // reason a new card exists in the first place.
        {
          at: now,
          tier: 'C',
          action: 'flag-review',
          generator: GENERATOR,
          reason: `New card drafted from coverage gap "${art.source_entry.heading}". ` +
            `Every checkable claim verified against the source entry, but a new card's ` +
            `category, kind, lifecycle and framing are judgement calls no source can settle. ` +
            `Model ${art.model}.`,
        } as HistoryEntry,
      ],
    },
    created_at: now,
    updated_at: now,
  };

  const body = prBody(art, regated, factSet);
  const bodyPath = join(DRAFT_DIR, `${cardId}.pr.md`);

  if (dryRun) {
    console.log('\n--- card (dry run, nothing written) ---\n');
    console.log(JSON.stringify(card, null, 2));
    console.log('\n--- PR body (dry run, nothing written) ---\n');
    console.log(body);
    process.exit(0);
  }

  saveCard(card);
  saveIdLedger([...ledger, cardId]);
  writeFileSync(bodyPath, body, 'utf8');
  console.log('');
  console.log(`  wrote  cards/${cardId}.json  (tier C, needs_review)`);
  console.log(`  wrote  content/card-id-ledger.json  (${cardId} appended)`);
  console.log(`  wrote  drafts/${cardId}.pr.md`);
  process.exit(0);
}

/** Best-effort recovery of the original summary text for the re-gate evidence pool. */
function sourceSummaryOf(art: NewCardArtifact, sets: FactSet[]): string {
  const factSet = findSourceFactSet(art.source_entry.heading, sets);
  if (!factSet) return '';
  const rows = Array.isArray(factSet.evidence?.canonical) ? (factSet.evidence.canonical as Record<string, unknown>[]) : [];
  const row = rows.find((r) => r.heading === art.source_entry.heading);
  return typeof row?.summary === 'string' ? row.summary : '';
}

if (import.meta.filename === process.argv[1]) main();
