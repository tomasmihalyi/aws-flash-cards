/**
 * Turn an ungoverned numeric literal in prose into a Tier A, fact-governed slot.
 *
 * WHAT THIS IS FOR, AND WHY IT IS NOT THE SAME AS "IS THE NUMBER TRUE"
 *
 * `verify-claims` answers whether a number is true against a source today.
 * `validate` asks a different and equally load-bearing question: will it still be
 * true tomorrow WITHOUT anyone noticing it changed? A literal typed into prose is
 * correct until the day it silently is not. A slot re-renders from a fact set, so
 * the next ingest either confirms it or reports a correction.
 *
 * AC-04 claimed Runtime executions run "up to 8 hours". True, and cited only to
 * release-notes prose — while Service Quotas publishes the number as an
 * authoritative, adjustable-flagged limit. Limits are the archetypal drifting
 * value; AWS raises them routinely.
 *
 * HOW THE HANDOFF WORKS
 *
 * This tool writes the slot's `template` and `facts` and sets `rendered` to the
 * ORIGINAL literal. It does not resolve anything. `src/ingest/apply.ts` then
 * renders the template from the fact set: if the result equals the seed the slot
 * is recorded as VERIFIED, and if it differs it is recorded as a CORRECTION with
 * provenance. Rendering here would bypass the only mechanism that proves the
 * number came from a source.
 *
 * Usage: node tools/govern-literal.ts [--dry-run]
 */

import { loadCards, saveCard } from '../src/lib/store.ts';
import type { Card } from '../src/lib/types.ts';

const GENERATOR = 'tools/govern-literal.ts';
const dryRun = process.argv.includes('--dry-run');

type Target = {
  card_id: string;
  slot: string;
  where: 'hook' | 'back.lead' | `back.kv[${number}].v`;
  /** the exact prose span to replace, INCLUDING the number */
  was: string;
  /** deterministic form; must render back to `was` for an unchanged fact */
  template: string;
  facts: string[];
  reason: string;
};

const TARGETS: Target[] = [
  {
    card_id: 'AC-04',
    slot: 'max_execution',
    where: 'hook',
    was: 'up to 8 hours',
    template: 'up to {{fact:agentcore.quotas.runtime.max-async-job-hours}} hours',
    facts: ['agentcore.quotas.runtime.max-async-job-hours'],
    reason:
      'The 8-hour execution ceiling was an ungoverned literal, cited only to release-notes prose. Service Quotas publishes it as "Asynchronous job maximum duration (in Hours)" = 8, not adjustable, across three quota codes that must agree. A limit is the archetypal drifting number, so it is now re-rendered from the API on every refresh instead of being trusted because someone typed it.',
  },
];

function readSpan(card: Card, where: Target['where']): string {
  if (where === 'hook') return card.hook;
  if (where === 'back.lead') return card.back.lead;
  return card.back.kv[Number(/\[(\d+)\]/.exec(where)![1])].v;
}

function writeSpan(card: Card, where: Target['where'], value: string): void {
  if (where === 'hook') {
    card.hook = value;
    return;
  }
  if (where === 'back.lead') {
    card.back.lead = value;
    return;
  }
  card.back.kv[Number(/\[(\d+)\]/.exec(where)![1])].v = value;
}

function apply(card: Card, t: Target, now: string): boolean {
  if (card.slots[t.slot]) {
    console.log(`  ${t.card_id}: slot "${t.slot}" already exists — skipping (one-time)`);
    return false;
  }
  const span = readSpan(card, t.where);
  if (!span.includes(t.was)) {
    console.error(`  ${t.card_id}: ${t.where} does not contain ${JSON.stringify(t.was)}. Refusing to guess.`);
    console.error(`     actual: ${JSON.stringify(span)}`);
    process.exitCode = 1;
    return false;
  }

  writeSpan(card, t.where, span.replace(t.was, `{{slot:${t.slot}}}`));
  card.slots[t.slot] = {
    tier: 'A',
    template: t.template,
    facts: t.facts,
    // Deliberately the ORIGINAL text: apply.ts resolves the template and decides
    // whether that is a verification or a correction.
    rendered: t.was,
    rendered_from: 'seed',
    seed_text: t.was,
  };
  card.facts_used = [...new Set([...card.facts_used, ...t.facts])].sort();
  card.provenance.history.push({
    at: now,
    tier: 'A',
    action: 'clear-review',
    generator: GENERATOR,
    slot: t.slot,
    facts: t.facts,
    reason: t.reason,
  });
  card.updated_at = now;

  console.log(`  ${t.card_id} ${t.where}`);
  console.log(`     was: ${JSON.stringify(t.was)} (ungoverned literal)`);
  console.log(`     now: {{slot:${t.slot}}} \u2192 ${t.template}`);
  return true;
}

function main(): void {
  const cards = loadCards();
  const now = new Date().toISOString();
  const touched: Card[] = [];

  console.log('govern-literal: a number typed into prose cannot notice when it changes\n');
  for (const t of TARGETS) {
    const card = cards.find((c) => c.card_id === t.card_id);
    if (!card) throw new Error(`${t.card_id} not found`);
    if (apply(card, t, now)) touched.push(card);
  }

  console.log(`\ngovern-literal: ${touched.length} slot(s) created`);
  if (dryRun) {
    console.log('govern-literal: --dry-run, nothing written');
    return;
  }
  for (const c of touched) saveCard(c);
  if (touched.length) console.log('govern-literal: now run src/ingest/apply.ts to resolve them against the facts');
}

main();
