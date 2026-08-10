/**
 * AgentCore gap cards — and three entries that were never gaps.
 *
 * check-coverage reported seven uncovered AgentCore entries. Reading the deck
 * against them, THREE are already covered and the matcher simply cannot see it:
 *
 *   "Agent Optimization Loop capabilities in Public Preview" — AC-13 is titled
 *     "Recommendations, batch evals & A/B tests" and its lead describes exactly
 *     this loop. No token is shared with the heading, so no match is possible.
 *
 *   "Tagging and AWS CloudFormation Support" — AC-19's lead already reads "GA
 *     brought the enterprise checklist: VPC connectivity across all services,
 *     PrivateLink, CloudFormation, and resource tagging."
 *
 *   "AgentCore is generally available in AWS GovCloud (US-West)" — AC-19 is the
 *     home for region and compliance posture and already names FedRAMP in
 *     GovCloud. The partition is US-only, so in an ANZ field deck it earns a line
 *     on an existing card rather than a card of its own.
 *
 * Those three go to coverage-ignore.json with that reasoning, which is what the
 * ignore file is for: "we decided not to" has to stay distinguishable from "we
 * never looked". Suppressing them is not hiding a gap; it is recording a reading.
 *
 * That leaves four real ones, confirmed absent by grepping the whole deck for
 * CDK, bidirectional, WebSocket, Bot Auth and Failure Insight — none appears
 * anywhere in cards/.
 *
 *   AC-22  Failure Insights          the failures that emit no error
 *   AC-23  Web Bot Auth              agent identity on someone else's website
 *   AC-24  Bidirectional streaming   full-duplex instead of request-response
 *   AC-25  AgentCore in CDK          stable constructs as an adoption gate
 *
 * NO VERSION NUMBERS IN PROSE. The source states CLI v0.19.0 and CDK
 * v0.1.0-alpha.36. Both are stale within weeks and no fact set governs either, so
 * AC-25 says "graduated from alpha to stable" and names no version. The one number
 * that matters — that the Policy submodule is STILL alpha — is a state, not a
 * version, and it is stated because a card claiming CDK support is simply stable
 * would be wrong in the direction that looks reassuring.
 *
 * Usage: node tools/add-cards-agentcore-gaps.ts [--dry-run]
 */

import { loadCards, saveCard, loadFactSetFile } from '../src/lib/store.ts';
import type { Card, Source } from '../src/lib/types.ts';

const GENERATOR = 'tools/add-cards-agentcore-gaps.ts';
const dryRun = process.argv.includes('--dry-run');
const NOW = new Date().toISOString();
const FACT_SET = 'agentcore.release-notes';

function citeReleaseNotes(): Source {
  const set = loadFactSetFile(`${FACT_SET}.json`);
  if (!set) {
    throw new Error(
      `cannot cite "${FACT_SET}" — no fact set on disk. Run node src/ingest/docs-release-notes.ts first; ` +
        'a card may not publish an uncited claim.',
    );
  }
  return {
    url: set.source.url,
    title: 'AgentCore release notes',
    kind: set.source.kind,
    fetched_at: set.source.fetched_at,
    content_hash: set.source.content_hash,
  };
}

type Spec = {
  card_id: string;
  lifecycle: Card['lifecycle'];
  badge_variant: Card['badge_variant'];
  badge_text: string;
  art: string;
  title: string;
  hook: string;
  lead: string;
  kv: [string, string][];
  hookline: string;
  tags: string[];
  depends_on: string[];
};

