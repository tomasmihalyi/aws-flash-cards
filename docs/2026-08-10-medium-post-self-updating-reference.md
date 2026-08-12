# Your Cheat Sheet Is Already Wrong

*I wanted a quick reference for AWS AI services. Keeping it true turned out to be the actual engineering problem.*

`[IMAGE — hero. Suggested: the deck's card UI beside the architecture diagram. Medium: full-width. Caption: "(Source: Author)"]`

I wanted something simple. A flashcard deck for the AWS AI-native development stack — AgentCore, Bedrock, Kiro, Strands — so I could recall a price or a region count in a customer conversation without opening six documentation tabs.

I wrote 21 cards in an afternoon. Good ones. Regions, pricing, service boundaries.

Three weeks later, most of the numbers were wrong.

Not badly wrong. Quietly wrong. AgentCore had gone from 4 regions to 19. A price had moved. A service had renamed itself. My cheat sheet was now a confident-sounding liability, and I was carrying it into customer conversations.

The obvious fix is to re-read the docs every month. Obvious. Intuitive. And it does not survive contact with a busy quarter.

So I stopped trying to maintain the content and built something that maintains it for me. This is what I learned — and the pattern generalises well beyond flashcards.

`[SECTION DIVIDER]`

## **Facts Are Not Prose**

Here is the defect that reframed the whole project.

One card claimed agentic workloads "typically spend **30–70%** of wall-clock time in I/O wait." Plausible. Specific. Useful-sounding.

It was invented. No AWS source publishes that number, and none could — it describes someone's workload, not the service. A model wrote a statistic because the sentence had a slot shaped like one.

> A model asked to write about a number will produce a number. That is not lying. That is the job you gave it.

The fix is structural, not editorial. A card never stores a number. It stores a **slot**, and a deterministic job fills it:

`[CODE BLOCK]`
```
// cards/AC-19.json
"back": { "lead": "{{slot:region_availability}} GA brought the enterprise checklist…" },
"slots": {
  "region_availability": {
    "template": "AgentCore is available in {{fact:agentcore.regions.count}} AWS regions, …",
    "rendered":  "AgentCore is available in 19 AWS regions, …",
    "seed_text": "AgentCore previewed in four regions"
  }
}
```

`seed_text` is what the deck used to claim, kept permanently. `rendered` is what it claims now. Between them sits a commit naming the source and its content hash.

> Separate the two stores and "numbers are never model-generated" stops being a policy someone has to remember. It becomes a property of the write path.

That distinction — **prose is authored, facts are ingested** — is the single idea worth stealing.

`[SECTION DIVIDER]`

## **Three Outcomes, and the Third Is the Point**

Ten ingest jobs read published sources — AWS APIs, docs pages, product changelogs — and write typed facts. Then one job resolves each slot. It has exactly three outcomes:

**VERIFY** — the source agrees. Stamp the verification date, change no text.

**CORRECT** — the source disagrees. Rewrite the slot, append a before/after entry to an append-only ledger.

**FAIL** — a fact is missing. Touch nothing. Exit non-zero.

That third branch is the one people skip, and it is the one that matters.

> A card carrying an unverified claim while wearing a fresh "verified today" stamp is worse than a card that is visibly stale. Stale looks stale. The other looks checked.

Same reasoning applies to freshness: a card's verification date is the **oldest** source behind it, never the newest. It is only as fresh as its stalest input.

`[SECTION DIVIDER]`

## **Correct Is Not the Same as Complete**

Here is the half I got wrong for weeks.

Every gate I had built kept **existing** cards correct. Not one could see that AWS had shipped something I had never written about. The deck could tell me a number moved. It could not tell me I was missing a topic entirely.

For a reference whose stated purpose is *"the latest information"*, that is the load-bearing gap.

So I added a coverage detector: match every dated source entry against every card's subject, rank the unmatched ones by significance, report them.

The first run reported 261 gaps. **Every one was wrong.**

Finding out why was the actual work:

❌ Wrong corpus — it was reading a document-history page ingested to verify *dates*, not product news. 366 entries down to 116.

❌ A common word is still a name — "gateway" appeared in 20 of the 102 headings in that corpus, so my scorer treated it as noise and the Gateway card failed to match a Gateway announcement.

