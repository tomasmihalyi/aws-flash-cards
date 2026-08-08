/**
 * P6 batch 1 — the first cards outside AgentCore.
 *
 * The deck's scope is AI-native development, but every card until now was
 * `bedrock-agentcore`. This adds the two areas that actually distinguish the
 * domain: the coding agents, and the Quick business-vs-engineer boundary.
 *
 * HOW FACT AND JUDGEMENT ARE KEPT APART
 *
 * The three service-fact cards are grounded in the vendor's own "what is" page,
 * fetched and retained by src/ingest/docs-pages.ts, and cite it. Their prose says
 * what the vendor says, not what I believe.
 *
 * The two boundary cards are positioning. The design doc is explicit that every
 * Quick-versus-Kiro claim is Tier C by definition, because it is a judgement
 * rather than a fact, so they carry no source, are marked needs_review for human
 * sign-off, and are confidence: low. That is not a defect to be fixed by fetching
 * more documentation — no doc page can tell you which tool a use case belongs in.
 *
 * NOT INCLUDED, AND WHY
 *
 * Claude Code on Bedrock and Codex on Bedrock are in scope and are missing.
 * docs.aws.amazon.com returns a redirect stub for claude-code.html,
 * claude-code-bedrock.html, coding-agents.html and third-party-agents.html — there
 * is no page to cite. Writing those cards from memory is exactly what this repo
 * exists to prevent, so they wait for a source.
 *
 * Usage: node tools/add-cards-p6-batch1.ts [--dry-run]
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCards, saveCard, loadFactSetFile, paths } from '../src/lib/store.ts';
import type { Card, Source } from '../src/lib/types.ts';

const GENERATOR = 'tools/add-cards-p6-batch1.ts';
const dryRun = process.argv.includes('--dry-run');
const NOW = new Date().toISOString();

/** Turn a fact-set id into a citation. Refuses if the set was never fetched. */
function cite(factSetId: string): Source {
  const set = loadFactSetFile(`${factSetId}.json`);
  if (!set) {
    throw new Error(
      `cannot cite "${factSetId}" — no fact set on disk. Run node src/ingest/docs-pages.ts first; a card may not publish an uncited claim.`,
    );
  }
  return {
    url: set.source.url,
    title: String(set.facts[`${factSetId}.title`]?.value ?? factSetId),
    kind: set.source.kind,
    fetched_at: set.source.fetched_at,
    content_hash: set.source.content_hash,
  };
}

type Spec = {
  card_id: string;
  kind: Card['kind'];
  lifecycle: Card['lifecycle'];
  service: string;
  category: string;
  badge_variant: Card['badge_variant'];
  badge_text: string;
  art: string;
  title: string;
  hook: string;
  lead: string;
  kv: [string, string][];
  hookline: string;
  tags: string[];
  depends_on?: string[];
  /** fact-set ids to cite; empty means this card is judgement, not fact */
  cites?: string[];
  /** why a human must sign this off */
  review?: string;
  notes?: string;
};

