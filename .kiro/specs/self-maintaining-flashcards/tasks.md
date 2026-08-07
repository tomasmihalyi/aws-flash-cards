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

## P4 — Tier B/C loop (not in this run)

- [ ] T4.1 Claim decomposition
- [ ] T4.2 Verifier: string-match numeric/date/region claims against fetched
      source text
- [ ] T4.3 Golden set of ~30 hand-verified cards as regression fixtures
- [ ] T4.4 Bedrock drafting with a schema-constrained output
- [ ] T4.5 Tier demotion path (any verifier failure ⇒ whole card to Tier C)
- [ ] T4.6 PR automation for Tier C
- [ ] T4.7 Researcher agent on AgentCore Runtime (Gateway + Memory + Evaluations
      + Policy). Scope: ambiguous launch item → card draft with citations. Nothing
      else moves to AgentCore.

**Exit:** the verifier catches an injected hallucination in the fixtures.

## P5 — Rename, retirement, fan-out (not in this run)

- [ ] T5.1 What's New RSS ingest + title-language signals
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
