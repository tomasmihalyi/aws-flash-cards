# Scope widened: AI-native development → AWS AI broadly

**Date:** 2026-08-20
**Status:** Decided (supersedes §4 of `.kiro/specs/self-maintaining-flashcards/requirements.md`)

## Context

The deck's stated scope since its rename was narrow and deliberate: "a card is
in scope if a developer, or an SA advising developers, would act on it." That
test explicitly excluded pre-genAI perception/language/personalisation services
(Rekognition, Comprehend, Personalize, Kendra, HealthLake, etc.) even where AWS
ships genuinely new capability in them.

The question that surfaced this: how should the deck represent models newly
supported on Bedrock (e.g. a coverage gap for "Amazon Bedrock now supports
SpaceXAI Grok 4.6")? Investigating it surfaced that this project had *already*
answered the adjacent question twice, in `content/coverage-ignore.json`: a
per-model card is the wrong shape because the roster moves faster than a card
can stay current, and the teachable idea is the pattern ("Bedrock's model layer
is provider-agnostic and grows constantly"), not any one model.

That answer didn't resolve on its own whether Bedrock's model *catalogue* as a
whole deserved deeper treatment — and answering that well required deciding
what the deck is *for* first, because the answer differs under "AI-native
development" (a learner cares that Bedrock abstracts model choice, not which
providers exist) versus "AWS AI broadly" (the model roster itself is
legitimately interesting to someone surveying AWS's AI portfolio).

## Decision

Widen scope from AI-native development to **AWS AI broadly**. Any AWS service
whose primary value is AI/ML is now eligible for a card, not only the
developer-agent slice of it.

**Kept unchanged:**
- The card quality bar and the "no card without a durable idea" discipline —
  restated as: a card must teach something a reader couldn't get faster by
  skimming a console or a single doc page.
- `content/service-scope.json`'s two-tier depth model (`comprehensive` vs
  `boundary`). Newly in-scope services default to `boundary` depth until
  there's a specific reason to track them comprehensively — the same
  discipline already applied to Quick.
- Every existing guarantee, provenance rule, and verification gate. This is a
  scope decision, not an architecture change.

**What actually changes:**
- `.kiro/specs/self-maintaining-flashcards/requirements.md` §4's IN/OUT list —
  updated in place (2026-08-20) to name the newly in-scope services and the
  widened test.
- `README.md`'s domain statement and naming footnote — updated to match.
- Still open, deliberately not decided here: whether to rename the deck itself
  (the published `<title>`/`<h1>` in `content/shell.html`, `package.json`'s
  description, and the Medium post framing all still say "AI-Native
  Development"). That's a bigger, more visible move than a scope-doc edit and
  is left for a separate, explicit decision.

## Consequences

- The coverage detector's news-source feed (`NEWS_KINDS`, `service-scope.json`)
  will need entries for newly in-scope services as they're added — deliberately
  incremental, not a bulk widening, to avoid reproducing the "261 uncovered
  entries out of 366" noise failure this repo's README already documents for
  an over-broad feed.
- The Bedrock model-roster question that started this: resolved separately and
  consistently with the existing ignore-list precedent — one concept card
  (`BR-01`), not one card per model or per provider family, regardless of
  scope. Widening scope changes which *services* are eligible; it does not
  change the answer to "does a fast-moving roster deserve a card per item,"
  which was already settled by precedent before this decision.
