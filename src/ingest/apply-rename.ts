/**
 * Apply corroborated renames (Tier A for the name, Tier C for the prose).
 *
 * ALIASING, NEVER OVERWRITING
 *
 * The old name goes into `aka[]` with the date and the source that retired it. It
 * is never deleted. Two things depend on that:
 *
 *   - search keeps finding the card by the name a learner remembers. Someone who
 *     learnt "Agent Registry" six months ago should not have to know it was
 *     renamed in order to find it again.
 *   - `deck-state.js` resolves a URL naming any alias, so a shared deep link
 *     survives. (The slug itself is derived from `card_id`, so a rename cannot
 *     break a link even without this — belt and braces, and the alias path is
 *     what makes an old NAME resolve as well as an old id.)
 *
 * TWO TIERS IN ONE RUN, KEPT APART
 *
 * The `title` field is Tier A: two independent sources agree on the string, so it
 * is deterministic and auto-committed with a `rename` provenance entry.
 *
 * The same name inside PROSE is Tier C. Substituting it is nearly mechanical, but
 * "nearly" is doing real work there — the new name contains the old one ("AWS
 * Agent Registry" ⊃ "Agent Registry"), so a naive replace is not idempotent and
 * would produce "AWS AWS Agent Registry" on a second run. Prose also carries
 * surrounding claims that a rename does not license changing. So the prose edit
 * goes through a slot, retains `seed_text`, and flags the card for human sign-off,
 * exactly as the AC-16 lead correction did.
 *
 * WHAT IS NOT TOUCHED, AND WHY
 *
 *   lifecycle  — lifecycle.ts's job. The August rename entry contains no GA
 *                language; reading "launches" as "generally available" is the
 *                overreach this repo exists to prevent. AC-14 stays `preview`,
 *                which April's "AgentCore Registry is now in Public Preview"
 *                independently confirms.
 *   service    — the join key to deterministic sources. The notes announce an
 *                `agent-registry` API namespace, but the pinned botocore snapshot
 *                still carries all 12 Registry control-plane operations under
 *                `bedrock-agentcore-control` and does not have the
 *                ListDiscoverableRegistryRecords the same entry announces. The
 *                namespace is recorded in the provenance reason; repointing the
 *                key on a claim the API surface cannot yet corroborate would break
 *                the card's link to every source that currently describes it.
 *
 * Usage: node src/ingest/apply-rename.ts [--dry-run] [--card AC-14]
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCards, saveCard, paths } from '../lib/store.ts';
import { datedEntriesFrom } from '../lib/verifier.ts';
import { detectRename, type RenameFinding } from '../lib/rename.ts';
import type { Card, FactSet, Source } from '../lib/types.ts';

const GENERATOR = 'src/ingest/apply-rename.ts';
const dryRun = process.argv.includes('--dry-run');
const only = (() => {
  const i = process.argv.indexOf('--card');
  return i >= 0 ? process.argv[i + 1]?.toUpperCase() : null;
})();

function factSets(): FactSet[] {
  if (!existsSync(paths.facts)) return [];
  return readdirSync(paths.facts)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(paths.facts, f), 'utf8')) as FactSet);
}

function sourceOf(sets: FactSet[], url: string): Source | null {
  const set = sets.find((s) => s.source.url === url);
  if (!set) return null;
  return {
    url: set.source.url,
    title: `${set.fact_set_id} (${set.source.kind})`,
    kind: set.source.kind,
    fetched_at: set.source.fetched_at,
    content_hash: set.source.content_hash,
  } as Source;
}

/** The earliest of a set of ISO timestamps. */
function oldest(times: string[]): string | null {
  const valid = times.filter(Boolean).sort();
  return valid.length ? valid[0] : null;
}

function addSource(card: Card, src: Source | null): void {
  if (!src) return;
  if (card.sources.some((s) => s.url === src.url && s.content_hash === src.content_hash)) return;
  card.sources = [...card.sources.filter((s) => s.url !== src.url), src];
}

/**
 * Substitute a renamed proper noun without mangling text or repeating a prefix.
 *
 * When the new name EXTENDS the old one — "Agent Registry" → "AWS Agent Registry"
 * — an occurrence that already reads "AWS Agent Registry" must be left alone, or a
 * second run yields "AWS AWS Agent Registry". Returns null when there is nothing
 * left to do, which is what makes the whole tool idempotent.
 */
export function substituteName(text: string, oldName: string, newName: string): string | null {
  if (!text.includes(oldName)) return null;
  const prefix = newName.endsWith(oldName) ? newName.slice(0, newName.length - oldName.length) : null;
  let out = '';
  let i = 0;
  let changed = false;
  while (i < text.length) {
    const at = text.indexOf(oldName, i);
    if (at < 0) {
      out += text.slice(i);
      break;
    }
    // Already the new name at this position? Copy it through untouched.
    const alreadyNew = prefix !== null && at >= prefix.length && text.slice(at - prefix.length, at) === prefix;
    out += text.slice(i, at);
    if (alreadyNew) {
      out += oldName;
    } else {
      out += newName;
      changed = true;
    }
    i = at + oldName.length;
  }
  return changed ? out : null;
}

