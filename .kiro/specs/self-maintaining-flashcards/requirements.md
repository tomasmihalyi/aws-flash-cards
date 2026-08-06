# Requirements — Self-Maintaining AI-Native Development Flashcards

Status: P0 complete · P1–P2 implemented · P3–P6 specified, not built
Binding upstream design: `docs/plans/2026-08-06-self-maintaining-flashcards-goal.md`
(that document wins on any conflict with this one, except where a run's
non-negotiables override both)

---

## 1. Problem

A hand-authored flashcard deck about a fast-moving domain is wrong within weeks.
Region lists grow, prices change, preview features go GA, services get renamed
and retired. The existing deck (`agentcore-flashcards.html`, 21 cards, content
hardcoded in a `<script>` block) has no mechanism to notice any of that, and no
way to show a learner whether a claim was ever verified.

The failure mode we are designing against is not "the deck is out of date". It is
**"the deck is confidently out of date"** — a learner memorises a wrong number
and repeats it to a customer.

## 2. Goal

A deck that keeps its own factual claims current from deterministic sources, and
that visibly distinguishes a verified fact from an unverified judgement.

## 3. Users

| User | Needs |
|---|---|
| Developer learning the domain | Fast recall, correct facts, "what changed since I last looked" |
| SA advising developers | Defensible claims with a source and a verification date; positioning boundaries |
| Deck maintainer | Not to hand-edit cards for routine factual drift; to be asked only for judgement calls |

## 4. Scope boundary (from Decision 1 of the design doc — binding)

**IN:** AgentCore (all primitives) · Bedrock (models incl. Nova and Anthropic,
Guardrails, Knowledge Bases, Flows, Data Automation, Evaluations, inference
modes) · SageMaker AI where developer-relevant · coding agents (Kiro, Claude Code
on Bedrock/AWS, Codex on Bedrock, Amazon Q Developer) · Quick Suite and Quick
Desktop **for the business-vs-engineer boundary only** · Strands Agents, MCP, A2A
· agentic and autonomous development practices, AI-DLC, spec-driven development,
context engineering, cost control · distillations of blogs, papers and talks in
those areas with attribution.

**OUT:** pre-genAI AI/ML services with no developer-agent relevance (Rekognition,
Textract, Comprehend, Transcribe, Polly, Translate, Lex, Personalize, Kendra,
Fraud Detector, Lookout family, Monitron, HealthLake/HealthScribe) · silicon
(Trainium, Inferentia, Neuron) unless it appears in a developer workflow ·
competitor product surfaces except as references inside positioning cards · Quick
end-user how-tos.

**Test:** a card is in scope if a developer, or an SA advising developers, would
act on it. The IN/OUT list is followed exactly rather than judged case by case.

## 5. Functional requirements

### FR-1 Card data is git-versioned, not embedded in HTML
One JSON file per card under `cards/`. Git is the source of truth for card
content. The single-file HTML becomes a build artifact.

### FR-2 Every card carries lifecycle and provenance metadata
`card_id`, `kind`, `lifecycle`, `service`, `tags[]`, `aka[]`, `superseded_by`,
`sources[]` (url + fetched_at + content_hash), `verified_at`, `confidence`,
`depends_on[]` — present on every card from P0, including fields no phase before
P4/P5 consumes.

### FR-3 Facts are separated from prose
Numbers, prices, dates and region lists live in **fact sets** under `facts/`,
written **only** by deterministic ingest jobs. Card prose references them by
placeholder. A model may never author a value in a fact set.

- FR-3.1 The build fails on an unresolvable placeholder.
- FR-3.2 A fact whose `tier` is `seed` is a pre-existing unverified literal
  carried over from the hand-authored deck. It is rendered, but reported by
  `validate` and eligible for replacement by any deterministic source.

### FR-4 The build renders both artifacts from one data source
`dist/deck.json` (the read-plane payload, per-category chunkable) and
`dist/agentcore-flashcards.html` (offline/field single file). Identical card
content in both.

### FR-5 Rendering parity with the legacy deck
For the 21 migrated cards, the generated front and back face HTML must be
**string-identical** to what the legacy `DECK` array produces through the legacy
template, and the CSS and pictogram library must be byte-identical. Verified by
an automated gate, not by eye.

### FR-6 Deterministic ingest (Tier A)
Read-only jobs that fetch:
- **Region availability** — SSM public parameters
  `/aws/service/global-infrastructure/services/<code>/regions`
