/**
 * verify-parity — the FR-5 gate.
 *
 * "Looks the same" is exactly the assurance that fails silently, so this gate is
 * four string/hash comparisons and no visual judgement:
 *
 *   1. DATA     — new cards projected to the legacy shape deep-equal the legacy
 *                 DECK literal, field by field, string by string.
 *   2. TEMPLATE — the committed template source is byte-identical to the one
 *                 still embedded in the legacy file.
 *   3. RENDER   — the legacy template, evaluated over legacy data and over new
 *                 data, produces identical HTML for every card and both faces.
 *   4. SHELL    — the generated HTML with its DECK literal swapped back for the
 *                 legacy one is byte-identical to the legacy file. This proves
 *                 the CSS, pictograms, state machine, keyboard handling and
 *                 reduced-motion rules are not merely equivalent but the same.
 *
 * With --baseline, writes the passing output to tests/fixtures/p1-parity-baseline/
 * so the P2 correction has a committed "before" to be a diff against.
 *
 * Usage: node src/verify-parity.ts [--baseline]
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, paths, loadCards, loadCategories, loadArt } from './lib/store.ts';
import { loadLegacy, deckLiteralBounds } from './lib/legacy.ts';
import { toLegacyShape, loadTemplateSource, compileTemplate, splitFaces, type LegacyShaped } from './lib/render.ts';
import { canonical, sha256 } from './lib/hash.ts';

const writeBaseline = process.argv.includes('--baseline');
const failures: string[] = [];
const checks: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) checks.push(`PASS  ${name}`);
  else failures.push(`FAIL  ${name}${detail ? '\n      ' + detail : ''}`);
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

  // ---- 1. DATA ---------------------------------------------------------------
  check('data: card count', cards.length === legacy.DECK.length, `new ${cards.length} vs legacy ${legacy.DECK.length}`);

  const projected: LegacyShaped[] = cards.map((c) => toLegacyShape(c, categories));
  let dataMismatches = 0;
  for (let i = 0; i < Math.min(projected.length, legacy.DECK.length); i++) {
    const a = projected[i];
    const b = legacy.DECK[i];
    if (canonical(a) !== canonical(b)) {
      dataMismatches++;
      failures.push(`FAIL  data: card index ${i} (${b.id}) differs\n${firstDiff(a, b)}`);
    }
  }
  check(`data: all ${legacy.DECK.length} cards field-identical`, dataMismatches === 0);

  // ---- 2. TEMPLATE -----------------------------------------------------------
  const committedTemplate = loadTemplateSource(ROOT);
  check(
    'template: committed source byte-identical to the legacy file',
    committedTemplate === legacy.templateSource,
    `committed sha ${sha256(committedTemplate)} vs legacy sha ${sha256(legacy.templateSource)}`,
  );

  // ---- 3. RENDER -------------------------------------------------------------
  const renderLegacy = compileTemplate(legacy.templateSource);
  const renderNew = compileTemplate(committedTemplate);
  let faceMismatches = 0;
  let facesCompared = 0;
  for (let i = 0; i < Math.min(projected.length, legacy.DECK.length); i++) {
    for (const flipped of [false, true]) {
      const fromLegacy = splitFaces(renderLegacy(legacy.DECK[i], flipped, legacy.CAT, legacy.ART));
      const fromNew = splitFaces(renderNew(projected[i], flipped, catLabels, art));
      for (const face of ['front', 'back'] as const) {
        facesCompared++;
        if (fromLegacy[face] !== fromNew[face]) {
          faceMismatches++;
          failures.push(
            `FAIL  render: ${legacy.DECK[i].id} ${face} face (flipped=${flipped})\n      legacy: ${fromLegacy[face].slice(0, 160)}\n      new:    ${fromNew[face].slice(0, 160)}`,
          );
        }
      }
    }
  }
  check(`render: ${facesCompared} face renders identical`, faceMismatches === 0);

  // ---- 4. SHELL --------------------------------------------------------------
  // Splice the legacy DECK literal back into the generated file. If the result is
  // not byte-identical to the legacy file, something other than the card data
  // changed — which is exactly what this gate exists to catch.
  const genBounds = deckLiteralBounds(generated);
  const legBounds = deckLiteralBounds(legacy.raw);
  const legacyDeckLiteral = legacy.raw.slice(legBounds.start, legBounds.end);
  const respliced = generated.slice(0, genBounds.start) + legacyDeckLiteral + generated.slice(genBounds.end);
  check(
    'shell: generated file identical to legacy outside the DECK literal',
    respliced === legacy.raw,
    respliced === legacy.raw ? '' : firstTextDiff(legacy.raw, respliced),
  );

  // Asset hashes, reported explicitly so a regression names the asset.
  const genLegacyView = loadLegacyLike(generated);
  check('assets: CSS byte-identical', sha256(genLegacyView.cssSource) === sha256(legacy.cssSource));
  check('assets: pictogram library byte-identical', sha256(genLegacyView.artSource) === sha256(legacy.artSource));

  report(legacy.DECK.length, facesCompared, generated);
}

/** Re-read the CSS and ART source out of an in-memory HTML string. */
function loadLegacyLike(raw: string): { cssSource: string; artSource: string } {
  const sOpen = raw.indexOf('<style>');
  const sClose = raw.indexOf('</style>');
  const aStart = raw.indexOf('const ART = {');
  const aEnd = raw.indexOf('\n};', aStart);
  if (sOpen < 0 || sClose < 0 || aStart < 0 || aEnd < 0) throw new Error('generated file: style/ART blocks not found');
  return {
    cssSource: raw.slice(sOpen + '<style>'.length, sClose),
    artSource: raw.slice(aStart, aEnd + '\n};'.length),
  };
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

function report(cardCount: number, facesCompared: number, generated: string): void {
  for (const c of checks) console.log(c);
  for (const f of failures) console.error(f);
  const ok = failures.length === 0;
  console.log(
    `\nverify-parity: ${ok ? 'PASS' : 'FAIL'} · ${cardCount} cards · ${facesCompared} face renders · ${checks.length} check(s) passed · ${failures.length} failed`,
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
    console.log(`verify-parity: baseline written to tests/fixtures/p1-parity-baseline/`);
  }

  process.exit(ok ? 0 : 1);
}

main();
