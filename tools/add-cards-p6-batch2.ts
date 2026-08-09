/**
 * P6 batch 2 — the model layer and the agent framework.
 *
 * The deck could describe where an agent RUNS in detail and had nothing about
 * what it thinks with, or what you build it in. Bedrock is the model layer every
 * AgentCore card implicitly depends on; Strands is the framework AC-01 already
 * name-drops without the deck ever explaining it.
 *
 * NUMBERS GO THROUGH SLOTS, INCLUDING THE VENDOR'S OWN ROUNDED ONES
 *
 * Three numbers arrive with these cards — the model-catalogue floor, and the two
 * minimum language versions. None is typed into prose. `src/ingest/docs-pages.ts`
 * now extracts declared facts from a page, so each one is a slot fed by the
 * source that states it, and the next refresh either confirms it or reports that
 * it moved.
 *
 * "100+" IS A FLOOR AND THE CARD MUST SAY SO
 *
 * The Bedrock overview page advertises "100+ foundation models". A card that
 * renders that as "100 foundation models" would be quietly wrong in the direction
 * that looks precise: it converts a lower bound into a count. The slot renders
 * "over 100", and the fact's own note records the distinction so the next person
 * to touch it cannot lose it.
 *
 * WHAT IS SOURCED AND WHAT IS NOT
 *
 * BR-01, BR-02 and ST-01 say what the vendor says and cite the page. ST-02 is the
 * framework-versus-runtime boundary — a positioning judgement of exactly the kind
 * the design doc puts permanently in Tier C. It carries no source and renders as
 * unsourced, for the same reason the Quick boundary cards do: no document settles
 * which layer a problem belongs in.
 *
 * Usage: node tools/add-cards-p6-batch2.ts [--dry-run]
 */

import { loadCards, saveCard, loadFactSetFile } from '../src/lib/store.ts';
import type { Card, Slot, Source } from '../src/lib/types.ts';

const GENERATOR = 'tools/add-cards-p6-batch2.ts';
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

type SlotSpec = {
  name: string;
  template: string;
  facts: string[];
  /** what the slot said before any fact resolved it — the permanent audit trail */
  seed_text: string;
};

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
  slots?: SlotSpec[];
  /** fact-set ids to cite; empty means this card is judgement, not fact */
  cites?: string[];
  /** why a human must sign this off */
  review?: string;
};

