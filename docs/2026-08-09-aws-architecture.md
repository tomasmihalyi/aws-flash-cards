# AWS architecture — proposed target state

**Nothing here is deployed.** As of 2026-08-09 the demo account holds zero
CloudFront distributions and zero resources for this project. This is a design, and
it is blocked on one human step (see §6).

Verified read-only, 2026-08-09:

| | |
|---|---|
| Account | `<deploy-account>` (`demo` profile) |
| Region | `ap-southeast-2` — except the Price List API, which is `us-east-1` only |
| CDK bootstrap | v28, present in ap-southeast-2 |
| Existing distributions | 0 |

Companion to `docs/2026-08-09-architecture.md`, which covers the repo-side system.

---

## 1. Two planes, deliberately separate

```
   ┌──────────────────────── REFRESH PLANE (writes) ────────────────────────┐
   │                                                                        │
   │  EventBridge Scheduler ──▶ CodeBuild "refresh"                         │
   │  weekly, ap-southeast-2       npm run refresh && npm run check         │
   │                                                                        │
   └────────────────────────────────┬───────────────────────────────────────┘
                                    │ commit (Tier A) or PR (needs_review)
                                    ▼
                        GitHub  tomasmihalyi/<repo>  main
                                    │ push
                                    ▼
   ┌──────────────────────── READ PLANE (publishes) ────────────────────────┐
   │                                                                        │
   │  CodeBuild "publish" ──▶ S3 (private) ◀── OAC ── CloudFront ──▶ learner│
   │   check → build            no public access      default domain        │
   │                            SSE-S3, versioned     TLS 1.2+, no auth     │
   │                                  ▲                                     │
   │                                  └── CreateInvalidation after upload   │
   └────────────────────────────────────────────────────────────────────────┘
```

They are separate because they fail differently. A refresh that finds a stale price
must be able to fail without taking the published deck offline, and a publish must
never be able to mutate `cards/`.

---

## 2. Read plane

```
  S3 bucket   aws-ai-native-dev-flashcards-<acct>-apse2
    Block Public Access: all four ON
    SSE-S3 · versioning ON (a bad build is one restore away)
    bucket policy: allow s3:GetObject ONLY to the CloudFront
                   distribution via OAC, condition AWS:SourceArn
    contents: /index.html            (the single-file deck)
              /deck.json             (structured, for anything else)

  CloudFront
    origin: the bucket, Origin Access Control (not legacy OAI)
    default root object: index.html
    viewer protocol policy: redirect-to-https · min TLS 1.2
    response headers policy: HSTS, X-Content-Type-Options,
                             Referrer-Policy, a CSP that permits
                             inline script (the deck is one file by design)
    cache: long TTL on the hashed build, short on index.html
    domain: the default *.cloudfront.net — no Route 53, no ACM
```

The deck is a single self-contained HTML file, so once loaded it works offline on a
customer site with no network. That is the point of the format, and CloudFront is
only the delivery mechanism.

**No auth**, as agreed earlier — but see the caveat in §7, because the deck's
contents changed after that decision was made.

---

## 3. Refresh plane

```
  EventBridge Scheduler  cron(0 20 ? * SUN *)  Australia/Sydney
        │
        ▼
  CodeBuild project "refresh"
    source: GitHub via CodeStar Connections (no long-lived token)
    image: standard image with runtime-versions nodejs: 22
           ⚠ the repo declares engines node >= 22.18 for native TS
             type-stripping — confirm the image offers it before relying on it
    compute: general1.small · ~2 min · no VPC needed

    buildspec:
      1  npm run ingest        3 AWS ingests (IAM role) + 5 public HTTPS
      2  npm run apply         resolve slots, or EXIT NON-ZERO
      3  npm run apply:rename  alias a renamed product
      4  npm run check         7 gates, 243 tests
      5  branch on outcome ──▶ below
```

### The outcome branch is the whole design

```
  all changes Tier A, gates green
      └─▶ commit to main, push          ──▶ triggers publish
          (deterministic, provenance-recorded, parity-gate-checked)

  anything set needs_review
      └─▶ push a branch, open a PR, notify
          NEVER commit to main. A Tier C judgement needs a human, and
          tools/sign-off.ts is how that human answers.

  any gate fails
      └─▶ fail the build, SNS → email, change NOTHING
          apply.ts already exits non-zero rather than stamping a fake
          verified_at, so a missing fact cannot fake freshness
```

