# Publishing the deck

The read plane is `infra/read-plane.yaml` — a private S3 origin, Origin Access
Control, and a CloudFront distribution. Deployed once; publishing after that is
an object upload.

## Deploy or update the stack

```bash
aws cloudformation deploy --profile demo --region ap-southeast-2 \
  --stack-name FlashcardsReadPlane --template-file infra/read-plane.yaml
```

First creation takes 5–15 minutes on CloudFront propagation. Subsequent updates
are quick unless the distribution itself changes.

## Publish a new build

```bash
npm run check                     # never publish an artifact the gate has not seen
BUCKET=$(aws cloudformation describe-stacks --profile demo --region ap-southeast-2 \
  --stack-name FlashcardsReadPlane \
  --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' --output text)

aws s3 cp dist/aws-ai-native-development-flashcards.html "s3://$BUCKET/index.html" \
  --profile demo --region ap-southeast-2 \
  --content-type 'text/html; charset=utf-8' \
  --cache-control 'public, max-age=300'
```

`max-age=300` is why no invalidation is needed for an ordinary content update:
a new deck is live within five minutes. Invalidate only when you need it
immediately:

```bash
DIST=$(aws cloudformation describe-stacks --profile demo --region ap-southeast-2 \
  --stack-name FlashcardsReadPlane \
  --query 'Stacks[0].Outputs[?OutputKey==`DistributionId`].OutputValue' --output text)
aws cloudfront create-invalidation --profile demo --distribution-id "$DIST" --paths '/'
```

## Verify a publish, rather than assuming it

The check that matters is that the bytes CloudFront serves are the bytes the gate
validated. Anything else — status codes, headers — can pass while serving a stale
or truncated artifact.

```bash
curl -s https://<dist>.cloudfront.net/ -o /tmp/live.html
cmp dist/aws-ai-native-development-flashcards.html /tmp/live.html && echo IDENTICAL
```

The origin must NOT be reachable directly. Both of these must return 403:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "https://$BUCKET.s3.ap-southeast-2.amazonaws.com/index.html"
curl -s -o /dev/null -w '%{http_code}\n' -X PUT --data x "https://$BUCKET.s3.ap-southeast-2.amazonaws.com/probe.txt"
```

## What is NOT verified by any of the above

`tools/browser-check.mjs` renders the deck in real Chromium and asserts the
behaviour that matters to a learner — flip, study queue, deep links, the a11y
invariant. **It only runs against a local `file://` path, and it needs Playwright,
which is not installed.** So the published artifact's byte-identity to a
gate-validated build is currently the strongest live claim available; nobody has
driven the deployed URL in a browser.

That gap is worth closing before this is published from CI, because CI is exactly
where nobody is watching. Two things are needed: accept Playwright as a
dev-only dependency (it cannot be a repo dependency — this project has none by
design, so it belongs in the CI image), and teach `browser-check.mjs` to take an
`https://` URL as well as a path.

## Why every resource carries `auto-delete: never`

This account runs **SpringClean** — stack `SpringClean-XUG3HH5R` in `us-east-1`,
which sweeps the whole account regardless of region. It warns by email, then
deletes or stops untagged resources after three days.

The documented exemption contract:

| tag | effect |
|---|---|
| `auto-delete` = `no` or `never` | never deleted |
| `springclean` = any value | never deleted |
| `auto-delete` = `2026-12-31` | deferred until that date |
| `auto-stop` = `no` | not stopped, without full deletion exemption |

Every taggable resource in both templates carries `auto-delete: never` — the
strongest form, which the spec describes as protecting a resource *regardless of
age or execution mode*. A date-based deferral was rejected deliberately: it
expires silently, and the failure mode is the deck disappearing on a day nobody
chose.

**`DeletionPolicy: Retain` is not a substitute.** It only constrains what
CloudFormation may do when a stack is deleted. It has no bearing on a direct
`DeleteBucket` call from an account janitor, so the tag is the only thing
standing between SpringClean and the published deck.

Three resources cannot be tagged at all, because their AWS resource types have
no tag support: the bucket policy, the Origin Access Control, and the response
headers policy. None is independently useful to a cleaner, and all three are
recreated by a stack update, so the gap is acceptable rather than merely ignored.

**What tagging does NOT exempt.** SpringClean's *lock* and *compliance* modes
have no tag opt-out. S3 Lock keeps account-level Block Public Access switched on
permanently. That is aligned with this design rather than in tension with it —
the bucket is private with OAC as the only reader, so the lock enforces exactly
what `read-plane.yaml` already asserts. Expect it to stay on, and do not design
anything that needs a public bucket.