const SPECS: Spec[] = [
  {
    card_id: 'AC-22',
    lifecycle: 'preview',
    badge_variant: 'pv',
    badge_text: 'PREVIEW',
    art: 'observe',
    title: 'Failure Insights',
    hook: 'The failures that matter most emit no error.',
    lead:
      'Failure insights read production traces and find recurring failure patterns across hundreds of agent sessions — ' +
      'including silent behavioural failures that produce no error signal at all — explain the root cause of each, and ' +
      'rank them by how widespread they are. Continuous monitoring can run on a daily cadence.',
    kv: [
      [
        'What a silent failure is',
        'An agent that answers confidently and wrongly raises no exception and returns a success status. Nothing in a ' +
          'conventional error budget notices, which is why traces have to be read for behaviour rather than for status codes.',
      ],
      [
        'Ranked, not just listed',
        'Patterns are ordered by how widespread they are, so the queue is sorted by blast radius rather than by recency. ' +
          'A list of every anomaly is a report; a ranking is a work queue.',
      ],
      [
        'Where it sits',
        'Observability produces the traces and this reads them, which is what makes the improvement loop closeable: ' +
          'findings become the input to recommendations and validated changes rather than to a manual investigation.',
      ],
    ],
    hookline: 'An exception says the agent broke. A pattern says it has been quietly wrong for a fortnight.',
    tags: ['agentcore', 'observability', 'operate', 'quality'],
    depends_on: ['AC-10', 'AC-13'],
  },
  {
    card_id: 'AC-23',
    lifecycle: 'preview',
    badge_variant: 'pv',
    badge_text: 'PREVIEW',
    art: 'identity',
    title: 'Web Bot Auth',
    hook: 'Your agent cannot prove it is not a scraper — until it signs.',
    lead:
      'Web Bot Auth lets an agent cryptographically sign its HTTP requests, so a site can distinguish a declared agent ' +
      'from anonymous automation and reduce the CAPTCHA challenges it serves while the agent browses.',
    kv: [
      [
        'The problem it solves',
        'A headless browser is indistinguishable from abuse by design. CAPTCHA is the web’s defence against that, and ' +
          'it is also the thing that silently strands an agent halfway through a task.',
      ],
      [
        'Claim versus evidence',
        'A user-agent string asserts an identity and anyone can copy it. A signature is verifiable by the site, which is ' +
          'what makes the assertion worth acting on.',
      ],
      [
        'A different problem from Identity',
        'AgentCore Identity governs what your agent may reach inside your own boundary. This governs whether a stranger’s ' +
          'website will serve it at all — identity pointed outward rather than inward.',
      ],
    ],
    hookline: 'A user-agent string is a claim. A signature is evidence.',
    tags: ['agentcore', 'browser', 'identity', 'tools'],
    depends_on: ['AC-07', 'AC-09'],
  },
  {
    card_id: 'AC-24',
    lifecycle: 'ga',
    badge_variant: 'core',
    badge_text: 'RUNTIME',
    art: 'runtime',
    title: 'Bidirectional streaming',
    hook: 'Full-duplex, not request-and-reply.',
    lead:
      'Runtime supports bidirectional streaming: real-time, full-duplex communication between a client and an agent over ' +
      'the WebSocket protocol, for interactive agent experiences rather than one request followed by one response.',
    kv: [
      [
        'What actually changes',
        'Both ends can send while the other is still sending. A client can interrupt, correct or add context mid-turn ' +
          'instead of waiting for the agent to finish being wrong.',
      ],
      [
        'What it enables',
        'Voice and other conversational surfaces, where waiting for a complete response is the difference between a ' +
          'conversation and submitting a form.',
      ],
      [
        'The operational cost',
        'A long-lived duplex connection is a different shape from a request: it holds resources for the length of the ' +
          'interaction, so concurrency is bounded by sessions rather than by requests per second.',
      ],
    ],
    hookline: 'Request-response is a form. Full-duplex is a conversation — including the interruptions.',
    tags: ['agentcore', 'core-services', 'runtime', 'streaming'],
    depends_on: ['AC-04'],
  },
  {
    card_id: 'AC-25',
    lifecycle: 'ga',
    badge_variant: 'core',
    badge_text: 'ENTERPRISE',
    art: 'platform',
    title: 'AgentCore in CDK',
    hook: 'A stable construct is an adoption gate, not a convenience.',
    lead:
      'The aws-bedrockagentcore constructs have graduated from alpha to stable in the main CDK library, so AgentCore ' +
      'resources — runtime, memory, gateway, identity and more — can be defined in CDK with full backward-compatibility ' +
      'guarantees and no separate alpha package. The Policy submodule remains in alpha.',
    kv: [
      [
        'Why stable is the gate',
        'An alpha package carries no backward-compatibility guarantee, which is usually enough for a platform team to ' +
          'refuse it in a shared pipeline. Graduation is the difference between a prototype and something allowed on the ' +
          'paved road.',
      ],
      [
        'The exception that has to be said',
        'Policy is still alpha. A card claiming AgentCore is simply stable in CDK would be wrong in the direction that ' +
          'looks reassuring — and Policy is exactly the service a governance-minded team would reach for first.',
      ],
      [
        'What it joins',
        'CloudFormation support and resource tagging landed earlier, so agents can be provisioned, versioned and ' +
          'cost-allocated with the same tooling as the rest of the account rather than as a special case.',
      ],
    ],
    hookline: 'Ask whether the construct is stable. “Alpha” is the answer that stops a rollout.',
    tags: ['agentcore', 'enterprise', 'iac', 'operate'],
    depends_on: ['AC-11', 'AC-19'],
  },
];

