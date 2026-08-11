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
- [x] T4.4 Bedrock drafting with a schema-constrained output. `src/lib/bedrock.ts`
      (CLI invocation, so NFR-1's zero dependencies survives), `src/lib/draft-gate.ts`
      (pure, 23 adversarial tests), `src/ingest/draft.ts`, and a separate
      `flashcards-draft` IAM role scoped to one inference profile.

      **The model sits inside the gate, never in place of it.** It rewrites prose
      around slots it must reproduce verbatim; every number still comes from a Tier
      A fact set. Three outcomes, and the third is the point: `accept` writes at
      Tier B, `review` opens a PR at Tier C, and `discard` writes nothing **and
      deliberately opens no PR** — handing a reviewer well-formed prose containing a
      fabricated number and relying on them to spot it is how a fabrication gets
      merged.

      The gate is stricter than L-NUMERIC by design. L-NUMERIC exempts a past date
      because it cannot drift; that exemption is sound for prose a human vouched for
      and unsound for a model, where the question is fabrication rather than drift.
      The rule is **may preserve, never introduce**: a digit is legal only where the
      identical span already appears in the original field.

      **Three defects found by running it, not by reading it:**

      | Defect | Why reading missed it |
      |---|---|
      | model id `apac.` does not exist in this account | documented examples use it; `list-inference-profiles` reports `au.` and `global.` |
      | `ACCEPT — every checkable claim verified (0)` | the draft still held `{{slot:…}}`, so the number was absent from the decomposed text and there was nothing to check. The gate accepted a draft it had not examined |
      | zero checkable claims read as acceptance | "no claim failed" is not "a claim passed" — the same error as stamping a fresh `verified_at` on a fact that never fetched |

      Each is pinned by a test, and each test was mutation-checked by reverting the
      fix and confirming the test fails.

      **Exercised once end to end** against `au.anthropic.claude-sonnet-4-5` on
      AC-19: ACCEPT, 3 checkable claims verified. **Not yet in CI** — the
      `flashcards-draft` role is in the template but undeployed, and no workflow
      calls it. Until it runs unattended it is built, not proven.
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

- [x] T6.4 **P6 batch 2 — the model layer and the framework.** BR-01 Amazon
      Bedrock, BR-02 Five ways to call a Bedrock model, ST-01 Strands Agents,
      ST-02 Strands or AgentCore? (mental-model, unsourced by design). 26 -> 30
      cards; two appended categories (`bedrock`, `frameworks`).

      `docs-pages.ts` gained declared fact EXTRACTION, because a page's evidence
      text lets the verifier check a number while only a fact can govern one.
      Three numbers arrived with these cards and none is typed into prose:
      Bedrock's model-count floor, and the Python/Node minimums.

      "100+" is a FLOOR. The slot renders "over 100" and the fact's note says why,
      because rendering it as "100 foundation models" converts a lower bound into
      a count — wrong in the direction that looks precise.

      Two gaps found by reading the output rather than the code:

      1. checkable claims stayed at 28 across four new cards. The unit list in
         `claims.ts` is an ALLOW-LIST, so "100 foundation models" was governed by
         a slot and a fact but never string-checked, because `models` was not on
         it. Added `models`, `providers`, `hours`; the limitation is now documented
         next to the pattern instead of being a surprise each time.
      2. a test pinned the `agentcore` tag at exactly 21 as a proxy for "the index
         is derived". ST-02 legitimately carries that tag while being a Strands
         card, so the assertion now counts the cards holding each tag.

      Strands is cited as `strands-agents/harness-sdk`, not `sdk-python`: the
      latter still resolves but REDIRECTS, and the raw READMEs are byte-identical.

- [x] T6.5 **Renamed the deck to "AWS AI-Native Development Flashcards".** The page
      said "AgentCore Flashcards / The full platform, one primitive per card" — true
      of 21 AgentCore cards, false of 30 spanning AgentCore, Bedrock, Strands, the
      coding agents and Quick.

      Changed: `<title>`, the eyebrow (was "Amazon Bedrock · Field Deck", too narrow
      once Kiro, Q Developer and Quick were in), the `<h1>`, the subtitle, and the
      build output filename (`dist/aws-ai-native-development-flashcards.html`).

      Landed as "AWS Agentic AI Flashcards" first and was corrected, for the reason
      that correction was flagged when the first name went in: "Agentic AI" is a
      tighter claim than the deck makes. QK-01/02/03 and parts of the coding-agent
      cards are about the business-versus-engineer boundary rather than agents as
      such. The title now matches this spec's OWN title — "Requirements —
      Self-Maintaining AI-Native Development Flashcards" — so the deck's name and
      the document defining it no longer disagree. (§4 is the service-by-service
      IN/OUT list; it never names the domain, so it is what the title must be
      CONSISTENT with rather than what it copies.)

      The output filename had been a literal in three places — build.ts,
      verify-parity.ts and browser-check.mjs — so it is now `DIST_HTML` in
      store.ts. That is why the second rename was one line rather than three, and
      the reason for doing it that way was exactly this: a gate left pointing at a
      stale name fails for a reason unrelated to the deck being wrong.

      **`agentcore-flashcards.html` at the repo root keeps its name.** It is the
      parity gate's reference — the artefact the migration must be shown not to
      have lost — and 21 cards carry a provenance entry reading "Mechanical
      migration from agentcore-flashcards.html". Renaming it would make an
      append-only historical record point at a file that does not exist, and would
      dress the original up as a current build.

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
- [x] T5.2 **Rename detection and aliasing** (`src/lib/rename.ts`,
      `src/check-rename.ts`, `src/ingest/apply-rename.ts`). AC-14 was titled
      "Agent Registry" while two AWS docs surfaces said "AWS Agent Registry", and
      `aka[]` had existed since the first schema with nothing ever writing to it.

      **A rename needs two sources where a lifecycle transition needs one.** "Is
      now generally available" is a fixed phrase with one meaning; a product NAME
      is not. AgentCore's own notes carry three candidate names across two
      entries ("AgentCore Registry" in April, "AWS Agent Registry" in August). So
      a rename is applied only when a second INDEPENDENT source (by URL, not by
      fact set) uses the same name verbatim — here the feature × region matrix.
      One source proposing a name is a candidate for review; two agreeing is a
      fact.

      Corpus check before applying: of 366 dated headings, the patterns fire on
      exactly 1, and 0 headings containing rename-ish words are missed.

      **Kept out of scope on purpose:** `lifecycle` (the August entry has no GA
      language; April independently confirms `preview`), `service` (the pinned
      botocore snapshot still has all 12 Registry ops under
      `bedrock-agentcore-control` and lacks the `ListDiscoverableRegistryRecords`
      the same entry announces, so the namespace is recorded but not acted on),
      and prose (Tier C — the new name contains the old one, so substitution is
      not idempotent without a guard).

      Two defects found while building it, both caught by existing gates rather
      than by inspection:

      1. `apply-rename.ts` had an unguarded `main()`, so importing
         `substituteName` in a test ran the applier and wrote to cards. It
         produced the right result, which is the dangerous kind of accident. Now
         behind `import.meta.filename === process.argv[1]`, as the other ingests
         already were.
      2. `verified_at ??= now` stamped the card as verified today against sources
         fetched yesterday. `tests/guarantees.test.ts` — "a card is only as fresh
         as its stalest source" — failed on it. Now derived from the oldest
         source fetch.

      `originalProjection` now inverts `rename` field entries as well as
      `correct` ones: a rename is a recorded reason too. The two actions stay
      distinct in the ledger because a correction says the card was wrong and a
      rename says the world renamed it.

      One rendering defect surfaced: AC-14 is the first card citing two different
      AWS docs pages, and labelling sources by hostname produced
      "docs.aws.amazon.com · docs.aws.amazon.com". Deduplicating would have
      hidden a source the citation gate requires, so docs URLs now label by page
      name instead.

- [ ] T5.1b What's New title-language signals for rename detection — superseded in
      practice by T5.2, which reads rename language from the docs release notes and
      document history instead. What's New remains unusable for this deck (RSS ~11
      days, archive frozen at 2024-05-17), so this stays open only as a
      second-corroboration source if it ever becomes reachable.
