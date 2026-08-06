/**
 * Semantic overlay for the one-time legacy migration.
 *
 * The legacy DECK array carries presentation and prose. It cannot carry the
 * semantics the new schema requires (kind, lifecycle, service, tags,
 * depends_on) nor the fact-governed slot declarations. Those live here, once,
 * and are applied mechanically by tools/extract-legacy.ts.
 *
 * SLOT DECLARATIONS: `find` is the EXACT substring in the legacy text that the
 * slot replaces. The extractor fails loudly if it is not found verbatim, so a
 * mismatch can never silently alter a card's text.
 */

export type SlotDecl = {
  /** where the text lives: 'lead' | 'hook' | 'hookline' | `kv:<index>` */
  field: string;
  /** exact legacy substring this slot replaces — becomes seed_text */
  find: string;
  tier: 'A' | 'B' | 'C';
  /** deterministic form, with {{fact:<id>}} references */
  template: string;
  facts: string[];
  /** set when no deterministic source can settle the claim */
  unresolvable_reason?: string;
};

export type CardSemantics = {
  kind: 'service-fact' | 'practice' | 'distillation' | 'mental-model';
  lifecycle: 'preview' | 'ga' | 'deprecated' | 'superseded' | 'retired';
  service: string;
  tags: string[];
  depends_on?: string[];
  aka?: { name: string; changed_at: string; source?: string }[];
  slots?: Record<string, SlotDecl>;
  notes?: string;
};

/** Legacy `c` index → category id in content/categories.json */
export const CATEGORY_BY_INDEX = [
  'foundations',
  'core-services',
  'built-in-tools',
  'governance-quality',
  'new-in-2026',
  'operate-adopt',
] as const;

const PRICE = 'agentcore.pricing.ap-southeast-2';

