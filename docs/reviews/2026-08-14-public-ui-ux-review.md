# Public UI/UX review — AWS AI-Native Development Flashcards

**Date:** 14 August 2026
**Live site:** https://d1hl3sanj0zgqn.cloudfront.net
**Review type:** expert heuristic evaluation, not user research or an accessibility certification

## Audience assumption

“General population” is interpreted as **public AWS builders and learners with basic cloud/developer familiarity**, not an internal field-only audience. If the intended audience includes people with no AWS or software-development background, the product also needs a guided curriculum and glossary; changing the interface alone will not make the current technical content introductory.

## Overall read

The deck is technically credible and visually coherent. The card itself is the strongest part: the question/answer hierarchy is clear, contrast is strong, source status is unusually honest, and all 43 cards fit without clipping at both tested breakpoints.

It is **not yet ready for a broad public launch without UX work**. The interface gives filtering controls more prominence than the learning task, the fixed navigation physically covers card and grading content, and two accessibility patterns prevent efficient or complete keyboard use. Study mode also assumes familiarity with spaced repetition and never explains who owns the progress data.

**Health tally:** 0 catastrophes · 6 major issues · 4 minor issues · 1 cosmetic issue.

## Evidence collected

Runtime evaluation covered:

- desktop: 1440×1000 and 1280×900;
- responsive/reflow: 640×800, 390×844, and 320×800;
- first visit with empty `localStorage`;
- browse, category and tag filtering, search, no-results recovery, flip, provenance link, study mode, reveal, grade, reload, and keyboard navigation;
- computed dimensions, text contrast, focus order, ARIA tree, reduced-motion behavior, and horizontal overflow;
- every front and back face across all 43 cards at desktop and mobile widths.

Measured positives:

- no document-level horizontal overflow at 320px;
- no clipped front or back face among all 43 cards;
- sampled text contrast ranged from **4.71:1 to 17.33:1**;
- hidden faces correctly use both `aria-hidden` and `inert`;
- the card has an explicit accessible state label and updates it after flipping;
- the 3D card transition is removed when `prefers-reduced-motion: reduce` is active;
- the no-results state says what filter is active and offers **Clear filters**;
- sourced cards show a verification date and source; judgement cards explicitly say **Unsourced — positioning and practice judgement**;
- grading persists locally across reloads and card corrections are designed to return to the study queue.

## Major findings — address before public launch

### F01 · The learning task is below the filtering interface on mobile

**Severity:** Major (3) · **Confidence:** high
**Area:** hierarchy, responsive usability, cognitive load

At 390px, the card starts **567px** down the page and the question starts at **792px**, while the fixed navigation begins at **782px**. The question is therefore behind the navigation on first view. At 320px, the question starts at **872px** and is entirely outside the 800px viewport.

Before reaching the first question, a learner sees the full introduction, four metrics, an 11-category horizontal strip, search, 12 tag chips, “+77 more tags”, study controls, three progress counters, and a progress bar. The 11-category strip is 1,234px wide inside a 358px mobile viewport, with its scrollbar hidden.

**Recommendation:** make the card the first-screen object. On mobile, keep the title, one short value statement, search, and a single **Topics & filters** control above it. Move categories and tags into a drawer or bottom sheet with an applied-filter summary. Consider the same progressive disclosure on desktop; tags are an advanced retrieval tool, not the primary task.

### F02 · The fixed bottom navigation covers card content and grading controls

**Severity:** Major (3) · **Confidence:** high
**Area:** interaction, mobile layout, study flow

The navigation is fixed and overlaps the card by **62px at every tested viewport**. In mobile study mode after revealing an answer, the four grade buttons occupy y=779–825 while the navigation starts at y=782. At that state, 43px of each 46px-tall grade control sits behind the navigation. A user can recover by scrolling further, but the controls are almost entirely hidden at the moment they become relevant.

The same overlay covers the lower provenance/schedule area on long answers and interrupts reading on desktop as well.

**Recommendation:** do not overlay the primary artifact. Put the navigation in normal or sticky layout after the card, or reserve a non-overlapping safe area equal to the navigation height plus spacing. When the answer is revealed in study mode, scroll the grade group into a visible position without moving persistent controls unpredictably.

