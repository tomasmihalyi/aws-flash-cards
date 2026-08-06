# GOAL — Self-maintaining AI-native development flashcards (P0–P2)

Build a flashcard system for the AI-native development domain that keeps itself
factually current without a human editing cards by hand.

**This run covers P0–P2 only: spec, data-driven build, and Tier A ingest.**
It stops before any AWS deployment. Later phases run in a separate session once
the target AWS account is confirmed.

## Read first (gate)

`docs/plans/2026-08-06-self-maintaining-flashcards-goal.md` in this repo is the
binding design: scope boundary, card schema, provenance tiers, verifier, rename
and retirement rules, architecture, frontend requirements, full phase detail.

Read it before writing any code or spec. Do not infer scope or schema from this
prompt alone — this prompt is a summary; that document is the contract. If they
conflict, the document wins, except for the non-negotiables below.

That document describes P0 through P6. Build only P0–P2 in this run, but design
so the later phases drop in without rework — schema fields, provenance records
and tier routing must all exist even where nothing consumes them yet.

## Start point

`agentcore-flashcards.html` — 36KB single-file SPA, 21 hand-authored AgentCore
cards, `DECK` array hardcoded in the script. The schema is sound: preserve the
content contract and the flip/filter/keyboard/reduced-motion UX. Convert from
hardcoded content into a generated deck built from git-versioned card data.

## Non-negotiable rules

- **Hard stop after P2.** Do not deploy. Do not create, modify or delete any AWS
  resource — no S3 buckets, no CloudFront, no CloudFormation, no Lambda, no
  Step Functions, no EventBridge, no IAM. Read-only AWS API calls are permitted
  and expected (SSM public parameters, Price List API). If P2 appears to need a
  write, stop and report instead of proceeding.
- Numbers, prices, dates and region lists are NEVER model-generated. They come
  from deterministic sources (SSM public parameters, Price List API, botocore
  service models) and are injected into cards.
- No card publishes without a citation to a source actually fetched in that run;
  store the source content hash alongside it.
- Rename and retirement are aliasing operations, never deletions. Card IDs are
  stable for the life of the concept and never reused. (Detection logic is P5 —
  in this run, only the schema fields that support it.)
- Git is the source of truth for card content. Commit locally; do not push to a
  remote or open pull requests in this run.
- Practice, distillation and positioning cards have no deterministic source.
  They stay current via dependency fan-out: a material change to a service-fact
  card flags every card that declares it in `depends_on[]`. Model the
  `depends_on[]` field now even though fan-out executes in P5.
- Write a spec under `.kiro/specs/` before implementation code.
- Do not advance a phase until its exit criteria are demonstrably met.

## Scope in one line

AI-native development, not all AWS AI: AgentCore, Bedrock, SageMaker AI where
developer-relevant, coding agents (Kiro, Claude Code and Codex on Bedrock, Q
Developer), Quick Suite and Quick Desktop for the business-vs-engineer boundary
only, Strands/MCP/A2A, agentic and autonomous development practices, and
distillations of blogs and talks in those areas. A card is in scope if a
developer, or an SA advising developers, would act on it. The full IN/OUT list is
in the design doc — follow it exactly rather than judging case by case.

Content authoring at scale is P6. In this run the deck stays at the existing 21
cards; the work is the schema, the build, and the ingest that keeps them true.

## Phases in this run — exit criteria are gates

- **P0 Spec** — `.kiro/specs/` requirements, design, tasks; card JSON schema
  covering all fields including those only later phases consume.
  *Exit:* schema validates the 21 migrated cards with no data loss.
- **P1 Data-driven build** — cards extracted to JSON; a build renders both
  `deck.json` and the single-file HTML from that data.
  *Exit:* the 21 cards render identically to today's file, from data.
- **P2 Tier A ingest** — SSM regions, Price List API, botocore diff wired as
  read-only local jobs, writing provenance records (`sources[]`, `verified_at`,
  content hash) onto cards.
  *Exit:* one card provably auto-corrected end to end — a region or price claim
  changed by deterministic data with zero model involvement, evidenced by the
  before/after card diff and the provenance record.

## Deliberately not in this run

P3 read plane (S3 + CloudFront + OAC), P4 draft/verify loop with Bedrock, P5
rename/retire detection and fan-out, P6 content scale-up. Do not scaffold
infrastructure-as-code for these. Design decisions that constrain them belong in
the P0 spec, not in code.

## Done when

The 21 existing cards live as validated JSON in git; a build renders both
`deck.json` and the single-file HTML with behaviour matching today's file; a
read-only ingest job has demonstrably corrected at least one factual claim from
deterministic AWS data and recorded its provenance; the P0 spec covers all seven
phases so the deploy and drafting work can start clean; and no AWS resource has
been created or modified.
