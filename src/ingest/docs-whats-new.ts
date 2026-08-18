/**
 * Tier A ingest — AWS "What's New" announcements, filtered per in-scope service.
 *
 * WHY THIS EXISTS ALONGSIDE docs-release-notes.ts AND docs-doc-history.ts
 *
 * check-coverage.ts's own NEWS_KINDS admission test documents why not every
 * dated source is a content source: Bedrock's document-history page carries
 * 264+ entries, most of which are documentation reorganisation ("reordered
 * quickstart tabs"), not product news. Admitting it produced 261 false
 * "uncovered" gaps out of 366 — a report nobody reads.
 *
 * The global What's New feed (https://aws.amazon.com/about-aws/whats-new/recent/feed/)
 * passes that same test in the other direction: every item IS a discrete,
 * human-titled announcement ("Amazon Bedrock expands API support and
 * introduces Cross Region Inferencing for OpenAI models"), the same shape as
 * AgentCore's release notes and Kiro's changelog, just not curated per
 * product. It has no per-item AWS-service tag (`<category/>` is empty on
 * every item, confirmed by inspecting the raw feed on 2026-08-18), so the
 * only way to scope it to this deck's covered services is to filter the
 * title + permalink against a keyword list — the same mechanism the coverage
 * detector already uses to match a headline to a card's subject.
 *
 * ONE SERVICE PER FACT SET, ON PURPOSE
 *
 * serviceOfFactSet() in lib/verifier.ts derives a fact set's service from its
 * id PREFIX (`bedrock.whats-new` -> `bedrock`), because every existing source
 * is already single-service (AgentCore's release notes, Kiro's changelog).
 * The global feed mixes every AWS service in one response, so rather than
 * widen that function to carry a per-ENTRY service tag, this ingest filters
 * client-side and writes one fact set per in-scope service
 * (`bedrock.whats-new.json`, `quick.whats-new.json`, ...). Every downstream
 * consumer (datedEntriesFrom, check-coverage, verify-claims) then sees these
 * exactly like any other day-precision, per-service source — no changes
 * needed to the shared library.
 *
 * WHAT "IN SCOPE" MEANS HERE, AND WHY IT IS NOT EVERY SERVICE WITH A CARD
 *
 * The README states the deck's domain, and it is not uniform: AgentCore,
 * Bedrock, Strands and coding agents are covered comprehensively; Quick is
 * covered only for the business-vs-engineer BOUNDARY question, deliberately
 * narrower. A Quick feature-GA announcement (new M365 extensions, say) is
 * real Quick news but not a gap in what this deck promises to track, the
 * same way a new Bedrock model is real Bedrock news that IS a gap.
 *
 * That distinction lives in content/service-scope.json, not in code, so it
 * can be revised without touching the ingest or the detector. A service
 * marked "comprehensive" surfaces every matched entry as an actionable gap
 * when no card covers it; one marked "boundary" only surfaces an entry when
 * it topically matches the boundary question a card already stakes out
 * (checked downstream, in check-coverage's existing subject-matching, not
 * here — this ingest only decides IN vs OUT of the feed at all).
 *
 * Read-only, no credentials, no AWS resource touched, no AI in this path.
 *
 * Usage: node src/ingest/docs-whats-new.ts
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashPayload } from '../lib/hash.ts';
import { saveFactSet, loadFactSetFile, paths } from '../lib/store.ts';
import type { FactSet, FactValue } from '../lib/types.ts';

const GENERATOR = 'src/ingest/docs-whats-new.ts';
const FEED_URL = 'https://aws.amazon.com/about-aws/whats-new/recent/feed/';

export type WhatsNewEntry = {
  iso_date: string;
  iso_month: string;
  month_label: string;
  date_label: string;
  heading: string;
  summary: string;
  url: string;
};

type ServiceScope = { service: string; keywords: string[]; depth: 'comprehensive' | 'boundary'; note?: string };

function loadServiceScope(): ServiceScope[] {
  const p = join(paths.content, 'service-scope.json');
  if (!existsSync(p)) {
    console.error('docs-whats-new: content/service-scope.json is missing — refusing to guess which services are in scope');
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  if (!Array.isArray(raw?.services) || !raw.services.length) {
    console.error('docs-whats-new: content/service-scope.json has no services[] — refusing to write an empty scope');
    process.exit(1);
  }
  return raw.services as ServiceScope[];
}

/** Strip HTML, collapse whitespace, keep the human-readable summary text. */
function plain(html: string): string {
  return html
    // The feed sometimes double-encodes an entity (a literal "&nbsp;" inside
    // an already-escaped paragraph becomes "&amp;nbsp;"), so decode "&amp;"
    // FIRST -- otherwise "&amp;nbsp;" survives as literal text instead of
    // resolving to a space. Then decode the rest, then strip tags (which
    // only works once "&lt;p&gt;" has become "<p>").
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesService(title: string, url: string, keywords: string[]): boolean {
  const hay = `${title} ${url}`.toLowerCase();
  return keywords.some((k) => hay.includes(k.toLowerCase()));
}

/** Parse the RSS 2.0 <item> blocks the feed actually returns. */
function parseFeed(xml: string): WhatsNewEntry[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const out: WhatsNewEntry[] = [];
  for (const item of items) {
    const title = plain((item.match(/<title>([\s\S]*?)<\/title>/) ?? [, ''])[1]);
    const link = (item.match(/<link>([\s\S]*?)<\/link>/) ?? [, ''])[1].trim();
    const desc = plain((item.match(/<description>([\s\S]*?)<\/description>/) ?? [, ''])[1]);
    const pub = (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) ?? [, ''])[1].trim();
    if (!title || !link || !pub) continue;
    const d = new Date(pub);
    if (Number.isNaN(d.getTime())) continue;
    const iso_date = d.toISOString().slice(0, 10);
    const iso_month = iso_date.slice(0, 7);
    out.push({
      iso_date,
      iso_month,
      month_label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
      date_label: d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
      heading: title,
      summary: desc.slice(0, 400),
      url: link,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const scopes = loadServiceScope();

  console.log(`docs-whats-new: fetching ${FEED_URL} (public GET, no credentials)`);
  const res = await fetch(FEED_URL, { headers: { accept: 'application/rss+xml,text/xml,*/*' } });
  if (!res.ok) {
    console.error(`docs-whats-new: HTTP ${res.status} — refusing to write a fact set from a failed fetch`);
    process.exit(1);
  }
  const xml = await res.text();
  if (xml.length < 2000) {
    console.error(`docs-whats-new: response was only ${xml.length} bytes — looks like a redirect stub, not a feed`);
    process.exit(1);
  }

  const allEntries = parseFeed(xml);
  if (allEntries.length < 10) {
    // A parse that silently yields little would quietly narrow the deck's
    // evidence base instead of failing loudly.
    console.error(`docs-whats-new: parsed only ${allEntries.length} entries — the feed format may have changed. Refusing to write.`);
    process.exit(1);
  }

  const fetchedAt = new Date().toISOString();
  let anyWritten = false;

  for (const scope of scopes) {
    const entries = allEntries.filter((e) => matchesService(e.heading, e.url, scope.keywords));
    const fileName = `${scope.service}.whats-new.json`;

    if (!entries.length) {
      console.log(`docs-whats-new: ${scope.service} — 0 matching entries in this window, leaving prior fact set untouched`);
      continue;
    }

    const dates = entries.map((e) => e.iso_date).sort();
    const contentHash = hashPayload(entries);
    const previous = loadFactSetFile(fileName);
    const prevCount = previous?.facts[`${scope.service}.whats-new.entry-count`]?.value as number | undefined;

    const facts: Record<string, FactValue> = {
      [`${scope.service}.whats-new.entry-count`]: {
        type: 'integer',
        value: entries.length,
        note: `Dated ${scope.service} announcements matched from the AWS What's New feed in the fetched window.`,
      },
      [`${scope.service}.whats-new.earliest-date`]: { type: 'string', value: dates[0] },
      [`${scope.service}.whats-new.latest-date`]: { type: 'string', value: dates[dates.length - 1] },
      [`${scope.service}.whats-new.precision`]: {
        type: 'string',
        value: 'day',
        note: 'Each entry carries the day it was posted and its own permalink.',
      },
    };

    const set: FactSet = {
      schema_version: 1,
      fact_set_id: `${scope.service}.whats-new`,
      tier: 'A',
      generator: GENERATOR,
      verified_at: fetchedAt,
      source: {
        kind: 'aws-docs-doc-history', // day-precision, per-item — identical shape to the doc-history kind
        url: FEED_URL,
        fetched_at: fetchedAt,
        content_hash: contentHash,
        retrieved_by: `GET ${FEED_URL}`,
      },
      evidence: {
        canonical: entries,
        text: entries.map((e) => `${e.date_label} — ${e.heading}: ${e.summary}`).join('\n'),
      },
      facts,
      ...(prevCount !== undefined ? { previous: { 'entry-count': prevCount } } : {}),
    };

    mkdirSync(paths.facts, { recursive: true });
    saveFactSet(fileName, set);
    anyWritten = true;

    const state = prevCount === undefined ? 'first observation' : prevCount === entries.length ? 'unchanged' : `CHANGED from ${prevCount}`;
    console.log(`docs-whats-new: ${scope.service} (${scope.depth}) — ${entries.length} entries (${dates[0]} → ${dates[dates.length - 1]}) · ${state}`);
    console.log(`docs-whats-new: wrote facts/${fileName} (${contentHash})`);
  }

  if (!anyWritten) {
    console.error('docs-whats-new: no in-scope service matched anything in this window — nothing written');
    process.exit(1);
  }
  console.log("docs-whats-new: precision is DAY — but a date match alone is not attestation; the verifier also requires topical relatedness");
}

main().catch((err) => {
  console.error(`docs-whats-new: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
