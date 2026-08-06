# AI-Native Development Flashcards

A flashcard deck that keeps its own factual claims current, and that shows a
learner the difference between a verified fact and an unverified judgement.

Domain: AI-native development — AgentCore, Bedrock, developer-relevant SageMaker
AI, coding agents (Kiro, Claude Code and Codex on Bedrock, Q Developer), the
Quick business-vs-engineer boundary, Strands/MCP/A2A, and agentic development
practice. Not all AWS AI: the full IN/OUT boundary is in
`.kiro/specs/self-maintaining-flashcards/requirements.md` §4.

**Status: P0–P2 complete.** No AWS resource is created, modified or deleted by
anything in this repo; ingest is read-only and stays that way.

## The one idea worth knowing

Facts are not prose.

```
facts/*.json                          cards/*.json
─────────────────────────             ────────────────────────
numbers, prices, dates,               explanation, framing,
region lists, API surfaces            "why it matters", memory hooks

written ONLY by deterministic         authored by a human, or by a model
ingest jobs                           under the Tier B/C gate
```

A card never stores a number that a deterministic source could supply. It stores
a **slot**, and a fact set fills it:

```jsonc
// cards/AC-19.json  (abridged)
"back": { "lead": "{{slot:region_availability}} GA brought the enterprise checklist: …" },
"slots": {
  "region_availability": {
    "tier": "A",
    "template": "AgentCore is available in {{fact:agentcore.regions.count}} AWS regions, including Asia Pacific (Sydney).",
    "rendered": "AgentCore is available in 19 AWS regions, including Asia Pacific (Sydney).",
    "rendered_from": "tier-a",
    "seed_text": "AgentCore previewed in four regions — including Asia Pacific (Sydney) — and has expanded steadily since."
  }
}
```

`seed_text` is what the deck used to claim, kept permanently. `rendered` is what
it claims now. The transition between them is a git commit with a provenance
record naming the source and its content hash.

This makes "numbers are never model-generated" an architectural property rather
than a policy someone has to remember to enforce.

## Layout

| Path | What it is |
|---|---|
| `cards/` | one JSON per card — **git is the source of truth** |
| `facts/` | deterministic fact sets — ingest writes these, nothing else does |
| `content/` | category taxonomy, pictogram library, the HTML shell and card template |
| `schema/` | published JSON Schema for cards and fact sets |
| `src/` | build, validate, parity gate, ingest jobs |
| `tools/` | one-time legacy migration, card-id ledger |
| `tests/fixtures/` | P1 parity baseline, committed API-surface snapshots |
| `dist/` | build output: `deck.json` + the single-file offline HTML |
| `agentcore-flashcards.html` | the original hand-authored deck, kept as the parity reference |

## Commands

Zero dependencies — TypeScript runs directly on Node ≥ 22.18's native type
stripping. There is no install step.

```bash
node src/validate.ts          # schema + lint + citation gate
node src/build.ts             # → dist/deck.json + dist/agentcore-flashcards.html
node src/verify-parity.ts     # the FR-5 gate against the original deck

node src/ingest/ssm-regions.ts    # region availability  (read-only AWS)
node src/ingest/pricelist.ts      # pricing              (read-only AWS)
node src/ingest/botocore-diff.ts  # API surface          (local, no AWS)
node src/ingest/apply.ts          # resolve slots: verify, correct, or fail

node src/ingest/apply.ts --dry-run   # show the corrections without writing
```

`package.json` wraps these as npm scripts (`npm run refresh` = ingest → apply →
build) but npm is only a task runner here; there are no packages to install.

## Guarantees, and how each one is enforced

| Guarantee | Enforcement |
|---|---|
| Numbers are never model-generated | Prose cannot hold a number a fact could supply; `validate` warns on every ungoverned numeric literal it finds |
| No claim without a citation | `validate` L-CITATION: a slot resolved from a source must carry `sources[]` + `verified_at` |
| Ingest cannot write to AWS | `src/lib/aws.ts` takes an explicit allow-list of `(service, operation)` pairs, not a `describe/list/get` heuristic |
| A missing fact never fakes freshness | `apply` leaves the card untouched and exits non-zero rather than stamping `verified_at` on an unverified claim |
| Card ids are never reused | append-only ledger in `content/card-id-ledger.json`; `validate` fails if an id disappears |
| Retirement never deletes | tombstones, `aka[]`, `superseded_by` — all modelled from P0 |
| Rendering matches the original | `verify-parity`: data, template, 84 face renders, and the shell byte-compared |

## What the deterministic sources cannot do

`bedrock-agentcore` region data from SSM is *service*-level. Card AC-12 claims
Evaluations is "GA in 9 regions" — a *feature*-level claim. Mapping the service
list onto it would be an overreach, so that slot stays on its seed literal, the
card is flagged `needs_review`, and the reason is recorded on the card.

Recording the limit is part of the design. Quietly widening a source's authority
to cover a claim it cannot support is the exact failure this system exists to
prevent.

## Next

P3 read plane (S3 + CloudFront + OAC, `ap-southeast-2`), the accessibility fix,
search, spaced repetition and the "what changed this week" deck. P4 adds the
model-drafted tiers behind a string-matching verifier; P5 rename/retire detection
and dependency fan-out; P6 content scale-up. Full detail and exit criteria in
`.kiro/specs/self-maintaining-flashcards/`.