const SPECS: Spec[] = [
  // ---------- coding agents ----------
  {
    card_id: 'CA-01',
    kind: 'service-fact',
    lifecycle: 'ga',
    service: 'q-developer',
    category: 'coding-agents',
    badge_variant: 'core',
    badge_text: 'CODING AGENT',
    art: 'cli',
    title: 'Amazon Q Developer',
    hook: 'A conversational assistant for understanding, building, extending and operating AWS applications.',
    lead:
      'Amazon Q Developer is a generative-AI conversational assistant that helps you understand, build, extend and operate AWS applications. You can ask about AWS architecture, your own AWS resources, best practices, documentation and support. It is built on Amazon Bedrock and inherits the abuse detection Bedrock implements.',
    kv: [
      ['In the IDE', 'Chats about code, provides inline completions, generates new code, scans for security vulnerabilities, and makes upgrades such as language version moves, debugging and optimisation.'],
      ['Substrate', 'Built on Amazon Bedrock, so the safety and responsible-use controls come from the same place as the rest of your Bedrock workloads.'],
      ['Where it fits', 'The AWS-aware assistant: strongest when the question is about your account, your resources, or AWS itself rather than about a codebase in the abstract.'],
    ],
    hookline: 'Ask it about AWS and your own resources \u2014 that account awareness is what it has and a general coding agent does not.',
    tags: ['q-developer', 'coding-agents', 'aws', 'ide'],
    cites: ['q-developer.what-is'],
  },
  {
    card_id: 'CA-02',
    kind: 'service-fact',
    lifecycle: 'ga',
    service: 'kiro',
    category: 'coding-agents',
    badge_variant: 'core',
    badge_text: 'CODING AGENT',
    art: 'code',
    title: 'Kiro',
    hook: 'An AI development environment from prototype to production \u2014 one agent harness across every surface.',
    lead:
      'Kiro is an AI-powered development environment for building software from prototype to production. One unified agent harness powers every surface \u2014 IDE, CLI, Web and Mobile \u2014 so configuration, specs and steering work everywhere, shared through a project\u2019s .kiro directory.',
    kv: [
      ['Surfaces', 'A desktop editor with chat, specs and hooks; a terminal-native agent with headless mode and CI integration; a browser agent for multi-repo tasks that opens pull requests; and mobile for monitoring and review.'],
      ['The mechanisms', 'Specs turn a feature into requirements, design and tasks. Steering enforces project standards. Hooks fire on file save, tool use or task completion. MCP connects external tools. Permissions bound what the agent may touch.'],
      ['Why the harness matters', 'Start a spec in the IDE, continue from the CLI, hand implementation to the web agent \u2014 the same steering, permissions and hooks apply, because every surface is a front end to one agent.'],
    ],
    hookline: 'Spec, steering, hooks, permissions \u2014 the configuration is the product, and it follows you between surfaces.',
    tags: ['kiro', 'coding-agents', 'spec-driven', 'ide'],
    cites: ['kiro.docs'],
  },

  // ---------- the Quick boundary ----------
  {
    card_id: 'QK-01',
    kind: 'service-fact',
    lifecycle: 'ga',
    service: 'quick',
    category: 'quick-boundary',
    badge_variant: 'core',
    badge_text: 'BUSINESS SURFACE',
    art: 'platform',
    title: 'What Amazon Quick is',
    hook: 'Natural-language chat over your data and applications, with agents that take action.',
    lead:
      'Amazon Quick is an AI-powered service for automating tasks, analysing data, building web applications and conducting research. You interact with it through natural-language chat, and Quick uses AI agents to process your requests against connected data sources and applications.',
    kv: [
      ['The parts', 'Quick Sight for data visualisation and business intelligence; Quick Flows for automating repetitive tasks; Quick Automate for business process automation with agents that make contextual decisions; Quick Index for grounding answers in your own documents; Quick Research for cited reports; and Apps in Amazon Quick for building web applications by describing them.'],
      ['How work gets expressed', 'Through chat against connected sources and applications \u2014 not through a repository, a build, or code someone reviews.'],
      ['Why an SA cares', 'This is the surface a business user reaches for. Knowing precisely what it does is the prerequisite for saying where it stops.'],
    ],
    hookline: 'Quick is the chat-and-agents surface over your data; that framing is what makes the boundary question answerable.',
    tags: ['quick', 'quick-boundary', 'business-users', 'automation'],
    cites: ['quick.what-is'],
  },
  {
    card_id: 'QK-02',
    kind: 'mental-model',
    lifecycle: 'ga',
    service: 'quick',
    category: 'quick-boundary',
    badge_variant: 'core',
    badge_text: 'POSITIONING',
    art: 'map',
    title: 'Where Quick stops and engineering starts',
    hook: 'Not a capability contest. The question is who owns the result and what has to be true about it.',
    lead:
      'Both surfaces can produce something that works, so capability is the wrong axis. The useful question is what the result has to survive. Quick suits work a business user owns end to end, expressed through chat, changed by whoever needs it changed. Engineering starts when the result needs version control, tests, review, deterministic behaviour, or an on-call owner who is not its author.',
    kv: [
      ['Signals it belongs in Quick', 'One team owns both the question and the answer; the data already lives in connected sources; being approximately right and quickly changed beats being provably right; nobody will be paged if it breaks.'],
      ['Signals it needs engineering', 'The output feeds another system; correctness must be demonstrable to an auditor or a regulator; behaviour must be identical every run; multiple teams depend on it; someone other than the author must operate it.'],
      ['The failure worth naming', 'A business-built automation quietly becoming load-bearing. It works, so it spreads, and nobody notices it has no tests, no owner and no rollback until it breaks in a month when its author has moved teams.'],
      ['How to say it', 'Frame it as ownership and consequence, never as capability. "Can Quick do this?" is almost always yes and almost never the point.'],
    ],
    hookline: 'Ask "who gets paged when this is wrong?" \u2014 the answer places the work faster than any feature comparison.',
    tags: ['quick-boundary', 'positioning', 'kiro', 'quick'],
    depends_on: ['QK-01', 'CA-02'],
    review:
      'Positioning judgement, Tier C by definition. No documentation page can settle which tool a use case belongs in, so this card carries no source and needs human sign-off before it is presented to a customer.',
  },
  {
    card_id: 'QK-03',
    kind: 'practice',
    lifecycle: 'ga',
    service: 'quick',
    category: 'quick-boundary',
    badge_variant: 'core',
    badge_text: 'PRACTICE',
    art: 'migrate',
    title: 'Handing a Quick automation to engineering',
    hook: 'The handoff is a rewrite. Plan for that and it is cheap; pretend otherwise and it is a rescue.',
    lead:
      'When a Quick-built automation becomes load-bearing, the goal is not to port it. It is to treat it as the specification it accidentally became: a working statement of what the business actually wanted, validated by use. That is a far better starting point than a requirements document, and it is worth saying so rather than treating the handoff as remedial work.',
    kv: [
      ['Harvest the intent first', 'Capture what the automation does, which sources it touches, and which decisions it makes. That is the requirement, already proven against real use.'],
      ['Expect to rebuild the mechanism', 'Chat-expressed logic and agent decisions do not port to code. The behaviour transfers; the implementation does not.'],
      ['Decide what stays', 'Often the right answer is a split: the business keeps the chat surface for exploration, engineering owns the path that other systems depend on.'],
      ['Name an owner at handoff', 'The most common failure is a rebuilt system with no clearer ownership than the automation it replaced.'],
    ],
    hookline: 'The automation was the spec. Treat the handoff as promotion, not cleanup.',
    tags: ['quick-boundary', 'practice', 'handoff', 'ai-dlc'],
    depends_on: ['QK-01', 'QK-02'],
    review:
      'Practice card authored from judgement, Tier C. No deterministic source attests a handoff pattern; it needs human sign-off and ideally a named engagement to cite.',
  },
];

