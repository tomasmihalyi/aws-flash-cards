/**
 * build — cards + facts + templates → dist/deck.json + dist/agentcore-flashcards.html
 *
 * Runs validate first and refuses to build on any error, so a broken card can
 * never reach an artifact.
 *
 * Determinism (NFR-3): cards sorted by card_id, object keys in a fixed order, no
 * build timestamp anywhere in the output. Two runs over the same inputs produce
 * byte-identical files, which is what lets the P3 publish step invalidate exactly
 * the chunks that changed.
 *
 * Usage: node src/build.ts [--skip-validate]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, paths, loadCards, loadCategories, loadArt, loadFactStore } from './lib/store.ts';
import { toLegacyShape, loadTemplateSource, compileTemplate, splitFaces, serialiseDeckLiteral } from './lib/render.ts';
import { hashPayload, sha256 } from './lib/hash.ts';
import type { Card } from './lib/types.ts';

const DECK_MARKER = '/*__DECK__*/';
const COUNT_MARKER = '@@COUNT@@';

function main(): void {
  if (!process.argv.includes('--skip-validate')) {
    try {
      const out = execFileSync(process.execPath, [join(ROOT, 'src', 'validate.ts')], { encoding: 'utf8' });
      const summary = out.trim().split('\n').at(-1);
      console.log(`validate: ${summary}`);
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      process.stderr.write(err.stdout ?? '');
      process.stderr.write(err.stderr ?? '');
      console.error('\nbuild aborted: validate failed');
      process.exit(1);
    }
  }

  const cards = loadCards().sort((a, b) => a.card_id.localeCompare(b.card_id));
  const categories = loadCategories();
  const art = loadArt();
  const store = loadFactStore();

  const templateSource = loadTemplateSource(ROOT);
  const renderFace = compileTemplate(templateSource);
  const catLabels = categories.map((c) => c.label);

  const legacyShaped = cards.map((c) => toLegacyShape(c, categories));

  mkdirSync(paths.dist, { recursive: true });

  // ---- deck.json -------------------------------------------------------------
  const deckCards = cards.map((card, i) => {
    const shell = renderFace(legacyShaped[i], false, catLabels, art);
    const faces = splitFaces(shell);
    return {
      card_id: card.card_id,
      kind: card.kind,
      lifecycle: card.lifecycle,
      service: card.service,
      category: card.category,
      tags: card.tags,
      badge: { variant: card.badge_variant, text: card.badge_text },
      art: card.art,
      title: card.title,
      hook: card.hook,
      back: card.back,
      // Slots are published resolved, plus their provenance state, so the P3
      // frontend can show a learner which claims are verified (FR-11).
      slots: Object.fromEntries(
        Object.entries(card.slots).map(([n, s]) => [
          n,
          {
            rendered: s.rendered,
            rendered_from: s.rendered_from,
            tier: s.tier,
            facts: s.facts,
            ...(s.unresolvable_reason ? { unresolvable_reason: s.unresolvable_reason } : {}),
          },
        ]),
      ),
      facts_used: card.facts_used,
      sources: card.sources,
      verified_at: card.verified_at,
      confidence: card.confidence,
      depends_on: card.depends_on,
      aka: card.aka,
      superseded_by: card.superseded_by,
      supersedes: card.supersedes,
      needs_review: card.needs_review,
      review_reasons: card.review_reasons,
      faces,
    };
  });

  const factSets = store.setsFor(store.ids()).map((s) => ({
    fact_set_id: s.fact_set_id,
    verified_at: s.verified_at,
    source: { kind: s.source.kind, url: s.source.url, fetched_at: s.source.fetched_at, content_hash: s.source.content_hash },
  }));

  const deck = {
    schema_version: 1,
    generated_from: {
      cards: cards.length,
      cards_hash: hashPayload(cards),
      template_hash: sha256(templateSource),
    },
    categories,
    fact_sets: factSets,
    cards: deckCards,
  };
  const deckJson = JSON.stringify(deck, null, 2) + '\n';
  writeFileSync(join(paths.dist, 'deck.json'), deckJson, 'utf8');

  // ---- single-file HTML ------------------------------------------------------
  // The shell is the legacy file with only the DECK literal and the card count
  // templated out. Reusing it verbatim is what guarantees identical CSS,
  // pictograms, state machine, keyboard handling and reduced-motion behaviour:
  // there is no second implementation that could drift.
  const shellHtml = readFileSync(join(paths.content, 'shell.html'), 'utf8');
  if (!shellHtml.includes(DECK_MARKER)) throw new Error(`shell.html is missing ${DECK_MARKER}`);
  const html = shellHtml
    .replace(DECK_MARKER, serialiseDeckLiteral(legacyShaped))
    .split(COUNT_MARKER)
    .join(String(cards.length));
  writeFileSync(join(paths.dist, 'agentcore-flashcards.html'), html, 'utf8');

  const seedSlots = cards.flatMap((c: Card) =>
    Object.entries(c.slots).filter(([, s]) => s.rendered_from === 'seed').map(([n]) => `${c.card_id}.${n}`),
  );

  console.log(`build: ${cards.length} cards → dist/deck.json (${deckJson.length} B), dist/agentcore-flashcards.html (${html.length} B)`);
  console.log(`build: ${factSets.length} fact set(s) referenced · ${seedSlots.length} slot(s) still on seed values`);
  if (seedSlots.length) console.log(`       seed slots: ${seedSlots.join(', ')}`);
}

main();