const SPECS: Spec[] = [
  // ---------- the model layer ----------
  {
    card_id: 'BR-01',
    kind: 'service-fact',
    lifecycle: 'ga',
    service: 'bedrock',
    category: 'bedrock',
    badge_variant: 'core',
    badge_text: 'MODEL LAYER',
    art: 'platform',
    title: 'Amazon Bedrock',
    hook: 'Managed, enterprise-grade access to foundation models from many providers behind one set of APIs.',
    lead:
      'Amazon Bedrock is a fully managed service that provides secure, enterprise-grade access to high-performing foundation models from leading AI companies, so you can build and scale generative-AI applications without operating inference infrastructure. {{slot:model_catalogue}}',
    slots: [
      {
        name: 'model_catalogue',
        // "over N", never "N": the source advertises a floor, not a count.
        template:
          'The catalogue runs to over {{fact:bedrock.what-is.model-count-floor}} foundation models, from Amazon, Anthropic, DeepSeek, Moonshot AI, MiniMax and OpenAI among others.',
        facts: ['bedrock.what-is.model-count-floor'],
        seed_text: 'The catalogue spans many providers.',
      },
    ],
    kv: [
      ['Customisation', 'A model can be adapted rather than merely prompted: fine-tuning, continued pre-training and distillation are all first-class.'],
      ['Relationship to AgentCore', 'Bedrock supplies the model; AgentCore runs the agent. Most "which should I use" questions are really about which of those two layers the problem sits in.'],
    ],
    hookline: 'Bedrock is the model layer. "Which model" is a Bedrock question; "how do I run the agent" is an AgentCore one.',
    tags: ['bedrock', 'foundation-models', 'model-layer'],
    cites: ['bedrock.what-is'],
  },
  {
    card_id: 'BR-02',
    kind: 'service-fact',
    lifecycle: 'ga',
    service: 'bedrock',
    category: 'bedrock',
    badge_variant: 'core',
    badge_text: 'API SURFACE',
    art: 'protocol',
    title: 'Five ways to call a Bedrock model',
    hook: "Anthropic's client, OpenAI's client, or AWS's own — Bedrock answers to all of them.",
    lead:
      "The Bedrock overview sends one identical prompt five ways: the Messages API through Anthropic's client, the Responses and Chat Completions APIs through OpenAI's client, and the Converse and Invoke APIs through boto3. For an application already written against Anthropic or OpenAI, the documented migration path is updating the base URL and API key rather than rewriting call sites.",
    kv: [
      ['Borrowed dialects', "Messages speaks the anthropic SDK; Responses and Chat Completions speak the openai SDK. Both are Bedrock endpoints, not shims you run."],
      ['AWS-native pair', 'Converse gives one request shape across every model. Invoke passes provider-native JSON, for the model-specific field Converse deliberately does not model.'],
      ['Watch for', 'A dialect is not a capability. The same model behind two dialects is still one model with one set of quotas and one set of limits.'],
    ],
    hookline: 'The cheapest migration is the one where you change a base URL.',
    tags: ['api', 'bedrock', 'converse', 'interoperability', 'mcp'],
    depends_on: ['BR-01'],
    cites: ['bedrock.what-is', 'bedrock.doc-history'],
  },

  // ---------- the framework ----------
  {
    card_id: 'ST-01',
    kind: 'service-fact',
    lifecycle: 'ga',
    service: 'strands',
    category: 'frameworks',
    badge_variant: 'core',
    badge_text: 'FRAMEWORK',
    art: 'harness',
    title: 'Strands Agents',
    hook: 'A model-driven SDK for building agents in a few lines, with the loop and its controls already built.',
    lead:
      'Strands Agents is an SDK that takes a model-driven approach to building and running agents, from a conversational assistant to an autonomous workflow. It ships as a monorepo: a Python SDK, a TypeScript SDK, a developer CLI, and the documentation site. {{slot:runtimes}}',
    slots: [
      {
        name: 'runtimes',
        template:
          'The SDKs require Python {{fact:strands.readme.python-min}} or Node.js {{fact:strands.readme.node-min}} as a minimum.',
        facts: ['strands.readme.python-min', 'strands.readme.node-min'],
        seed_text: 'The SDKs target current Python and Node.js runtimes.',
      },
    ],
    kv: [
      ['Model agnostic', 'First-class Amazon Bedrock, Anthropic, OpenAI and Gemini providers plus many more, and custom ones. Both SDKs default to the Bedrock provider, so an unconfigured agent is already an AWS agent.'],
      ['Built in, not bolted on', 'MCP, streaming, multi-agent patterns and structured output ship with it. The agent loop traces every decision by default, and hooks let you intercept a step to log, validate or redirect it.'],
      ['Correcting, not just failing', 'Guardrails catch mistakes before they run; steering handlers let an agent correct itself instead of failing silently.'],
    ],
    hookline: 'Two lines to an agent — and the same two lines after you swap the model backend.',
    tags: ['a2a', 'framework', 'mcp', 'strands'],
    cites: ['strands.readme'],
  },
  {
    card_id: 'ST-02',
    kind: 'mental-model',
    lifecycle: 'ga',
    service: 'strands',
    category: 'frameworks',
    badge_variant: 'core',
    badge_text: 'MENTAL MODEL',
    art: 'map',
    title: 'Strands or AgentCore?',
    hook: 'Not a choice. One is what you write the agent in; the other is what you run it on.',
    lead:
      'The question is asked as though these compete, and they do not. Strands is a framework: it gives you the agent loop, tool wiring, hooks and provider abstraction inside your process. AgentCore is infrastructure: session isolation, memory, identity, a tool gateway and observability around whatever process you deployed. You can use either alone, and the common production shape is both.',
    kv: [
      ['Strands alone', 'Fine for local development, a batch job, or an agent embedded in a service you already operate. You own the runtime, the isolation and the credentials.'],
      ['AgentCore alone', 'Fine when the agent is written in something else entirely — LangGraph, CrewAI, or bare SDK calls. AgentCore is framework-agnostic by design.'],
      ['The tell', 'If the pain is "my agent code is a tangle of orchestration", that is a framework problem. If it is "I cannot isolate, observe or authorise this in production", that is an infrastructure problem.'],
    ],
    hookline: 'Framework problems and infrastructure problems feel identical at 2am and have completely different fixes.',
    tags: ['agentcore', 'architecture', 'framework', 'positioning', 'strands'],
    depends_on: ['ST-01', 'AC-01', 'AC-04'],
    review:
      'Positioning judgement about which layer a problem belongs in. No deterministic source can settle it, so the card carries no citation and needs human sign-off before it is taught as guidance.',
  },
];

