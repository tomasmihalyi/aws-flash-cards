/**
 * One-time migration: legacy single-file SPA → git-versioned card JSON.
 *
 * Mechanical by design. Card text is lifted from the evaluated legacy literals,
 * never retyped, so the migration cannot introduce a wording change. Slot
 * extraction requires an EXACT substring match and aborts the whole run on a
 * miss, so a slot can never silently swallow the wrong span of text.
 *
 * Outputs:
 *   cards/<id>.json               one file per card
 *   content/art.json              pictogram library
 *   content/legacy-template.txt   verbatim card template source
 *   content/shell.html            the legacy file with DECK + card count templated
 *
 * Usage: node tools/extract-legacy.ts [--force]
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLegacy, deckLiteralBounds, type LegacyCard } from '../src/lib/legacy.ts';
import { CATEGORY_BY_INDEX, SEMANTICS, type SlotDecl } from './card-semantics.ts';
import type { Card, Slot } from '../src/lib/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY = join(ROOT, 'agentcore-flashcards.html');
const NOW = new Date().toISOString();
const GENERATOR = 'tools/extract-legacy.ts';

const force = process.argv.includes('--force');

function main() {
  const legacy = loadLegacy(LEGACY);
  console.log(`legacy: ${legacy.DECK.length} cards, ${legacy.CAT.length} categories, ${Object.keys(legacy.ART).length} pictograms`);

  const cardsDir = join(ROOT, 'cards');
  if (existsSync(cardsDir) && readdirSync(cardsDir).length && !force) {
    throw new Error('cards/ is not empty. Migration is one-time; pass --force to overwrite.');
  }
  mkdirSync(cardsDir, { recursive: true });
  mkdirSync(join(ROOT, 'content'), { recursive: true });

  // Sanity: the category list in content/categories.json must match the legacy
  // order exactly, or every card's rendered category label would shift.
  const cats = JSON.parse(readFileSync(join(ROOT, 'content', 'categories.json'), 'utf8')) as {
    categories: { id: string; label: string }[];
  };
  if (cats.categories.length !== legacy.CAT.length) {
    throw new Error(`categories.json has ${cats.categories.length} entries, legacy CAT has ${legacy.CAT.length}`);
  }
  cats.categories.forEach((c, i) => {
    if (c.label !== legacy.CAT[i]) {
      throw new Error(`category ${i}: categories.json label "${c.label}" !== legacy "${legacy.CAT[i]}"`);
    }
    if (c.id !== CATEGORY_BY_INDEX[i]) {
      throw new Error(`category ${i}: id "${c.id}" !== overlay "${CATEGORY_BY_INDEX[i]}"`);
    }
  });

  let slotCount = 0;
  for (const d of legacy.DECK) {
    const card = migrate(d);
    slotCount += Object.keys(card.slots).length;
    writeFileSync(join(cardsDir, `${card.card_id}.json`), JSON.stringify(card, null, 2) + '\n', 'utf8');
  }
  console.log(`wrote ${legacy.DECK.length} cards with ${slotCount} fact-governed slots`);

  writeFileSync(join(ROOT, 'content', 'art.json'), JSON.stringify(legacy.ART, null, 2) + '\n', 'utf8');
  console.log('wrote content/art.json');

  // The card template started life as the legacy one but is now OURS: it carries
  // the aria-hidden accessibility fix and the provenance footer. Silently
  // overwriting it with the legacy version would quietly reinstate the
  // screen-reader defect, which is exactly the class of regression this project
  // exists to prevent — so refuse unless asked twice.
  const templatePath = join(ROOT, 'content', 'card-template.html');
  if (existsSync(templatePath) && !process.argv.includes('--force-template')) {
    console.log('kept content/card-template.html (already exists — pass --force-template to reset it to the legacy version)');
  } else {
    writeFileSync(templatePath, legacy.templateSource, 'utf8');
    console.log('wrote content/card-template.html from the legacy template');
  }

  // Same reasoning as the template: shell.html now carries the aria-hidden
  // toggling, the provenance styling and the data-driven header markers.
  // Regenerating it from the legacy file would throw all three away.
  const shellPath = join(ROOT, 'content', 'shell.html');
  if (existsSync(shellPath) && !process.argv.includes('--force-shell')) {
    console.log('kept content/shell.html (already exists — pass --force-shell to reset it to the legacy version)');
  } else {
    writeFileSync(shellPath, makeShell(legacy.raw), 'utf8');
    console.log('wrote content/shell.html from the legacy file');
  }
}

function migrate(d: LegacyCard): Card {
  const sem = SEMANTICS[d.id];
  if (!sem) throw new Error(`no semantic overlay for card ${d.id} — refusing to guess kind/lifecycle/service`);

  // Lint the badge/lifecycle relationship at migration time, not later.
  if ((d.b === 'pv') !== (sem.lifecycle === 'preview')) {
    throw new Error(`card ${d.id}: badge_variant "${d.b}" and lifecycle "${sem.lifecycle}" disagree`);
  }

  const back = {
    lead: d.back.lead,
    kv: d.back.kv.map(([k, v]) => ({ k, v })),
    hookline: d.back.hookline,
  };
  const fields: Record<string, { get: () => string; set: (s: string) => void }> = {
    lead: { get: () => back.lead, set: (s) => (back.lead = s) },
    hookline: { get: () => back.hookline, set: (s) => (back.hookline = s) },
  };
  back.kv.forEach((row, i) => {
    fields[`kv:${i}`] = { get: () => row.v, set: (s) => (row.v = s) };
  });

  const slots: Record<string, Slot> = {};
  for (const [name, decl] of Object.entries(sem.slots ?? {})) {
    slots[name] = extractSlot(d.id, name, decl, fields);
  }

  const factsUsed = [...new Set(Object.values(slots).flatMap((s) => s.facts))].sort();
  const anySeed = Object.values(slots).some((s) => s.rendered_from === 'seed');

  // A slot no deterministic source can settle is a review item from the moment
  // it is created. Recording the limit is mandatory; leaving it silent is not.
  const unresolvable = Object.entries(slots).filter(([, s]) => s.unresolvable_reason);
  const reviewReasons = unresolvable.map(([name, s]) => ({
    reason: `Slot "${name}" has no deterministic source: ${s.unresolvable_reason}`,
    raised_at: NOW,
    raised_by: GENERATOR,
  }));

  const card: Card = {
    schema_version: 1,
    card_id: d.id,
    kind: sem.kind,
    lifecycle: sem.lifecycle,
    service: sem.service,
    category: CATEGORY_BY_INDEX[d.c],
    tags: [...sem.tags].sort(),
    badge_variant: d.b as Card['badge_variant'],
    badge_text: d.bt,
    art: d.art,
    title: d.t,
    hook: d.hook,
    back,
    slots,
    facts_used: factsUsed,
    // Empty on import: nothing has been fetched yet, so there is nothing to cite.
    // The citation gate in validate.ts is what makes that state visible.
    sources: [],
    verified_at: null,
    // Any unverified seed slot forces low confidence — not a judgement, a rule.
    confidence: anySeed || factsUsed.length > 0 ? 'low' : 'medium',
    depends_on: [...(sem.depends_on ?? [])].sort(),
    aka: sem.aka ?? [],
    superseded_by: null,
    supersedes: [],
    needs_review: reviewReasons.length > 0,
    review_reasons: reviewReasons,
    provenance: {
      tier: 'seed',
      authored_by: 'legacy-import',
      history: [
        {
          at: NOW,
          tier: 'seed',
          action: 'import',
          generator: GENERATOR,
          reason: 'Mechanical migration from agentcore-flashcards.html; card text lifted verbatim from the legacy DECK literal.',
        },
        ...reviewReasons.map((r) => ({
          at: NOW,
          tier: 'seed' as const,
          action: 'flag-review' as const,
          generator: GENERATOR,
          reason: r.reason,
        })),
      ],
    },
    created_at: NOW,
    updated_at: NOW,
    ...(sem.notes ? { notes: sem.notes } : {}),
  };
  return card;
}

function extractSlot(
  cardId: string,
  name: string,
  decl: SlotDecl,
  fields: Record<string, { get: () => string; set: (s: string) => void }>,
): Slot {
  const field = fields[decl.field];
  if (!field) throw new Error(`card ${cardId} slot ${name}: unknown field "${decl.field}"`);
  const before = field.get();
  if (!before.includes(decl.find)) {
    throw new Error(
      `card ${cardId} slot ${name}: exact text not found in ${decl.field}.\n  looking for: ${JSON.stringify(decl.find)}\n  field text:  ${JSON.stringify(before)}`,
    );
  }
  const occurrences = before.split(decl.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(`card ${cardId} slot ${name}: text appears ${occurrences} times in ${decl.field}; must be unique`);
  }
  field.set(before.replace(decl.find, `{{slot:${name}}}`));
  return {
    tier: decl.tier,
    template: decl.template,
    facts: [...decl.facts],
    rendered: decl.find,
    rendered_from: 'seed',
    seed_text: decl.find,
    ...(decl.unresolvable_reason ? { unresolvable_reason: decl.unresolvable_reason } : {}),
  };
}

/**
 * Turn the legacy file into a shell: byte-identical except that the DECK literal
 * and the card count become markers. Keeping the shell verbatim is what
 * guarantees the generated HTML has the same CSS, pictograms, state machine,
 * keyboard handling and reduced-motion behaviour — there is no second
 * implementation that could drift.
 */
function makeShell(raw: string): string {
  const { start, end } = deckLiteralBounds(raw);
  let shell = raw.slice(0, start) + '/*__DECK__*/' + raw.slice(end);

  const titleFrom = '<title>AgentCore Field Deck \u2014 21 Flashcards</title>';
  const titleTo = '<title>AgentCore Field Deck \u2014 @@COUNT@@ Flashcards</title>';
  if (!shell.includes(titleFrom)) throw new Error('shell: expected <title> not found');
  shell = shell.replace(titleFrom, titleTo);

  const metaFrom = '<b id="mTotal">21</b>';
  const metaTo = '<b id="mTotal">@@COUNT@@</b>';
  if (!shell.includes(metaFrom)) throw new Error('shell: expected mTotal not found');
  shell = shell.replace(metaFrom, metaTo);

  const countFrom = '<div class="count" id="count">1 / 21</div>';
  const countTo = '<div class="count" id="count">1 / @@COUNT@@</div>';
  if (!shell.includes(countFrom)) throw new Error('shell: expected initial count not found');
  shell = shell.replace(countFrom, countTo);

  return shell;
}

main();