function build(spec: Spec, source: Source): Card {
  return {
    schema_version: 1,
    card_id: spec.card_id,
    kind: 'service-fact',
    lifecycle: spec.lifecycle,
    service: 'bedrock-agentcore',
    category: spec.card_id === 'AC-25' ? 'operate-adopt' : spec.card_id === 'AC-22' ? 'governance-quality' : 'core-services',
    tags: [...spec.tags].sort(),
    badge_variant: spec.badge_variant,
    badge_text: spec.badge_text,
    art: spec.art,
    title: spec.title,
    hook: spec.hook,
    back: { lead: spec.lead, kv: spec.kv.map(([k, v]) => ({ k, v })), hookline: spec.hookline },
    slots: {},
    facts_used: [],
    sources: [source],
    verified_at: source.fetched_at,
    confidence: 'medium',
    depends_on: [...spec.depends_on].sort(),
    aka: [],
    superseded_by: null,
    supersedes: [],
    needs_review: false,
    review_reasons: [],
    provenance: {
      tier: 'C',
      authored_by: 'model',
      history: [
        {
          at: NOW,
          tier: 'C',
          action: 'import',
          generator: GENERATOR,
          reason:
            `New card authored from ${source.url}, closing a gap check-coverage reported and confirmed absent from ` +
            'every existing card. Every new card enters through Tier C.',
        },
      ],
    },
    created_at: NOW,
    updated_at: NOW,
  } as Card;
}

function main(): void {
  const source = citeReleaseNotes();
  const existing = new Set(loadCards().map((c) => c.card_id));
  let written = 0;

  console.log(`add-cards-agentcore-gaps: four cards from ${source.url}\n`);
  for (const spec of SPECS) {
    if (existing.has(spec.card_id)) {
      console.log(`  ${spec.card_id}: already exists — skipping`);
      continue;
    }
    const card = build(spec, source);
    console.log(`  ${card.card_id}  ${card.lifecycle.padEnd(7)} ${card.art.padEnd(9)} ${card.title}`);
    console.log(`     category ${card.category} · depends on ${card.depends_on.join(', ')}`);
    if (!dryRun) saveCard(card);
    written += 1;
  }
  console.log(
    `\nadd-cards-agentcore-gaps: ${written} card(s) ${dryRun ? 'would be written' : 'written'}. ` +
      'Run node tools/sync-id-ledger.ts, then npm run check.',
  );
}

if (import.meta.filename === process.argv[1]) main();
