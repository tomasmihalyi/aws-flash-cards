/**
 * Tests for Atom feed ingest and cross-product coverage scoping.
 *
 * Two of these pin defects that were found by reading real output, not by reading
 * code, and neither could have appeared while the deck had a single news source:
 *
 *  - a per-build title repeated verbatim across releases is a template, not news
 *  - a Kiro entry must not be "covered" by an AgentCore card sharing one noun
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAtom,
  htmlToText,
  decodeEntities,
  unwrapCdata,
  templateTitles,
  normaliseTitle,
  dedupeSameDay,
  type AtomEntry,
} from '../src/lib/atom.ts';
import { toAnnouncements } from '../src/ingest/kiro-changelog.ts';
import { splitTag, toReleaseRows } from '../src/ingest/github-releases.ts';
import { detectCoverage } from '../src/lib/coverage.ts';
import { serviceOfFactSet, type DatedEntry } from '../src/lib/verifier.ts';
import type { Card } from '../src/lib/types.ts';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Kiro Changelog</title>
  <entry>
    <title>IDE: Agent Plugin Support and Session Pinning</title>
    <link href="https://kiro.dev/changelog/ide/1-0-288" />
    <id>https://kiro.dev/changelog/ide/1-0-288</id>
    <published>2026-08-07T00:00:00.000Z</published>
    <updated>2026-08-09T00:00:00.000Z</updated>
    <category term="IDE" />
    <summary type="html"><![CDATA[This version supports Powers packaged in the <b>open Agent Plugin</b> format.]]></summary>
  </entry>
  <entry>
    <title>IDE 1.0.288: Agent Focus, Permissions, Custom Agents, and More</title>
    <link href="https://kiro.dev/changelog/ide/1-0-288-b" />
    <id>b</id>
    <published>2026-08-06T00:00:00.000Z</published>
    <category term="IDE" />
    <summary type="html"><![CDATA[Boilerplate.]]></summary>
  </entry>
  <entry>
    <title>IDE 1.0.242: Agent Focus, Permissions, Custom Agents, and More</title>
    <link href="c" /><id>c</id>
    <published>2026-07-28T00:00:00.000Z</published>
    <category term="IDE" />
    <summary type="html"><![CDATA[Boilerplate.]]></summary>
  </entry>
  <entry>
    <title>IDE 1.0.212: Agent Focus, Permissions, Custom Agents, and More</title>
    <link href="d" /><id>d</id>
    <published>2026-07-23T00:00:00.000Z</published>
    <category term="IDE" />
    <summary type="html"><![CDATA[Boilerplate.]]></summary>
  </entry>
  <entry>
    <title>CLI: Expanded MCP OAuth Support</title>
    <link href="e" /><id>e</id>
    <published>2026-07-09T00:00:00.000Z</published>
    <category term="CLI" />
    <summary type="html"><![CDATA[MCP OAuth now supports servers with strict requirements, like Figma. Longer body.]]></summary>
  </entry>
  <entry>
    <title>CLI 2.12.1: Expanded MCP OAuth Support</title>
    <link href="f" /><id>f</id>
    <published>2026-07-09T00:00:00.000Z</published>
    <category term="CLI" />
    <summary type="html"><![CDATA[Short.]]></summary>
  </entry>
</feed>`;

function card(over: Partial<Card>): Card {
  return {
    schema_version: 1,
    card_id: 'X-01',
    slug: 'x',
    kind: 'service-fact',
    lifecycle: 'ga',
    service: 'bedrock-agentcore',
    category: 'foundations',
    title: 'Thing',
    tags: [],
    front: { question: 'q' },
    back: { lead: 'l' },
    ...(over as object),
  } as Card;
}

function entry(over: Partial<DatedEntry>): DatedEntry {
  return {
    iso_month: '2026-07',
    month_label: 'July 2026',
    iso_date: '2026-07-09',
    precision: 'day',
    heading: 'h',
    summary: '',
    url: 'https://example.test/',
    service: null,
    ...over,
  };
}

describe('atom parsing', () => {
  test('entries are parsed with day precision, category and permalink', () => {
    const e = parseAtom(FEED);
    assert.equal(e.length, 6);
    assert.equal(e[0].title, 'IDE: Agent Plugin Support and Session Pinning');
    assert.equal(e[0].iso_date, '2026-08-07');
    assert.equal(e[0].iso_month, '2026-08');
    assert.deepEqual(e[0].categories, ['IDE']);
    assert.equal(e[0].link, 'https://kiro.dev/changelog/ide/1-0-288');
  });

  test('published wins over updated — an entry edited later keeps its announcement date', () => {
    // The first entry carries published 2026-08-07 and updated 2026-08-09. Taking
    // `updated` would present an old announcement as this week's news.
    assert.equal(parseAtom(FEED)[0].iso_date, '2026-08-07');
  });

  test('CDATA is unwrapped and markup stripped from the summary', () => {
    const e = parseAtom(FEED)[0];
    assert.ok(e.summary.includes('open Agent Plugin'));
    assert.ok(!e.summary.includes('CDATA'));
    assert.ok(!e.summary.includes('<b>'));
    assert.ok(!e.summary.includes(']]>'));
  });

  test('a feed whose shape has changed yields zero entries rather than junk', () => {
    // Every caller treats zero as "refuse to write", because a silent empty parse
    // is indistinguishable from a quiet week.
    assert.equal(parseAtom('<html><body>not a feed</body></html>').length, 0);
    assert.equal(parseAtom('').length, 0);
  });

  test('an entry with no date is skipped, not dated to today', () => {
    const xml = '<feed><entry><title>No date</title></entry></feed>';
    assert.equal(parseAtom(xml).length, 0);
  });

  test('double-encoded entities resolve — Atom escapes an HTML body', () => {
    assert.equal(decodeEntities('&amp;lt;p&amp;gt;'), '<p>');
    assert.equal(htmlToText('&lt;p&gt;a &amp;amp; b&lt;/p&gt;'), 'a & b');
  });

  test('block boundaries become spaces so list items do not weld together', () => {
    assert.equal(htmlToText('<ul><li>one</li><li>two</li></ul>'), 'one two');
  });

  test('unwrapCdata handles the escaped form GitHub uses as well as the raw one', () => {
    assert.equal(unwrapCdata('<![CDATA[x]]>'), 'x');
    assert.equal(htmlToText('&lt;![CDATA[x]]&gt;'), 'x');
  });
});

describe('template and duplicate noise', () => {
  test('a title repeated across releases is a template, detected by frequency not by a literal', () => {
    const titles = [
      'IDE 1.0.288: Agent Focus, Permissions, Custom Agents, and More',
      'IDE 1.0.242: Agent Focus, Permissions, Custom Agents, and More',
      'IDE 1.0.212: Agent Focus, Permissions, Custom Agents, and More',
      'IDE: Agent Plugin Support and Session Pinning',
    ];
    const t = templateTitles(titles);
    assert.equal(t.size, 1);
    assert.ok(t.has(normaliseTitle(titles[0])));
    assert.ok(!t.has(normaliseTitle(titles[3])));
  });

  test('two occurrences are NOT a template — a genuinely repeated announcement survives', () => {
    assert.equal(templateTitles(['Region expansion', 'Region expansion']).size, 0);
  });

  test('normalisation strips versions so a reworded template is still caught', () => {
    assert.equal(normaliseTitle('CLI 2.12.1: Expanded MCP OAuth Support'), 'cli: expanded mcp oauth support');
    assert.equal(normaliseTitle('CLI: Expanded MCP OAuth Support'), 'cli: expanded mcp oauth support');
  });

  test('same-day duplicates collapse, keeping the copy without a version', () => {
    const raw = parseAtom(FEED);
    const both = raw.filter((e) => e.title.includes('OAuth'));
    assert.equal(both.length, 2);
    const deduped = dedupeSameDay(both);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].title, 'CLI: Expanded MCP OAuth Support');
  });

  test('the same title on DIFFERENT days stays two rows — preview then GA is two events', () => {
    const mk = (d: string): AtomEntry => ({
      id: d, title: 'Failure Insights', iso_date: d, iso_month: d.slice(0, 7),
      link: '', summary: '', categories: [],
    });
    assert.equal(dedupeSameDay([mk('2026-05-01'), mk('2026-07-01')]).length, 2);
  });

  test('the Kiro ingest turns 6 feed entries into 2 announcements', () => {
    const out = toAnnouncements(parseAtom(FEED));
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((o) => o.heading), [
      'IDE: Agent Plugin Support and Session Pinning',
      'CLI: Expanded MCP OAuth Support',
    ]);
    assert.equal(out[0].product, 'IDE');
    assert.equal(out[0].date_label, 'August 7, 2026');
    assert.equal(out[0].month_label, 'August 2026');
  });
});

describe('github release tags', () => {
  test('a monorepo tag splits into package and version', () => {
    assert.deepEqual(splitTag('typescript/v1.12.0'), { package: 'typescript', version: 'v1.12.0' });
    assert.deepEqual(splitTag('python/v2.0.1'), { package: 'python', version: 'v2.0.1' });
  });

  test('a single-package tag has no package', () => {
    assert.deepEqual(splitTag('v1.12.0'), { package: '', version: 'v1.12.0' });
  });

  test('an unrecognised tag is kept whole rather than dropped', () => {
    // Losing a release because its tag was unusual would be a silent gap.
    assert.deepEqual(splitTag('nightly-build'), { package: '', version: 'nightly-build' });
  });

  test('rows carry a day label and the release permalink', () => {
    const rows = toReleaseRows([{
      id: 'x', title: 'typescript/v1.12.0', iso_date: '2026-08-07', iso_month: '2026-08',
      link: 'https://github.test/r/tag', summary: 'auto-drafted', categories: [],
    }]);
    assert.equal(rows[0].date_label, 'August 7, 2026');
    assert.equal(rows[0].package, 'typescript');
    assert.equal(rows[0].url, 'https://github.test/r/tag');
  });
});

describe('a source may only speak for its own service', () => {
  test('fact set ids map to the card service vocabulary, which differs', () => {
    // The fact sets say `agentcore`, the cards say `bedrock-agentcore`.
    assert.equal(serviceOfFactSet('agentcore.release-notes'), 'bedrock-agentcore');
    assert.equal(serviceOfFactSet('kiro.changelog'), 'kiro');
    assert.equal(serviceOfFactSet('strands.releases'), 'strands');
  });

  test('an unregistered source has unknown scope, which is permissive', () => {
    // A new source must not silently match nothing, which would look like total
    // coverage — the one failure this whole detector exists to prevent.
    assert.equal(serviceOfFactSet('newthing.feed'), null);
  });

  test('a Kiro CLI entry is NOT covered by the AgentCore CLI card', () => {
    // The defect this fixes: "CLI: Tangent Side-Conversations" matched AC-16,
    // the AgentCore CLI card, on the single shared token `cli`.
    const agentcoreCli = card({ card_id: 'AC-16', title: 'AgentCore CLI', service: 'bedrock-agentcore' });
    const kiroEntry = entry({ heading: 'CLI: Tangent Side-Conversations', service: 'kiro' });
    const [finding] = detectCoverage([agentcoreCli], [kiroEntry]);
    assert.equal(finding.status, 'uncovered');
    assert.deepEqual(finding.matches, []);
  });

  test('the same entry IS covered by a Kiro card', () => {
    const kiroCli = card({ card_id: 'CA-03', title: 'Kiro CLI', service: 'kiro' });
    const kiroEntry = entry({ heading: 'CLI: Tangent Side-Conversations', service: 'kiro' });
    const [finding] = detectCoverage([kiroCli], [kiroEntry]);
    assert.equal(finding.status, 'covered');
    assert.deepEqual(finding.matches.map((m) => m.card_id), ['CA-03']);
  });

  test('scoping did not break same-service matching', () => {
    const ac = card({ card_id: 'AC-06', title: 'Gateway', service: 'bedrock-agentcore' });
    const e = entry({ heading: 'Gateway: Configurable rate limits', service: 'bedrock-agentcore' });
    assert.equal(detectCoverage([ac], [e])[0].status, 'covered');
  });

  test('an entry with unknown scope can still match any card', () => {
    const ac = card({ card_id: 'AC-06', title: 'Gateway', service: 'bedrock-agentcore' });
    const e = entry({ heading: 'Gateway: Configurable rate limits', service: null });
    assert.equal(detectCoverage([ac], [e])[0].status, 'covered');
  });
});