- [ ] T5.2 Doc URL redirect detection (301/302 on previously-200 URLs)
- [ ] T5.3 Price List product disappearance signal
- [ ] T5.4 botocore rename-vs-remove discrimination (shape-identity test)
- [ ] T5.5 Non-AWS changelogs (Claude Code, Codex)
- [ ] T5.6 Automatic rename ⇒ `aka[]` + commit
- [ ] T5.7 Human-gated retirement ⇒ PR + tombstone render state
- [x] T5.8 **Dependency fan-out — resurface the cards that build on a corrected
      one.** `depends_on` had existed since P0, was carried into `dist/deck.json`,
      and never reached the page — so the scheduler could not see a single edge.
      The SRS resurfaced a card whose own `chash` moved and nothing downstream of
      it: correcting AC-04 left AC-18, which quotes Runtime's pricing, sitting on
      whatever interval it had. The stated guarantee ("a corrected card is
      re-studied, not left memorised wrong") held for the card that changed and
      failed silently for everything built on it. 12 cards carry 41 edges.

      **Two signals, kept distinct.** A review now also records `dhash`, a
      fingerprint of the card's dependencies. `changed` means this card's answer
      moved; the new `context` means a card it builds on moved. A context-stale
      card is NOT wrong — its own claims still verify — so it gets cooler wording,
      a cooler colour, and a banner that names the dependency instead of implying
      the card is stale.

      Ranked `changed` > `context` > `new` > `due`. Context above `new` because a
      context-stale card is one the learner already believes something about on the
      basis of a card that has since been corrected — an active risk of holding a
      stale belief, which is worse than not having seen a card yet.

      Design choices worth keeping:

      - the fingerprint is a plain sorted `id:chash` concatenation, not a hash. It
        is only compared for equality, and a readable value is one a human can
        debug straight out of localStorage.
      - `deps` is excluded from `AuthoredText`. Folding it into the content hash
        would change the hash of every card with dependencies, invalidating real
        review history to record a fact about the graph rather than the text.
      - an absent `dhash` reads as "unknown", never "changed". Reading it as
        changed would have dumped every dependent card into the queue on upgrade,
        announcing a correction that never happened. SCHEMA_VERSION stays 1
        because the field degrades safely.
      - a dependency missing from the deck counts as movement, so removing a card
        a learner had studied still surfaces.
      - `byId` is an optional argument, so a caller that predates dependencies
        degrades to the old behaviour instead of throwing.

      11 new SRS tests and 5 new browser assertions, including the end-to-end
      case: study AC-02, schedule it a decade out, move AC-04, and the banner reads
      "This card's own claims still check out, but a card it depends on was
      corrected since you last studied it: AC-04 — AgentCore Runtime."

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
| Repo extraction | done 2026-08-10 | Created under `tomyister`, then transferred to `tomasmihalyi` on 2026-08-11 (owner id `34014084` → `20979055`, repo id `1329366635` carried through). `git subtree split` preserved the commit history. The owner id is part of the OIDC subject, so the transfer required a `FlashcardsGitHubOIDC` stack update. |
| `dist/` not committed | — | The parent vault's `.gitignore` excludes `dist`. Regenerable from `cards/` + `facts/` via `node src/build.ts`, and the P1 baseline copy under `tests/fixtures/` is committed, so no evidence is lost. |

### Closed since the original list

- **a11y `aria-hidden` fix** — was blocked by the byte-parity gate. Gate replaced
  (T3.1), fix landed (T3.2), verified in a browser.
- **Page-chrome staleness** — the hand-maintained "current to mid-2026" line and
  the unsourced "GA OCT 2025" badge are gone; the header is derived (T3.11).
