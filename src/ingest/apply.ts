/**
 * Tier A apply — resolve fact-governed slots and correct the cards.
 *
 * This is where deterministic data actually changes a card. Three outcomes per
 * slot, and the third is the one that matters most:
 *
 *   resolved === rendered   VERIFY    stamp verified_at + sources[], text unchanged
 *   resolved !== rendered   CORRECT   rewrite the slot, record before/after in the
 *                                     append-only provenance ledger
 *   a fact is missing       FAIL      touch nothing, exit non-zero
 *
 * The third branch is deliberately not a no-op. A fact that failed to fetch must
 * never leave a card carrying an unverified claim *and* wearing a fresh
 * verified_at — that combination is worse than being visibly stale, because it
 * looks checked.
 *
 * No model is involved at any point in this file.
 *
 * Usage: node src/ingest/apply.ts [--dry-run]
 */

import { loadCards, saveCard, loadFactStore } from '../lib/store.ts';
import { resolveTemplate, type FactStore } from '../lib/facts.ts';
import type { Card, Source, HistoryEntry } from '../lib/types.ts';

const GENERATOR = 'src/ingest/apply.ts';
const dryRun = process.argv.includes('--dry-run');

type Outcome = { card: string; slot: string; kind: 'verify' | 'correct' | 'skip-unresolvable'; before?: string; after?: string };

function main(): void {
  const store = loadFactStore();
  const cards = loadCards();
  const now = new Date().toISOString();

  const outcomes: Outcome[] = [];
  const failures: string[] = [];
  const written: string[] = [];

  for (const card of cards) {
    const tierA = Object.entries(card.slots).filter(([, s]) => s.tier === 'A');
    if (!tierA.length) continue;

    // Pass 1: refuse to touch this card at all unless every fact it needs is present.
    let blocked = false;
    for (const [name, slot] of tierA) {
      if (slot.unresolvable_reason) continue;
      const absent = slot.facts.filter((f) => !store.has(f));
      if (absent.length) {
        failures.push(`${card.card_id}.${name}: missing fact(s) ${absent.join(', ')} — card left untouched`);
        blocked = true;
      }
    }
    if (blocked) continue;

    // Pass 2: apply.
    // Two kinds of change, tracked separately because they mean different things:
    //   contentChanged — a claim or its provenance state moved  → ledger entry + updated_at
    //   reverified     — the source still agrees                → freshness stamp only
    let contentChanged = false;
    let reverified = false;
    const history: HistoryEntry[] = [];
    const usedFactIds: string[] = [];

    for (const [name, slot] of tierA) {
      if (slot.unresolvable_reason) {
        outcomes.push({ card: card.card_id, slot: name, kind: 'skip-unresolvable' });
        continue;
      }
      const res = resolveTemplate(slot.template, store);
      if (!res.ok) {
        failures.push(`${card.card_id}.${name}: unresolvable after the pre-check (${res.missing.join(', ')})`);
        blocked = true;
        break;
      }
      usedFactIds.push(...slot.facts);

      if (res.text === slot.rendered) {
        outcomes.push({ card: card.card_id, slot: name, kind: 'verify' });
        if (slot.rendered_from === 'seed') {
          // The seed literal happened to already match the source. It is now
          // verified rather than merely asserted, so its provenance changes even
          // though its text does not — that IS a state change, so it is logged.
          slot.rendered_from = 'tier-a';
          contentChanged = true;
          history.push({
            at: now, tier: 'A', action: 'verify', generator: GENERATOR, slot: name,
            facts: [...slot.facts].sort(),
            reason: 'Seed literal matched the deterministic source exactly; promoted from seed to tier-a with no text change.',
          });
        } else {
          // Re-verification with no change is NOT a ledger event. Appending one
          // per slot per run would add thousands of "nothing happened" entries a
          // year and bury the real corrections — which is the same as deleting
          // them. Only the freshness stamp moves.
          reverified = true;
        }
      } else {
        outcomes.push({ card: card.card_id, slot: name, kind: 'correct', before: slot.rendered, after: res.text });
        history.push({
          at: now, tier: 'A', action: 'correct', generator: GENERATOR, slot: name,
          before: slot.rendered, after: res.text, facts: [...slot.facts].sort(),
          reason: 'Deterministic source disagreed with the rendered claim. Corrected with zero model involvement.',
        });
        slot.rendered = res.text;
        slot.rendered_from = 'tier-a';
        contentChanged = true;
      }
    }
    if (blocked || (!contentChanged && !reverified)) continue;

    // Citation (FR-7): one source entry per backing fact set, latest fetch wins.
    card.sources = mergeSources(card.sources, sourcesFor(store, usedFactIds));

    // A card is only as fresh as its stalest input, so verified_at is the OLDEST
    // fact-set verification behind it, never the newest.
    card.verified_at = oldest(card.sources.map((s) => s.fetched_at)) ?? null;

    card.confidence = deriveConfidence(card);
    card.provenance.tier = 'A';
    if (contentChanged) {
      card.provenance.history.push(...history);
      // updated_at means "the content moved", not "we looked again".
      card.updated_at = now;
    }

    if (!dryRun) saveCard(card);
    written.push(card.card_id);
  }

  report(outcomes, failures, written);
}