function buildSlots(spec: Spec): { slots: Record<string, Slot>; facts: string[] } {
  const slots: Record<string, Slot> = {};
  const facts: string[] = [];
  for (const s of spec.slots ?? []) {
    slots[s.name] = {
      tier: 'A',
      template: s.template,
      facts: s.facts,
      // Left on the seed: src/ingest/apply.ts resolves the template and records
      // whether that was a verification or a correction. Pre-rendering here would
      // bypass the only mechanism that proves the value came from a source.
      rendered: s.seed_text,
      rendered_from: 'seed',
      seed_text: s.seed_text,
    };
    facts.push(...s.facts);
  }
  return { slots, facts: [...new Set(facts)].sort() };
}

function build(spec: Spec): Card {
  const sources = (spec.cites ?? []).map(cite);
  const needsReview = Boolean(spec.review);
  const { slots, facts } = buildSlots(spec);
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
    slots,
    facts_used: facts,
    sources,
    // A card citing a fetched page is verified as of the OLDEST fetch: it is only
    // as fresh as its stalest input.
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
            : 'New mental-model card authored from judgement; no deterministic source applies. Every new card enters through Tier C.',
        },
        ...(needsReview
          ? [{ at: NOW, tier: 'C' as const, action: 'flag-review' as const, generator: GENERATOR, reason: spec.review! }]
          : []),
      ],
    },
    created_at: NOW,
    updated_at: NOW,
  };
}

function main(): void {
  const existing = new Set(loadCards().map((c) => c.card_id));
  const built: Card[] = [];

  console.log('add-cards-p6-batch2: the model layer and the agent framework\n');
  for (const spec of SPECS) {
    if (existing.has(spec.card_id)) {
      console.log(`  ${spec.card_id}: already exists — skipping`);
      continue;
    }
    const card = build(spec);
    built.push(card);
    const slotNames = Object.keys(card.slots);
    console.log(`  ${card.card_id}  ${card.kind.padEnd(13)} ${card.title}`);
    console.log(`     category ${card.category} · service ${card.service}`);
    console.log(
      `     ${card.sources.length ? `cites ${card.sources.length} source(s)` : 'NO SOURCE (judgement, needs sign-off)'}` +
        `${slotNames.length ? ` · slots: ${slotNames.join(', ')}` : ''}` +
        `${card.depends_on.length ? ` · depends on ${card.depends_on.join(', ')}` : ''}`,
    );
  }

  console.log(`\nadd-cards-p6-batch2: ${built.length} card(s) built`);
  if (dryRun) {
    console.log('add-cards-p6-batch2: --dry-run, nothing written');
    return;
  }
  for (const c of built) saveCard(c);
  if (built.length) {
    console.log('add-cards-p6-batch2: next — node tools/sync-id-ledger.ts, then node src/ingest/apply.ts to resolve the slots');
  }
}

main();
