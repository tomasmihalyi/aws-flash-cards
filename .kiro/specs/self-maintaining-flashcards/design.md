# Design — Self-Maintaining AI-Native Development Flashcards

Covers P0–P6. P0–P2 are implemented; P3–P6 are designed here so they drop in
without reworking the schema or the data model.

---

## 1. The central design decision: facts are not prose

Everything else follows from one separation.

```
facts/*.json          prose in cards/*.json
────────────────      ───────────────────────
numbers               explanation
prices                framing
dates                 "why it matters"
region lists          memory hooks
API surfaces          positioning

written ONLY by       written by a human, or by a model
deterministic         under the Tier B/C gate
ingest jobs           never contains a raw number that a
                      fact set could supply
```

A card never stores a number that a deterministic source could supply. It stores
a **slot** that a fact set fills.

Why this and not "let the model refresh the card text and check it afterwards":
a verifier that string-matches numbers after the fact is a second line of
defence. Making it structurally impossible for a model to author a number is the
first. The rule "numbers are never model-generated" becomes an architectural
property rather than a policy someone has to enforce.

### 1.1 Slots

A card field may contain a slot reference:

```
"lead": "AgentCore is the successor to Bedrock Agents. {{slot:region_availability}}"
```

The slot itself lives on the card, and has three parts:

```json
"slots": {
  "region_availability": {
    "tier": "A",
    "template": "Generally available in {{fact:agentcore.regions.count}} regions, including Asia Pacific (Sydney).",
    "facts": ["agentcore.regions.count", "agentcore.regions.includes.ap-southeast-2"],
    "rendered": "AgentCore previewed in four regions — including Asia Pacific (Sydney) — and has expanded steadily since.",
    "rendered_from": "seed",
    "seed_text": "AgentCore previewed in four regions — including Asia Pacific (Sydney) — and has expanded steadily since."
  }
}
```

- `rendered` is what the build emits. It is the **only** thing the renderer reads,
  which is what keeps the build deterministic and offline.
- `rendered_from` is `seed` until an ingest job has resolved the slot, then
  `tier-a` (or later `tier-b` / `tier-c`).
- `seed_text` is the original hand-authored literal, kept forever as the audit
  trail of what the deck used to claim.
- `template` is the deterministic form. Ingest resolves it against the fact
  store; if the result differs from `rendered`, that is a **correction event**.

This is what makes the P1 parity gate and the P2 correction non-contradictory:
at P1 every slot renders from `seed` and reproduces the legacy text byte for
byte; P2 replaces `rendered` with the fact-resolved string, and the diff between
the two is the evidence.

### 1.2 Why slots and not JSON paths

An earlier option was to let an ingest job patch `back.kv[2].v` directly.
Rejected: the path breaks the moment a card is re-ordered or a row is inserted,
and a silently-missed patch target is indistinguishable from "nothing to fix".
A named slot is stable under editing and **fails loudly** when it disappears.

## 2. Data model

### 2.1 Card

One file per card, `cards/<card_id>.json`. Fields, grouped by what consumes them:

| Group | Fields | First consumer |
|---|---|---|
| Identity | `card_id`, `schema_version`, `created_at`, `updated_at` | P1 |
| Taxonomy | `kind`, `category`, `service`, `tags[]` | P1 (`tags` filtering: P3) |
| Lifecycle | `lifecycle`, `aka[]`, `superseded_by`, `supersedes[]` | P1 schema, P5 behaviour |
| Presentation | `badge_variant`, `badge_text`, `art`, `title`, `hook`, `back{lead,kv[],hookline}` | P1 |
| Facts | `slots{}`, `facts_used[]` | P1 render, P2 correction |
| Provenance | `sources[]`, `verified_at`, `confidence`, `provenance{tier,authored_by,history[]}` | P2 |
| Review | `needs_review`, `review_reasons[]`, `depends_on[]` | P5 |

**`kind`** — `service-fact` | `practice` | `distillation` | `mental-model`.
Determines the verification lane:

| kind | source of truth | staleness trigger |
|---|---|---|
| `service-fact` | SSM regions, Price List, botocore, What's New, docs | source diff |
| `practice` | named document/author + `depends_on[]` | dependency fan-out |
| `distillation` | one canonical URL + author + publish date | source edit or fan-out |
| `mental-model` | human-authored | fan-out only |

