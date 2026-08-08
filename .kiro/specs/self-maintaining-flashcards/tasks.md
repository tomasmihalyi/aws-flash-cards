# Tasks — Self-Maintaining AI-Native Development Flashcards

Legend: `[x]` done · `[ ]` not started · `[-]` deliberately deferred to a later phase

---

## P0 — Spec

- [x] T0.1 Read and record the binding design doc as the contract
- [x] T0.2 `requirements.md` — problem, scope boundary, FR/NFR, phase gates
- [x] T0.3 `design.md` — fact/prose separation, slots, data model, all 7 phases
- [x] T0.4 `tasks.md` — this file
- [x] T0.5 `schema/card.schema.json` — every field, including P4/P5-only ones
- [x] T0.6 `schema/fact-set.schema.json`
- [x] T0.7 `content/categories.json` — ordered category taxonomy
- [x] T0.8 Inclusion policy committed (requirements §4)

**Exit:** schema validates all 21 migrated cards with no data loss → verified by
`npm-free` run of `src/validate.ts` after T1.2.

## P1 — Data-driven build

- [x] T1.1 `tools/extract-legacy.ts` — evaluate the legacy `DECK`/`CAT`/`ART`
      literals in a `node:vm` sandbox and emit `cards/*.json`, `content/art.json`.
      Mechanical extraction, not transcription — no chance of a typo changing a
      card's text.
- [x] T1.2 Semantic overlay table (`tools/card-semantics.ts`): per card the
      fields the legacy data cannot supply — `kind`, `lifecycle`, `service`,
      `tags[]`, `depends_on[]`, slot declarations.
- [x] T1.3 `src/lib/render.ts` — single render function used by both outputs
- [x] T1.4 `src/lib/facts.ts` — slot resolution, placeholder expansion, fail-loud
      on unresolvable
- [x] T1.5 `src/validate.ts` — schema check + lint rules + citation gate
- [x] T1.6 `src/build.ts` — `dist/deck.json` + `dist/agentcore-flashcards.html`
- [x] T1.7 `src/verify-parity.ts` — data parity, render parity, asset parity
- [x] T1.8 Commit the parity baseline under `tests/fixtures/p1-parity-baseline/`
      so P2's correction diff has something to be a diff *against*

**Exit:** `verify-parity` passes on all 21 cards × 2 faces + CSS + art hashes.

## P2 — Tier A ingest (read-only)

- [x] T2.1 `src/lib/aws.ts` — read-only AWS CLI wrapper. Hard allow-list of
      verbs; refuses anything that is not a read.
- [x] T2.2 `src/lib/hash.ts` — canonicalise + sha256 for content hashes
- [x] T2.3 `src/ingest/ssm-regions.ts` — SSM public parameters → fact set
- [x] T2.4 `src/ingest/pricelist.ts` — Price List API → fact set
- [x] T2.5 `src/ingest/botocore-diff.ts` — service model → canonical operation
      list + fingerprint, diffed against the committed snapshot
- [x] T2.6 `src/ingest/apply.ts` — resolve Tier A slots; verify, correct, or fail
- [x] T2.7 Demonstrate one end-to-end correction with a card diff and a
      provenance record
- [x] T2.8 Record what the deterministic sources *cannot* substantiate
      (design §4.1) rather than overreaching
- [x] T2.9 Re-base the parity gate on the durable invariant: the deck must be
      identical to the original **except** where a deterministic source
      corrected a fact-governed slot. The original "nothing changed" form was
      going to be permanently red the moment ingest worked, which would have
      trained everyone to ignore it.

**Exit:** one card provably auto-corrected from deterministic data, zero model
involvement, evidenced by the before/after diff and the provenance record.

**Result:** met. Five corrections across AC-05, AC-18 and AC-19. Headline —
AC-19 `region_availability` moved from *"previewed in four regions … expanded
steadily since"* to *"available in 19 AWS regions, including Asia Pacific
(Sydney)"*, sourced from SSM with a content hash. Commit `2750b06`.

## P3 — Read plane + frontend at scale

Split deliberately: the frontend half is entirely local and proceeding; the
deploy half is parked until a repo and CI exist.