function applyOne(card: Card, finding: RenameFinding, sets: FactSet[], now: string): boolean {
  const c = finding.candidate;
  if (!c) return false;
  if (!finding.confident) {
    console.log(`  ${card.card_id}: candidate "${c.new_name}" has no second source — refusing to apply`);
    return false;
  }
  const oldName = card.title;
  if (oldName === c.new_name) return false;

  // ---- Tier A: the name itself -------------------------------------------
  card.title = c.new_name;
  card.aka = [
    ...card.aka.filter((a) => a.name !== oldName),
    { name: oldName, changed_at: now, source: c.url },
  ];
  addSource(card, sourceOf(sets, c.url));
  for (const co of finding.corroboration) addSource(card, sourceOf(sets, co.url));
  /**
   * A card is only as fresh as its STALEST input, so verified_at is the oldest
   * source fetch — never the wall clock.
   *
   * Caught by tests/guarantees.test.ts, which is the whole reason that invariant
   * is a test: `verified_at ??= now` looked harmless and stamped a card as
   * verified today against sources fetched yesterday. Inventing freshness is
   * worse than being visibly stale.
   */
  card.verified_at = oldest(card.sources.map((s) => s.fetched_at)) ?? card.verified_at;

  const nsNote = c.namespace
    ? ` The entry also announces the "${c.namespace}" namespace; the card's service key is deliberately NOT repointed, because the pinned API surface still carries this feature's operations under bedrock-agentcore-control.`
    : '';
  card.provenance.history.push({
    at: now,
    tier: 'A',
    action: 'rename',
    field: 'title',
    before: oldName,
    after: c.new_name,
    generator: GENERATOR,
    reason:
      `${c.month_label} release notes: "${c.heading}" (matched on ${c.matched.join(', ')}). ` +
      `Corroborated by ${finding.corroboration.map((x) => x.fact_set_id).join(', ')}, which uses the same name verbatim. ` +
      `Old name retained in aka[] so search and shared links keep resolving.${nsNote}`,
  });

  console.log(`  ${card.card_id} title`);
  console.log(`     was: ${oldName}`);
  console.log(`     now: ${c.new_name}`);
  console.log(`     aka: ${card.aka.map((a) => a.name).join(', ')}`);

  // ---- Tier C: the same name in prose ------------------------------------
  const slotName = 'product_name_lead';
  if (finding.stale_prose.includes('back.lead') && !card.slots[slotName]) {
    const originalLead = card.back.lead;
    const updated = substituteName(originalLead, oldName, c.new_name);
    if (updated) {
      card.back.lead = `{{slot:${slotName}}}`;
      card.slots[slotName] = {
        tier: 'C',
        template: updated,
        facts: [],
        rendered: updated,
        rendered_from: 'tier-c',
        // The sentence exactly as authored, kept permanently.
        seed_text: originalLead,
        unresolvable_reason:
          'Prose containing the product name. The rename itself is deterministic, but rewriting a sentence is authorship, and the new name contains the old one so substitution is not safely repeatable. Tier C, with the original retained.',
      };
      card.provenance.history.push({
        at: now,
        tier: 'C',
        action: 'correct',
        generator: GENERATOR,
        slot: slotName,
        before: originalLead,
        after: updated,
        reason: `Prose still used the retired name "${oldName}" after the Tier A rename to "${c.new_name}".`,
      });
      const reviewReason = `Tier C prose substitution of a renamed product name (${slotName}), applied by an agent. Needs human sign-off; the Tier A rename of the title itself is deterministic and does not.`;
      card.needs_review = true;
      card.review_reasons = [...card.review_reasons, { reason: reviewReason, raised_at: now, raised_by: GENERATOR }];
      card.provenance.history.push({ at: now, tier: 'C', action: 'flag-review', generator: GENERATOR, reason: reviewReason });
      console.log(`  ${card.card_id} back.lead \u2192 Tier C slot "${slotName}" (old name retained as seed_text)`);
    }
  }

  card.updated_at = now;
  return true;
}

function main(): void {
  const sets = factSets();
  const entries = datedEntriesFrom(sets);
  if (!entries.length) {
    console.error('apply-rename: no dated source in facts/ — run the docs ingests first');
    process.exit(1);
  }

  let cards = loadCards();
  if (only) cards = cards.filter((c) => c.card_id === only);

  console.log('apply-rename: aliasing, never overwriting\n');
  const touched: Card[] = [];
  for (const card of cards) {
    const finding = detectRename(card, entries, sets);
    if (!finding.candidate) continue;
    if (applyOne(card, finding, sets, new Date().toISOString())) touched.push(card);
  }

  if (!touched.length) {
    console.log('apply-rename: nothing to apply');
    return;
  }
  console.log(`\napply-rename: ${touched.length} card(s) renamed`);
  if (dryRun) {
    console.log('apply-rename: --dry-run, nothing written');
    return;
  }
  for (const c of touched) saveCard(c);
}

// Guard the entry point: tests import substituteName from this module, and an
// unguarded main() would rewrite cards on import.
if (import.meta.filename === process.argv[1]) main();
