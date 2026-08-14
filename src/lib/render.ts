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
import { sha256 } from './hash.ts';

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
  /** Taxonomy for tag filtering. */
  tags: string[];
  /** Stable URL slug. */
  slug: string;
  /** Every name this card has been known by — what makes a shared link survive a rename. */
  aliases: string[];
  /** Precomputed lowercase haystack, so search costs nothing at runtime. */
  search: string;
  /**
   * Hash of the learnable content. Spaced repetition stores this at review time
   * and compares it later: if a Tier A ingest has since corrected a price or a
   * region count, the learner's memory of this card is stale and it must be
   * resurfaced regardless of its interval.
   */
  chash: string;
  /**
   * Card ids this card builds on.
   *
   * Needed on the CLIENT, not just in the repo: when a deterministic source
   * corrects a card, the cards that depend on it are not wrong, but the ground
   * under them has moved — and the learner has no way to know that unless the
   * scheduler can see the edges.
   */
  deps: string[];
};

/**
 * The authored-content subset — what the migration must have preserved exactly.
 *
 * `deps` is excluded along with the other derived fields. It is structure rather
 * than something a learner reads, and folding it into the content hash would
 * change the hash of every card that has dependencies — invalidating existing
 * review history to record a fact about the graph, not about the card's text.
 */
export type AuthoredText = Omit<LegacyShaped, 'prov' | 'tags' | 'slug' | 'aliases' | 'search' | 'chash' | 'deps'>;

export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Project a card to the renderer's shape, expanding slots into prose.
 */
export function toLegacyShape(card: Card, categories: Category[]): LegacyShaped {
  const text = authoredText(card, categories);
  const aliases = card.aka.map((a) => a.name);
  const search = [
    text.id,
    text.t,
    text.hook,
    text.back.lead,
    text.back.hookline,
    ...text.back.kv.flatMap((r) => r),
    ...card.tags,
    ...aliases,
    card.service,
    card.kind,
    card.lifecycle,
  ]
    .join(' \u00b7 ')
    .toLowerCase();

  return {
    ...text,
    prov: provenanceLine(card),
    tags: card.tags,
    slug: slugify(card.card_id),
    aliases,
    search,
    chash: contentHash(text),
    deps: [...card.depends_on].sort(),
  };
}

/**
 * Hash of everything a learner actually memorises.
 *
 * Front-face title and hook are included alongside the whole back face, because
 * a Tier C edit to the framing is as much a reason to re-study as a Tier A
 * correction to a number. Presentation (badge, art, category) is excluded: a
 * pictogram change is not a reason to reset someone's schedule.
 *
 * Truncated to 16 hex chars — this detects change, it does not defend against an
 * adversary, and it is stored once per card in every learner's localStorage.
 */
export function contentHash(text: AuthoredText): string {
  const material = [
    text.t,
    text.hook,
    text.back.lead,
    ...text.back.kv.flatMap((r) => r),
    text.back.hookline,
  ].join('\u0000');
  return sha256(material).replace(/^sha256:/, '').slice(0, 16);
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
    parts.push(`<b>Verified against cited source</b> ${formatDate(card.verified_at)}`);
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

  /**
   * A card with no source and no verification would otherwise render an EMPTY
   * footer — indistinguishable from a card nobody has looked at. A positioning
   * card is legitimately unsourced, because no documentation page can settle a
   * judgement, but the learner has to be told that: the deck's silence would
   * otherwise read as endorsement.
   */
  if (!card.sources.length && !card.verified_at) {
    const why =
      card.kind === 'mental-model' || card.kind === 'practice'
        ? 'positioning and practice judgement \u2014 no deterministic source applies'
        : 'no source recorded for this card yet';
    parts.push(`<b>Unsourced</b> ${why}`);
  }

  if (card.needs_review) {
    parts.push('<b>Needs review</b> awaiting human sign-off');
  }

  if (!parts.length) return '';
  return parts.map((p) => `<span>${p}</span>`).join('');
}

/**
 * Shorten a source url to something readable in a card footer.
 *
 * Documentation pages get their page name, not just the host. AC-14 is the first
 * card to cite two different AWS docs pages — the release notes that recorded its
 * rename and the region matrix that corroborated it — and labelling both by
 * hostname rendered "docs.aws.amazon.com · docs.aws.amazon.com", which reads to a
 * learner like a bug. Deduplicating would have been worse: it hides a source that
 * the citation gate requires the card to carry.
 */
function sourceLabel(url: string): string {
  if (url.startsWith('ssm:')) return 'AWS global-infrastructure (SSM)';
  if (url.includes('api.pricing')) return 'AWS Price List API';
  if (url.startsWith('file://')) return 'botocore service model';
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (/(^|\.)docs\.aws\.amazon\.com$/.test(host)) {
      const page = u.pathname.split('/').filter(Boolean).pop()?.replace(/\.html?$/, '') ?? '';
      if (u.pathname.includes('/bedrock-agentcore/')) {
        if (page === 'release-notes') return 'Amazon Bedrock AgentCore release notes';
        if (page === 'agentcore-regions') return 'Amazon Bedrock AgentCore regional availability';
      }
      if (page) return `AWS docs: ${page}`;
    }
    return host;
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
      ',slug:' + js(d.slug) +
      ',tags:[' + d.tags.map(js).join(',') + ']' +
      ',aliases:[' + d.aliases.map(js).join(',') + ']' +
      ',search:' + js(d.search) +
      ',chash:' + js(d.chash) +
      ',deps:[' + d.deps.map(js).join(',') + ']' +
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