- [x] T3.1 Replace the FR-5 byte-parity gate with a behavioural test suite
      (**had to land before any DOM change**). State machine extracted to
      `src/lib/deck-state.js`; 58 tests across `tests/`. `verify-parity` now
      checks *authored content* parity, not DOM bytes.
- [x] T3.2 NFR-4 a11y fix: `aria-hidden` toggling on flip, plus `aria-pressed`
      and a label that states which side is showing. Verified in a real browser,
      not just in the state machine.
- [x] T3.8 Per-card provenance display on the back face — verification date,
      source links, and an explicit "Unverified" marker with the reason when no
      deterministic source exists.
- [x] T3.11 Page-chrome staleness closed: the header's hand-maintained
      *"Content is current to mid-2026"* and unsourced *"GA OCT 2025"* are gone.
      `CARDS / REGIONS / SYD REGION / VERIFIED` are all derived from cards or
      fact sets, and anything without a source is omitted rather than guessed.
- [x] T3.12 Single template source. `content/card-template.html` was being used
      for `deck.json` while `shell.html` kept its own inlined copy — they had
      already drifted, so the a11y fix and provenance footer reached the JSON but
      never the page. The template is now injected into the shell at build time.
- [x] T3.13 Cards size to their content. A fixed 520px height clipped the
      longest backs once the provenance footer was added.
- [x] T3.14 The hidden face is `inert`, not merely `aria-hidden`. Found by the
      browser check: a keyboard user could Tab onto the unseen face and hit a
      grade button — or a provenance link — on a side they had not read.
      `aria-hidden` governs what is *read*; `inert` governs what is *reachable*,
      and focusable content inside `aria-hidden` is a violation in its own right.
- [x] T3.3 Taxonomy + tag filtering, full-text search. Tags derived from the
      cards so the taxonomy cannot drift from the content; search is AND across
      tokens (an OR search over 200+ cards returns the deck and is worse than
      none) and ranked by where the match lands — id, title, tag, hook, body.
- [x] T3.4 Deep-linkable card URLs that survive rename via `aka[]`. The hash
      names a card *slug*, never an index, and resolves through aliases so a link
      shared before a rename still lands on the right card.
- [x] T3.5 Spaced repetition, progress in `localStorage`. **SM-2, not FSRS** —
      FSRS's edge comes from weights that need a few hundred personal reviews to
      optimise, and its correctness rests on 19 constants and a forgetting curve
      that cannot be verified offline against reference vectors. Shipping an
      unverifiable scheduler into a deck built on verifiability would be a quiet
      contradiction. SM-2 is forty lines and every branch has a test. Revisit
      FSRS once a real review log exists.
      **Beyond both algorithms:** a card whose content hash has changed since it
      was last studied is pulled back into the queue regardless of its interval.
      Neither SM-2 nor FSRS models a card whose *answer* changed, which is the
      normal case here — a six-month interval must not keep teaching a price a
      deterministic source corrected this morning.
- [ ] T3.6 Tracks (AgentCore deep dive, agentic coding practices, Quick-vs-Kiro,
      ANZ-relevant)
- [ ] T3.7 "What changed this week" deck from git history
- [ ] T3.9 Icon strategy at scale — verify AWS Architecture Icons licence terms
      **before** shipping them
- [ ] T3.10 S3 + CloudFront + OAC in `ap-southeast-2`; publish on merge
      (**blocked: needs its own repo + remote; deploy account confirmed as
      `demo` / <deploy-account>**)

## P4 — Tier B/C loop

The verifier half is built. The drafting half is not, and that ordering is
deliberate: the verifier is the gate, drafting is merely one producer feeding it.
Building the producer first would have meant generating cards with nothing to
check them.

- [x] T4.0 **Retain fetched evidence.** Prerequisite nobody had noticed: ingest
      stored a `content_hash` but discarded the payload, so the hash was an
      assertion nobody could check and the verifier had no source text to match
      against. Fact sets now carry `evidence.canonical` (exactly what was hashed)
      plus `evidence.text`, and `validate` re-hashes the evidence — the hash is
      now a check rather than a claim.
- [x] T4.1 Claim decomposition (`src/lib/claims.ts`). Splits on
      *checkability*, not sentences: numbers, prices, dates, regions and
      durations are checkable; positioning and framing are `judgement` and are
      never scored.