export const SEMANTICS: Record<string, CardSemantics> = {
  'AC-01': {
    kind: 'service-fact', lifecycle: 'ga', service: 'bedrock-agentcore',
    tags: ['agentcore', 'platform', 'overview'],
  },
  'AC-02': {
    kind: 'service-fact', lifecycle: 'ga', service: 'bedrock-agentcore',
    tags: ['agentcore', 'architecture', 'modularity'],
    depends_on: ['AC-04', 'AC-05', 'AC-06', 'AC-07', 'AC-08', 'AC-09', 'AC-10', 'AC-11', 'AC-12', 'AC-14'],
  },
  'AC-03': {
    kind: 'service-fact', lifecycle: 'ga', service: 'bedrock-agentcore',
    tags: ['agentcore', 'mcp', 'a2a', 'protocols'],
    depends_on: ['AC-04', 'AC-06'],
  },
  'AC-04': {
    kind: 'service-fact', lifecycle: 'ga', service: 'bedrock-agentcore',
    tags: ['agentcore', 'runtime', 'compute', 'isolation'],
  },
  'AC-05': {
    kind: 'service-fact', lifecycle: 'ga', service: 'bedrock-agentcore',
    tags: ['agentcore', 'memory', 'context'],
    slots: {
      memory_price: {
        field: 'kv:3',
        find: 'Consumption-based; short-term events billed per volume (launched around $0.25 per 1,000 events).',
        tier: 'A',
        template: 'Consumption-based. Short-term memory events are billed at {{fact:' + PRICE + '.memory.short-term.usd-per-1k-events}} per 1,000 events in Asia Pacific (Sydney); long-term storage and retrieval are priced separately.',
        facts: [`${PRICE}.memory.short-term.usd-per-1k-events`],
      },
    },
  },
  'AC-06': {
    kind: 'service-fact', lifecycle: 'ga', service: 'bedrock-agentcore',
    tags: ['agentcore', 'gateway', 'tools', 'mcp'],
  },
  'AC-07': {
    kind: 'service-fact', lifecycle: 'ga', service: 'bedrock-agentcore',
    tags: ['agentcore', 'identity', 'auth', 'security'],
  },
  'AC-08': {
    kind: 'service-fact', lifecycle: 'ga', service: 'bedrock-agentcore',
    tags: ['agentcore', 'code-interpreter', 'sandbox', 'tools'],
  },
  'AC-09': {
    kind: 'service-fact', lifecycle: 'ga', service: 'bedrock-agentcore',
    tags: ['agentcore', 'browser', 'tools', 'automation'],
  },
  'AC-10': {
    kind: 'service-fact', lifecycle: 'ga', service: 'bedrock-agentcore',
    tags: ['agentcore', 'observability', 'otel', 'tracing'],
  },
  'AC-11': {
    kind: 'service-fact', lifecycle: 'ga', service: 'bedrock-agentcore',
    tags: ['agentcore', 'policy', 'governance', 'security'],
    depends_on: ['AC-06'],
  },
  'AC-12': {
    kind: 'service-fact', lifecycle: 'ga', service: 'bedrock-agentcore',
    tags: ['agentcore', 'evaluations', 'quality'],
    slots: {
      // Deliberately unresolvable: SSM tracks SERVICE availability, not
      // FEATURE availability. Mapping the 19-region service list onto a
      // feature-level "9 regions" claim would be an overreach, so this slot
      // stays seed and the card is flagged for review with the reason recorded.
      evaluations_regions: {
        field: 'kv:2',
        find: 'GA in 9 regions incl. Sydney, Tokyo, Singapore, Frankfurt, Ireland, and US East/West.',
        tier: 'A',
        template: 'GA in 9 regions incl. Sydney, Tokyo, Singapore, Frankfurt, Ireland, and US East/West.',
        facts: [],
        unresolvable_reason:
          'Feature-level region availability. SSM /aws/service/global-infrastructure exposes service-level regions for bedrock-agentcore only; it cannot substantiate the region list for the Evaluations feature specifically. Needs a Tier C source (What\u2019s New post or docs page) before this claim can be verified.',
      },
    },
  },
  'AC-13': {
    kind: 'service-fact', lifecycle: 'preview', service: 'bedrock-agentcore',
    tags: ['agentcore', 'evaluations', 'optimization', 'prompt-engineering'],
    depends_on: ['AC-10', 'AC-12'],
  },
  'AC-14': {
    kind: 'service-fact', lifecycle: 'preview', service: 'bedrock-agentcore',
    tags: ['agentcore', 'registry', 'governance', 'catalog'],
  },
  'AC-15': {
    kind: 'service-fact', lifecycle: 'preview', service: 'bedrock-agentcore',
    tags: ['agentcore', 'harness', 'runtime', 'declarative'],
    depends_on: ['AC-04'],
  },
  'AC-16': {
    kind: 'service-fact', lifecycle: 'preview', service: 'bedrock-agentcore',
    tags: ['agentcore', 'cli', 'developer-experience', 'kiro', 'claude-code', 'q-developer'],
  },
  'AC-17': {
    kind: 'service-fact', lifecycle: 'preview', service: 'bedrock-agentcore',
    tags: ['agentcore', 'payments', 'agentic-economy'],
    depends_on: ['AC-07'],
  },
  'AC-18': {
    kind: 'service-fact', lifecycle: 'ga', service: 'bedrock-agentcore',
    tags: ['agentcore', 'pricing', 'cost-control', 'economics'],
    depends_on: ['AC-04', 'AC-05', 'AC-06', 'AC-08', 'AC-09'],
    slots: {
      compute_price: {
        field: 'kv:0',
        find: 'Per-second CPU + memory for Runtime / Browser / Code Interpreter (active consumption only).',
        tier: 'A',
        template: 'Per-second vCPU + memory for Runtime / Browser / Code Interpreter, on active consumption only \u2014 {{fact:' + PRICE + '.runtime.vcpu.usd-per-vcpu-hour}} per vCPU-hour and {{fact:' + PRICE + '.runtime.memory.usd-per-gb-hour}} per GB-hour in Asia Pacific (Sydney).',
        facts: [`${PRICE}.runtime.vcpu.usd-per-vcpu-hour`, `${PRICE}.runtime.memory.usd-per-gb-hour`],
      },
      gateway_price: {
        field: 'kv:1',
        find: 'Per tool invocation (launched around $0.005 per 1,000 calls) plus request charges.',
        tier: 'A',
        template: 'Per tool invocation \u2014 {{fact:' + PRICE + '.gateway.api-invocations.usd-per-1k}} per 1,000 API invocations in Asia Pacific (Sydney) \u2014 plus tool-indexing and data-processing charges.',
        facts: [`${PRICE}.gateway.api-invocations.usd-per-1k`],
      },
    },
  },
  'AC-19': {
    kind: 'service-fact', lifecycle: 'ga', service: 'bedrock-agentcore',
    tags: ['agentcore', 'regions', 'compliance', 'anz', 'data-residency'],
    slots: {
      region_availability: {
        field: 'lead',
        find: 'AgentCore previewed in four regions \u2014 including Asia Pacific (Sydney) \u2014 and has expanded steadily since.',
        tier: 'A',
        template: 'AgentCore is available in {{fact:agentcore.regions.count}} AWS regions, including Asia Pacific (Sydney).',
        facts: ['agentcore.regions.count', 'agentcore.regions.list'],
      },
      sydney_availability: {
        field: 'kv:0',
        find: 'In the preview set (Jul 2025) and in the Evaluations GA region list (Mar 2026) \u2014 full-stack AgentCore is buildable ap-southeast-2-native.',
        tier: 'A',
        template: 'ap-southeast-2 is in the current bedrock-agentcore region list ({{fact:agentcore.regions.count}} regions total) \u2014 full-stack AgentCore is buildable Sydney-native.',
        facts: ['agentcore.regions.count', 'agentcore.regions.list'],
      },
    },
  },
  'AC-20': {
    kind: 'service-fact', lifecycle: 'ga', service: 'bedrock-agentcore',
    tags: ['agentcore', 'migration', 'bedrock-agents-classic', 'rename'],
    notes:
      'P5 rename fixture. The renamed entity is Bedrock Agents \u2192 Bedrock Agents Classic; when that gains its own card, this card sets supersedes[] and the Classic card carries the aka[] entry plus the closed-to-new-customers date. No aka[] here: AgentCore itself was never renamed.',
  },
  'AC-21': {
    kind: 'mental-model', lifecycle: 'ga', service: 'bedrock-agentcore',
    tags: ['agentcore', 'mental-model', 'recall'],
    // The fan-out fixture: a mental-model card with no deterministic source of
    // its own, kept honest only by depends_on[].
    depends_on: ['AC-04', 'AC-05', 'AC-06', 'AC-07', 'AC-08', 'AC-09', 'AC-10', 'AC-11', 'AC-12', 'AC-13', 'AC-15'],
  },
};
