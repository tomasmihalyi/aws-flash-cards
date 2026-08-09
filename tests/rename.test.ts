/**
 * Tests for rename detection and application.
 *
 * A rename is the one operation in this deck that changes what a card is CALLED,
 * so its failure modes are about vocabulary churn and broken continuity rather
 * than wrong numbers. These tests pin the three things that make it safe: it
 * needs two sources, it never touches lifecycle, and the old name never dies.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { loadCards } from '../src/lib/store.ts';
import { renameCandidateFrom, detectRename, corroborate } from '../src/lib/rename.ts';
import { substituteName } from '../src/ingest/apply-rename.ts';
import { originalProjection } from '../src/lib/provenance.ts';
import { slugify } from '../src/lib/render.ts';
import type { Card, FactSet } from '../src/lib/types.ts';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../src/lib/store.ts';
import { datedEntriesFrom } from '../src/lib/verifier.ts';

const CARDS = loadCards();
const SETS: FactSet[] = existsSync(paths.facts)
  ? readdirSync(paths.facts).filter((f) => f.endsWith('.json')).sort()
      .map((f) => JSON.parse(readFileSync(join(paths.facts, f), 'utf8')) as FactSet)
  : [];
const DATED = datedEntriesFrom(SETS);
const byId = (id: string) => CARDS.find((c) => c.card_id === id)!;
const clone = (c: Card): Card => JSON.parse(JSON.stringify(c));

describe('rename language extraction', () => {
  test('the namespace-launch phrasing yields the product name and the namespace', () => {
    const got = renameCandidateFrom('AWS Agent Registry launches under the new `agent-registry` namespace');
    assert.deepEqual(got, { new_name: 'AWS Agent Registry', namespace: 'agent-registry' });
  });

  test('the other rename phrasings are recognised', () => {
    assert.equal(renameCandidateFrom('Quick Suite is now called Amazon Quick')?.new_name, 'Amazon Quick');
    assert.equal(renameCandidateFrom('Bedrock Agents has been renamed to Bedrock Agents Classic')?.new_name, 'Bedrock Agents Classic');
    assert.equal(renameCandidateFrom('Amazon Quick (formerly Quick Suite) adds flows')?.new_name, 'Amazon Quick');
  });

  test('an ordinary feature heading is not a rename', () => {
    for (const h of [
      'AgentCore Evaluations is now Generally Available',
      'Region Expansion: São Paulo and Canada Central',
      'Runtime: Managed Session Storage in Public Preview',
      'Memory, policy, and harness are now available in AWS GovCloud (US-West)',
    ]) {
      assert.equal(renameCandidateFrom(h), null, `false rename detected in: ${h}`);
    }
  });

  test('a clause is not mistaken for a product name', () => {
    // A permissive capture would happily read "available in more regions" as a
    // name. Names are short, capitalised, and not verb phrases.
    assert.equal(renameCandidateFrom('Gateway is now called available in more regions'), null);
    assert.equal(renameCandidateFrom('This is now named that thing which we all use and love daily'), null);
  });
});

describe('a rename needs a second independent source', () => {
  test('AC-14 is renamed, and the corroborating source is a different URL', () => {
    const f = detectRename(byId('AC-14'), DATED, SETS);
    // AC-14 has already been applied, so the live card reports no further rename.
    // The property under test is the gate itself, so drive it from the pre-rename shape.
    const before = clone(byId('AC-14'));
    before.title = 'Agent Registry';
    before.aka = [];
    const g = detectRename(before, DATED, SETS);
    assert.ok(g.candidate, 'no rename candidate found');
    assert.equal(g.candidate.new_name, 'AWS Agent Registry');
    assert.equal(g.confident, true, g.reason);
    assert.ok(g.corroboration.length >= 1);
    for (const c of g.corroboration) {
      assert.notEqual(c.url, g.candidate.url, 'corroboration must come from a different source');
    }
    assert.equal(f.candidate, null, 'an applied rename must not be detected again');
  });

  test('an uncorroborated candidate is reported but never confident', () => {
    // A name only one source uses must not be applied. Simulated by asking for
    // corroboration of a name that appears nowhere else.
    const invented = corroborate('Totally Invented Registry Name', SETS, 'about:blank');
    assert.equal(invented.length, 0);
  });

  test('corroboration is by URL, so two fact sets from one page prove nothing', () => {
    const rn = SETS.find((s) => s.fact_set_id === 'agentcore.release-notes')!;
    const self = corroborate('AWS Agent Registry', SETS, rn.source.url);
    assert.ok(!self.some((c) => c.url === rn.source.url), 'a source cannot corroborate itself');
  });
});

describe('what a rename must not touch', () => {
  test('lifecycle is untouched: "launches" is not "generally available"', () => {
    const card = byId('AC-14');
    assert.equal(card.lifecycle, 'preview',
      'the August rename entry carries no GA language; the April entry confirms preview');
    assert.equal(card.badge_variant, 'pv', 'L-BADGE: preview lifecycle keeps the preview badge');
  });

  test('the service join key is untouched, because the API surface does not corroborate it', () => {
    // The release notes announce an `agent-registry` namespace. The pinned
    // botocore snapshot still carries the Registry operations under
    // bedrock-agentcore-control, and every docs source describing Registry is an
    // AgentCore page. Repointing the key would orphan the card from its sources.
    assert.equal(byId('AC-14').service, 'bedrock-agentcore');
  });

  test('the rename is recorded as a rename, not as a correction', () => {
    // The ledger keeps them apart: a correction says the card was wrong, a rename
    // says the world changed its mind. Collapsing them loses that signal.
    const h = byId('AC-14').provenance.history.find((x) => x.field === 'title');
    assert.ok(h, 'no title-level provenance entry');
    assert.equal(h.action, 'rename');
    assert.equal(h.before, 'Agent Registry');
    assert.equal(h.after, 'AWS Agent Registry');
    assert.match(h.reason, /agent-registry/, 'the namespace observation should be recorded');
  });
});

describe('the old name never dies', () => {
  test('the retired name is kept in aka with a date and a source', () => {
    const card = byId('AC-14');
    const alias = card.aka.find((a) => a.name === 'Agent Registry');
    assert.ok(alias, 'the old name was dropped instead of aliased');
    assert.ok(alias.changed_at, 'no changed_at on the alias');
    assert.ok(alias.source?.startsWith('http'), 'no source recorded for the rename');
  });

  test('a link naming the old name still resolves', () => {
    // deck-state resolves a URL against the slug OR any alias. The slug itself is
    // derived from card_id, so the id-based link was never at risk; this covers
    // the case where someone shared a NAME.
    const card = byId('AC-14');
    const aliasSlugs = card.aka.map((a) => slugify(a.name));
    assert.ok(aliasSlugs.includes('agent-registry'), `old name does not resolve: ${aliasSlugs.join(', ')}`);
  });

  test('the original prose is retained verbatim in seed_text', () => {
    const slot = byId('AC-14').slots.product_name_lead;
    assert.ok(slot, 'no slot governs the renamed prose');
    assert.match(slot.seed_text, /\bAgent Registry \(preview via AgentCore\)/);
    assert.ok(!slot.seed_text.includes('AWS Agent Registry'), 'seed_text must be the ORIGINAL name');
    assert.match(slot.rendered, /AWS Agent Registry \(preview via AgentCore\)/);
  });

  test('the parity gate can still reconstruct the card as authored', () => {
    // A rename changes `title`, which is part of authored text. The gate inverts
    // recorded `rename` entries as well as `correct` ones — a rename is a
    // recorded reason too.
    const original = originalProjection(byId('AC-14'));
    assert.equal(original.title, 'Agent Registry');
    assert.match(original.slots.product_name_lead.rendered, /\bAgent Registry \(preview/);
  });
});

describe('prose substitution is safe to repeat', () => {
  test('a name that extends the old one does not accumulate its prefix', () => {
    const once = substituteName('Agent Registry is a catalogue.', 'Agent Registry', 'AWS Agent Registry');
    assert.equal(once, 'AWS Agent Registry is a catalogue.');
    // The dangerous case: running again must be a no-op, not "AWS AWS Agent Registry".
    assert.equal(substituteName(once!, 'Agent Registry', 'AWS Agent Registry'), null);
  });

  test('mixed old and new occurrences converge', () => {
    const got = substituteName('AWS Agent Registry and Agent Registry.', 'Agent Registry', 'AWS Agent Registry');
    assert.equal(got, 'AWS Agent Registry and AWS Agent Registry.');
    assert.equal(substituteName(got!, 'Agent Registry', 'AWS Agent Registry'), null);
  });

  test('text without the old name is left alone', () => {
    assert.equal(substituteName('Nothing to see.', 'Agent Registry', 'AWS Agent Registry'), null);
  });

  test('an unrelated rename still works as a plain substitution', () => {
    assert.equal(substituteName('Quick Suite ships.', 'Quick Suite', 'Amazon Quick'), 'Amazon Quick ships.');
  });
});