### F03 · Filtering creates a 26-control keyboard barrier before the card

**Severity:** Major (3) · **Confidence:** high
**Area:** keyboard accessibility, efficiency, ARIA consistency

Every category is exposed as `role="tab"`, but all 11 tabs have `tabIndex=0`; Right Arrow on **All** does nothing. This combines the semantics of a tablist with the keyboard behavior of ordinary buttons, rather than implementing either model cleanly.

The measured focus path is 11 category tabs → search → 13 tag controls → Study mode → card. A keyboard user must press Tab **26 times** before reaching the flashcard. This is repeated on every fresh visit and is amplified when all tags are expanded.

**Recommendation:** if these remain tabs, implement the ARIA tab pattern: one tab stop, roving `tabIndex`, Left/Right Arrow navigation, Home/End, `aria-controls`, and correct selection focus. A simpler fit is to use ordinary filter buttons inside a collapsible filter region. Add a **Skip to current card** link and place advanced tags after the card or in the filter drawer.

### F04 · The visible source link cannot be reached by keyboard

**Severity:** Major (3) · **Confidence:** high
**Area:** semantic structure, keyboard accessibility, trust

The entire card is a `div role="button"`. On the back face, the AWS source link is nested inside that button role. The accessibility tree exposes the link, but keyboard testing shows that Tab from the flipped card moves directly to **Previous card**; it skips the source link. This makes the most important trust affordance mouse/touch-only.

Nested interactive controls also create conflicting actions: “activate the card” means flip, while “activate the link inside the card” means navigate.

**Recommendation:** make the card an `article` or labelled region, not a single composite button. Use an explicit full-face reveal button on the question side and keep the source link as a normal sibling control on the answer side. The existing fixed **Flip card** control can remain as an accelerator.

### F05 · Study mode has no first-use explanation or progress ownership model

**Severity:** Major (3) · **Confidence:** high
**Area:** onboarding, mental model, data expectations

A new learner sees **NEW 43 · DUE 0 · SCHEDULED 0** before entering study mode, but the interface does not explain what “due” or “scheduled” means. Pressing **Study mode** changes the queue without visible explanatory copy. Only after revealing a card do **Again / Hard / Good / Easy** appear, with no description of how those choices affect the schedule.

Progress is stored in browser `localStorage`, but the page does not say “saved on this device”, offer reset/export, or explain that progress will not follow the learner to another browser. The implementation persists correctly; the product does not set the expectation.

**Recommendation:** add a one-time, dismissible study introduction: “Reveal the answer, then rate your recall. Your progress is stored only on this device.” Explain the four grades in one sentence, move the progress counters inside the active study experience, and provide **Reset progress** plus JSON export/import. An account is optional; expectation-setting is not.

### F06 · The public identity and trust boundary are missing

**Severity:** Major (3) · **Confidence:** high
**Area:** credibility, content, public positioning

The header presents **AWS · Field Deck** and **AWS AI-Native Development Flashcards**, but there is no visible author, “independent resource” statement, About/Methodology link, repository link, feedback path, or disclaimer that this is not official AWS documentation. On a CloudFront domain, a public visitor cannot tell who publishes it or how to report a bad card.

Per-card sourcing is excellent and should stay. The missing page-level context is what turns that evidence into a trustworthy public product.

**Recommendation:** add a compact footer or About panel with: publisher/author, independent/unofficial status, GitHub repository, update methodology, licence/copyright position, and **Report an issue with this card** deep link. For each report, include the card id and current URL automatically.

## Minor findings — address in the next iteration

### F07 · Global freshness wording makes a healthy pipeline look stale

**Severity:** Minor (2) · **Confidence:** high

On 14 August, after a successful refresh and publish, the header still says **last verified 8 Aug 2026**. That may be the oldest source timestamp by design, but a public learner reads it as “the deck has not checked for six days.” The UI collapses two different concepts: when automation last checked, and how old the oldest evidence behind a claim is.

**Recommendation:** display two explicit concepts: **Deck checked 14 Aug 2026** and, per card, **Oldest cited source verified 8 Aug 2026**. Link “How verification works” to the methodology page.

### F08 · Public-facing filter labels look like raw taxonomy tokens