- [x] T4.2 Verifier (`src/lib/verifier.ts`). String matching only. Four verdicts
      kept distinct because they need different human responses: `verified`,
      `contradicted` (slot and prose disagree → correction), `unsupported` (no
      source → govern or cite), `unverifiable` (historical date no deterministic
      source can settle).
- [x] T4.3 Adversarial fixtures (`tests/verifier.test.ts`) — see exit below.
- [x] T4.5 Tier demotion: any failing checkable claim demotes the **whole card**
      to Tier C. Partial publication would ship the confidently-wrong artefact
      the design exists to prevent.
- [ ] T4.4 Bedrock drafting with a schema-constrained output
- [ ] T4.6 PR automation for Tier C
- [ ] T4.7 Researcher agent on AgentCore Runtime (Gateway + Memory + Evaluations
      + Policy). Scope: ambiguous launch item → card draft with citations. Nothing
      else moves to AgentCore.

**Exit:** the verifier catches an injected hallucination in the fixtures.

**Result:** met. Six adversarial cases pass — a fabricated region count (31), a
fabricated price ($0.049), a non-existent region id (eu-south-9), an off-by-one
(18 where 19 is correct and present in the source), a substring collision (9,
which is a digit inside the correct 19), and whole-card demotion when only one
claim fails. Plus the counterpart test that the *correct* card still reaches
Tier A — without it, a verifier that failed everything would satisfy all six.

**What it found on the existing deck:** 27 checkable claims, 14 verified (52%),
0 contradicted, 3 unsupported, 10 unverifiable dates, 12 judgement claims.
10 of 21 cards demote to Tier C. That is the honest state of a deck that looked
finished.

- [x] T4.8 **Close the claim gaps by fixing cards, not the verifier.** 21/28 →
      26/28 verified by adding two day-capable sources, then 28/28 by correcting
      five cards. Every gap had a different cause and needed a different fix:

      | Card | Gap | Cause | Fix |
      |---|---|---|---|
      | AC-12 | "GA in 9 regions" | card was **stale** — Evaluations is in 16 | slot promoted to Tier A off a feature × region docs matrix |
      | AC-17 | "$0.10–$3.00 per call" | card was **wrong** — the payments docs say "often under $1 or fractions of a cent" | replaced with the documented characterisation |
      | AC-01, AC-11, AC-13 | day-precision dates | **no source sees days** for these | reduced to the month the release notes attest |
      | AC-20 | "Nov 2023", "July 30 2026" | needed a source that **states** a date, not one merely dated | Bedrock document-history ingest (day precision, 264 entries) |

      New ingests: `docs-doc-history.ts` (day precision),
      `docs-feature-regions.ts` (per-feature availability), plus the AgentCore
      payments page added to `docs-pages.ts`.

      **Six verifier defects were found by distrusting its own good news.** The
      first run after the new sources reported 82%, which was wrong:

      1. a *region* claim (`eu-south-9`) verified against a region **count**,
         because the id was reduced to the number 9 — caught by the existing
         adversarial test
      2. AC-12's "9 regions" verified against **Runtime Instances**' 9, because a
         value match consulted every fact id regardless of subject
      3. a claim's own **year** counted as evidence of its own topic, so a July
         claim looked related to every July entry
      4. shared **boilerplate** ("available" 12.6% of the corpus, "support"
         34.4%) counted as relatedness
      5. a `$1` money claim matched a bare digit in a **region list**
      6. the extractor had **no month-precision date pattern**, so reducing a
         claim to "October 2025" silently downgraded it to the year "2025" —
         making the correction *weaken* the check

      Then two quality defects that produced right verdicts with wrong citations:
      AC-11's Policy GA cited "Chrome Policies" (same month, more shared words)
      while "AgentCore Policy is now Generally Available" sat beside it; and
      AC-16's CLI GA cited "Code Interpreter: Node.js Support" because `stemsOf`
      drops tokens under four characters and **CLI** was invisible — the identical
      bug `lifecycle.ts` had already fixed, on the identical card. The tokenizer is
      now shared between them rather than duplicated.

      Guards added: facts must not name a subject the claim does not; numeric
      claims need numeric facts; money needs a currency marker; ambiguous sources
      (13 region counts on one page) need a row-identifying term; relatedness needs
      a *distinctive* term, and a distinctive term in a **heading** outweighs two
      generic ones in a body; windows are clipped to entry boundaries so a
      neighbouring release note cannot vouch for a match.

      **Still refused, correctly:** AC-01's "Preview July 2025". The only July 2025
      release-notes entry is "Initial release (preview)", and the three July 16
      2025 document-history entries are Data Automation, Nova imports and custom
      model deployment. It verifies on the month via the preview entry; the *day*
      does not, and is not claimed any more.

