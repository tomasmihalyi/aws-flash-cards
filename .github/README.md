# The refresh plane

The trigger that turns self-maintain**able** into self-maintain**ing**. Everything
it invokes was already built and green; this is what invokes it.

Runs **daily** at 19:00 UTC (05:00 AEST). Daily rather than weekly so a correction
lands the day the source moves, and so each diff is small enough to read.

## One-time setup

Three steps. Only the first touches AWS.

**1. Deploy the roles.** No access keys are created and nothing long-lived is
stored in GitHub — Actions gets short-lived credentials via OIDC.

```bash
BUCKET=$(aws cloudformation describe-stacks --profile demo --region ap-southeast-2 \
  --stack-name FlashcardsReadPlane \
  --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' --output text)
DIST=$(aws cloudformation describe-stacks --profile demo --region ap-southeast-2 \
  --stack-name FlashcardsReadPlane \
  --query 'Stacks[0].Outputs[?OutputKey==`DistributionId`].OutputValue' --output text)

aws cloudformation deploy --profile demo --region ap-southeast-2 \
  --stack-name FlashcardsGitHubOIDC \
  --template-file infra/github-oidc.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides "DeckBucketName=$BUCKET" "DistributionId=$DIST"
```

**2. Set five repository variables** (Settings → Secrets and variables → Actions →
Variables). They are variables, not secrets: a role ARN and a bucket name are not
credentials, and putting them in secrets would only make them harder to read in a
log when something breaks.

```bash
gh variable set AWS_REFRESH_ROLE_ARN --body "$(aws cloudformation describe-stacks --profile demo --region ap-southeast-2 --stack-name FlashcardsGitHubOIDC --query 'Stacks[0].Outputs[?OutputKey==`RefreshRoleArn`].OutputValue' --output text)"
gh variable set AWS_PUBLISH_ROLE_ARN --body "$(aws cloudformation describe-stacks --profile demo --region ap-southeast-2 --stack-name FlashcardsGitHubOIDC --query 'Stacks[0].Outputs[?OutputKey==`PublishRoleArn`].OutputValue' --output text)"
gh variable set DECK_BUCKET --body "$BUCKET"
gh variable set DECK_URL    --body "https://$(aws cloudfront get-distribution --profile demo --id "$DIST" --query 'Distribution.DomainName' --output text)"
```

**3. Dry-run it once, attended.** `gh workflow run refresh.yml` then read the run
summary before trusting the schedule. The first run will almost certainly be
`FRESHNESS_ONLY`, and that is the expected result rather than a failure.

## What a run does

```
assume RefreshRole (OIDC) → npm run refresh → npm run check → classify → act
```

`npm run refresh` is ingest → apply → apply-rename → build. `apply` exits non-zero
rather than stamping a fresh `verified_at` on a claim whose fact failed to fetch,
so a failure there **should** fail the job: a visibly stale card beats a card that
looks checked.

Then `tools/refresh-outcome.ts` decides:

| outcome | action | why |
|---|---|---|
| `NO_CHANGE` | nothing | tree matches HEAD |
| `FRESHNESS_ONLY` | discard, or stamp on the interval | see below |
| `TIER_A` | commit to `main`, then publish | a deterministic source disagreed; no judgement involved |
| `NEEDS_REVIEW` | open a PR, never commit | a pipeline may correct a number by itself; it may not publish a judgement |

Review beats correction when a run produces both. The safe half does not license
the unsafe half to ride along.

## The freshness problem, which is specific to running daily

Every ingest stamps `fetched_at`, and `apply` rewrites `verified_at` on any card it
re-verified. So **after a refresh where nothing moved, the tree is dirty.**
Measured on a real run: 17 files changed, 7 cards rewritten, zero deck content
different.

A job that reads "dirty" as "commit" therefore produces one empty commit per run.
Weekly that is 52 a year and merely untidy. Daily it is 365, `git log` over
`cards/` stops being readable, and the one day a price actually moved is invisible.

Neither extreme is right, so: **check daily, stamp weekly.** A real correction still
lands the day the source moves — the interval only governs the no-op case, so the
displayed verified date is never more than 7 days stale while history stays
readable. Override per run with the `freshness_interval_days` input; `0` stamps
every run.

## Two GitHub behaviours the design has to work around

**A `GITHUB_TOKEN` push does not trigger other workflows.** GitHub's recursion
guard. If publishing were wired only to `push`, every commit the refresh made
would sit on `main` and never reach CloudFront — the deck would silently stop
matching the repo. So `publish.yml` is a **reusable** workflow that `refresh.yml`
calls directly, and keeps its `push` trigger for commits a human makes.

**`fetch-depth: 0` is mandatory, not tidiness.** The freshness interval is found
with `git log --grep` over past commits. A shallow clone finds nothing, reports
"never stamped", and stamps every single day — quietly restoring the noisy
behaviour the interval exists to prevent.

## What is deliberately not here

**No branch protection interaction.** `main` has none today, so the bot can push
to it. Adding protection later means the `commit` path needs either an exemption
for the bot or a switch to PR-always.

**No notification.** A failed run is visible in the Actions tab and by email from
GitHub. Wiring SNS or Slack is worth doing once there is evidence about which
failures actually recur, not before.

**No auto-merge of the review PR.** That is the entire point of the branch.
