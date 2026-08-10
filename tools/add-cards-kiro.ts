/**
 * Kiro concept cards — the gaps check-coverage found, at the right granularity.
 *
 * WHY SIX CARDS AND NOT TEN
 *
 * The coverage detector reported ten uncovered Kiro entries. Writing ten cards
 * would have been the wrong response, because Kiro's changelog titles bundle
 * three unrelated changes per release — "Global Hooks, Session Search, and
 * Reliability Fixes" is not a subject, it is a shipping note. AWS release notes
 * title one feature each; this source does not.
 *
 * So the teachable units are the concepts that recur ACROSS entries. Hooks appear
 * in four separate releases; MCP authentication in two; specs and plan mode in
 * two. Those are cards. The roundups were suppressed in coverage-ignore.json with
 * that reason written down, and two model-roster entries were suppressed with the
 * note that the teachable idea is model-agnosticism — CA-07 is that card, so this
 * batch closes a suppression the detector was pointing at.
 *
 * WHAT IS DELIBERATELY ABSENT FROM THE PROSE
 *
 * No version numbers. "Code OSS v1.109.5" is in the source and would be stale
 * within a fortnight; a card that carries it is a card that needs a slot, and no
 * fact set governs an editor build number.
 *
 * No model names in the lead of CA-07. Naming today's best model in a card about
 * model-agnosticism would be self-refuting. That OpenAI models arrived for the
 * FIRST time is durable history and is stated; which model is currently strongest
 * is not.
 *
 * No dates in prose. The changelog is day-precision and the citation carries the
 * date, so a card claiming one adds a verifiable-but-pointless claim. The concept
 * is the content.
 *
 * Every card cites kiro.changelog and enters at Tier C, like all new cards.
 *
 * Usage: node tools/add-cards-kiro.ts [--dry-run]
 */

import { loadCards, saveCard, loadFactSetFile } from '../src/lib/store.ts';
import type { Card, Source } from '../src/lib/types.ts';

const GENERATOR = 'tools/add-cards-kiro.ts';
const dryRun = process.argv.includes('--dry-run');
const NOW = new Date().toISOString();
const FACT_SET = 'kiro.changelog';

/** Cite the changelog. Refuses if it was never fetched — no uncited claims. */
function citeChangelog(): Source {
  const set = loadFactSetFile(`${FACT_SET}.json`);
  if (!set) {
    throw new Error(
      `cannot cite "${FACT_SET}" — no fact set on disk. Run node src/ingest/kiro-changelog.ts first; ` +
        'a card may not publish an uncited claim.',
    );
  }
  return {
    url: set.source.url,
    title: 'Kiro changelog',
    kind: set.source.kind,
    fetched_at: set.source.fetched_at,
    content_hash: set.source.content_hash,
  };
}

type Spec = {
  card_id: string;
  art: string;
  title: string;
  hook: string;
  lead: string;
  kv: [string, string][];
  hookline: string;
  tags: string[];
};

