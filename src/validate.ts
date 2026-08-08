/**
 * validate — the gate the build runs first.
 *
 * Three layers:
 *   1. Schema conformance (schema/card.schema.json, schema/fact-set.schema.json)
 *   2. Lint rules — invariants a JSON Schema cannot express
 *   3. Citation gate (FR-7) — no resolved fact-governed claim without a source
 *
 * Exits non-zero on any error. Warnings are reported but do not fail: a `seed`
 * slot is a known, tracked state, not a defect — hiding it would be the defect.
 *
 * Usage: node src/validate.ts [--strict]
 *   --strict  treat warnings as errors (used by CI once the deck is fully verified)
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validate as validateJson, validateSchemaKeywords } from './lib/schema.ts';
import { loadCards, loadCategories, loadArt, loadFactStore, loadSchema, loadIdLedger, paths } from './lib/store.ts';
import { resolveTemplate, slotRefs, FACT_RE } from './lib/facts.ts';
import { hashPayload } from './lib/hash.ts';
import { datedEntriesFrom } from './lib/verifier.ts';
import { detectAll } from './lib/lifecycle.ts';
import type { Card, FactSet } from './lib/types.ts';

const strict = process.argv.includes('--strict');
const errors: string[] = [];
const warnings: string[] = [];

const err = (m: string) => errors.push(m);
const warn = (m: string) => warnings.push(m);

/** A literal that looks like a number, price or date sitting in authored prose. */
const NUMERIC_LITERAL_RE =
  /(\$\s?\d|(?<![\w-])\d{1,3}(,\d{3})*(\.\d+)?\s?(%|regions?|GB|MB|hours?|seconds?|minutes?|events?|tokens?)|\b(19|20)\d{2}\b)/i;