❌ Lifecycle language is not a subject — "General Availability" is a real heading and it names nothing.

The version that survived: **117 entries, 104 covered, 0 actionable.** The three it did flag were a to-do list, not a defect — I have since written those cards. It reports; it never fails a build.

> A missing card is a to-do. A wrong card is a defect. Conflating them produces a report nobody reads.

`[SECTION DIVIDER]`

## **Daily Broke Something Weekly Would Have Hidden**

I originally scheduled the refresh weekly. Changed it to daily, so a correction lands the day the source moves.

Then I ran one and watched what happened.

`[CODE BLOCK]`
```
apply: 0 correction(s) · 9 verification(s) · 7 cards written
git status:  17 files changed
actual deck content changed:  nothing
```

Every ingest stamps a fetch time. So a refresh where **nothing moved** still leaves the repository dirty. Weekly, that is 52 empty commits a year and merely untidy. Daily, it is 365, and the one morning a price actually moved is invisible.

Neither extreme was right. Committing every run makes the history useless; never committing means the deck shows a verification date older than reality while a job checks it every single day.

The answer: **check daily, stamp weekly.** A real correction is never delayed — the interval governs only the no-op case.

> Cadence is not a scheduling detail. Going daily changed which failure mode dominates.

`[SECTION DIVIDER]`

## **Then It Ran Unattended, and Found Five Things**

Local runs were green for weeks. The first five scheduled runs failed, each for a genuinely different reason — and every one existed **only** in an environment nobody develops in:

`[TABLE → export as image for Medium. Full-width.]`

| # | What broke | The lesson underneath |
|---|---|---|
| 1 | OIDC trust used the documented `repo:owner/repo` subject; GitHub issues an *immutable* one with numeric IDs | Ask the API what it sends |
| 2 | `--profile default` — a CI runner has no named profiles | Tooling encoded my laptop |
| 3 | Public AWS SSM parameter ARNs carry **no account ID** | My policy could never match |
| 4 | The runner shipped a botocore nine minor versions old | A floating dependency measures itself |
| 5 | Ten modules ran their `main()` on import | Importing must never execute |

Number three carries the lesson I keep thinking about. I had verified that policy with twelve cases of `iam simulate-principal-policy`. All twelve passed.

They passed because I fed the simulator the resource ARN **from the policy I was testing**.

> That confirms a policy matches itself, and nothing more. Take the ARN from a real error message, from CloudTrail, or from the docs — never from the template under test.

Twice that day a verification told me what I wanted to hear. Both times the fix was the same: stop reasoning, read the actual error, import the actual module, and look.

`[SECTION DIVIDER]`

## **The Four Rules That Generalise**

Strip out the flashcards and this is a pattern for any reference that has to stay true — a pricing page, a compliance matrix, an internal wiki.

**1. Separate authored prose from ingested facts.** Prose is judgement and belongs to a human. Facts belong to a deterministic job. Never let one write the other's store.

**2. Make "no data" fail loudly.** The dangerous state is not missing information. It is missing information wearing a fresh timestamp.

**3. Build the detector that notices what you have not covered.** Correctness gates are the easy half. Completeness is where a stale reference actually hurts.

**4. Let a machine correct a number. Never let it publish a judgement.** My pipeline commits a price change unattended and opens a pull request for anything involving positioning. That line is the whole safety model.

The deck is 43 cards now. It refreshes itself every morning at 5am, corrects its own numbers against live AWS APIs, and tells me each day what AWS shipped that I have not written about yet.

One limit is permanent, and it is worth naming. A handful of those cards carry my own positioning judgement — where one service stops and another starts. No document settles that, so no ingest job can ever verify it. Those cards render as *"Unsourced — positioning and practice judgement"* and always will.

> Quietly widening a source's authority to cover a claim it cannot support is the exact failure this whole system exists to prevent.

Everything else — the prices, the region counts, the API surfaces, the lifecycle badges — I no longer maintain. I maintain the machine that maintains them.

I have not manually checked a region count in weeks.

*Follow me on* ***Medium*** *and* ***LinkedIn*** *to learn how to build self-maintaining systems with agentic coding tools and principles.*
