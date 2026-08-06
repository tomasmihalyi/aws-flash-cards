/**
 * Reads the legacy single-file SPA without executing its DOM code.
 *
 * The legacy content lives as JS object literals inside a <script> block. We
 * evaluate ONLY the data prefix of that block (the S() helper, ART, CAT, DECK)
 * in a node:vm sandbox with no DOM, no network and no filesystem. Nothing after
 * the data section runs, so there is no way for this to touch the outside world.
 *
 * This is the mechanism that makes the migration a mechanical extraction rather
 * than a transcription: no human or model retypes a card's text, so no card's
 * text can silently change.
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export type LegacyCard = {
  c: number;
  id: string;
  b: string;
  bt: string;
  art: string;
  t: string;
  hook: string;
  back: { lead: string; kv: [string, string][]; hookline: string };
};

export type LegacyData = {
  ART: Record<string, string>;
  CAT: string[];
  DECK: LegacyCard[];
  /** verbatim source of the card template literal (between the backticks) */
  templateSource: string;
  /** verbatim <style>…</style> inner text */
  cssSource: string;
  /** verbatim `const ART = {…};` source */
  artSource: string;
  /** the whole file */
  raw: string;
};

const DECK_START = 'const DECK = [';
const DATA_END_MARKER = '/* ---- state & render ---- */';
const TEMPLATE_START = 'stage.innerHTML=`';

function sliceScript(raw: string): string {
  const open = raw.indexOf('<script>');
  const close = raw.lastIndexOf('</script>');
  if (open < 0 || close < 0) throw new Error('legacy file: no <script> block found');
  return raw.slice(open + '<script>'.length, close);
}

/** Index just past the DECK array's closing `];` */
export function deckLiteralBounds(raw: string): { start: number; end: number } {
  const start = raw.indexOf(DECK_START);
  if (start < 0) throw new Error(`legacy file: "${DECK_START}" not found`);
  const close = raw.indexOf('\n];', start);
  if (close < 0) throw new Error('legacy file: DECK array closing "\\n];" not found');
  return { start, end: close + '\n];'.length };
}

export function loadLegacy(path: string): LegacyData {
  const raw = readFileSync(path, 'utf8');
  const script = sliceScript(raw);

  const dataEnd = script.indexOf(DATA_END_MARKER);
  if (dataEnd < 0) throw new Error(`legacy file: data/behaviour boundary "${DATA_END_MARKER}" not found`);
  const dataSection = script.slice(0, dataEnd);

  // No DOM, no require, no process, no network: the sandbox has nothing to reach.
  // `const` declarations stay lexically scoped to the script, so the values are
  // taken from the trailing expression's result rather than off the sandbox.
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  const evaluated = vm.runInContext(dataSection + '\n;({ART: ART, CAT: CAT, DECK: DECK});', sandbox, {
    timeout: 5000,
    displayErrors: true,
  }) as { ART: Record<string, string>; CAT: string[]; DECK: LegacyCard[] };

  const { ART, CAT, DECK } = evaluated;
  if (!ART || !CAT || !DECK) throw new Error('legacy file: ART/CAT/DECK not all present after evaluation');

  // Template literal source, verbatim.
  const tStart = script.indexOf(TEMPLATE_START);
  if (tStart < 0) throw new Error(`legacy file: "${TEMPLATE_START}" not found`);
  const tBodyStart = tStart + TEMPLATE_START.length;
  const tEnd = script.indexOf('`;', tBodyStart);
  if (tEnd < 0) throw new Error('legacy file: card template closing backtick not found');
  const templateSource = script.slice(tBodyStart, tEnd);

  // CSS, verbatim.
  const sOpen = raw.indexOf('<style>');
  const sClose = raw.indexOf('</style>');
  if (sOpen < 0 || sClose < 0) throw new Error('legacy file: no <style> block found');
  const cssSource = raw.slice(sOpen + '<style>'.length, sClose);

  // ART source, verbatim.
  const aStart = script.indexOf('const ART = {');
  const aEnd = script.indexOf('\n};', aStart);
  if (aStart < 0 || aEnd < 0) throw new Error('legacy file: ART object source not found');
  const artSource = script.slice(aStart, aEnd + '\n};'.length);

  return { ART, CAT, DECK, templateSource, cssSource, artSource, raw };
}
