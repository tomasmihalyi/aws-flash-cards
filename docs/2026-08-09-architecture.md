# Architecture — AWS AI-Native Development Flashcards

As built, 2026-08-10. 30 cards, 15 fact sets, 10 ingests, 7 gates, 280 tests.

The one structural idea: **facts and prose are separate stores, and only
deterministic code may write facts.** Everything below is a consequence of that.

---

## 1. The whole system

```
 SOURCES OF TRUTH                      DETERMINISTIC INGEST            STORES
 ─────────────────────────────         ────────────────────────        ──────────────

 AWS APIs (read-only, allow-listed)
 ┌──────────────────────────────┐
 │ SSM global-infrastructure    │──▶ ssm-regions.ts ───────┐
 │ Price List  GetProducts      │──▶ pricelist.ts ─────────┤
 │ Service Quotas  List*        │──▶ service-quotas.ts ────┤
 └──────────────────────────────┘                          │
        ▲  credentials required                            │
        │  (3 of 13 ingests)                               ▼
                                                    ┌──────────────┐
 Public HTTPS (no credentials)                      │  facts/*.json│
 ┌──────────────────────────────┐                   │              │
 │ docs release-notes  (month)  │──▶ docs-release-notes.ts ──▶      │  15 sets
 │ docs doc-history    (day)    │──▶ docs-doc-history.ts ───▶       │  every value
 │ agentcore-regions matrix     │──▶ docs-feature-regions.ts ─▶     │  carries a
 │ service "what is" pages      │──▶ docs-pages.ts ─────────▶       │  content_hash
 │ kiro.dev · strands README    │──▶ (docs-pages, vendor-docs)      │  + retained
 │ kiro changelog Atom  (day)   │──▶ kiro-changelog.ts ─────▶       │    evidence
 │ github releases Atom (day)   │──▶ github-releases.ts ────▶       │
 └──────────────────────────────┘                   │              │
                                                    └──────┬───────┘
 Local snapshot                                            │
 ┌──────────────────────────────┐                          │
 │ botocore service models      │──▶ botocore-diff.ts ─────┘
 └──────────────────────────────┘

                                                           │  facts only
                                                           ▼
                            ┌──────────────────────────────────────────┐
                            │  APPLIERS — the only writers of a slot    │
                            │                                          │
                            │  apply.ts          resolve · verify ·     │
                            │                    correct · or FAIL      │
                            │  apply-lifecycle.ts  preview ⇄ ga badge  │
                            │  apply-rename.ts     title → aka[]        │
                            └───────────────────┬──────────────────────┘
                                                │ writes slots + provenance
                                                ▼
                                        ┌───────────────┐
                                        │  cards/*.json │  30 cards, 10 categories
                                        │               │  prose authored by a human
                                        │  slots{}  ◀───┘  or model (Tier B/C)
                                        │  provenance[]    slots ONLY by an applier
                                        └───────┬───────┘
                                                │
                                                ▼
                                          git = source of truth
```

**The seam that matters.** A card never stores a number a fact could supply. It
stores `{{slot:name}}`, and only an applier may fill it. So "numbers are never
model-generated" is a property of the write path, not a policy someone remembers.

---

## 2. The gates (`npm run check`)

```
  cards/ + facts/
        │
        ├─▶ validate.ts        schema · 20+ lint rules · citation gate
        │                      L-CITATION   resolved slot ⇒ sources[] + verified_at
        │                      L-EVIDENCE   content_hash must re-hash (ERROR)
        │                      L-NUMERIC    ungoverned literal (warn; past dates exempt)
        │                      L-UNRESOLVABLE  seed ⇒ flagged; authored ⇒ signed off
        │
        ├─▶ node --test        280 tests · behaviour, guarantees, verifier,
        │                      ingest parsers, atom/coverage, rename, lint
        │
        ├─▶ build.ts           cards + facts + template ─▶ dist/
        │
        ├─▶ verify-parity.ts   revert slots to seed_text, invert recorded
        │                      corrections ⇒ must equal the ORIGINAL 21 cards
        │
        ├─▶ verify-claims.ts   decompose every card into claims;
        │                      string-match each against retained evidence.
        │                      Any failure demotes the WHOLE card to Tier C
        │
        ├─▶ check-lifecycle.ts is a preview/GA badge stale?
        └─▶ check-rename.ts    has the thing been renamed? (needs 2 sources)

  reports, never fails the build:
  └─▶ check-coverage.ts        what has been PUBLISHED that no card covers?
                               a source may only cover a card in its own service

  + tools/browser-check.mjs    real Chromium: a11y, study queue, deep links,
                               provenance footer, no console errors
```

