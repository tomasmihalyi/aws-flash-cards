/**
 * build — cards + facts + templates → dist/deck.json + the single-file deck
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
import { ROOT, paths, DIST_HTML, loadCards, loadCategories, loadArt, loadFactStore } from './lib/store.ts';
import { toLegacyShape, loadTemplateSource, compileTemplate, splitFaces, serialiseDeckLiteral, formatDate } from './lib/render.ts';
import { hashPayload, sha256 } from './lib/hash.ts';
import type { Card } from './lib/types.ts';

const DECK_MARKER = '/*__DECK__*/';
const TEMPLATE_MARKER = '/*__TEMPLATE_FN__*/';
const SRS_MARKER = '/*__SRS__*/';
const CAT_MARKER = '/*__CAT__*/';
const COUNT_MARKER = '@@COUNT@@';
const META_MARKER = '@@META@@';
const FRESHNESS_MARKER = '@@FRESHNESS@@';

/**
 * Inline an ES module into the single-file HTML.
 *
 * The scheduler is authored once in src/lib/srs.js — imported by the tests,
 * inlined here for the browser. Stripping the `export` keywords is the whole
 * transform; there is no bundler and no second copy to drift.
 */
function inlineModule(source: string, label: string): string {
  const stripped = source.replace(/^export\s+(?=(function|const|let|class)\s)/gm, '');
  if (/^\s*(import|export)\s/m.test(stripped)) {
    throw new Error(`${label}: still contains import/export after stripping — it cannot be inlined`);
  }
  return `/* inlined from ${label} — single source of truth, shared with the tests */\n${stripped}`;
}

/**
 * The header used to hardcode "Content is current to mid-2026" and
 * "GA OCT 2025 / SYD REGION YES" — factual claims sitting outside the card
 * schema, which no slot governed and no ingest job could ever correct. A
 * self-maintaining deck with a hand-maintained "current to" line is not
 * self-maintaining. Every figure below is now derived from the cards or from a
 * deterministic fact set, and anything without a source is simply omitted
 * rather than guessed.
 */
function headerMeta(cards: Card[], store: ReturnType<typeof loadFactStore>): { meta: string; freshness: string } {
  const cells: string[] = [`<span>CARDS <b>${cards.length}</b></span>`];

  const regionCount = store.get('agentcore.regions.count');
  if (regionCount) cells.push(`<span>REGIONS <b>${String(regionCount.value.value)}</b></span>`);

  const syd = store.get('agentcore.regions.includes.ap-southeast-2');
  if (syd) cells.push(`<span>SYD REGION <b>${syd.value.value ? 'YES' : 'NO'}</b></span>`);

  const verifiedTimes = cards.map((c) => c.verified_at).filter((t): t is string => Boolean(t)).sort();
  if (verifiedTimes.length) cells.push(`<span>VERIFIED <b>${formatDate(verifiedTimes[0]).toUpperCase()}</b></span>`);

  const unverified = cards.flatMap((c) =>
    Object.values(c.slots).filter((s) => s.rendered_from === 'seed'),
  ).length;

  const freshness = verifiedTimes.length
    ? `Region and price figures are read from AWS APIs, not written by hand — last verified ${formatDate(verifiedTimes[0])}.` +
      (unverified
        ? ` ${unverified} claim${unverified > 1 ? 's' : ''} ${unverified > 1 ? 'have' : 'has'} no deterministic source and ${unverified > 1 ? 'are' : 'is'} marked unverified on ${unverified > 1 ? 'their cards' : 'its card'}.`
        : '')
    : 'Facts have not yet been verified against a deterministic source — run the Tier A ingest.';

  return { meta: cells.join(''), freshness };
}

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
  for (const m of [DECK_MARKER, TEMPLATE_MARKER, SRS_MARKER, CAT_MARKER, META_MARKER, FRESHNESS_MARKER]) {
    if (!shellHtml.includes(m)) throw new Error(`shell.html is missing ${m}`);
  }
  const { meta, freshness } = headerMeta(cards, store);
  // One template, two consumers: the runtime renderer in the page and the
  // pre-rendered faces in deck.json.
  const templateFn = `function renderCard(d,flipped,CAT,ART){return \`${templateSource}\`;}`;
  const srs = inlineModule(readFileSync(join(ROOT, 'src', 'lib', 'srs.js'), 'utf8'), 'src/lib/srs.js');
  const html = shellHtml
    .replace(DECK_MARKER, serialiseDeckLiteral(legacyShaped))
    .replace(TEMPLATE_MARKER, templateFn)
    .replace(SRS_MARKER, srs)
    // The category list is injected, not baked in. It was a literal in the shell
    // until a card landed in an appended category and CAT[index] came back
    // undefined, throwing inside the template and rendering nothing at all.
    .replace(CAT_MARKER, `const CAT = ${JSON.stringify(categories.map((c) => c.label))};`)
    .split(COUNT_MARKER).join(String(cards.length))
    .replace(META_MARKER, meta)
    .replace(FRESHNESS_MARKER, freshness);
  writeFileSync(paths.distHtml, html, 'utf8');

  const seedSlots = cards.flatMap((c: Card) =>
    Object.entries(c.slots).filter(([, s]) => s.rendered_from === 'seed').map(([n]) => `${c.card_id}.${n}`),
  );

  console.log(`build: ${cards.length} cards → dist/deck.json (${deckJson.length} B), dist/${DIST_HTML} (${html.length} B)`);
  console.log(`build: ${factSets.length} fact set(s) referenced · ${seedSlots.length} slot(s) still on seed values`);
  if (seedSlots.length) console.log(`       seed slots: ${seedSlots.join(', ')}`);
}

main();
