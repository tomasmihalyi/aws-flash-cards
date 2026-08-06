/**
 * verify-parity — the FR-5 gate.
 *
 * "Looks the same" is exactly the assurance that fails silently, so this gate is
 * string and hash comparisons with no visual judgement.
 *
 * The invariant it enforces is not "the deck never changes" — the whole point of
 * the system is that the deck changes when AWS does. It is the stronger and more
 * useful claim:
 *
 *     The deck is byte-identical to the original hand-authored deck EXCEPT
 *     where a deterministic source corrected a fact-governed slot.
 *
 * So every card is projected twice: once as it renders now, and once with every
 * slot forced back to its `seed_text`. The seed projection must match the legacy
 * deck exactly — any difference there is unexplained drift and fails the gate.
 * The live projection is then reported as corrections, which are expected.
 *
 * Checks:
 *   1. SEED DATA   seed-projected cards deep-equal the legacy DECK literal
 *   2. TEMPLATE    committed template source byte-identical to the legacy file's
 *   3. SEED RENDER the legacy template over legacy data and over seed-projected
 *                  data produces identical HTML, every card, both faces
 *   4. SHELL       generated HTML with its DECK literal swapped for the legacy one
 *                  is byte-identical to the legacy file — proving the CSS,
 *                  pictograms, state machine, keyboard handling and reduced-motion
 *                  rules are the same code, not an equivalent reimplementation
 *   5. ASSETS      CSS and pictogram library hashes
 *
 * Usage: node src/verify-parity.ts [--baseline] [--verbatim]
 *   --baseline  on pass, write the output to tests/fixtures/p1-parity-baseline/
 *   --verbatim  additionally require ZERO corrections (the P1 exit condition)
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, paths, loadCards, loadCategories, loadArt } from './lib/store.ts';
import { loadLegacy, deckLiteralBounds } from './lib/legacy.ts';
import { toLegacyShape, loadTemplateSource, compileTemplate, splitFaces, type LegacyShaped } from './lib/render.ts';
import { canonical, sha256 } from './lib/hash.ts';
import type { Card } from './lib/types.ts';

const writeBaseline = process.argv.includes('--baseline');
const verbatim = process.argv.includes('--verbatim');
const failures: string[] = [];
const checks: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) checks.push(`PASS  ${name}`);
  else failures.push(`FAIL  ${name}${detail ? '\n      ' + detail : ''}`);
}

/** A copy of the card with every slot reverted to the text the deck shipped with. */
function seedProjection(card: Card): Card {
  const clone = JSON.parse(JSON.stringify(card)) as Card;
  for (const slot of Object.values(clone.slots)) slot.rendered = slot.seed_text;
  return clone;
}

function main(): void {
  const legacy = loadLegacy(paths.legacyHtml);
  const cards = loadCards().sort((a, b) => a.card_id.localeCompare(b.card_id));
  const categories = loadCategories();
  const art = loadArt();
  const catLabels = categories.map((c) => c.label);

  const generatedPath = join(paths.dist, 'agentcore-flashcards.html');
  if (!existsSync(generatedPath)) {
    console.error('verify-parity: dist/agentcore-flashcards.html not found — run node src/build.ts first');
    process.exit(1);
  }
  const generated = readFileSync(generatedPath, 'utf8');

  check('data: card count', cards.length === legacy.DECK.length, `new ${cards.length} vs legacy ${legacy.DECK.length}`);

  const live: LegacyShaped[] = cards.map((c) => toLegacyShape(c, categories));
  const seeded: LegacyShaped[] = cards.map((c) => toLegacyShape(seedProjection(c), categories));

  // ---- 1. SEED DATA: unexplained drift is a failure -------------------------
  let unexplained = 0;
  for (let i = 0; i < Math.min(seeded.length, legacy.DECK.length); i++) {
    if (canonical(seeded[i]) !== canonical(legacy.DECK[i])) {
      unexplained++;
      failures.push(
        `FAIL  data: card ${legacy.DECK[i].id} differs from the original in text no fact-governed slot explains\n${firstDiff(seeded[i], legacy.DECK[i])}`,
      );
    }
  }
  check(`data: all ${legacy.DECK.length} cards identical to the original once slots are reverted to seed text`, unexplained === 0);

  // Corrections are expected, not failures — but they are itemised so a reader
  // can see exactly which claims the pipeline changed and why.
  const corrected: { id: string; slot: string; before: string; after: string }[] = [];
  for (const card of cards) {
    for (const [name, slot] of Object.entries(card.slots)) {
      if (slot.rendered !== slot.seed_text) {
        corrected.push({ id: card.card_id, slot: name, before: slot.seed_text, after: slot.rendered });
      }
    }
  }

  // ---- 2. TEMPLATE ----------------------------------------------------------
  const committedTemplate = loadTemplateSource(ROOT);
  check(
    'template: committed source byte-identical to the legacy file',
    committedTemplate === legacy.templateSource,
    `committed ${sha256(committedTemplate)} vs legacy ${sha256(legacy.templateSource)}`,
  );

  // ---- 3. SEED RENDER -------------------------------------------------------
  const renderLegacy = compileTemplate(legacy.templateSource);
  const renderNew = compileTemplate(committedTemplate);
  let faceMismatches = 0;
  let facesCompared = 0;
  for (let i = 0; i < Math.min(seeded.length, legacy.DECK.length); i++) {
    for (const flipped of [false, true]) {
      const a = splitFaces(renderLegacy(legacy.DECK[i], flipped, legacy.CAT, legacy.ART));
      const b = splitFaces(renderNew(seeded[i], flipped, catLabels, art));
      for (const face of ['front', 'back'] as const) {
        facesCompared++;
        if (a[face] !== b[face]) {
          faceMismatches++;
          failures.push(
            `FAIL  render: ${legacy.DECK[i].id} ${face} face (flipped=${flipped})\n      legacy: ${a[face].slice(0, 160)}\n      new:    ${b[face].slice(0, 160)}`,
          );
        }
      }
    }
  }
  check(`render: ${facesCompared} face renders identical (seed projection)`, faceMismatches === 0);

  // ---- 4. SHELL -------------------------------------------------------------
  const genBounds = deckLiteralBounds(generated);
  const legBounds = deckLiteralBounds(legacy.raw);
  const respliced =
    generated.slice(0, genBounds.start) + legacy.raw.slice(legBounds.start, legBounds.end) + generated.slice(genBounds.end);
  check(
    'shell: generated file identical to legacy outside the DECK literal',
    respliced === legacy.raw,
    respliced === legacy.raw ? '' : firstTextDiff(legacy.raw, respliced),
  );

  // ---- 5. ASSETS ------------------------------------------------------------
  const genView = assetsOf(generated);
  check('assets: CSS byte-identical', sha256(genView.cssSource) === sha256(legacy.cssSource));
  check('assets: pictogram library byte-identical', sha256(genView.artSource) === sha256(legacy.artSource));

  // ---- live render sanity: the built HTML must contain what the cards claim --
  let liveEmbedMismatches = 0;
  const genDeckLiteral = generated.slice(genBounds.start, genBounds.end);
  for (const d of live) {
    if (!genDeckLiteral.includes(JSON.stringify(d.back.lead))) liveEmbedMismatches++;
  }
  check('embed: every card\u2019s current lead text present in the generated DECK literal', liveEmbedMismatches === 0, `${liveEmbedMismatches} missing`);

  if (verbatim && corrected.length) {
    failures.push(`FAIL  --verbatim: ${corrected.length} slot(s) have been corrected away from the original text`);
  }

  report(legacy.DECK.length, facesCompared, generated, corrected);
}