**Severity:** Minor (2) · **Confidence:** high

Tags render as `agentcore26`, `coding-agents11`, and `quick-boundary3`. The count is visually concatenated with the label, and hyphenated internal vocabulary is exposed directly. “+77 more tags” also signals that the taxonomy is too large to be the default navigation model.

**Recommendation:** humanise labels and separate counts visually: **AgentCore · 26**, **Coding agents · 11**, **Quick boundary · 3**. Group tags by a few public concepts or keep them as searchable advanced filters.

### F09 · The shuffle control looks like another flip control

**Severity:** Minor (2) · **Confidence:** high

The shuffle button is shown only as **⇄**, immediately beside **Flip card**. For sighted users, the icon communicates exchange or reverse more readily than random order; only its accessible name reveals “Shuffle deck”. Accidental shuffle is recoverable but breaks orientation.

**Recommendation:** use a recognisable crossed-arrows shuffle icon plus a visible **Shuffle** label or tooltip. Announce “Deck shuffled; showing card 1 of 43” and consider preserving the current card when shuffling.

### F10 · Critical metadata is legible by contrast but unnecessarily small

**Severity:** Minor (2) · **Confidence:** high

Category/tag metadata and lifecycle labels are approximately **10.24–11.2px**. Their measured contrast passes, but repeated public navigation and trust metadata should not depend on such small type, particularly for older or low-vision learners.

**Recommendation:** bring interactive labels and provenance metadata closer to 12–14px, preserving the existing strong contrast. Keep card body copy at its current readable size.

## Cosmetic finding

### F11 · The top metrics are tailored to the owner, not the public audience

**Severity:** Cosmetic (1) · **Confidence:** high

**SYD REGION YES** is meaningful for an Australia-based field deck but unexplained and arbitrary to a global visitor. It competes with more useful product-level information.

**Recommendation:** replace it with **Topics 11**, **Checked today**, or remove the metrics row entirely on mobile. Region-specific availability belongs on the relevant cards or behind a selected home region preference.

## What should not be lost in redesign

1. **Honest provenance.** The distinction between a linked source, verification date, and explicit unsourced judgement is the product’s strongest trust feature.
2. **The card hierarchy.** Question, answer lead, labelled facts, memory hook, and lifecycle badge scan well.
3. **Responsive content integrity.** All 43 fronts and backs fit without clipping, and the page reflows without horizontal document overflow at 320px.
4. **Accessibility mechanisms already present.** `aria-hidden` + `inert`, live announcements, accessible card state labels, keyboard shortcuts, and reduced card motion are strong foundations.
5. **No-results recovery and URL state.** Search, filters, deep links, and **Clear filters** form a coherent retrieval model.

## Recommended delivery sequence

### P0 — public-launch blockers

1. Remove fixed-nav overlap, including the grade row.
2. Refactor the card/source semantics so the source is keyboard reachable.
3. Reduce the pre-card mobile chrome and provide **Skip to current card**.
4. Fix category keyboard semantics or replace the pseudo-tablist with filter buttons.
5. Add public identity, independent status, methodology, repository, and issue-reporting links.

### P1 — make learning understandable

6. Add first-use Study mode guidance and local-progress disclosure.
7. Add reset plus export/import for progress.
8. Separate deck-check time from evidence-verification time.
9. Humanise and progressively disclose tags.

### P2 — polish

10. Label shuffle visibly.
11. Increase small metadata type.
12. Replace or remove the Sydney-specific global metric.

## Validation after changes

Repeat the current 73 browser checks, then add explicit checks for:

- source link reached by Tab after revealing a card;
- one-tab-stop category control with working arrow keys, or no `tablist` role;
- question visible without scrolling at 390×844;
- grade buttons not intersecting the fixed/sticky navigation rectangle;
- Skip link moves focus to the current card;
- first-use Study mode guidance and local-progress disclosure;
- public footer links and per-card issue-report deep link;
- reduced motion also disables smooth scrolling, not only the card transform.

Finally, run moderated tests with 5–8 first-time public AWS learners. Ask them to: find a Bedrock pricing card, explain whether a claim is sourced, study and grade one card, return after reload, and report a suspected error. The present review can identify heuristic defects; only users can show whether the product’s mental model is actually learned.
