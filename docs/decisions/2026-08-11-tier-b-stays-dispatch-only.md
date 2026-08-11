# Tier B drafting stays dispatch-only

**Date:** 2026-08-11
**Status:** Decided
**Scope:** `.github/workflows/draft.yml`, `src/ingest/draft.ts`

## The question

Tier B (model-drafted prose, deterministically gated) currently runs only when a
human dispatches it with a named card id. So the AI drafting path contributes
nothing unattended, while the deterministic refresh runs every morning at 05:00
AEST without supervision.

Should drafting go on the schedule too?

## Decision

**No. Dispatch-only, with a required card id.** The refresh role keeps its
explicit `Deny` on `bedrock:*`, so the nightly job cannot reach a model even if a
future code path tries.

## Why

**The scarce resource is review, not drafting.** Every Tier B outcome that reaches
a human is a pull request someone has to read — including `accept`, because the
verifier proves no fabricated *fact* and cannot prove the prose is *better*.
Scheduling the drafter multiplies the thing that is already the bottleneck. A
nightly run across 40 cards would generate a review queue nobody asked for, and a
review queue nobody clears is indistinguishable from no review at all.

**Unattended prose rewriting drifts the voice.** The first two real drafts
demonstrated this on the day they shipped. AC-05 changed `afterwards` →
`afterward` (US spelling, in a deck written in Australian English) and stripped
the spaces around an em dash. Both passed the gate, correctly — neither is a
fact, so neither is the verifier's business. Across a few hundred cards that is a
slow Americanisation of the deck's voice that no human chose. On a schedule,
nobody would be watching the run in which it happened.

**A prose rewrite is a judgement, and this repo routes judgements to a human.**
That rule is what the whole Tier A/B/C split exists to encode. Putting the model
on a timer would not break the rule — the PR gate still holds — but it would mean
the *initiation* of a judgement happens without one, which is the same category
error one level up.

## What was rejected, and why

**Schedule it across all cards nightly.** Rejected: generates review debt
proportional to deck size, and the deck is meant to grow to 200–400 cards.

**Schedule it for cards the coverage detector flags.** Tempting, and closer to
right, but still inverts the dependency: it decides *that* a rewrite should happen
based on a signal about *coverage*, which is a different question from whether the
prose needs work.

**The middle option, not taken yet:** schedule the **selection**, not the
drafting. A deterministic job — no model, therefore no new IAM — could report
"these cards are the best redraft candidates" into the existing refresh run
summary, and a human dispatches the ones worth doing. That keeps the model out of
the schedule while removing the "which card?" friction that currently makes
drafting something you have to remember to do.

Worth building when drafting is used often enough that choosing a target is the
annoying part. It is not yet.

## Consequences

- Tier B contributes nothing unattended. **This is the intended state**, not an
  omission — recorded here because "we never got round to scheduling it" and "we
  decided not to" look identical in a workflow file.
- The daily refresh remains fully deterministic, which is the project's headline
  claim and the more interesting one.
- Reversing this is a five-line change (`on: schedule:` plus a card-selection
  step). The IAM already exists and is already scoped to one model.

## Revisit if

- Review throughput stops being the constraint (e.g. a batch review UI exists).
- A house-style rule lands in the drafter's system prompt and demonstrably holds
  across 20+ drafts, removing the voice-drift objection.
- The deck passes ~150 cards, where manually choosing redraft targets stops
  scaling.
