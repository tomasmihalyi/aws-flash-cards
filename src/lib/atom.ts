/**
 * Atom feed parsing — shared by every vendor changelog ingest.
 *
 * WHY A DECLARED FEED RATHER THAN THE RENDERED PAGE
 *
 * `kiro.dev/changelog/` renders 8 entries per page behind client-side pagination,
 * so scraping it means either 8 entries or a crawl loop guessing at page counts.
 * `kiro.dev/changelog/feed.atom` is a declared interface carrying 25 entries with
 * explicit dates. A feed the vendor publishes for consumption is a far more stable
 * contract than markup they are free to restyle, and it costs one GET.
 *
 * NO XML DEPENDENCY
 *
 * This repo has zero dependencies on purpose, so there is no XML library. That is
 * an acceptable trade here and not elsewhere: an Atom feed is a flat list of
 * <entry> blocks with non-nested leaf elements, which a regex can read correctly.
 * The parser is deliberately strict — a feed whose shape has changed yields zero
 * entries, and every caller treats zero as "refuse to write" rather than as "no
 * news this week". A silent empty parse is the failure mode that matters, because
 * it looks exactly like a quiet week.
 */

/** One feed entry, with markup and entities already resolved to text. */
export type AtomEntry = {
  id: string;
  title: string;
  /** ISO date, day precision — feeds carry a timestamp, unlike AWS release notes */
  iso_date: string;
  iso_month: string;
  link: string;
  /** entry body as plain text, markup stripped */
  summary: string;
  /**
   * `<category term="...">` values as published by the feed.
   *
   * Kiro tags every entry IDE / CLI / Models / General. That is the vendor's own
   * classification, which beats parsing it back out of the title prefix — the
   * prefix is presentation and can be dropped in a redesign, the category is a
   * declared field.
   */
  categories: string[];
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Resolve XML/HTML entities, including the double-encoding Atom `type="html"` uses. */
export function decodeEntities(s: string): string {
  let out = s;
  // Two passes: Atom escapes the HTML body, so `&amp;lt;` is a real occurrence.
  for (let pass = 0; pass < 2; pass += 1) {
    out = out.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, code: string) => {
      if (code.startsWith('#x') || code.startsWith('#X')) {
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      }
      if (code.startsWith('#')) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
      const named = NAMED_ENTITIES[code.toLowerCase()];
      return named ?? whole;
    });
  }
  return out;
}

/** Strip HTML tags and collapse whitespace, after entity resolution. */
export function htmlToText(html: string): string {
  return unwrapCdata(decodeEntities(unwrapCdata(html)))
    // Block boundaries become spaces so "</li><li>" does not weld two items together.
    .replace(/<\/(?:p|li|h[1-6]|div|tr)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Remove CDATA wrappers.
 *
 * Kiro wraps every summary in CDATA, GitHub escapes its HTML instead — so both
 * forms occur and both must be handled. Run before AND after entity decoding: an
 * escaped `&lt;![CDATA[` only becomes recognisable once decoded.
 */
export function unwrapCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function firstTag(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? m[1] : null;
}

function firstAltLink(block: string): string {
  // Prefer rel="alternate"; fall back to the first href on a <link>.
  const alt = /<link[^>]*rel="alternate"[^>]*href="([^"]+)"/i.exec(block)
    ?? /<link[^>]*href="([^"]+)"[^>]*rel="alternate"/i.exec(block)
    ?? /<link[^>]*href="([^"]+)"/i.exec(block);
  return alt ? decodeEntities(alt[1]) : '';
}

/**
 * Parse an Atom feed into dated entries, newest first as published.
 *
 * `published` wins over `updated` when both exist: a changelog entry edited for
 * typos months later must keep the date it was announced, or a coverage report
 * would present an old feature as this week's news.
 */
export function parseAtom(xml: string): AtomEntry[] {
  const out: AtomEntry[] = [];
  const blocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  for (const block of blocks) {
    const rawTitle = firstTag(block, 'title');
    const stamp = firstTag(block, 'published') ?? firstTag(block, 'updated');
    if (!rawTitle || !stamp) continue;

    const title = htmlToText(rawTitle);
    const isoDate = stamp.trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) continue;
    if (!title) continue;

    const body = firstTag(block, 'content') ?? firstTag(block, 'summary') ?? '';
    const categories = [...block.matchAll(/<category[^>]*term="([^"]+)"/gi)].map((m) => decodeEntities(m[1]));
    out.push({
      id: (firstTag(block, 'id') ?? title).trim(),
      title,
      iso_date: isoDate,
      iso_month: isoDate.slice(0, 7),
      link: firstAltLink(block),
      summary: htmlToText(body).slice(0, 400),
      categories,
    });
  }
  return out;
}

/**
 * Collapse entries that are the same announcement published twice.
 *
 * Kiro's feed carries both "CLI: Expanded MCP OAuth Support" and
 * "CLI 2.12.1: Expanded MCP OAuth Support" on 2026-07-09 — one curated entry and
 * one per-build entry for the same release. Two occurrences is below the template
 * threshold, so frequency alone cannot catch it.
 *
 * Same normalised title on the same DAY is one announcement. Deliberately not
 * "same title, any date": a feature genuinely re-announced months later (preview
 * then GA) is two events and must stay two rows, since that is precisely the
 * lifecycle transition the deck cares about.
 *
 * The kept copy is the one WITHOUT a version in its title — the curated headline
 * reads as prose a card can be matched against, where "CLI 2.12.1: …" leads with
 * a build number.
 */
export function dedupeSameDay(entries: AtomEntry[]): AtomEntry[] {
  const best = new Map<string, AtomEntry>();
  const order: string[] = [];
  for (const e of entries) {
    const key = `${e.iso_date}|${normaliseTitle(e.title)}`;
    const held = best.get(key);
    if (!held) {
      best.set(key, e);
      order.push(key);
      continue;
    }
    const heldHasVersion = /\bv?\d+(?:\.\d+)+\b/.test(held.title);
    const thisHasVersion = /\bv?\d+(?:\.\d+)+\b/.test(e.title);
    // Prefer no version; then prefer the longer summary, which carries more evidence.
    if ((heldHasVersion && !thisHasVersion) || (heldHasVersion === thisHasVersion && e.summary.length > held.summary.length)) {
      best.set(key, e);
    }
  }
  return order.map((k) => best.get(k)!);
}

/**
 * Titles a feed repeats verbatim across many releases are a TEMPLATE, not news.
 *
 * Kiro's feed carries one entry per IDE build whose title is the same sentence
 * every time — "IDE 1.0.288: Agent Focus, Permissions, Custom Agents, and More"
 * appeared 10 times in 25 entries with only the version differing. Ten identical
 * headings in a coverage report is ten copies of one to-do that no card can ever
 * satisfy, because there is no subject in it.
 *
 * Detected by measurement rather than by a hard-coded string: strip version-like
 * tokens, then any normalised title occurring `minRepeats`+ times is a template.
 * A vendor who changes their boilerplate wording is still caught; a genuinely
 * recurring announcement ("Region expansion") needs only to appear under 3 times
 * to stay, which is the common case.
 */
export function templateTitles(titles: string[], minRepeats = 3): Set<string> {
  const counts = new Map<string, number>();
  for (const t of titles) {
    const key = normaliseTitle(t);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [key, n] of counts) {
    if (n >= minRepeats) out.add(key);
  }
  return out;
}

/** Title with version numbers removed, for template detection. */
export function normaliseTitle(title: string): string {
  return title
    .replace(/\bv?\d+(?:\.\d+)+\b/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*:\s*/g, ': ')
    .trim()
    .toLowerCase();
}