This is the same Tier discipline the repo enforces locally, expressed in CI. The
pipeline is allowed to correct a number by itself; it is not allowed to publish a
judgement.

---

## 4. IAM — the control that actually binds

`src/lib/aws.ts` holds a six-pair allow-list. That is good hygiene and it is
**client-side**: it constrains code that chooses to use it. On AWS the IAM role is
the enforced boundary, and it should mirror the allow-list exactly rather than being
broader "because it's only reads".

```
  RefreshRole  (CodeBuild)

  reads the deck's sources
    ssm:GetParametersByPath, ssm:GetParameter
        Resource: arn:aws:ssm:*::parameter/aws/service/global-infrastructure/*
    pricing:GetProducts, pricing:DescribeServices
        Resource: *          (Region: us-east-1 — the API lives there only)
    servicequotas:ListServiceQuotas
        Resource: *          (scoped by service-code in the call)
    sts:GetCallerIdentity

  its own plumbing
    logs:CreateLogStream, logs:PutLogEvents   on its own log group
    codestar-connections:UseConnection        on the one connection

  explicitly NOT present
    anything mutating: no ssm:PutParameter, no servicequotas:RequestServiceQuotaIncrease,
    no bedrock:*, no iam:*. "Ingest cannot write to AWS" becomes a property of the
    role, not a promise about the code.

  PublishRole  (CodeBuild)
    s3:PutObject, s3:DeleteObject   on the bucket only
    cloudfront:CreateInvalidation   on the one distribution
    — and no read access to the deck's data sources at all
```

Two roles, not one. The publisher has no reason to read SSM, and the refresher has
no reason to touch the bucket.

---

## 5. Operations

| Concern | Answer |
|---|---|
| Failure signal | CloudWatch alarm on CodeBuild `FAILED_BUILDS` → SNS → email. Silence is not success — the same lesson your vault sync taught |
| Logs | CloudWatch Logs, one group per project, 30-day retention |
| Drift in the deck itself | already covered in-repo: `check-lifecycle`, `check-rename`, `verify-claims` all run in step 4 |
| Rollback | S3 versioning for the artefact; `git revert` for the cards |
| Cost | CodeBuild ~2 min/week + <1 MB in S3 + a field deck's traffic. Cents per month; I have not priced it precisely and would not quote a figure without the calculator |

---

## 6. What blocks all of it

One human step: **the project has no git remote.** It lives inside the Activity
vault, so there is nothing for CodeStar Connections to connect to and nothing to
trigger a build.

```
  git subtree split --prefix=PROJECTS/aws-flash-cards -b flashcards-export
  gh auth switch --user tomyister        # gh currently defaults to Gatherlyco-au
  gh repo create ... && push the split branch
```

> **Resolved.** The extraction was done on 2026-08-10 and the repository was
> created under `tomyister` as written above. It was subsequently transferred to
> **`tomasmihalyi`** on 2026-08-11, which is where it lives now. The command is
> left as it was actually run — the owner in it is history, not a current address.

`subtree split` preserves the commit history — 20-odd commits of provenance that
are, in a project about provenance, worth keeping.

Same step unblocks T4.6 (PR automation for Tier C), which the outcome branch in §3
depends on.

---

## 7. One decision worth revisiting before publishing

"Public, no auth" was agreed when the deck was 21 AgentCore service-fact cards —
all of it restating AWS documentation.

It now contains **six Tier C judgement cards** that are your own positioning, not
AWS's: QK-02/QK-03 (where Quick stops and engineering starts), ST-02 (Strands vs
AgentCore), and the practice framing in several others. They render honestly as
"Unsourced — positioning and practice judgement", so nothing is misrepresented.

But a public CloudFront URL is a different audience from a laptop, and that content
is field positioning you may want to place deliberately rather than have indexed.
Options, in increasing effort: publish everything as-is; exclude
`category: quick-boundary` and `frameworks` from the published build; or put
CloudFront behind a signed URL or a Lambda@Edge basic-auth.

Worth a deliberate answer rather than inheriting the earlier one.
