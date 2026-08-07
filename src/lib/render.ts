/**
 * Rendering.
 *
 * The card template lives in content/card-template.html. It started as the
 * verbatim template lifted out of the original single-file SPA, and is now ours
 * to evolve — the byte-for-byte DOM parity gate that used to pin it has been
 * replaced by the behavioural tests in tests/deck-state.test.ts, so markup can
 * improve without the guarantee weakening.
 *
 * The template still consumes the LEGACY card shape. That projection is the
 * single point where the new schema meets the renderer.
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
  /** Provenance footer HTML for the back face. Presentation, not authored content. */
  prov: string;
};

/** The authored-content subset — what the migration must have preserved exactly. */
export type AuthoredText = Omit<LegacyShaped, 'prov'>;

/**
 * Project a card to the renderer's shape, expanding slots into prose.
 */
export function toLegacyShape(card: Card, categories: Category[]): LegacyShaped {
  return { ...authoredText(card, categories), prov: provenanceLine(card) };
}

/**
 * Authored text only — no derived provenance. This is what the content-parity
 * check compares against the original deck, because provenance is something the
 * pipeline adds, not something the original author wrote.
 */
export function authoredText(card: Card, categories: Category[]): AuthoredText {
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

/**
 * The provenance footer a learner sees (FR-11).
 *
 * A deck whose entire premise is "every factual claim carries a source" has to
 * actually show the source. Equally important: a card with an unverified claim
 * says so, rather than looking identical to a verified one.
 */
export function provenanceLine(card: Card): string {
  const parts: string[] = [];

  if (card.verified_at) {
    parts.push(`<b>Verified</b> ${formatDate(card.verified_at)}`);
  }

  const seeds = Object.entries(card.slots).filter(([, s]) => s.rendered_from === 'seed');
  if (seeds.length) {
    const why = seeds.find(([, s]) => s.unresolvable_reason)
      ? 'no deterministic source exists for this claim'
      : 'not yet checked against a source';
    parts.push(`<b>Unverified</b> ${seeds.length} claim${seeds.length > 1 ? 's' : ''} — ${why}`);
  }

  if (card.sources.length) {
    const links = card.sources.map((s) => {
      const label = escapeHtml(sourceLabel(s.url));
      return s.url.startsWith('http')
        ? `<a href="${escapeHtml(s.url)}" rel="noopener noreferrer" target="_blank">${label}</a>`
        : label;
    });
    parts.push(`<b>Source</b> ${links.join(' · ')}`);
  }

  if (!parts.length) return '';
  return parts.map((p) => `<span>${p}</span>`).join('');
}

/** Shorten a source url to something readable in a card footer. */
function sourceLabel(url: string): string {
  if (url.startsWith('ssm:')) return 'AWS global-infrastructure (SSM)';
  if (url.includes('api.pricing')) return 'AWS Price List API';
  if (url.startsWith('file://')) return 'botocore service model';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 48);
  }
}

/** "2026-08-06T…" → "6 Aug 2026". Fixed locale so the build stays deterministic. */
export function formatDate(iso: string): string {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function loadTemplateSource(root: string): string {
  return readFileSync(join(root, 'content', 'card-template.html'), 'utf8');
}

export type FaceRenderer = (d: LegacyShaped, flipped: boolean, CAT: string[], ART: Record<string, string>) => string;

/**
 * Compile the template source into a function. `new Function` over a committed,
 * repo-local build input is how the template stays a single source of truth for
 * both the build and the shipped HTML instead of being written twice.
 */
export function compileTemplate(templateSource: string): FaceRenderer {
  return new Function('d', 'flipped', 'CAT', 'ART', 'return `' + templateSource + '`') as FaceRenderer;
}

/** Split the rendered card shell into its front and back face HTML. */
export function splitFaces(html: string): { front: string; back: string } {
  const frontOpen = html.indexOf('<div class="face front"');
  const backOpen = html.indexOf('<div class="face back"');
  if (frontOpen < 0 || backOpen < 0) throw new Error('render: could not locate face boundaries');
  return {
    front: html.slice(frontOpen, backOpen).trimEnd(),
    back: html.slice(backOpen).replace(/<\/div>\s*$/, '').trimEnd(),
  };
}

/** Serialise the deck as a JS array literal for the single-file HTML. */
export function serialiseDeckLiteral(cards: LegacyShaped[]): string {
  const rows = cards.map(
    (d) =>
      '{c:' + d.c +
      ',id:' + js(d.id) +
      ',b:' + js(d.b) +
      ',bt:' + js(d.bt) +
      ',art:' + js(d.art) +
      ',t:' + js(d.t) +
      ',hook:' + js(d.hook) +
      ',prov:' + js(d.prov) +
      ',\nback:{lead:' + js(d.back.lead) +
      ',\nkv:[' + d.back.kv.map((r) => '[' + js(r[0]) + ',' + js(r[1]) + ']').join(',\n') +
      '],\nhookline:' + js(d.back.hookline) +
      '}}',
  );
  return 'const DECK = [\n' + rows.join(',\n\n') + '\n];';
}

function js(s: string): string {
  return JSON.stringify(s);
}