function assetsOf(raw: string): { cssSource: string; artSource: string } {
  const sOpen = raw.indexOf('<style>');
  const sClose = raw.indexOf('</style>');
  const aStart = raw.indexOf('const ART = {');
  const aEnd = raw.indexOf('\n};', aStart);
  if (sOpen < 0 || sClose < 0 || aStart < 0 || aEnd < 0) throw new Error('generated file: style/ART blocks not found');
  return { cssSource: raw.slice(sOpen + '<style>'.length, sClose), artSource: raw.slice(aStart, aEnd + '\n};'.length) };
}

function firstDiff(a: unknown, b: unknown): string {
  const sa = JSON.stringify(a, null, 1).split('\n');
  const sb = JSON.stringify(b, null, 1).split('\n');
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    if (sa[i] !== sb[i]) return `      new:    ${sa[i] ?? '<end>'}\n      legacy: ${sb[i] ?? '<end>'}`;
  }
  return '';
}

function firstTextDiff(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return `first difference at byte ${i}:\n      legacy:    …${JSON.stringify(a.slice(Math.max(0, i - 40), i + 40))}\n      generated: …${JSON.stringify(b.slice(Math.max(0, i - 40), i + 40))}`;
    }
  }
  return `identical for ${n} bytes then lengths differ (legacy ${a.length}, generated ${b.length})`;
}

function report(
  cardCount: number,
  facesCompared: number,
  generated: string,
  corrected: { id: string; slot: string; before: string; after: string }[],
): void {
  for (const c of checks) console.log(c);
  for (const f of failures) console.error(f);

  if (corrected.length) {
    console.log(`\nDeterministic corrections since the original deck (${corrected.length}) — expected, not failures:`);
    for (const c of corrected) {
      console.log(`  ${c.id}.${c.slot}`);
      console.log(`    was: ${c.before}`);
      console.log(`    now: ${c.after}`);
    }
  }

  const ok = failures.length === 0;
  console.log(
    `\nverify-parity: ${ok ? 'PASS' : 'FAIL'} · ${cardCount} cards · ${facesCompared} face renders · ${checks.length} check(s) passed · ${failures.length} failed · ${corrected.length} deterministic correction(s)`,
  );

  if (ok && writeBaseline) {
    const dir = join(paths.tests, 'fixtures', 'p1-parity-baseline');
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(paths.dist, 'deck.json'), join(dir, 'deck.json'));
    writeFileSync(join(dir, 'agentcore-flashcards.html'), generated, 'utf8');
    writeFileSync(
      join(dir, 'README.md'),
      [
        '# P1 parity baseline',
        '',
        'The build output at the moment the FR-5 parity gate passed, **before** any',
        'Tier A ingest ran. Every slot here still renders its unverified `seed`',
        'literal, so this deck is byte-identical in card content to the original',
        'hand-authored `agentcore-flashcards.html`.',
        '',
        'It exists so the P2 correction has a committed "before" to be a diff',
        'against. Do not regenerate it after ingest — that would erase the evidence.',
        '',
        `Card content hash: ${sha256(readFileSync(join(paths.dist, 'deck.json'), 'utf8'))}`,
      ].join('\n') + '\n',
      'utf8',
    );
    console.log('verify-parity: baseline written to tests/fixtures/p1-parity-baseline/');
  }

  process.exit(ok ? 0 : 1);
}

main();
