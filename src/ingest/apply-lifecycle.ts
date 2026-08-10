/**
 * Tier A apply — lifecycle transitions from the dated source.
 *
 * The design doc lists "GA/preview transitions" in Tier A alongside region
 * availability and pricing: deterministic, no model, auto-commit. This is that
 * applier. It exists because three cards shipped a `preview` badge for months
 * after the features went GA, and nothing in the repo was looking at `lifecycle`.
 *
 * WHAT IT TOUCHES, AND WHY ONLY THAT
 *
 *   lifecycle       set from the source's latest transition
 *   badge_variant   forced to agree, because a `pv` badge on a `ga` card is a
 *                   lint failure and, worse, is what a learner actually reads
 *   badge_text      rebuilt as "GA MAR 2026" from the signal's own month
 *
 * It does NOT touch prose. A card's wording may also be wrong — AC-16 claimed the
 * CLI shipped in April when it went GA in March — but rewriting prose is a
 * judgement call, which is Tier C by definition. Applying the deterministic half
 * and silently leaving the prose wrong would produce a card that looks corrected
 * and still misinforms, so prose mismatches are flagged for review instead.
 *
 * Usage:
 *   node src/ingest/apply-lifecycle.ts --dry-run
 *   node src/ingest/apply-lifecycle.ts
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCards, saveCard, paths } from '../lib/store.ts';
import { datedEntriesFrom } from '../lib/verifier.ts';
import { detectAll, type LifecycleFinding } from '../lib/lifecycle.ts';
import type { Card, FactSet, HistoryEntry } from '../lib/types.ts';

const GENERATOR = 'src/ingest/apply-lifecycle.ts';
const dryRun = process.argv.includes('--dry-run');

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "2026-03" + ga → "GA MAR 2026". Same shape as the badges already in the deck. */
function badgeTextFor(lifecycle: 'preview' | 'ga', isoMonth: string): string {
  const [year, month] = isoMonth.split('-');
  const label = MONTHS[Number(month) - 1] ?? month;
  return `${lifecycle === 'ga' ? 'GA' : 'PREVIEW'} ${label} ${year}`;
}

function factSets(): FactSet[] {
  if (!existsSync(paths.facts)) return [];
  return readdirSync(paths.facts)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(paths.facts, f), 'utf8')) as FactSet);
}

/**
 * Does the card's prose still describe the old state?
 *
 * Deliberately crude: it looks for the words, it does not judge the sentence. The
 * point is to raise a review flag a human can act on, not to decide anything.
 */
function proseMentionsPreview(card: Card): string[] {
  const fields: [string, string][] = [
    ['hook', card.hook],
    ['back.lead', card.back.lead],
    ['back.hookline', card.back.hookline],
    ...card.back.kv.map((r, i) => [`back.kv[${i}]`, r.v] as [string, string]),
  ];
  return fields
    .filter(([, text]) => /\bpreview\b/i.test(text))
    .map(([field]) => field);
}

function main(): void {
  const dated = datedEntriesFrom(factSets());
  if (!dated.length) {
    console.error('apply-lifecycle: no dated source in facts/ — run node src/ingest/docs-release-notes.ts first');
    process.exit(1);
  }

  const cards = loadCards().sort((a, b) => a.card_id.localeCompare(b.card_id));
  const byId = new Map(cards.map((c) => [c.card_id, c]));
  const findings = detectAll(cards, dated).filter((f) => f.drift && f.latest);

  if (!findings.length) {
    console.log('apply-lifecycle: no lifecycle drift — nothing to apply');
    return;
  }

  const now = new Date().toISOString();
  const applied: string[] = [];

  for (const f of findings) {
    const card = byId.get(f.card_id)!;
    const signal = f.latest!;
    const history: HistoryEntry[] = [];

    const changes: [keyof Card, string, string][] = [];

    // lifecycle
    if (card.lifecycle !== signal.lifecycle) {
      changes.push(['lifecycle', card.lifecycle, signal.lifecycle]);
    }
    // badge_variant must agree with lifecycle or the L-BADGE lint fails — and the
    // badge is the part a learner actually reads.
    const wantVariant = signal.lifecycle === 'preview' ? 'pv' : 'ga';
    if (card.badge_variant !== wantVariant) {
      changes.push(['badge_variant', card.badge_variant, wantVariant]);
    }
    // badge_text carries the month the source actually attests.
    const wantText = badgeTextFor(signal.lifecycle, signal.iso_month);
    if (card.badge_text !== wantText) {
      changes.push(['badge_text', card.badge_text, wantText]);
    }

    if (!changes.length) continue;

    for (const [field, before, after] of changes) {
      history.push({
        at: now,
        tier: 'A',
        action: 'correct',
        generator: GENERATOR,
        field: String(field),
        before,
        after,
        reason: `${signal.month_label} release notes: "${signal.heading}" (matched on ${signal.matched.join(', ')})`,
      });
      (card as unknown as Record<string, string>)[field as string] = after;
    }

    // The source is now a citation on this card.
    const already = card.sources.some((s) => s.url === signal.url);
    if (!already) {
      const set = factSets().find((s) => s.source.url === signal.url);
      if (set) {
        card.sources = [
          ...card.sources,
          {
            url: set.source.url,
            title: `${set.fact_set_id} (${set.source.kind})`,
            kind: set.source.kind,
            fetched_at: set.source.fetched_at,
            content_hash: set.source.content_hash,
          },
        ].sort((a, b) => a.url.localeCompare(b.url));
        card.verified_at = card.sources.map((s) => s.fetched_at).sort()[0];
      }
    }

    // Prose that still says "preview" after a GA transition is a Tier C problem.
    const stale = signal.lifecycle === 'ga' ? proseMentionsPreview(card) : [];
    if (stale.length) {
      const reason = `Lifecycle corrected to "ga" from ${signal.month_label} release notes, but prose still says "preview" in ${stale.join(', ')}. Rewording is Tier C (judgement) and needs a human.`;
      card.needs_review = true;
      card.review_reasons = [
        ...card.review_reasons.filter((r) => !r.reason.startsWith('Lifecycle corrected')),
        { reason, raised_at: now, raised_by: GENERATOR },
      ];
      history.push({ at: now, tier: 'A', action: 'flag-review', generator: GENERATOR, reason });
    }

    card.provenance.history.push(...history);
    card.updated_at = now;
    // A card under review is never "high", and a corrected one is no longer "low"
    // on account of this field.
    card.confidence = card.needs_review ? 'medium' : card.confidence === 'low' ? 'low' : 'medium';

    console.log(`\n${card.card_id}`);
    for (const [field, before, after] of changes) {
      console.log(`  ${String(field).padEnd(14)} ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    }
    console.log(`  evidence       ${signal.month_label} "${signal.heading}"`);
    if (stale.length) console.log(`  flagged        prose still says "preview" in ${stale.join(', ')}`);

    if (!dryRun) saveCard(card);
    applied.push(card.card_id);
  }

  console.log(
    `\napply-lifecycle: ${applied.length} card(s) ${dryRun ? 'would be corrected' : 'corrected'}${applied.length ? ' — ' + applied.join(' ') : ''}`,
  );
  if (dryRun) console.log('apply-lifecycle: --dry-run, nothing written');
}

if (import.meta.filename === process.argv[1]) main();