const SPECS: Spec[] = [
  {
    card_id: 'CA-03',
    art: 'policy',
    title: 'Kiro hooks',
    hook: 'Automation that fires on an event, not on a prompt.',
    lead:
      'A hook runs automatically when something happens rather than when you ask. Hooks can be scoped to a project or ' +
      'made global at the user level so they apply across every workspace, and they can fire on the agent’s own writes ' +
      'rather than only on yours. Kiro also ships a guided form for creating one, so the trigger and the action are ' +
      'chosen rather than hand-written.',
    kv: [
      [
        'Two scopes',
        'A project hook lives with the repository and travels with it, so every contributor gets the same behaviour. ' +
          'A global hook is user-level and applies across all workspaces, which is where personal habits belong.',
      ],
      [
        'On the agent’s writes',
        'A hook can trigger when the agent writes a file, not just when a human saves one. That is the difference ' +
          'between a check you run afterwards and a check the generated code has to pass through.',
      ],
      [
        'Why it matters',
        'A hook is the deterministic part of an agentic workflow. Steering and prompts shape what the model tends to ' +
          'do; a hook happens regardless.',
      ],
    ],
    hookline: 'A prompt asks the agent to remember. A hook does not depend on it remembering.',
    tags: ['automation', 'coding-agents', 'governance', 'hooks', 'kiro'],
  },
  {
    card_id: 'CA-04',
    art: 'memory',
    title: 'Tangents and the context budget',
    hook: 'Branch a side-conversation, then come back exactly where you were.',
    lead:
      'A tangent branches into a side-conversation that inherits the full conversation history, lets you explore ' +
      'freely, then returns you to exactly where you left off. Alongside it, the context command reports a per-tool ' +
      'token breakdown, so what is consuming the context window is visible rather than inferred.',
    kv: [
      [
        'What a tangent is',
        'Not a new session and not a fork you have to reconcile. It inherits the history, so the detour has the same ' +
          'context, and abandoning it costs nothing.',
      ],
      [
        'Seeing the budget',
        'A per-tool breakdown attributes context consumption to the tool responsible. A single verbose MCP server can ' +
          'dominate a window, and without attribution that looks like the model losing track.',
      ],
      [
        'Why it matters',
        'Context is a budget, and the expensive mistake is spending it on an exploratory question that then crowds out ' +
          'the work. A tangent makes the detour cheap; the breakdown makes the spend legible.',
      ],
    ],
    hookline: 'Context is a budget. A tangent is how you spend some of it without losing your place.',
    tags: ['coding-agents', 'context-engineering', 'kiro', 'practice'],
  },
  {
    card_id: 'CA-05',
    art: 'map',
    title: 'Specs and Plan mode',
    hook: 'The approval gate is the plan, not the diff.',
    lead:
      'Creating a spec walks through a guided description step rather than starting from a blank prompt, and Plan mode ' +
      'executes an approved plan automatically instead of requiring a manual switch back into an execution mode. ' +
      'Approval of the plan is therefore the point at which a human reads intent.',
    kv: [
      [
        'The loop',
        'Describe the feature, get a spec, get a plan, approve it — and the approved plan runs. The guided description ' +
          'step exists because the quality of everything downstream is set by how the intent was stated.',
      ],
      [
        'What changed',
        'Approval used to be followed by a manual mode switch. Removing that step is small mechanically and large in ' +
          'practice: the plan is now the thing you act on, not a document you then re-authorise.',
      ],
      [
        'Why it matters',
        'Reviewing a plan is reading intent; reviewing a diff is reading consequence. Moving the gate earlier is the ' +
          'whole argument for spec-driven work with an agent.',
      ],
    ],
    hookline: 'Approve intent before it becomes a diff — reviewing the plan is cheaper than reviewing the result.',
    tags: ['ai-dlc', 'coding-agents', 'kiro', 'spec-driven'],
  },
  {
    card_id: 'CA-06',
    art: 'identity',
    title: 'Making MCP work behind an enterprise IdP',
    hook: 'The blocker is rarely the protocol. It is the OAuth.',
    lead:
      'Kiro’s MCP OAuth support covers servers with strict requirements: configure a client secret for servers that ' +
      'need one, point the redirect URI at a custom callback path, and skip Dynamic Client Registration entirely when ' +
      'you bring your own client ID. Those three knobs are what turn a governed MCP server from unreachable into ' +
      'usable.',
    kv: [
      [
        'The three knobs',
        'A client secret, a custom callback path, and bring-your-own client ID. Each exists because some identity ' +
          'provider refuses the default path.',
      ],
      [
        'Why DCR is the sticking point',
        'Dynamic Client Registration lets a client register itself at connect time. That is convenient, and it is also ' +
          'the thing a regulated identity team is most likely to have disabled — pre-registered clients only.',
      ],
      [
        'Why it matters',
        'An MCP integration that works on a laptop and not behind the IdP is not an integration. This is the difference ' +
          'between a demo and something a platform team will approve.',
      ],
    ],
    hookline:
      'Dynamic Client Registration is what your identity team will say no to. Bring your own client ID and the objection goes away.',
    tags: ['coding-agents', 'enterprise', 'identity', 'kiro', 'mcp'],
  },
  {
    card_id: 'CA-07',
    art: 'modular',
    title: 'Kiro is model-agnostic',
    hook: 'Which model is a setting, not an architecture.',
    lead:
      'Kiro’s model roster spans frontier models from more than one vendor, and it changes continuously — OpenAI models ' +
      'became available for the first time alongside Anthropic’s, each tuned to a different point on the ' +
      'performance-versus-cost curve. A new model arrives across the IDE, the CLI and the web surfaces together, ' +
      'because they are front ends to one agent harness.',
    kv: [
      [
        'The roster moves',
        'Additions land continuously, which is why this card names no current favourite. Any card that did would be ' +
          'stale by design, and this deck would rather teach the shape than the leaderboard.',
      ],
      [
        'Tiers, not a winner',
        'Vendors ship families tuned for different points on the performance-cost curve. The interesting question is ' +
          'which tier a task needs, not which model is strongest.',
      ],
      [
        'Why it matters',
        'Model choice becomes a per-task decision about cost, latency and difficulty rather than a project-level ' +
          'commitment. That is only true if switching is a setting — and here it is.',
      ],
    ],
    hookline: 'Ask what the task needs, not which model is best this month.',
    tags: ['bedrock-adjacent', 'coding-agents', 'kiro', 'models'],
  },
  {
    card_id: 'CA-08',
    art: 'pricing',
    title: 'Capping Kiro overage with Service Quotas',
    hook: 'The cost control is an AWS quota, not an IDE setting.',
    lead:
      'Enterprise administrators cap overage through AWS Service Quotas rather than through anything inside the editor. ' +
      'The quota field named “Maximum allowed overage per Kiro profile” bounds the maximum allowed overage for every ' +
      'user in that profile, which keeps spend predictable without throttling the team.',
    kv: [
      [
        'Where the control lives',
        'AWS Service Quotas, applied per Kiro profile. Being a quota rather than a product toggle means it is managed ' +
          'with the same tooling and audit trail as the rest of the account.',
      ],
      [
        'What it bounds',
        'The maximum allowed overage for every user in the profile — a ceiling on the surprise, not a cap on ordinary ' +
          'usage.',
      ],
      [
        'Why it matters',
        'The alternative to a ceiling is discovering the overage on an invoice. For a regulated buyer, predictable ' +
          'spend is often the precondition for the rollout, not a detail after it.',
      ],
    ],
    hookline: 'The quota name is the control: “Maximum allowed overage per Kiro profile”.',
    tags: ['coding-agents', 'cost', 'enterprise', 'governance', 'kiro'],
  },
];

