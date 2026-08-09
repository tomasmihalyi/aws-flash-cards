/**
 * Close the claim gaps the verifier reported, by fixing CARDS rather than by
 * loosening the verifier.
 *
 * The verifier had 21 of 28 checkable claims verified. Each remaining gap has a
 * different honest cause and therefore a different honest fix:
 *
 *   AC-12  "GA in 9 regions"          the card was STALE. Evaluations is in 16.
 *                                     Resolvable now that a feature-level source
 *                                     exists, so the slot becomes Tier A.
 *
 *   AC-17  "typically $0.10–$3.00     the card was WRONG. The payments docs say
 *          per call"                  transactions are "typically
 *                                     microtransactions (often under $1 or
 *                                     fractions of a cent)". $3.00 is not under
 *                                     $1. Replaced with what AWS says.
 *
 *   AC-01  "generally available       the card claimed a DAY that no source
 *          Oct 13 2025"               attests. Release notes are month
 *   AC-11  "re:Invent (Dec 2 2025)"   precision, and the day-precision document
 *   AC-13  "Announced April 30 2026"  history has no matching entry. Reduced to
 *                                     the month the source can actually support.
 *
 * WHY REDUCING PRECISION IS A FIX AND NOT A RETREAT
 *
 * A flashcard that asserts "October 13" teaches a fact the deck cannot stand
 * behind. The deck's whole claim on a learner's trust is that what it states is
 * checkable, so an unprovable day is worse than a provable month. The day is not
 * lost — `seed_text` and the provenance entry keep it permanently, so if a
 * day-precision source ever appears the original can be restored with evidence.
 *
 * WHAT THIS DELIBERATELY DOES NOT FIX
 *
 * AC-01 also claims AgentCore previewed in July 2025. No source in this repo
 * attests it: the only July 2025 release-notes entry is "Initial release of the
 * Developer Guide", which is not topically close enough, and the three July 16
 * 2025 entries in the Bedrock document history are about Data Automation and
 * Nova. That claim stays reported as unverifiable. Manufacturing a citation for
 * it would defeat the point of having a verifier.
 *
 * Usage: node tools/close-claim-gaps.ts [--dry-run]
 */

import { loadCards, saveCard, loadFactSetFile } from '../src/lib/store.ts';
import type { Card, Source } from '../src/lib/types.ts';

const GENERATOR = 'tools/close-claim-gaps.ts';
const dryRun = process.argv.includes('--dry-run');

/** A prose span replaced by a Tier C slot, with the reason recorded. */
type ProseFix = {
  card_id: string;
  slot: string;
  /** which card field the span lives in */
  where: 'back.lead' | `back.kv[${number}].v`;
  was: string;
  now: string;
  reason: string;
  unresolvable_reason: string;
  /** fact set whose source should be cited, or null when the fix REMOVES a claim */
  cite: string | null;
};