function main(): void {
  // ---- layer 0: the schemas themselves must only use keywords we implement ----
  for (const name of ['card.schema.json', 'fact-set.schema.json']) {
    const problems = validateSchemaKeywords(loadSchema(name), name);
    problems.forEach(err);
  }

  const cardSchema = loadSchema('card.schema.json');
  const factSchema = loadSchema('fact-set.schema.json');
  const categories = loadCategories();
  const art = loadArt();
  const store = loadFactStore();
  const cards = loadCards();

  // ---- fact sets ----
  if (existsSync(paths.facts)) {
    for (const f of readdirSync(paths.facts).filter((n) => n.endsWith('.json')).sort()) {
      const set = JSON.parse(readFileSync(join(paths.facts, f), 'utf8')) as FactSet;
      validateJson(set, factSchema, `facts/${f}`).forEach(err);

      // L-EVIDENCE: re-hash the retained payload. Until this check existed the
      // content_hash was an assertion nobody could verify — a fact set could
      // claim any provenance it liked. Now the hash either matches the evidence
      // or the build fails.
      if (set.evidence) {
        const recomputed = hashPayload(set.evidence.canonical);
        if (recomputed !== set.source.content_hash) {
          err(
            `facts/${f}: content_hash does not match its own evidence (recorded ${set.source.content_hash}, evidence hashes to ${recomputed}) — the provenance record is unverifiable`,
          );
        }
        if (!set.evidence.text.trim()) {
          err(`facts/${f}: evidence.text is empty — the verifier would have nothing to string-match against`);
        }
      }

      for (const [id, v] of Object.entries(set.facts)) {
        if (v.type === 'money' && !v.currency) err(`facts/${f}: fact "${id}" is money but has no currency`);
        if ((v.type === 'region_list' || v.type === 'string_list') && !Array.isArray(v.value)) {
          err(`facts/${f}: fact "${id}" is ${v.type} but value is not an array`);
        }
      }
    }
  }

  // ---- cards ----
  const ids = new Set<string>();
  const catIds = new Set(categories.map((c) => c.id));

  for (const card of cards) {
    const id = card.card_id;
    validateJson(card, cardSchema, `cards/${id}.json`).forEach(err);

    // L-DUP: card ids are unique
    if (ids.has(id)) err(`${id}: duplicate card_id`);
    ids.add(id);

    // L-CAT: category must exist in the taxonomy
    if (!catIds.has(card.category)) err(`${id}: unknown category "${card.category}"`);

    // L-ART: pictogram must exist
    if (!art[card.art]) err(`${id}: unknown art key "${card.art}"`);

    // L-BADGE: presentation and semantics must not drift apart
    if ((card.badge_variant === 'pv') !== (card.lifecycle === 'preview')) {
      err(`${id}: badge_variant "${card.badge_variant}" and lifecycle "${card.lifecycle}" disagree (L-BADGE)`);
    }

    // L-SLOT-REF: every {{slot:…}} in prose must exist, and every slot must be used
    const refs = new Set(slotRefs(card));
    for (const r of refs) if (!card.slots[r]) err(`${id}: prose references undeclared slot "${r}"`);
    for (const name of Object.keys(card.slots)) {
      if (!refs.has(name)) err(`${id}: slot "${name}" is declared but never referenced in prose`);
    }

    // L-SLOT-FACTS: a slot's declared facts must match its template's references
    for (const [name, slot] of Object.entries(card.slots)) {
      const inTemplate = [...slot.template.matchAll(FACT_RE)].map((m) => m[1]);
      for (const f of inTemplate) {
        if (!slot.facts.includes(f)) err(`${id}.${name}: template uses fact "${f}" not listed in facts[]`);
      }
      if (slot.unresolvable_reason && inTemplate.length) {
        err(`${id}.${name}: marked unresolvable but its template still references facts`);
      }
      if (!slot.unresolvable_reason && !inTemplate.length) {
        err(`${id}.${name}: template references no facts and carries no unresolvable_reason — it is not fact-governed`);
      }
      // L-SEED: a seed slot is a tracked liability, surfaced not hidden
      if (slot.rendered_from === 'seed' && !slot.unresolvable_reason) {
        warn(`${id}.${name}: still rendering the unverified seed literal`);
      }
      if (slot.unresolvable_reason && !card.needs_review) {
        err(`${id}: slot "${name}" is unresolvable but the card is not flagged needs_review`);
      }
    }

    // L-FACTS-USED: derived field must match the union of slot facts
    const expectUsed = [...new Set(Object.values(card.slots).flatMap((s) => s.facts))].sort();
    if (JSON.stringify(expectUsed) !== JSON.stringify(card.facts_used)) {
      err(`${id}: facts_used ${JSON.stringify(card.facts_used)} !== union of slot facts ${JSON.stringify(expectUsed)}`);
    }

    // L-CITATION (FR-7): a slot resolved from a source must be able to name it
    for (const [name, slot] of Object.entries(card.slots)) {
      if (slot.rendered_from === 'seed') continue;
      if (!card.sources.length) {
        err(`${id}.${name}: rendered_from "${slot.rendered_from}" but the card carries no sources[] (citation gate)`);
      }
      if (!card.verified_at) {
        err(`${id}.${name}: rendered_from "${slot.rendered_from}" but verified_at is null`);
      }
    }

    // L-CONFIDENCE: 'low' is mandatory while any seed slot remains; 'high' needs full verification
    const anySeed = Object.values(card.slots).some((s) => s.rendered_from === 'seed');
    if (anySeed && card.confidence !== 'low') {
      err(`${id}: confidence "${card.confidence}" but a slot still renders from seed — must be "low"`);
    }
    if (card.confidence === 'high' && (!card.verified_at || card.needs_review)) {
      err(`${id}: confidence "high" requires verified_at and no needs_review flag`);
    }

    // L-DEPENDS: depends_on must point at real cards and never at itself
    for (const dep of card.depends_on) {
      if (dep === id) err(`${id}: depends_on includes itself`);
      if (!existsSync(join(paths.cards, `${dep}.json`))) err(`${id}: depends_on "${dep}" does not exist`);
    }

    // L-FANOUT: a non-service-fact card with no deterministic source of its own
    // has nothing keeping it honest unless it declares dependencies (FR-10)
    if (card.kind !== 'service-fact' && card.depends_on.length === 0) {
      warn(`${id}: kind "${card.kind}" has no deterministic source and declares no depends_on — nothing will ever flag it stale`);
    }

    // L-SUPERSEDE / L-RETIRE
    if (card.superseded_by && !existsSync(join(paths.cards, `${card.superseded_by}.json`))) {
      err(`${id}: superseded_by "${card.superseded_by}" does not exist`);
    }
    if (card.lifecycle === 'superseded' && !card.superseded_by) {
      err(`${id}: lifecycle "superseded" requires superseded_by`);
    }
    if (card.needs_review && card.review_reasons.length === 0) {
      err(`${id}: needs_review is set but review_reasons is empty`);
    }

    // L-NUMERIC: a number, price or date in authored prose that no slot governs
    // is exactly the failure mode this system exists to prevent
    for (const [field, text] of proseFields(card)) {
      const withoutSlots = text.replace(/\{\{slot:[a-z0-9_-]+\}\}/g, '');
      const hit = withoutSlots.match(NUMERIC_LITERAL_RE);
      if (hit) {
        warn(`${id}.${field}: ungoverned numeric/date literal ${JSON.stringify(hit[0].trim())} in authored prose — should become a fact-governed slot`);
      }
    }

    // L-RESOLVABLE: every declared fact must exist, or the slot must say why not
    for (const [name, slot] of Object.entries(card.slots)) {
      if (slot.unresolvable_reason) continue;
      const res = resolveTemplate(slot.template, store);
      if (!res.ok) {
        warn(`${id}.${name}: facts not yet ingested: ${res.missing.join(', ')} — run the Tier A ingest`);
      }
    }
  }

  // ---- FR-9 / Tier A: has a card's lifecycle drifted from the dated source? ----
  // `lifecycle` is a schema field, not prose, so the claim verifier never saw it —
  // and three cards shipped a "preview" badge for features that had gone GA
  // months earlier. The design doc lists GA/preview transitions as Tier A; this is
  // the check that was missing. Reported as a warning, not an error: the matcher
  // is heuristic, and a heuristic should not hard-fail a build.
  {
    const dated = datedEntriesFrom(
      existsSync(paths.facts)
        ? readdirSync(paths.facts)
            .filter((f) => f.endsWith('.json'))
            .map((f) => JSON.parse(readFileSync(join(paths.facts, f), 'utf8')) as FactSet)
        : [],
    );
    if (dated.length) {
      for (const f of detectAll(cards, dated)) {
        if (!f.drift) continue;
        warn(
          `${f.card_id}: LIFECYCLE DRIFT — ${f.reason}. Run node src/check-lifecycle.ts for the full signal history.`,
        );
      }
    }
  }

  // ---- FR-9: ids are never reused, and a card never simply disappears ----
  const ledger = loadIdLedger();
  for (const issued of ledger) {
    if (!ids.has(issued)) {
      err(`card id "${issued}" is in the id ledger but has no file in cards/ — cards are tombstoned, never deleted (FR-9)`);
    }
  }
  const unledgered = [...ids].filter((i) => !ledger.includes(i));
  if (unledgered.length && ledger.length) {
    warn(`card ids not yet in the ledger: ${unledgered.join(', ')} — run node tools/sync-id-ledger.ts`);
  }

  report(cards.length);
}

function proseFields(card: Card): [string, string][] {
  return [
    ['title', card.title],
    ['hook', card.hook],
    ['back.lead', card.back.lead],
    ['back.hookline', card.back.hookline],
    ...card.back.kv.map((r, i) => [`back.kv[${i}].v`, r.v] as [string, string]),
  ];
}

function report(cardCount: number): void {
  for (const w of warnings) console.log(`WARN  ${w}`);
  for (const e of errors) console.error(`ERROR ${e}`);
  const failed = errors.length > 0 || (strict && warnings.length > 0);
  console.log(
    `\nvalidate: ${cardCount} cards · ${errors.length} error(s) · ${warnings.length} warning(s)` +
      (strict ? ' · strict' : ''),
  );
  process.exit(failed ? 1 : 0);
}

main();