**`lifecycle`** — `preview` | `ga` | `deprecated` | `superseded` | `retired`.

**Splitting the legacy badge.** The legacy deck had one field `b` with values
`ga|pv|core` and a free-text `bt`. That conflated three things: lifecycle stage,
card kind, and a display label. They are now separate: `lifecycle` and `kind` are
semantic; `badge_variant` and `badge_text` are presentation, retained explicitly
so P1 can prove byte-identical rendering. A lint rule ties them together
(`badge_variant === "pv"` ⟺ `lifecycle === "preview"`) so they cannot drift.

**`confidence`** — `high` | `medium` | `low`. Not a vibe: `high` requires every
fact-governed slot resolved from a deterministic source in the last N days;
`low` is the automatic value for any card still rendering a `seed` slot.

### 2.2 Fact set

One file per namespace, `facts/<name>.json`, written **only** by ingest:

```json
{
  "fact_set_id": "agentcore.regions",
  "tier": "A",
  "generator": "src/ingest/ssm-regions.ts",
  "verified_at": "2026-08-06T12:44:03.118Z",
  "source": {
    "kind": "ssm-public-parameter",
    "url": "ssm://aws/service/global-infrastructure/services/bedrock-agentcore/regions",
    "fetched_at": "2026-08-06T12:44:03.118Z",
    "content_hash": "sha256:…",
    "retrieved_by": "aws ssm get-parameters-by-path --path …"
  },
  "facts": {
    "agentcore.regions.count": { "type": "integer", "value": 19 },
    "agentcore.regions.list":  { "type": "region_list", "value": ["ap-northeast-1", "…"] }
  }
}
```

`content_hash` is over the **canonicalised payload actually returned**, not over
the pretty-printed file, so a formatting change is not a false positive and a
value change can never be a false negative.

### 2.3 Directory layout

```
cards/            one JSON per card — the content, git is the source of truth
facts/            deterministic fact sets — ingest writes, nothing else does
content/          categories.json, art.json (pictogram library)
schema/           card.schema.json, fact-set.schema.json
src/lib/          shared modules (render, validate, hash, fact resolution)
src/build.ts      cards + facts + templates → dist/
src/validate.ts   schema + lint + citation gate
src/verify-parity.ts   FR-5 gate against the legacy file
src/ingest/       ssm-regions.ts, pricelist.ts, botocore-diff.ts, apply.ts
tools/            one-time migration from the legacy HTML
tests/fixtures/   parity baseline, golden set (P4), rename fixtures (P5)
dist/             deck.json + single-file HTML (build output)
```

## 3. Build (P1)

```
cards/*.json ─┐
facts/*.json ─┼→ resolve slots → validate → render ─┬→ dist/deck.json
content/*   ──┘                                     └→ dist/agentcore-flashcards.html
```

- **One render function, two consumers.** `renderCardFaces(card)` produces the
  front and back face HTML as strings. The single-file HTML embeds the deck and
  the same function; `deck.json` carries the structured card plus the rendered
  faces. This is what makes FR-5 checkable: parity is a string comparison on the
  output of one function, not a visual judgement about two codebases.
- **Deterministic output.** Keys emitted in a fixed order, cards sorted by
  `card_id`, no build timestamp in the artifact.
- **`deck.json` shape.** `{ schema_version, categories[], cards[] }`, and per
  card the structured fields plus `faces:{front,back}`. Chunking per category is
  a P3 concern; the shape already supports it because `categories[]` is
  independent of `cards[]`.

### 3.1 Parity gate (FR-5)

`src/verify-parity.ts` does three independent checks:

1. **Data parity** — extract the legacy `DECK`, `CAT` and `ART` literals from
   `agentcore-flashcards.html` by evaluating just those expressions in a
   `node:vm` sandbox (no DOM, no network). Project each new card back to the
   legacy shape and deep-compare. Any difference in any string fails.
2. **Render parity** — run the legacy template and the new render function over
   the same data and compare the emitted HTML per card per face.