`verify-claims` and `validate` ask **different** questions — is this true, versus
will it re-render from a source — which is why a past date is exempt from one and
still checked by the other.

---

## 3. Build output

```
  dist/deck.json                              structured, 30 cards
  dist/aws-ai-native-development-flashcards.html   single file, offline, ~123 KB
        │
        └─ inlined verbatim from src/lib/:  deck-state.js · srs.js
           (plain JS with JSDoc, because they run in a browser AND under node --test
            — one implementation, shared with the tests)
```

Zero runtime dependencies. Node's native TypeScript type-stripping, no build step,
no `node_modules`.

---

## 4. The learner-facing loop

```
  a Tier A ingest corrects a price
        │
        ▼
  card's content hash changes ──▶ SRS marks it `changed`   ──▶ front of queue,
        │                                                       amber banner
        │
        └─▶ cards that DEPEND on it ──▶ `context`          ──▶ after changed,
            (dhash fingerprint)                                blue banner naming
                                                               the card that moved
```

Neither SM-2 nor FSRS models a card whose *answer* changed. That is the whole
reason the scheduler lives in this repo instead of being imported.

---

## 5. Refresh — the gap between "maintainable" and "maintaining"

Everything above is **manual today**. Nothing schedules it.

```
  NOW (manual)
    npm run refresh   = ingest → apply → apply:rename → build
    npm run check     = the 7 gates above

  PROPOSED — local, KiroCrew cron (zero infra, zero tokens)
    ┌────────────────────────────────────────────────────┐
    │ weekly · docs-only · NO credentials needed         │
    │   ingest:docs → apply → check → report diff        │
    │   stage, do not auto-commit                        │
    └────────────────────────────────────────────────────┘
    ┌────────────────────────────────────────────────────┐
    │ occasional · attended · needs AWS SSO              │
    │   ingest:regions + ingest:pricing + ingest:quotas  │
    └────────────────────────────────────────────────────┘
      ✗ does not run with the laptop shut (leave: Aug 24 – Oct 5)
      ✗ fails safely if the SSO token has expired

  LATER — on AWS, after the repo exists (T3.10 dependency)
    EventBridge Schedule ─▶ CodeBuild (Node ≥ 22.18, IAM role)
                              │  git clone → npm run refresh → npm run check
                              └─▶ commit + push, or open a PR
      ✓ no SSO expiry — IAM role
      ✓ runs through leave
```

---

## 6. Parked: the read plane (T3.10)

```
  git push ──▶ CI ──▶ S3 (private) ──▶ CloudFront + OAC ──▶ public HTTPS
                          demo account <deploy-account> · ap-southeast-2
                          CloudFront default domain · no auth
```

Blocked on one human step: the project lives inside the Activity vault with no
remote. It needs extracting into its own repo (`tomyister`, via
`git subtree split` to preserve history) before publish-on-merge can exist. That
same step unblocks PR automation for Tier C (T4.6).

---

## Trust boundaries, stated plainly

| Boundary | Enforcement |
|---|---|
| Ingest cannot write to AWS | `src/lib/aws.ts` holds an explicit `(service, operation)` allow-list — 6 pairs, all reads. Not a `describe/list/get` heuristic |
| A model cannot write a number | slots are written only by an applier, from a hashed fact set |
| An agent cannot ship a judgement | Tier C ⇒ `needs_review` ⇒ blocks on `signed_off.by` |
| A correction cannot be silent | append-only `provenance[]`; the parity gate fails on an unrecorded change |
| Endorsement is not verification | `deriveConfidence` caps an unsourced card at `medium` regardless of sign-off |
