/**
 * One-time Tier C correction: AC-16's lead was factually wrong.
 *
 * It claimed "April 2026 shipped a developer-experience wave: the AgentCore CLI".
 * The documentation release notes say the CLI launched in public preview in
 * February 2026 and reached general availability in March 2026 (v0.4.0). April
 * 2026 shipped CLI *features* — the Agent Inspector, resource import, and bash
 * commands inside the agent's runtime — not the CLI itself.
 *
 * WHY THIS IS A SLOT RATHER THAN AN EDIT
 *
 * Rewording prose is a judgement call, which the design puts in Tier C. Editing
 * `back.lead` in place would also erase what the deck used to claim. Going through
 * a slot keeps `seed_text` as the permanent record of the wrong original, makes the
 * correction visible in the parity report, and marks the card for human review —
 * which is the closest thing to Tier C's "arrives as a pull request" available
 * while this project has no remote.
 *
 * Every date in the replacement is attested by the release notes at month
 * precision, which is exactly what that source can support.
 *
 * Usage: node tools/correct-ac16-lead.ts [--dry-run]
 */

import { loadCards, saveCard } from '../src/lib/store.ts';

const GENERATOR = 'tools/correct-ac16-lead.ts';
const dryRun = process.argv.includes('--dry-run');
const SLOT = 'cli_timeline';

const WRONG =
  'April 2026 shipped a developer-experience wave: the AgentCore CLI for managing the full agent lifecycle from one interface, plus AgentCore skills that teach coding assistants how to build on the platform.';

const CORRECTED =
  'The AgentCore CLI launched in public preview in February 2026 and reached general availability in March 2026, managing the full agent lifecycle from one interface. April 2026 added the Agent Inspector, resource import, and bash commands inside the agent\u2019s runtime.';

function main(): void {
  const cards = loadCards();
  const card = cards.find((c) => c.card_id === 'AC-16');
  if (!card) throw new Error('AC-16 not found');

  if (card.slots[SLOT]) {
    console.log(`correct-ac16-lead: slot "${SLOT}" already exists — nothing to do (this correction is one-time)`);
    return;
  }
  if (!card.back.lead.includes(WRONG)) {
    // Refuse rather than guess. If the lead has moved on, a human should look.
    console.error('correct-ac16-lead: AC-16 lead no longer contains the exact wrong sentence. Refusing to guess.');
    console.error(`  expected: ${JSON.stringify(WRONG)}`);
    console.error(`  actual:   ${JSON.stringify(card.back.lead)}`);
    process.exit(1);
  }

  const now = new Date().toISOString();

  card.back.lead = card.back.lead.replace(WRONG, `{{slot:${SLOT}}}`);
  card.slots[SLOT] = {
    tier: 'C',
    // No deterministic template: the release notes attest the months, but turning
    // them into a sentence is authorship, not resolution.
    template: CORRECTED,
    facts: [],
    rendered: CORRECTED,
    rendered_from: 'tier-c',
    seed_text: WRONG,
    unresolvable_reason:
      'Prose describing a feature timeline. The release notes attest the months (CLI preview February 2026, GA March 2026, features April 2026) but composing them into a sentence is authorship, so this slot is Tier C and cannot be resolved deterministically.',
  };

  card.provenance.history.push({
    at: now,
    tier: 'C',
    action: 'correct',
    generator: GENERATOR,
    slot: SLOT,
    before: WRONG,
    after: CORRECTED,
    reason:
      'Card claimed the CLI shipped in April 2026. Release notes: "AgentCore CLI: Public Preview Launch" (February 2026) and "AgentCore CLI is now Generally Available" (March 2026). April 2026 shipped CLI features, not the CLI.',
  });

  const reason =
    'Tier C prose correction to the CLI timeline applied by an agent. Needs human sign-off: the design gates judgement rewrites behind a human, and there is no remote to raise a PR against.';
  card.needs_review = true;
  card.review_reasons = [...card.review_reasons, { reason, raised_at: now, raised_by: GENERATOR }];
  card.provenance.history.push({ at: now, tier: 'C', action: 'flag-review', generator: GENERATOR, reason });

  card.confidence = 'medium';
  card.updated_at = now;

  console.log('AC-16.back.lead');
  console.log(`  was: ${WRONG}`);
  console.log(`  now: ${CORRECTED}`);
  console.log(`\ncorrect-ac16-lead: slot "${SLOT}" created, card flagged needs_review`);

  if (dryRun) {
    console.log('correct-ac16-lead: --dry-run, nothing written');
    return;
  }
  saveCard(card);
}

main();
