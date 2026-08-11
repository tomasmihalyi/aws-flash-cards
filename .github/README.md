# The refresh plane

The trigger that turns self-maintain**able** into self-maintain**ing**. Everything
it invokes was already built and green; this is what invokes it.

Runs **daily** at 19:00 UTC (05:00 AEST). Daily rather than weekly so a correction
lands the day the source moves, and so each diff is small enough to read.

## One-time setup

Three steps. Only the first touches AWS.

**1. Deploy the roles.** No access keys are created and nothing long-lived is
stored in GitHub — Actions gets short-lived credentials via OIDC.

The two numeric ids are **required** and are not cosmetic — see "the subject claim
is not what the documentation says" below.

```bash
OWNER_ID=$(gh api repos/tomasmihalyi/aws-flash-cards --jq .owner.id)
REPO_ID=$(gh api repos/tomasmihalyi/aws-flash-cards --jq .id)
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
  --parameter-overrides "DeckBucketName=$BUCKET" "DistributionId=$DIST" \
                        "GitHubOwnerId=$OWNER_ID" "GitHubRepoId=$REPO_ID"
```

### The subject claim is not what the documentation says

Nearly every GitHub-OIDC example writes the trust subject as
`repo:OWNER/REPO:ref:refs/heads/main`. This repository is issued an **immutable**
subject with numeric ids embedded:

```
repo:tomasmihalyi@20979055/aws-flash-cards@1329366635:ref:refs/heads/main
```

The first deploy used the documented form and every assume-role failed with
`Not authorized to perform sts:AssumeRoleWithWebIdentity` — a message that names no
claim, and that looks identical to a wrong audience, a missing provider or the
wrong account. Guessing between those is how an afternoon disappears.

**Ask GitHub what it actually sends:**

```bash
gh api repos/OWNER/REPO/actions/oidc/customization/sub
# {"use_default":true,"sub_claim_prefix":"repo:tomasmihalyi@20979055/aws-flash-cards@1329366635"}
```

That is the only place the real prefix is visible without decoding a token you
never get to see. Read it *before* debugging the trust policy.

The immutable form is **stricter**, not merely different, which is why it is
adopted here rather than worked around: numeric ids cannot be reused, so deleting
this repository and recreating one with the same name yields a different subject
and cannot assume these roles. The name-based form would have gone on trusting the
impostor.

### Moving the repository to a different owner

That strictness has a cost, and it is worth stating because the failure is silent
on the GitHub side. **Transferring the repository changes the subject**, because the
owner id is part of it. IAM learns nothing from a transfer; the only symptom is
that every `assume-role` afterwards fails with the same uninformative message.

This repository moved from `tomyister` (owner id `34014084`) to `tomasmihalyi`
(owner id `20979055`) on 2026-08-11. The repository id `1329366635` was carried
through the transfer unchanged, so the owner id was the only component that moved:

```
before  repo:tomyister@34014084/aws-flash-cards@1329366635:ref:refs/heads/main
after   repo:tomasmihalyi@20979055/aws-flash-cards@1329366635:ref:refs/heads/main
```

Two consequences worth knowing before doing this again:

- **The stack update is not optional and not deferrable.** Transfer, then update
  `FlashcardsGitHubOIDC` in the same sitting. Between those two acts the refresh
  and publish roles are unassumable. Nothing auto-fires on a transfer, so the
  window is only as long as you leave it — but the daily cron does not care that
  you were interrupted.
- **Read the ids back rather than assuming them.** A transfer preserves the
  repository id; creating a fresh repository and pushing into it does not. Those
  two routes look identical in `git log` and produce different subjects, so take
  both numbers from the API afterwards, not from this document.

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

## Verifying IAM without fooling yourself

`iam simulate-principal-policy` is the right tool and it will still tell you what
you want to hear if you feed it the wrong input. The refresh role's SSM grant
passed a twelve-case simulation and then failed on the first real read, because
the simulation used the resource ARN **from the policy under test** rather than
the one the API uses:

```bash
# WRONG — confirms the policy matches itself
--resource-arns 'arn:aws:ssm:us-east-1:123099425127:parameter/aws/service/global-infrastructure/...'  # allowed

# RIGHT — public AWS parameters carry NO account id
--resource-arns 'arn:aws:ssm:us-east-1::parameter/aws/service/global-infrastructure/...'              # implicitDeny
```

Take the resource ARN from a real error message, from CloudTrail, or from the
service's documentation. Never from the template you are trying to validate.

## What is deliberately not here

**No branch protection interaction.** `main` has none today, so the bot can push
to it. Adding protection later means the `commit` path needs either an exemption
for the bot or a switch to PR-always.

**Failure notification is a GitHub Issue**, not email, Slack or SNS — see
`.github/workflows/refresh-watchdog.yml`. GitHub already emails on a failed
scheduled workflow, so the gap was never "was I told once", it was "is it broken
right now". One deduplicated issue that **closes itself on the next success** answers
that; an alert that only ever opens becomes a to-do list of things that already
fixed themselves.

Both of the watchdog's shell expressions were verified against real failed runs
before committing, including the nested case: when publish fails *inside* a refresh
run it reports `publish / publish → <step>`, because publish is a called workflow
rather than a separate one.

**No auto-merge of the review PR.** That is the entire point of the branch.
