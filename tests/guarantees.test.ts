/**
 * Tests for the guarantees the README claims.
 *
 * Each one corresponds to a promise made to a reader of this repo. A promise
 * without a test is a hope, and the whole premise of this deck is that its
 * claims are checkable.
 *
 * Run: node --test tests/guarantees.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FactStore, resolveTemplate, formatFact, expandSlots, slotRefs } from '../src/lib/facts.ts';
import { canonical, hashPayload, sha256 } from '../src/lib/hash.ts';
import { validate, validateSchemaKeywords } from '../src/lib/schema.ts';
import { awsRead, AwsWriteRefused, commandLine } from '../src/lib/aws.ts';
import { loadCards, loadCategories, loadSchema, loadFactStore, loadIdLedger, paths } from '../src/lib/store.ts';
import { toLegacyShape, authoredText } from '../src/lib/render.ts';
import { originalProjection, fieldCorrections, deriveConfidence } from '../src/lib/provenance.ts';
import { loadLegacy } from '../src/lib/legacy.ts';
import type { Card } from '../src/lib/types.ts';

describe('guarantee: ingest cannot write to AWS', () => {
  test('a write operation is refused before any process is spawned', () => {
    for (const [svc, op] of [
      ['s3', 'create-bucket'],
      ['cloudfront', 'create-distribution'],
      ['iam', 'create-role'],
      ['ssm', 'put-parameter'],
      ['dynamodb', 'delete-table'],
      ['cloudformation', 'deploy'],
    ] as const) {
      assert.throws(
        () => awsRead(svc, op),
        AwsWriteRefused,
        `${svc}:${op} must be refused by the allow-list`,
      );
    }
  });

  test('the allow-list is pairs, not a verb heuristic', () => {
    // "get-*" is not automatically safe: an operation is allowed only if the
    // exact (service, operation) pair was declared.
    assert.throws(() => awsRead('secretsmanager', 'get-secret-value'), AwsWriteRefused);
    assert.throws(() => awsRead('ssm', 'get-parameters'), AwsWriteRefused); // near-miss of an allowed op
  });

  test('shell metacharacters in arguments are refused', () => {
    assert.throws(
      () => awsRead('ssm', 'get-parameters-by-path', { args: ['--path', '/x; rm -rf /'] }),
      AwsWriteRefused,
    );
    assert.throws(
      () => awsRead('ssm', 'get-parameters-by-path', { args: ['--path', '$(whoami)'] }),
      AwsWriteRefused,
    );
  });
});

describe('guarantee: a recorded command is reproducible off this machine', () => {
  // The scheduled refresh died on its first real run with "The config profile
  // (default) could not be found". A GitHub runner has no named profiles —
  // configure-aws-credentials exports environment credentials, and passing
  // --profile makes the CLI ignore them and look for a config file that is not
  // there. Same underlying mistake as the file:///Users/<me>/… citation that was
  // in the botocore fact set: tooling encoding the author's environment.

  test('no profile resolved → --profile is omitted entirely', () => {
    const saved = process.env.AWS_PROFILE;
    delete process.env.AWS_PROFILE;
    try {
      const cmd = commandLine('ssm', 'get-parameters-by-path', { region: 'us-east-1', args: ['--path', '/x'] });
      assert.ok(!cmd.includes('--profile'), `must not name a profile: ${cmd}`);
      assert.ok(cmd.includes('--region us-east-1'));
    } finally {
      if (saved !== undefined) process.env.AWS_PROFILE = saved;
    }
  });

  test('an explicit profile is still honoured', () => {
    const cmd = commandLine('ssm', 'get-parameter', { profile: 'demo', region: 'us-east-1' });
    assert.ok(cmd.includes('--profile demo'), cmd);
  });

  test('AWS_PROFILE is honoured when no explicit profile is given', () => {
    const saved = process.env.AWS_PROFILE;
    process.env.AWS_PROFILE = 'someprofile';
    try {
      assert.ok(commandLine('ssm', 'get-parameter').includes('--profile someprofile'));
    } finally {
      if (saved === undefined) delete process.env.AWS_PROFILE;
      else process.env.AWS_PROFILE = saved;
    }
  });

  test('an empty profile string means "let the chain decide", not a profile named ""', () => {
    const saved = process.env.AWS_PROFILE;
    process.env.AWS_PROFILE = '';
    try {
      assert.ok(!commandLine('ssm', 'get-parameter').includes('--profile'));
    } finally {
      if (saved === undefined) delete process.env.AWS_PROFILE;
      else process.env.AWS_PROFILE = saved;
    }
  });
});

describe('guarantee: a missing fact never fakes freshness', () => {
  test('resolveTemplate reports every missing fact rather than emitting a gap', () => {
    const store = new FactStore(paths.facts);
    const res = resolveTemplate('there are {{fact:does.not.exist}} of them', store);
    assert.equal(res.ok, false);
    if (!res.ok) assert.deepEqual(res.missing, ['does.not.exist']);
  });

  test('a partially resolvable template still fails', () => {
    const store = new FactStore(paths.facts);
    const res = resolveTemplate('{{fact:agentcore.regions.count}} and {{fact:nope.nope}}', store);
    assert.equal(res.ok, false, 'one missing fact must fail the whole template');
  });

  test('expandSlots throws on a slot the card does not declare', () => {
    const card = loadCards()[0];
    assert.throws(() => expandSlots('text {{slot:ghost}} more', card), /unknown slot "ghost"/);
  });
});

describe('guarantee: numbers are formatted deterministically, never invented', () => {
  test('money keeps significant decimals and drops trailing zeros', () => {
    assert.equal(formatFact('x', { type: 'money', value: 0.005, currency: 'USD' }), '$0.005');
    assert.equal(formatFact('x', { type: 'money', value: 0.25, currency: 'USD' }), '$0.25');
    assert.equal(formatFact('x', { type: 'money', value: 0.0895, currency: 'USD' }), '$0.0895');
    assert.equal(formatFact('x', { type: 'money', value: 0.00945, currency: 'USD' }), '$0.00945');
    assert.equal(formatFact('x', { type: 'money', value: 12, currency: 'USD' }), '$12');
  });

  test('integers must actually be integers', () => {
    assert.equal(formatFact('x', { type: 'integer', value: 19 }), '19');
    assert.throws(() => formatFact('x', { type: 'integer', value: 19.5 }), /type integer/);
  });

  test('region lists render as a joined list, not a JSON blob', () => {
    const out = formatFact('x', { type: 'region_list', value: ['us-east-1', 'ap-southeast-2'] });
    assert.equal(out, 'us-east-1, ap-southeast-2');
  });
});

describe('guarantee: content hashes are stable and meaningful', () => {
  test('key order does not change the hash', () => {
    assert.equal(hashPayload({ a: 1, b: 2 }), hashPayload({ b: 2, a: 1 }));
  });

  test('array order DOES change the hash (order is data for region lists)', () => {
    assert.notEqual(hashPayload(['a', 'b']), hashPayload(['b', 'a']));
  });

  test('a value change always changes the hash', () => {
    assert.notEqual(hashPayload({ count: 19 }), hashPayload({ count: 20 }));
  });

  test('nested keys are sorted too', () => {
    assert.equal(canonical({ z: { b: 1, a: 2 } }), '{"z":{"a":2,"b":1}}');
  });

  test('hashes carry their algorithm prefix', () => {
    assert.match(sha256('x'), /^sha256:[0-9a-f]{64}$/);
  });
});

describe('guarantee: the schema validator does not silently skip keywords', () => {
  test('both published schemas use only implemented keywords', () => {
    for (const name of ['card.schema.json', 'fact-set.schema.json']) {
      assert.deepEqual(validateSchemaKeywords(loadSchema(name), name), [], `${name} uses an unimplemented keyword`);
    }
  });

  test('it actually rejects bad data', () => {
    const schema = loadSchema('card.schema.json');
    assert.ok(validate({}, schema).length > 0, 'an empty object must not validate');
    const card = loadCards()[0] as unknown as Record<string, unknown>;
    assert.deepEqual(validate(card, schema), [], 'a real card must validate');
    assert.ok(validate({ ...card, card_id: 'nope' }, schema).length > 0, 'a malformed card_id must fail');
    assert.ok(validate({ ...card, lifecycle: 'invented' }, schema).length > 0, 'an out-of-enum lifecycle must fail');
    assert.ok(validate({ ...card, extra_field: 1 }, schema).length > 0, 'additionalProperties:false must bite');
  });
});

describe('guarantee: every card validates and its invariants hold', () => {
  const cards = loadCards();
  const schema = loadSchema('card.schema.json');

  test('all 21 cards conform to the published schema', () => {
    for (const c of cards) {
      assert.deepEqual(validate(c as unknown as Record<string, unknown>, schema), [], `${c.card_id} failed schema`);
    }
  });

  test('badge presentation and lifecycle semantics cannot drift', () => {
    for (const c of cards) {
      assert.equal(c.badge_variant === 'pv', c.lifecycle === 'preview', `${c.card_id} badge/lifecycle disagree`);
    }
  });

  test('every declared slot is referenced, and every reference is declared', () => {
    for (const c of cards) {
      const refs = new Set(slotRefs(c));
      for (const name of Object.keys(c.slots)) assert.ok(refs.has(name), `${c.card_id}: slot ${name} unused`);
      for (const r of refs) assert.ok(c.slots[r], `${c.card_id}: undeclared slot ${r}`);
    }
  });

  test('facts_used is exactly the union of slot facts', () => {
    for (const c of cards) {
      const expect = [...new Set(Object.values(c.slots).flatMap((s) => s.facts))].sort();
      assert.deepEqual(c.facts_used, expect, `${c.card_id}: facts_used drifted`);
    }
  });

  test('depends_on points at real cards and never at self', () => {
    const ids = new Set(cards.map((c) => c.card_id));
    for (const c of cards) {
      for (const d of c.depends_on) {
        assert.notEqual(d, c.card_id, `${c.card_id} depends on itself`);
        assert.ok(ids.has(d), `${c.card_id} depends on missing ${d}`);
      }
    }
  });
});

describe('guarantee: no claim without a citation (FR-7)', () => {
  test('a slot resolved from a source names the source and a verification time', () => {
    for (const c of loadCards()) {
      for (const [name, slot] of Object.entries(c.slots)) {
        if (slot.rendered_from === 'seed') continue;
        assert.ok(c.sources.length > 0, `${c.card_id}.${name}: resolved but uncited`);
        assert.ok(c.verified_at, `${c.card_id}.${name}: resolved but verified_at is null`);
      }
    }
  });

  test('every source carries a content hash in the expected form', () => {
    for (const c of loadCards()) {
      for (const s of c.sources) {
        assert.match(s.content_hash, /^sha256:[0-9a-f]{64}$/, `${c.card_id}: bad content_hash`);
        assert.ok(!Number.isNaN(Date.parse(s.fetched_at)), `${c.card_id}: bad fetched_at`);
      }
    }
  });

  test('a card is only as fresh as its stalest source', () => {
    for (const c of loadCards()) {
      if (!c.verified_at || !c.sources.length) continue;
      const oldest = c.sources.map((s) => s.fetched_at).sort()[0];
      assert.equal(c.verified_at, oldest, `${c.card_id}: verified_at must be the OLDEST source fetch, not the newest`);
    }
  });

  test('confidence is derived, not asserted', () => {
    for (const c of loadCards()) {
      const anySeed = Object.values(c.slots).some((s) => s.rendered_from === 'seed');
      if (anySeed) assert.equal(c.confidence, 'low', `${c.card_id}: seed slot must force low confidence`);
      if (c.confidence === 'high') {
        assert.ok(c.verified_at, `${c.card_id}: high confidence needs verified_at`);
        assert.equal(c.needs_review, false, `${c.card_id}: high confidence cannot be under review`);
      }
    }
  });

  test('an unresolvable slot is accounted for, and says why it cannot be resolved', () => {
    /**
     * Was: "unresolvable ⟹ needs_review". That held while every unresolvable slot
     * was a PENDING one — a seed literal waiting for a source. It could not survive
     * agents authoring Tier C prose, where no fact can ever govern the slot and a
     * human is the only possible authority: the flag would have been permanent and
     * sign-off impossible. Split, not relaxed — the seed case keeps the hard rule,
     * and the full pair is pinned in its own suite below.
     */
    for (const c of loadCards()) {
      for (const [name, slot] of Object.entries(c.slots)) {
        if (!slot.unresolvable_reason) continue;
        assert.ok(slot.unresolvable_reason.length > 20,
          `${c.card_id}.${name}: unresolvable with no usable explanation`);
        if (slot.rendered_from === 'seed') {
          assert.equal(c.needs_review, true, `${c.card_id}: a pending seed slot must flag needs_review`);
        } else {
          assert.ok(c.needs_review || Boolean(c.signed_off?.by),
            `${c.card_id}.${name}: authored Tier C judgement neither flagged nor signed off`);
        }
        if (c.needs_review) {
          assert.ok(c.review_reasons.length > 0, `${c.card_id}: needs_review with no reason recorded`);
        }
      }
    }
  });
});