function sourcesFor(store: FactStore, factIds: string[]): Source[] {
  return store.setsFor([...new Set(factIds)]).map((s) => ({
    url: s.source.url,
    title: `${s.fact_set_id} (${s.source.kind})`,
    kind: s.source.kind,
    fetched_at: s.source.fetched_at,
    content_hash: s.source.content_hash,
  }));
}

/** One entry per source url; a fresher fetch replaces an older one. */
function mergeSources(existing: Source[], incoming: Source[]): Source[] {
  const byUrl = new Map(existing.map((s) => [s.url, s]));
  for (const s of incoming) byUrl.set(s.url, s);
  return [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
}

function oldest(times: string[]): string | undefined {
  return times.length ? times.slice().sort()[0] : undefined;
}

/**
 * Derived, not judged. Any slot still on its seed literal — including one no
 * deterministic source can settle — caps the card at "low".
 */
function deriveConfidence(card: Card): Card['confidence'] {
  const anySeed = Object.values(card.slots).some((s) => s.rendered_from === 'seed');
  if (anySeed) return 'low';
  if (card.needs_review || !card.verified_at) return 'medium';
  return 'high';
}

function report(outcomes: Outcome[], failures: string[], written: string[]): void {
  const corrections = outcomes.filter((o) => o.kind === 'correct');
  const verifications = outcomes.filter((o) => o.kind === 'verify');
  const skipped = outcomes.filter((o) => o.kind === 'skip-unresolvable');

  if (corrections.length) {
    console.log(`\n=== CORRECTIONS (${corrections.length}) — deterministic data disagreed with the card ===`);
    for (const c of corrections) {
      console.log(`\n${c.card}.${c.slot}`);
      console.log(`  - ${c.before}`);
      console.log(`  + ${c.after}`);
    }
  }
  if (verifications.length) {
    console.log(`\n=== VERIFIED unchanged (${verifications.length}) ===`);
    for (const v of verifications) console.log(`  ${v.card}.${v.slot}`);
  }
  if (skipped.length) {
    console.log(`\n=== SKIPPED — no deterministic source exists (${skipped.length}) ===`);
    for (const s of skipped) console.log(`  ${s.card}.${s.slot} (stays seed, card flagged needs_review)`);
  }
  if (failures.length) {
    console.error(`\n=== FAILURES (${failures.length}) ===`);
    for (const f of failures) console.error(`  ${f}`);
  }

  console.log(
    `\napply: ${corrections.length} correction(s) · ${verifications.length} verification(s) · ${skipped.length} skipped · ${written.length} card(s) ${dryRun ? 'would be written' : 'written'}`,
  );
  if (dryRun) console.log('apply: --dry-run, nothing written');
  process.exit(failures.length ? 1 : 0);
}

main();
