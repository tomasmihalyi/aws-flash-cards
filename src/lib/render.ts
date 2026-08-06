/**
 * Rendering.
 *
 * The card template is not reimplemented here — it is loaded verbatim from
 * content/legacy-template.txt, which tools/extract-legacy.ts lifted out of the
 * original single-file SPA. Using the original template source (rather than a
 * hand-copied equivalent) is what makes FR-5 render parity a property of the
 * design instead of something to be re-checked by eye after every edit.
 *
 * The template expects the LEGACY card shape, so the projection below is the
 * single point where the new schema meets the old renderer. P3 replaces both.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Card, Category } from './types.ts';
import { expandSlots } from './facts.ts';

export type LegacyShaped = {
  c: number;
  id: string;
  b: string;
  bt: string;
  art: string;
  t: string;
  hook: string;
  back: { lead: string; kv: [string, string][]; hookline: string };
};

/**
 * Project a card to the legacy renderer's shape, expanding slots into prose.
 * This is also exactly what the parity gate compares against the legacy DECK.
 */
export function toLegacyShape(card: Card, categories: Category[]): LegacyShaped {
  const c = categories.findIndex((x) => x.id === card.category);
  if (c < 0) throw new Error(`card ${card.card_id}: unknown category "${card.category}"`);
  return {
    c,
    id: card.card_id,
    b: card.badge_variant,
    bt: card.badge_text,
    art: card.art,
    t: expandSlots(card.title, card),
    hook: expandSlots(card.hook, card),
    back: {
      lead: expandSlots(card.back.lead, card),
      kv: card.back.kv.map((r) => [expandSlots(r.k, card), expandSlots(r.v, card)] as [string, string]),
      hookline: expandSlots(card.back.hookline, card),
    },
  };
}

export function loadTemplateSource(root: string): string {
  return readFileSync(join(root, 'content', 'legacy-template.txt'), 'utf8');
}

export type FaceRenderer = (d: LegacyShaped, flipped: boolean, CAT: string[], ART: Record<string, string>) => string;

/**
 * Compile the extracted template source into a function. `new Function` over a
 * repo-local build input is the only way to execute the original template
 * without reimplementing it; the input is committed and hash-checked by the
 * parity gate, so it cannot drift.
 */
export function compileTemplate(templateSource: string): FaceRenderer {
  // eslint-disable-next-line no-new-func
  return new Function('d', 'flipped', 'CAT', 'ART', 'return `' + templateSource + '`') as FaceRenderer;
}

/** Split the rendered card shell into its front and back face HTML. */
export function splitFaces(html: string): { front: string; back: string } {
  const frontOpen = html.indexOf('<div class="face front">');
  const backOpen = html.indexOf('<div class="face back">');
  if (frontOpen < 0 || backOpen < 0) throw new Error('render: could not locate face boundaries');
  return {
    front: html.slice(frontOpen, backOpen).trimEnd(),
    back: html.slice(backOpen).replace(/<\/div>\s*$/, '').trimEnd(),
  };
}

/** Serialise a legacy-shaped deck as a JS array literal for the single-file HTML. */
export function serialiseDeckLiteral(cards: LegacyShaped[]): string {
  const rows = cards.map(
    (d) =>
      '{c:' +
      d.c +
      ',id:' +
      js(d.id) +
      ',b:' +
      js(d.b) +
      ',bt:' +
      js(d.bt) +
      ',art:' +
      js(d.art) +
      ',t:' +
      js(d.t) +
      ',hook:' +
      js(d.hook) +
      ',\nback:{lead:' +
      js(d.back.lead) +
      ',\nkv:[' +
      d.back.kv.map((r) => '[' + js(r[0]) + ',' + js(r[1]) + ']').join(',\n') +
      '],\nhookline:' +
      js(d.back.hookline) +
      '}}',
  );
  return 'const DECK = [\n' + rows.join(',\n\n') + '\n];';
}

/** JSON string quoting is valid JS string quoting for our content. */
function js(s: string): string {
  return JSON.stringify(s);
}
