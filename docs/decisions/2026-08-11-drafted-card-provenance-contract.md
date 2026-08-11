# The provenance contract for a drafted card change

**Date:** 2026-08-11
**Status:** Binding — enforced by `tests/apply-draft.test.ts` and the parity gate
**Scope:** `tools/apply-draft.ts`, `src/lib/provenance.ts`, `tests/guarantees.test.ts`

Written down because it was learned through two defects and, until now, existed
only as assertions. A contract that lives only in tests is discoverable by
breaking it.

## The guarantee this serves

> Nothing changes without a recorded reason.

Not "nothing changes" — that forbids all change forever, which is the trap the
original byte-for-byte DOM gate fell into. The parity gate enforces the weaker and
far more useful version: revert every slot to its `seed_text`, invert every
recorded field correction, and the result must equal the original deck exactly.

Everything below follows from the word **invert**.

## Rule 1 — one history entry per changed field, each naming its path

A `correct` entry must carry `field` and `before`. An entry that names no field
inverts nothing.

```jsonc
// RIGHT — three fields changed, three invertible entries
{ "action": "correct", "field": "hook",          "before": "…", "after": "…" }
{ "action": "correct", "field": "back.lead",     "before": "…", "after": "…" }
{ "action": "correct", "field": "back.hookline", "before": "…", "after": "…" }

// WRONG — one entry for the whole card
{ "action": "correct", "before": "<the old lead>", "after": "<the new lead>" }
```

**Defect 1.** The first version of `apply-draft.ts` wrote the second form. Parity
failed with:

```
FAIL AC-19: authored text differs with no recorded field correction to explain it
```

The correction *was* recorded. It just wasn't recorded in a shape anything could
reverse, so the gate was correct to call it unexplained.

## Rule 2 — a field path may be nested, and the inversion must walk it

`originalProjection` used to invert with a flat assignment:

```ts
(clone as Record<string, string>)[field] = before;   // WRONG for nested paths
```

That is correct for every field ever corrected before Tier B — `lifecycle`,
`badge_variant`, `badge_text`, `title`, all top level — and for `back.lead` it
silently creates a junk property literally named `"back.lead"` while leaving the
real prose untouched.

**Defect 2**, and the reason it was hard to see: the recorded reason existed, the
gate reported it missing, and both were telling the truth about different things.

Supported forms:

| Path | Resolves to |
|---|---|
| `hook` | `card.hook` |
| `back.lead` | `card.back.lead` |
| `back.hookline` | `card.back.hookline` |
| `back.kv[2].v` | `card.back.kv[2].v` |

A path that cannot be walked changes nothing rather than corrupting the card, so a
malformed entry is visible instead of destructive.

## Rule 3 — the earliest entry per field carries the original

History is append-only and chronological, so the *first* recorded `before` for a
field is the one parity reverts to. A second correction to the same field does not
overwrite it.

## Rule 4 — raising a review flag is a ledger event, not a field

`needs_review` and `review_reasons` are **live state**, and `tools/sign-off.ts`
removes the reasons when a human approves. A flag recorded only there is erased by
its own approval.

So raising it must also append:

```jsonc
{ "action": "flag-review", "tier": "C", "reason": "<why>", "generator": "…" }
```

**Defect 3**, found the moment the first drafted card was signed off:

```
clearing a review flag never erases why it was raised
AC-05: signed off but the history never records it being flagged
```

The existing guarantee only fired once a card was *both* flagged and signed off,
so a card left flagged and unsigned could carry `needs_review: true` indefinitely
with the ledger silent. A counterpart invariant now catches it at raise time:
**any card with `needs_review` set must have a `flag-review` entry.**

## Rule 5 — a drafted card is Tier C even when the gate accepted it

`provenance.tier = 'C'`, `authored_by = 'model'`, `needs_review = true`, and
`signed_off = null`.

Not a hedge. The verifier proves there is no fabricated **fact**; it cannot prove
the prose is **good** — a rewrite can be entirely true and still vaguer, or subtly
off about a positioning boundary. That judgement has no deterministic source,
which makes it Tier C by this repository's own rule.

`signed_off` is cleared because a previous human's approval says nothing about
prose written after it.

The consequence worth stating: if one of these branches were merged without being
read, the card renders as *needing review* rather than passing itself off as
verified. Marking it Tier C is the defence that survives a careless merge.

## Rule 6 — the gate re-runs at apply time

The draft artifact is a file on disk, editable between generation and
application. If the gate ran only at generation, the **file** would be the thing
authorising a card change rather than the gate. So `checkDraft` runs again against
the card's current state, and the recorded verdict is read as a claim about the
past — never as permission. A verdict that changed in between is reported to the
reviewer rather than hidden.

## How each rule is enforced

| Rule | Enforced by |
|---|---|
| 1, 2, 3 | `tests/apply-draft.test.ts` + `npm run parity` |
| 4 | `tests/guarantees.test.ts` — both the raise and the clear invariants |
| 5 | `tools/apply-draft.ts`; visible in the card diff a reviewer reads |
| 6 | `tools/apply-draft.ts`, reported in its own output |

Rules 1, 2 and 4 were each mutation-checked: the fix reverted, the test confirmed
failing, the fix restored. A test that has never failed is not known to work.