3. **Asset parity** — hash the `<style>` block and the `ART` library in the
   legacy file and in the generated file; require equality.

A visual check is *additional* evidence, never the gate. The gate is a string
comparison, because "looks the same" is exactly the assurance that fails silently.

## 4. Tier A ingest (P2)

Three read-only jobs. None of them can write to AWS; none of them invoke a model.

| Job | Source | Produces |
|---|---|---|
| `ssm-regions.ts` | `aws ssm get-parameters-by-path /aws/service/global-infrastructure/services/<code>/regions` | region list, count, per-region availability booleans |
| `pricelist.ts` | `aws pricing get-products --service-code AmazonBedrockAgentCore --filters regionCode=<r>` | per-usage-type unit price, unit, currency |
| `botocore-diff.ts` | botocore service model `service-2.json` | canonical operation list + fingerprint |

Then `apply.ts`:

```
for each card, for each slot with tier A:
    resolve slot.template against the fact store
    if resolved === slot.rendered:      → verify only  (touch verified_at, sources[])
    if resolved !== slot.rendered:      → CORRECTION
                                          slot.rendered      = resolved
                                          slot.rendered_from = "tier-a"
                                          append provenance.history entry
                                          append sources[] entry (url + hash + fetched_at)
                                          recompute confidence
    if a required fact is missing:      → do NOT touch the slot; report and exit non-zero
```

The third branch matters: a fact that failed to fetch must never cause a card to
silently keep an unverified claim *and* gain a fresh `verified_at`. Missing data
is a build failure, not a no-op.

### 4.1 What the deterministic sources can and cannot substantiate

Verified against the live APIs on 2026-08-06 (account <dev-account>, read-only):

- **SSM `bedrock-agentcore/regions`** returns 19 regions including
  `ap-southeast-2`. This substantiates *service-level* availability.
- **Price List `AmazonBedrockAgentCore`** returns per-usage-type prices —
  `Gateway:Consumption-based:API-Invocations` $0.000005/invocation,
  `Memory:Consumption-based:Short-Term-Memory` $0.00025/event,
  `Runtime:Consumption-based:vCPU` $0.0895/vCPU-hour, and others.
- **Neither substantiates a feature-level region claim.** Card AC-12 says
  Evaluations is "GA in 9 regions"; SSM tracks the service, not the feature.
  Mapping the service list onto the feature claim would be an overreach, so that
  slot stays `seed`, is marked `needs_review`, and its reason records *why* the
  deterministic source cannot settle it. Recording the limit is part of the
  design, not a gap in it.

### 4.2 Rate limits and failure behaviour

Both APIs are called once per run per namespace, results cached to `facts/`. The
Price List response for one region is ~570 records; filter server-side by
`regionCode` and select usage types locally. On any fetch failure the job exits
non-zero without writing a partial fact set — a half-written fact store is worse
than a stale one.

## 5. P3 — Read plane (designed, not built)

S3 (private) + CloudFront + OAC in `ap-southeast-2`. Static SPA plus versioned
`deck.json` chunked per category. No API, no auth in v1. The single-file HTML
stays a build artifact for offline/field use. Publish on merge to `main`: build →
sync to S3 → CloudFront invalidation.

Constraints this design already satisfies: `deck.json` is chunkable because
categories and cards are separate arrays; the build is deterministic so the
invalidation set is exactly the changed chunks; there is no server-side state to
migrate.

**Also in P3** (deferred here deliberately): the NFR-4 accessibility fix
(`aria-hidden` toggling on flip), taxonomy/tag filtering, full-text search,
deep-linkable card URLs that survive rename via `aka[]`, spaced repetition
(FSRS or SM-2) with progress in `localStorage`, tracks, the "what changed this
week" deck built from git history, and per-card provenance display. These change
the DOM and therefore cannot land while the FR-5 parity gate is the definition
of correct. Sequence: P3 replaces the parity gate with a behavioural test suite,
*then* changes the DOM.

## 6. P4 — Tier B/C loop (designed, not built)

- **Tier B** — model-drafted refresh of an existing card where the change is
  small and a specific fetched URL supports it. All numbers and dates injected
  from Tier A fact sets; the model never emits them. Must pass the verifier.