function build(spec: Spec, source: Source): Card {
  return {
    schema_version: 1,
    card_id: spec.card_id,
    kind: 'service-fact',
    lifecycle: 'ga',
    service: 'kiro',
    category: 'coding-agents',
    tags: [...spec.tags].sort(),
    badge_variant: 'core',
    badge_text: 'CODING AGENT',
    art: spec.art,
    title: spec.title,
    hook: spec.hook,
    back: { lead: spec.lead, kv: spec.kv.map(([k, v]) => ({ k, v })), hookline: spec.hookline },
    slots: {},
    facts_used: [],
    sources: [source],
    // Only as fresh as the source it cites.
    verified_at: source.fetched_at,
    confidence: 'medium',
    // Every one of these builds on what Kiro IS. Recording it means a correction
    // to CA-02 resurfaces these in the study queue as `context` rather than
    // leaving a learner confident about a detail whose foundation moved.
    depends_on: ['CA-02'],
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
            `New card authored from ${source.url}, closing a gap check-coverage reported. ` +
            'Written at concept granularity because the source titles bundle unrelated changes per release. ' +
            'Every new card enters through Tier C.',
        },
      ],
    },
    created_at: NOW,
    updated_at: NOW,
  } as Card;
}

function main(): void {
  const source = citeChangelog();
  const existing = new Set(loadCards().map((c) => c.card_id));
  let written = 0;

  console.log(`add-cards-kiro: six concept cards from ${source.url} (fetched ${source.fetched_at})\n`);
  for (const spec of SPECS) {
    if (existing.has(spec.card_id)) {
      console.log(`  ${spec.card_id}: already exists — skipping`);
      continue;
    }
    const card = build(spec, source);
    console.log(`  ${card.card_id}  ${card.art.padEnd(9)} ${card.title}`);
    console.log(`     tags ${card.tags.join(', ')} · depends on ${card.depends_on.join(', ')}`);
    if (!dryRun) saveCard(card);
    written += 1;
  }

  console.log(
    `\nadd-cards-kiro: ${written} card(s) ${dryRun ? 'would be written' : 'written'}. ` +
      'Run node tools/sync-id-ledger.ts, then npm run check.',
  );
  if (dryRun) console.log('add-cards-kiro: --dry-run, nothing written');
}

if (import.meta.filename === process.argv[1]) main();