- **Pricing** — AWS Price List Query API (`describe-services` / `get-products`)
- **API surface** — botocore service model, canonicalised and fingerprinted

Each job writes a fact set with `source.url`, `source.fetched_at`,
`source.content_hash`, and `verified_at`. No model is involved at any point.

### FR-7 Citation gate
No card may be published with a fact-governed claim that has no `sources[]`
entry from a fetch performed in that run. Enforced by `validate`, which the build
runs first.

### FR-8 Correction is a diffable, reviewable event
When a deterministic source disagrees with a card's current rendered claim, the
ingest job rewrites the card's fact-governed slot, appends a provenance record,
and leaves a git diff on both the card and the fact set. Nothing is edited in
place without a recorded reason.

### FR-9 Identity is stable; rename and retirement are aliasing
- Card IDs are stable for the life of the concept and are **never reused**.
- A renamed thing keeps its card and gains an `aka[]` entry with the old name and
  the change date.
- A superseded thing sets `superseded_by` and stays reachable.
- A retired card becomes a tombstone: resolves on its deep link, renders a
  "retired / see X" state, preserves learner progress.
- **No card is ever deleted.** `validate` fails if a previously present
  `card_id` disappears from `cards/`.

### FR-10 Dependency fan-out (schema in P0/P1, execution in P5)
`depends_on[]` declares the service-fact cards a practice / distillation /
mental-model card depends on. A material change to a service-fact card flags
every dependent card `needs_review`. Quick-vs-Kiro boundary cards declare
`depends_on` on **both** sides.

### FR-11 Provenance is visible to the learner
The back face shows `verified_at` and source links. A card whose facts are
`seed`-tier or which is `needs_review` is visibly marked as such rather than
silently presented as verified.

### FR-12 Tier routing exists in data from P0
Every change carries a tier: **A** deterministic/auto-commit · **B**
model-drafted, grounded, verifier-gated, auto-publish · **C** model-drafted,
human-gated via PR. All Quick-vs-Kiro boundary claims are Tier C by definition.
The schema and the apply-path record the tier even in phases where only Tier A
runs.

## 6. Non-functional requirements

- **NFR-1 Zero runtime dependencies.** Node's built-in TypeScript execution; no
  npm install, no lockfile, no supply-chain surface. Validation is a
  hand-written checker over the published JSON Schema subset actually used.
- **NFR-2 Offline-capable read.** The single-file HTML works with no network.
- **NFR-3 Determinism.** Same inputs ⇒ byte-identical outputs. Stable key order,
  stable sort, no timestamps in rendered artifacts except explicit `verified_at`.
- **NFR-4 Accessibility.** Fix the legacy defect where both card faces are always
  in the DOM and read by screen readers; toggle `aria-hidden` on flip. Honour
  `prefers-reduced-motion`. (Deferred to P3 with the frontend work, because
  changing it now would break the FR-5 parity gate — see design §9.)
- **NFR-5 No AWS writes.** The pipeline's read plane is the only thing that ever
  touches AWS state, and only from P3. Ingest is read-only forever.

## 7. Constraints for this run (P0–P2)

- Hard stop after P2. No AWS resource created, modified or deleted. Read-only
  AWS API calls only.
- Commit locally. No push, no PR.
- Deck stays at 21 cards; authoring at scale is P6.
- No IaC scaffolding for P3–P6.

## 8. Phase exit criteria

| Phase | Exit criterion |
|---|---|
| **P0** Spec | Card JSON schema validates all 21 migrated cards with no data loss |
| **P1** Data-driven build | The 21 cards render identically to the legacy file, from data |
| **P2** Tier A ingest | One card provably auto-corrected end to end from deterministic data with zero model involvement, evidenced by the card diff and the provenance record |
| **P3** Read plane | Public URL serves the generated deck; cache invalidated on merge |
| **P4** Tier B/C loop | Verifier catches an injected hallucination in the golden fixtures |
| **P5** Rename/retire + fan-out | Both rename fixtures handled correctly; a dependent practice card gets flagged |
| **P6** Content scale-up | Full in-scope surface incl. the Quick boundary set |

## 9. Out of scope for v1

No authentication or multi-user backend. No model-generated numbers or dates. No
scraping behind logins or paywalls. No DynamoDB unless sub-daily Tier A updates
without commits become a real requirement. No AWS AI services outside §4.