## P5 — Rename, retirement, fan-out (not in this run)

- [x] T5.1a **Dated feature history ingest** (`src/ingest/docs-release-notes.ts`).
      Built to give the P4 verifier something to cite for date claims.
      AWS What's New was tried first and **does not work for this deck**: the
      recent RSS feed carries ~11 days, and the searchable archive's newest entry
      is 2024-05-17 — neither can reach a 2025 date. The `amazon-bedrock` tag
      stops at 2024-05 as well. The service's own documentation release-notes page
      covers 2025-07 → present, is authoritative, and is a plain public GET.
      102 dated entries across 12 months.
      **Its limit is the interesting part:** release notes are MONTH precision.
      They can attest "GA in October 2025", never "on October 13". The verifier is
      told the precision and reports a day-precision claim as `partial` rather
      than rounding a month up to a day.
- [ ] T5.1b What's New title-language signals for rename detection — still needs
      a source that reaches back further than the stale archive API
- [ ] T5.2 Doc URL redirect detection (301/302 on previously-200 URLs)
- [ ] T5.3 Price List product disappearance signal
- [ ] T5.4 botocore rename-vs-remove discrimination (shape-identity test)
- [ ] T5.5 Non-AWS changelogs (Claude Code, Codex)
- [ ] T5.6 Automatic rename ⇒ `aka[]` + commit
- [ ] T5.7 Human-gated retirement ⇒ PR + tombstone render state
- [ ] T5.8 Dependency fan-out ⇒ `needs_review` on dependents
- [ ] T5.9 Rename fixtures: Bedrock Agents → Classic (incl. closed-to-new date);
      QuickSight → Quick Suite lineage

**Exit:** both fixtures handled correctly and a dependent practice card flagged.

## P6 — Content scale-up (not in this run)

- [ ] T6.1 Bedrock, SageMaker AI (developer-relevant), Strands/MCP/A2A
- [ ] T6.2 Coding agents: Kiro, Claude Code on Bedrock, Codex on Bedrock, Q Dev
- [ ] T6.3 Quick boundary set — Tier C by definition
- [ ] T6.4 Practice cards from the three published Medium articles
- [ ] T6.5 Distillation cards with attribution
- [ ] T6.6 Grow to 200–400 cards

## Deferred with reasons

| Item | Deferred to | Why |
|---|---|---|
| Feature-level region facts (e.g. Evaluations "9 regions") | — | No deterministic source exists. Slot stays `seed` + `needs_review` with the reason recorded, and the card now says "Unverified" to the learner. Not a gap: a limit. |
| AWS Architecture Icons | P3 | Licence terms must be verified before shipping. |
| IaC for the read plane | P3 | Needs its own repo + remote first. Deploy target confirmed: `demo` / <deploy-account>, `ap-southeast-2`, CloudFront default domain, no auth. |
| Repo extraction | when Tomas creates it | Local development only for now; the repo will be created manually under the `tomyister` GitHub account. `git subtree split` preserves the commit history when the time comes. |
| `dist/` not committed | — | The parent vault's `.gitignore` excludes `dist`. Regenerable from `cards/` + `facts/` via `node src/build.ts`, and the P1 baseline copy under `tests/fixtures/` is committed, so no evidence is lost. |

### Closed since the original list

- **a11y `aria-hidden` fix** — was blocked by the byte-parity gate. Gate replaced
  (T3.1), fix landed (T3.2), verified in a browser.
- **Page-chrome staleness** — the hand-maintained "current to mid-2026" line and
  the unsourced "GA OCT 2025" badge are gone; the header is derived (T3.11).