function build(spec: Spec): Card {
  const sources = (spec.cites ?? []).map(cite);
  const needsReview = Boolean(spec.review);
  return {
    schema_version: 1,
    card_id: spec.card_id,
    kind: spec.kind,
    lifecycle: spec.lifecycle,
    service: spec.service,
    category: spec.category,
    tags: [...spec.tags].sort(),
    badge_variant: spec.badge_variant,
    badge_text: spec.badge_text,
    art: spec.art,
    title: spec.title,
    hook: spec.hook,
    back: { lead: spec.lead, kv: spec.kv.map(([k, v]) => ({ k, v })), hookline: spec.hookline },
    slots: {},
    facts_used: [],
    sources,
    // A card citing a fetched page is verified as of that fetch. A judgement card
    // is not verified at all, and says so.
    verified_at: sources.length ? sources.map((s) => s.fetched_at).sort()[0] : null,
    confidence: needsReview ? 'low' : 'medium',
    depends_on: [...(spec.depends_on ?? [])].sort(),
    aka: [],
    superseded_by: null,
    supersedes: [],
    needs_review: needsReview,
    review_reasons: needsReview ? [{ reason: spec.review!, raised_at: NOW, raised_by: GENERATOR }] : [],
    provenance: {
      tier: 'C',
      authored_by: 'model',
      history: [
        {
          at: NOW,
          tier: 'C',
          action: 'import',
          generator: GENERATOR,
          reason: sources.length
            ? `New card authored from ${sources.map((s) => s.url).join(', ')}. Every new card enters through Tier C.`
            : 'New positioning card authored from judgement, no deterministic source applies. Every new card enters through Tier C.',
        },
        ...(needsReview
          ? [{ at: NOW, tier: 'C' as const, action: 'flag-review' as const, generator: GENERATOR, reason: spec.review! }]
          : []),
      ],
    },
    created_at: NOW,
    updated_at: NOW,
    ...(spec.notes ? { notes: spec.notes } : {}),
  };
}

function main(): void {
  const existing = new Set(loadCards().map((c) => c.card_id));
  const cats = JSON.parse(readFileSync(join(paths.content, 'categories.json'), 'utf8')) as {
    categories: { id: string }[];
  };
  const catIds = new Set(cats.categories.map((c) => c.id));

  let written = 0;
  for (const spec of SPECS) {
    if (existing.has(spec.card_id)) {
      console.log(`${spec.card_id}: already exists — skipped (card ids are never reused or overwritten)`);
      continue;
    }
    if (!catIds.has(spec.category)) {
      throw new Error(`${spec.card_id}: category "${spec.category}" is not in content/categories.json`);
    }
    const card = build(spec);
    console.log(
      `${card.card_id}  ${card.kind.padEnd(13)} ${card.category.padEnd(15)} ${card.sources.length ? 'cites ' + card.sources.length : 'JUDGEMENT, no source'}${card.needs_review ? ' · needs_review' : ''}`,
    );
    console.log(`        ${card.title}`);
    if (!dryRun) saveCard(card);
    written++;
  }
  console.log(`\nadd-cards-p6-batch1: ${written} card(s) ${dryRun ? 'would be written' : 'written'}`);
  if (dryRun) console.log('add-cards-p6-batch1: --dry-run, nothing written');
  else console.log('add-cards-p6-batch1: run node tools/sync-id-ledger.ts next so the new ids are on record');
}

main();