const PROSE_FIXES: ProseFix[] = [
  {
    card_id: 'AC-01',
    slot: 'ga_timeline',
    where: 'back.kv[1].v',
    was: 'Preview Jul 16 2025 \u2192 generally available Oct 13 2025, with VPC, PrivateLink, CloudFormation, and tagging support.',
    now: 'Preview July 2025 \u2192 generally available October 2025, with VPC, PrivateLink, CloudFormation, and tagging support.',
    reason:
      'Card claimed day precision ("Oct 13 2025") that no source attests. The release notes confirm October 2025 ("General Availability") at month precision, and the day-precision Bedrock document history has no AgentCore GA entry. Reduced to the month the source supports. The July preview date remains unattested and is reported as such.',
    unresolvable_reason:
      'A feature timeline sentence. The release notes attest the months but composing them into prose is authorship, so this slot is Tier C rather than deterministically resolved.',
    cite: 'agentcore.release-notes',
  },
  {
    card_id: 'AC-11',
    slot: 'policy_timeline',
    where: 'back.kv[3].v',
    was: 'Preview at re:Invent (Dec 2 2025) \u2192 GA March 2026.',
    now: 'Preview at re:Invent (December 2025) \u2192 GA March 2026.',
    reason:
      'Card claimed day precision ("Dec 2 2025"). Release notes confirm December 2025 ("Policy in Amazon Bedrock AgentCore") at month precision only, and no day-precision source carries the re:Invent announcement. Reduced to the month.',
    unresolvable_reason:
      'A feature timeline sentence. Both months are attested by the release notes; the sentence around them is authored, so Tier C.',
    cite: 'agentcore.release-notes',
  },
  {
    card_id: 'AC-13',
    slot: 'announcement_date',
    where: 'back.lead',
    was: 'Announced April 30 2026, these capabilities turn evaluation findings into action.',
    now: 'Announced April 2026, these capabilities turn evaluation findings into action.',
    reason:
      'Card claimed day precision ("April 30 2026"). Release notes confirm April 2026 ("Agent Optimization Loop capabilities in Public Preview") at month precision only. Reduced to the month.',
    unresolvable_reason:
      'The month is attested by the release notes; the sentence is authored, so Tier C.',
    cite: 'agentcore.release-notes',
  },
  {
    card_id: 'AC-17',
    slot: 'transaction_size',
    where: 'back.lead',
    was: 'typically $0.10\u2013$3.00 per call',
    now: 'typically under $1, often fractions of a cent',
    reason:
      'Card claimed transactions are "typically $0.10\u2013$3.00 per call". No AWS source carries that range, and the AgentCore payments documentation contradicts its upper bound: "Transactions are typically microtransactions (often under $1 or fractions of a cent)". Replaced with the documented characterisation.',
    unresolvable_reason:
      'The documentation states transaction size in prose, not as a published price, so there is no fact to interpolate. The wording is quoted from the payments page rather than composed.',
    cite: 'agentcore.payments',
  },
  {
    /**
     * Not stale, not mistaken about a source — INVENTED. No AWS source publishes
     * an I/O-wait share for agentic workloads, because it is a property of
     * someone's workload rather than of the service.
     *
     * The number was also invisible for a different reason: the claim extractor's
     * unit alternation put `\b` after a group that can match "%", so no
     * percentage in the deck was ever extracted as a claim. `validate` could see
     * the literal and the verifier could not, which is why this sat behind a
     * "100% verified" headline.
     *
     * The architectural point does not need the statistic and is made concretely
     * by the card's own hookline ("thinks for 60s but computes for 6s"), so the
     * fix is to drop the number rather than to find a citation for it.
     */
    card_id: 'AC-18',
    slot: 'io_wait_share',
    where: 'back.lead',
    was: 'agentic workloads typically spend 30\u201370% of wall-clock time in I/O wait',
    now: 'agentic workloads spend much of their wall-clock time waiting on I/O rather than on CPU',
    reason:
      'Card asserted that agentic workloads "typically spend 30\u201370% of wall-clock time in I/O wait". No AWS source publishes that figure and none could: it describes a customer workload, not the service. The quantity is removed; the qualitative point it supported is retained and is quantified concretely by the card\u2019s hookline instead.',
    unresolvable_reason:
      'A general characterisation of agentic workloads. No deterministic source can settle it, so it carries no number and is Tier C by nature rather than pending a source.',
    cite: null,
  },
];

/** AC-12's slot becomes deterministically resolvable, so it stops being prose. */
const AC12_TEMPLATE =
  'GA in {{fact:agentcore.feature-regions.evaluations.count}} regions incl. Sydney, Tokyo, Singapore, Frankfurt, Ireland, and US East/West.';
const AC12_FACTS = [
  'agentcore.feature-regions.evaluations.count',
  'agentcore.feature-regions.evaluations.regions',
];

function sourceFrom(factSetId: string): Source {
  const set = loadFactSetFile(`${factSetId}.json`);
  if (!set) throw new Error(`fact set ${factSetId} not found — run its ingest first`);
  return {
    url: set.source.url,
    title: `${factSetId} (${set.source.kind})`,
    kind: set.source.kind,
    fetched_at: set.source.fetched_at,
    content_hash: set.source.content_hash,
  } as Source;
}

function addSource(card: Card, src: Source): void {
  if (card.sources.some((s) => s.url === src.url && s.content_hash === src.content_hash)) return;
  card.sources = [...card.sources.filter((s) => s.url !== src.url), src];
}

function readSpan(card: Card, where: ProseFix['where']): string {
  if (where === 'back.lead') return card.back.lead;
  const i = Number(/\[(\d+)\]/.exec(where)![1]);
  return card.back.kv[i].v;
}

function writeSpan(card: Card, where: ProseFix['where'], value: string): void {
  if (where === 'back.lead') {
    card.back.lead = value;
    return;
  }
  const i = Number(/\[(\d+)\]/.exec(where)![1]);
  card.back.kv[i].v = value;
}