- **Tier C** — new cards, retirements, category changes, positioning or
  "why it matters" claims, anything failing the verifier. Arrives as a PR.
  **All Quick-vs-Kiro boundary claims are Tier C by definition** — they are
  positioning judgements, not facts.

**Verifier.** Decompose a drafted card into atomic claims. Check each against the
fetched source text. Numeric, date and region claims are **string-matched, not
judged** — if the number does not appear in the source, the claim fails. Any
failure demotes the whole card to Tier C. ~30 hand-verified cards are kept as
golden fixtures; the build fails if the verifier regresses on them. Exit
criterion is that the verifier catches an *injected* hallucination, i.e. it is
tested adversarially rather than on happy paths.

**Researcher agent on AgentCore Runtime — deliberately narrow.** One component
runs on AgentCore: the researcher that takes an ambiguous launch item, reads
documentation, and returns a card draft with citations. It uses Gateway (docs,
pricing, SSM as MCP tools), Memory (per-service accumulated context), Evaluations
(card quality against the golden set) and Policy (hard rule: cannot publish a
card without a verified citation). **The deterministic spine stays on Step
Functions and Lambda.** Moving the deterministic pipeline onto AgentCore would be
over-engineering: it is a fixed DAG over structured APIs with no ambiguity to
resolve, and the whole value of Tier A is that no agent is in the loop.

## 7. P5 — Rename, retirement, fan-out (designed, not built)

Detection signals: What's New title language ("now known as", "renamed", "is
now", "Classic", "end of support", "no longer accepting new customers") ·
documentation URL redirects (301/302 on a previously-200 URL) · disappearance
from the Price List product set · botocore service-model rename or operation
removal · non-AWS changelogs for Claude Code / Codex.

Gate asymmetry, and the reason for it: applying a **rename** is automatic (Tier
A, alias + commit) because it is reversible and additive. Applying a
**retirement** is human-gated via PR because a false retirement silently
destroys knowledge — the costs are not symmetric, so the gates are not either.

**Rename ≠ add + remove.** A botocore diff showing one operation gone and one
appeared is ambiguous. Treat it as a rename only when the two shapes are
structurally identical after canonicalisation (same input/output members, same
errors) — otherwise it is a removal plus an addition, and the removal is
human-gated.

Regression fixtures, both of which must be handled correctly:
- Bedrock Agents → Bedrock Agents Classic, including the closed-to-new-customers
  date
- QuickSight → Quick Suite lineage (the Quick family carries a rename in its own
  history)

**Fan-out.** A material change to a `service-fact` card sets `needs_review` on
every card listing it in `depends_on[]`, with a reason naming the changed card
and fact. This is the only thing keeping practice and distillation cards honest,
because they have no deterministic source.

## 8. P6 — Content scale-up (designed, not built)

Expand to the full in-scope surface including the Quick boundary set. Practice
and distillation cards authored from nominated sources including the three
published Medium articles on agentic coding. Target 200–400 cards. Every new card
enters through Tier C.

## 9. Rejected alternatives

| Option | Why rejected |
|---|---|
| DynamoDB as the card store | Git gives free diffs, review, blame and rollback — exactly the audit trail this system's credibility rests on. Add DynamoDB only if sub-daily updates without commits become a real requirement. |
| Model rewrites card text, verifier checks numbers afterwards | Makes correctness a policy instead of a structural property. Slots make a model-authored number impossible, and the verifier becomes defence in depth rather than the only defence. |
| Patch cards by JSON path | Breaks on reordering, and a missed target looks identical to "nothing to fix". Named slots fail loudly. |
| Deterministic pipeline on AgentCore | It is a fixed DAG over structured APIs. Agency adds nondeterminism to the one part of the system whose value is that it has none. |
| Delete retired cards | Destroys learner progress and breaks deep links. Tombstones cost almost nothing. |
| npm dependencies (ajv, a bundler) | A deck of facts about AWS does not need a supply chain. Node's native TS execution and a hand-written validator over the schema subset we actually use are enough. |
| Fix the a11y defect in P1 | It changes the DOM, which is what the parity gate pins. Sequence it after the gate is replaced by behavioural tests (P3). |
