/**
 * verify-claims — decompose every card into atomic claims and verify each one.
 *
 * This is the P4 gate applied to the deck we already have. It answers a question
 * the rest of the pipeline could not: of everything this deck asserts, how much
 * is actually backed by something fetched?
 *
 * Usage:
 *   node src/verify-claims.ts                # summary
 *   node src/verify-claims.ts --card AC-19   # one card in full
 *   node src/verify-claims.ts --failing      # only claims that did not verify
 *   node src/verify-claims.ts --strict       # exit non-zero if any card demotes
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCards, loadCategories, loadFactStore, paths } from './lib/store.ts';
import { authoredText } from './lib/render.ts';
import { decompose, isCheckable } from './lib/claims.ts';
import { verifyCard, evidenceTextsFrom, datedEntriesFrom, subjectStemsOf, type CardVerdict } from './lib/verifier.ts';
import type { FactSet } from './lib/types.ts';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
}
const onlyCard = arg('card');
const failingOnly = process.argv.includes('--failing');
const strict = process.argv.includes('--strict');

function loadFactSets(): FactSet[] {
  if (!existsSync(paths.facts)) return [];
  return readdirSync(paths.facts)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(paths.facts, f), 'utf8')) as FactSet);
}

function main(): void {
  const cards = loadCards().sort((a, b) => a.card_id.localeCompare(b.card_id));
  const cats = loadCategories();
  const store = loadFactStore();
  const sets = loadFactSets();
  const evidence = evidenceTextsFrom(sets);
  const dated = datedEntriesFrom(sets);
  if (!dated.length) console.log('verify-claims: no month-precision dated source \u2014 date claims cannot be checked. Run docs-release-notes.');

  if (!evidence.length) {
    console.error('verify-claims: no retained source evidence in facts/ — run the Tier A ingest first.');
    console.error('               Without fetched sources every claim is unverifiable by definition.');
    process.exit(1);
  }

  const verdicts: CardVerdict[] = [];
  for (const card of cards) {
    if (onlyCard && card.card_id !== onlyCard) continue;
    const resolved = authoredText(card, cats);
    const claims = decompose(card, resolved);
    verdicts.push(verifyCard(card, claims, {
      store, evidenceTexts: evidence, datedEntries: dated, subjectStems: subjectStemsOf(card),
    }));
  }

  if (onlyCard || failingOnly) detail(verdicts);
  summary(verdicts, evidence.length);
}

function detail(verdicts: CardVerdict[]): void {
  const mark: Record<string, string> = {
    verified: 'OK  ', partial: 'PART', contradicted: 'BAD ', unsupported: 'NONE', unverifiable: 'DATE', judgement: 'JUDG',
  };
  for (const v of verdicts) {
    const shown = v.results.filter((r) => (failingOnly ? r.verdict !== 'verified' && r.verdict !== 'judgement' : true));
    if (!shown.length) continue;
    console.log(`\n${v.card_id}  \u2192 Tier ${v.tier}${v.demoted ? '  (demoted)' : ''}`);
    console.log(`  ${v.reason}`);
    for (const r of shown) {
      console.log(`  ${mark[r.verdict]} [${r.claim.kind}] ${JSON.stringify(r.claim.token)}`);
      console.log(`       ${r.reason}`);
      if (r.verdict !== 'verified' && r.verdict !== 'judgement') {
        console.log(`       in ${r.claim.field}: ${r.claim.context.slice(0, 110)}`);
      }
    }
  }
}

function summary(verdicts: CardVerdict[], sourceCount: number): void {
  const total = { verified: 0, partial: 0, unsupported: 0, contradicted: 0, unverifiable: 0, judgement: 0 };
  for (const v of verdicts) for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += v.counts[k];

  const checkable = total.verified + total.partial + total.unsupported + total.contradicted + total.unverifiable;
  const demoted = verdicts.filter((v) => v.demoted);
  const pct = checkable ? Math.round((total.verified / checkable) * 100) : 0;

  console.log('\n\u2500'.repeat(1) + '─'.repeat(66));
  console.log(`verify-claims: ${verdicts.length} card(s) against ${sourceCount} fetched source(s)\n`);
  console.log(`  checkable claims   ${checkable}`);
  console.log(`    verified         ${total.verified}  (${pct}% of checkable)`);
  console.log(`    partial          ${total.partial}  \u2190 month confirmed, day not attested by any source`);
  console.log(`    contradicted     ${total.contradicted}  \u2190 slot and prose disagree; needs a correction`);
  console.log(`    unsupported      ${total.unsupported}  \u2190 no source at all; govern with a slot or cite`);
  console.log(`    unverifiable     ${total.unverifiable}  \u2190 historical dates; need a docs/What's New citation`);
  console.log(`  judgement claims   ${total.judgement}  (positioning \u2014 Tier C by definition, never "verified")`);
  console.log(`\n  cards at Tier A    ${verdicts.length - demoted.length}`);
  console.log(`  cards demoted to C ${demoted.length}${demoted.length ? '  ' + demoted.map((d) => d.card_id).join(' ') : ''}`);
  console.log('─'.repeat(67));
  console.log('Run with --failing to see every claim that did not verify, or --card <id> for one card.');

  if (strict && demoted.length) {
    console.error(`\nverify-claims: --strict and ${demoted.length} card(s) demoted`);
    process.exit(1);
  }
}

main();