describe('guarantee: fact sets are deterministic-only', () => {
  test('every fact set declares tier A and names its generator and source', () => {
    if (!existsSync(paths.facts)) return;
    const schema = loadSchema('fact-set.schema.json');
    for (const f of readdirSync(paths.facts).filter((n) => n.endsWith('.json'))) {
      const set = JSON.parse(readFileSync(join(paths.facts, f), 'utf8')) as Record<string, unknown>;
      assert.deepEqual(validate(set, schema), [], `facts/${f} failed schema`);
      assert.equal(set.tier, 'A', `facts/${f}: there is no model-authored fact set`);
      assert.match(String(set.generator), /^src\/ingest\//, `facts/${f}: generator must be an ingest job`);
    }
  });

  test('no fact id is defined by two different fact sets', () => {
    assert.doesNotThrow(() => new FactStore(paths.facts));
  });
});

describe('guarantee: card ids are never reused, cards are never deleted (FR-9)', () => {
  test('every id in the append-only ledger still has a card file', () => {
    const ids = new Set(loadCards().map((c) => c.card_id));
    for (const issued of loadIdLedger()) {
      assert.ok(ids.has(issued), `id ${issued} left the ledger without a tombstone`);
    }
  });

  test('a superseded card keeps a forward pointer and stays reachable', () => {
    for (const c of loadCards()) {
      if (c.lifecycle === 'superseded') assert.ok(c.superseded_by, `${c.card_id}: superseded with no successor`);
      if (c.superseded_by) {
        assert.ok(existsSync(join(paths.cards, `${c.superseded_by}.json`)), `${c.card_id}: successor missing`);
      }
    }
  });

  test('a rename is recorded as an alias, never as a replacement', () => {
    for (const c of loadCards()) {
      for (const a of c.aka) {
        assert.ok(a.name.length > 0, `${c.card_id}: empty aka name`);
        assert.ok(a.changed_at.length > 0, `${c.card_id}: aka with no change date`);
      }
    }
  });
});

describe('guarantee: authored content survived the migration unchanged', () => {
  test('reverting slots and inverting recorded field corrections reproduces the original deck', () => {
    const legacy = loadLegacy(paths.legacyHtml);
    const cats = loadCategories();
    // Match by id, not position: the deck grows, and a card added later is not
    // something the migration could have lost.
    const byId = new Map(loadCards().map((c) => [c.card_id, c]));
    for (const legacyCard of legacy.DECK) {
      assert.ok(byId.has(legacyCard.id), `${legacyCard.id} disappeared — cards are tombstoned, never removed`);
    }

    for (let i = 0; i < legacy.DECK.length; i++) {
      // The shared helper the parity gate uses, so the two cannot drift apart.
      const seeded = originalProjection(byId.get(legacy.DECK[i].id)!);
      // authoredText, not toLegacyShape: the provenance footer is something the
      // pipeline derives, not something the original author wrote, so it is not
      // part of the content the migration had to preserve.
      assert.equal(
        canonical(authoredText(seeded, cats)),
        canonical(legacy.DECK[i]),
        `${legacy.DECK[i].id}: authored text differs from the original in a way no slot explains`,
      );
    }
  });

  test('every deterministic correction is traceable to a provenance entry', () => {
    for (const c of loadCards()) {
      for (const [name, slot] of Object.entries(c.slots)) {
        if (slot.rendered === slot.seed_text) continue;
        const entry = c.provenance.history.find((h) => h.slot === name && h.action === 'correct');
        assert.ok(entry, `${c.card_id}.${name}: text changed with no 'correct' entry in the ledger`);
        assert.equal(entry.before, slot.seed_text, `${c.card_id}.${name}: ledger 'before' does not match seed_text`);
        assert.equal(entry.after, slot.rendered, `${c.card_id}.${name}: ledger 'after' does not match rendered`);
        // Only a Tier A correction is resolved from facts. A Tier C correction is
        // a judgement rewrite; demanding facts of it would be incoherent.
        if (entry.tier === 'A') {
          assert.ok(entry.facts?.length, `${c.card_id}.${name}: tier A correction cites no facts`);
        }
      }
    }
  });

  test('every field-level correction records both sides, so it can be inverted', () => {
    for (const c of loadCards()) {
      for (const fc of fieldCorrections(c)) {
        assert.ok(fc.before.length > 0, `${c.card_id}: correction to ${fc.field} has no "before" — the original is unrecoverable`);
        assert.ok(fc.after.length > 0, `${c.card_id}: correction to ${fc.field} has no "after"`);
        assert.notEqual(fc.before, fc.after, `${c.card_id}: correction to ${fc.field} records no actual change`);
      }
    }
  });

  test('a corrected card still carries the source that justified it', () => {
    for (const c of loadCards()) {
      if (!fieldCorrections(c).length) continue;
      assert.ok(c.sources.length > 0, `${c.card_id}: field corrected with no source cited`);
      assert.ok(c.verified_at, `${c.card_id}: field corrected but verified_at is null`);
    }
  });

  test('the provenance ledger is append-only and chronological', () => {
    for (const c of loadCards()) {
      const times = c.provenance.history.map((h) => Date.parse(h.at));
      const sorted = [...times].sort((a, b) => a - b);
      assert.deepEqual(times, sorted, `${c.card_id}: provenance history is out of order`);
    }
  });
});

describe('guarantee: a Tier C judgement is accounted for, by a flag or by a human', () => {
  /**
   * This pins a guardrail that had to be SPLIT rather than relaxed.
   *
   * The original rule was "an unresolvable slot ⟹ the card is flagged
   * needs_review". Correct when the only unresolvable slots were PENDING ones —
   * a seed literal waiting for a source nobody had found yet. AC-12 sat in
   * exactly that state claiming "9 regions" until the feature × region matrix
   * turned up and the real number was 16.
   *
   * It became wrong once agents started authoring Tier C PROSE, where no fact
   * could ever govern the slot because it holds a sentence rather than a value.
   * Under the old rule those cards could never be signed off, so "Needs review"
   * would have been permanent — and a permanent warning is one a learner stops
   * reading.
   */
  const cards = loadCards();

  test('a PENDING unresolvable slot (still on seed) must stay flagged', () => {
    for (const c of cards) {
      for (const [name, slot] of Object.entries(c.slots)) {
        if (!slot.unresolvable_reason || slot.rendered_from !== 'seed') continue;
        assert.equal(c.needs_review, true,
          `${c.card_id}.${name}: a seed slot with no source must remain flagged — sign-off must not be able to bless an unverified value`);
      }
    }
  });

  test('an AUTHORED unresolvable slot is either flagged or signed off by a named human', () => {
    for (const c of cards) {
      for (const [name, slot] of Object.entries(c.slots)) {
        if (!slot.unresolvable_reason || slot.rendered_from === 'seed') continue;
        const accounted = c.needs_review || Boolean(c.signed_off?.by);
        assert.ok(accounted,
          `${c.card_id}.${name}: an unresolvable Tier C judgement is neither flagged nor signed off`);
        if (c.signed_off) {
          assert.ok(c.signed_off.by.length > 0, `${c.card_id}: signed_off with no approver named`);
          assert.ok(!Number.isNaN(Date.parse(c.signed_off.at)), `${c.card_id}: signed_off.at is not a date`);
        }
      }
    }
  });

  test('sign-off is endorsement, never verification', () => {
    /**
     * The property that stops a confident human laundering a claim no source
     * supports: signing off an unsourced card must not make it look verified.
     * `deriveConfidence` is the single implementation, shared with apply.ts.
     */
    for (const c of cards) {
      if (!c.signed_off) continue;
      assert.equal(c.confidence, deriveConfidence(c),
        `${c.card_id}: confidence was set by hand instead of derived`);
      if (!c.verified_at) {
        assert.notEqual(c.confidence, 'high',
          `${c.card_id}: signed off but unsourced — must never reach "high"`);
      }
    }
  });

  test('clearing a review flag never erases why it was raised', () => {
    // The reasons come off the live card, but the flag-review entry that recorded
    // them stays in the append-only history. Otherwise sign-off would destroy the
    // only record of what was approved.
    for (const c of cards) {
      if (!c.signed_off) continue;
      const cleared = c.provenance.history.filter((h) => h.action === 'clear-review');
      assert.ok(cleared.length > 0, `${c.card_id}: signed off with no clear-review entry`);
      const flagged = c.provenance.history.some((h) => h.action === 'flag-review');
      assert.ok(flagged, `${c.card_id}: signed off but the history never records it being flagged`);
      assert.ok(cleared.some((h) => /Signed off by \S/.test(h.reason)),
        `${c.card_id}: no clear-review entry names an approver`);
    }
  });
});