function applyProseFix(card: Card, fix: ProseFix, now: string): boolean {
  if (card.slots[fix.slot]) {
    console.log(`  ${fix.card_id}: slot "${fix.slot}" already exists — skipping (one-time)`);
    return false;
  }
  const span = readSpan(card, fix.where);
  if (!span.includes(fix.was)) {
    // Refuse rather than guess. If the card has moved on, a human should look.
    console.error(`  ${fix.card_id}: ${fix.where} no longer contains the expected text. Refusing to guess.`);
    console.error(`     expected: ${JSON.stringify(fix.was)}`);
    console.error(`     actual:   ${JSON.stringify(span)}`);
    process.exitCode = 1;
    return false;
  }

  writeSpan(card, fix.where, span.replace(fix.was, `{{slot:${fix.slot}}}`));
  card.slots[fix.slot] = {
    tier: 'C',
    template: fix.now,
    facts: [],
    rendered: fix.now,
    rendered_from: 'tier-c',
    seed_text: fix.was,
    unresolvable_reason: fix.unresolvable_reason,
  };

  card.provenance.history.push({
    at: now,
    tier: 'C',
    action: 'correct',
    generator: GENERATOR,
    slot: fix.slot,
    before: fix.was,
    after: fix.now,
    reason: fix.reason,
  });

  if (fix.cite) {
    const src = sourceFrom(fix.cite);
    addSource(card, src);
    card.verified_at = card.verified_at ?? src.fetched_at;
  }

  const reviewReason = `Tier C prose correction applied by an agent (${fix.slot}). Needs human sign-off: the design gates judgement rewrites behind a human, and there is no remote to raise a PR against.`;
  card.needs_review = true;
  card.review_reasons = [...card.review_reasons, { reason: reviewReason, raised_at: now, raised_by: GENERATOR }];
  card.provenance.history.push({ at: now, tier: 'C', action: 'flag-review', generator: GENERATOR, reason: reviewReason });
  card.confidence = 'medium';
  card.updated_at = now;

  console.log(`  ${fix.card_id} ${fix.where}`);
  console.log(`     was: ${fix.was}`);
  console.log(`     now: ${fix.now}`);
  return true;
}

function applyAc12(card: Card, now: string): boolean {
  const slot = card.slots.evaluations_regions;
  if (!slot) throw new Error('AC-12 slot evaluations_regions not found');
  if (slot.template === AC12_TEMPLATE) {
    console.log('  AC-12: slot already governed by the feature-region facts — skipping');
    return false;
  }

  slot.tier = 'A';
  slot.template = AC12_TEMPLATE;
  slot.facts = AC12_FACTS;
  // `facts_used` must equal the union of slot facts (validate enforces it), so a
  // slot gaining facts has to declare them at the card level too.
  card.facts_used = [...new Set([...card.facts_used, ...AC12_FACTS])].sort();
  // `rendered` is deliberately left alone. src/ingest/apply.ts resolves the
  // template against the facts and records the value change as a correction —
  // writing the new number here would bypass the mechanism that proves it came
  // from a source.
  delete slot.unresolvable_reason;

  card.provenance.history.push({
    at: now,
    tier: 'A',
    action: 'clear-review',
    generator: GENERATOR,
    slot: 'evaluations_regions',
    reason:
      'The slot recorded that service-level SSM data could not substantiate a feature-level region claim, pending a docs source. That source now exists: agentcore-regions.html is a feature \u00d7 region matrix. Slot promoted from unresolvable seed to Tier A; src/ingest/apply.ts records the value change itself, with the facts that produced it.',
  });

  // The recorded limit is resolved, so its review reason no longer applies.
  const before = card.review_reasons.length;
  card.review_reasons = card.review_reasons.filter((r) => !/feature-level|region list for the Evaluations/i.test(r.reason));
  if (card.review_reasons.length !== before) {
    console.log(`  AC-12: cleared ${before - card.review_reasons.length} review reason(s) that the new source resolves`);
  }
  card.needs_review = card.review_reasons.length > 0;
  card.updated_at = now;

  console.log('  AC-12 slots.evaluations_regions');
  console.log(`     was: seed literal "${slot.seed_text}"`);
  console.log(`     now: Tier A template governed by ${AC12_FACTS[0]} (apply.ts will resolve and cite it)`);
  return true;
}

function main(): void {
  const cards = loadCards();
  const now = new Date().toISOString();
  const touched: Card[] = [];

  console.log('close-claim-gaps: fixing cards, not the verifier\n');

  const ac12 = cards.find((c) => c.card_id === 'AC-12');
  if (!ac12) throw new Error('AC-12 not found');
  if (applyAc12(ac12, now)) touched.push(ac12);
  console.log();

  for (const fix of PROSE_FIXES) {
    const card = cards.find((c) => c.card_id === fix.card_id);
    if (!card) throw new Error(`${fix.card_id} not found`);
    if (applyProseFix(card, fix, now)) touched.push(card);
  }

  console.log(`\nclose-claim-gaps: ${touched.length} card(s) changed`);
  if (dryRun) {
    console.log('close-claim-gaps: --dry-run, nothing written');
    return;
  }
  for (const c of touched) saveCard(c);
  console.log('close-claim-gaps: now run src/ingest/apply.ts to resolve AC-12 against the facts');
}

main();
