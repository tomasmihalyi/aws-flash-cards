/** Shared types. Mirrors schema/card.schema.json and schema/fact-set.schema.json. */

export type Tier = 'A' | 'B' | 'C';
export type Kind = 'service-fact' | 'practice' | 'distillation' | 'mental-model';
export type Lifecycle = 'preview' | 'ga' | 'deprecated' | 'superseded' | 'retired';
export type Confidence = 'high' | 'medium' | 'low';
export type RenderedFrom = 'seed' | 'tier-a' | 'tier-b' | 'tier-c';

export type Source = {
  url: string;
  title?: string;
  kind?: string;
  fetched_at: string;
  content_hash: string;
  author?: string;
  published_at?: string;
};

export type Slot = {
  tier: Tier;
  template: string;
  facts: string[];
  rendered: string;
  rendered_from: RenderedFrom;
  seed_text: string;
  unresolvable_reason?: string;
};

export type ReviewReason = {
  reason: string;
  raised_at: string;
  raised_by?: string;
  trigger_card?: string;
  trigger_fact?: string;
};

export type HistoryEntry = {
  at: string;
  tier: Tier | 'seed';
  action: 'import' | 'verify' | 'correct' | 'rename' | 'supersede' | 'retire' | 'flag-review' | 'clear-review';
  generator: string;
  slot?: string;
  /** A card field rather than a slot — lifecycle, badge_variant, badge_text. */
  field?: string;
  before?: string;
  after?: string;
  facts?: string[];
  reason?: string;
};

export type Card = {
  schema_version: 1;
  card_id: string;
  kind: Kind;
  lifecycle: Lifecycle;
  service: string;
  category: string;
  tags: string[];
  badge_variant: 'ga' | 'pv' | 'core';
  badge_text: string;
  art: string;
  title: string;
  hook: string;
  back: { lead: string; kv: { k: string; v: string }[]; hookline: string };
  slots: Record<string, Slot>;
  facts_used: string[];
  sources: Source[];
  verified_at: string | null;
  confidence: Confidence;
  depends_on: string[];
  aka: { name: string; changed_at: string; source?: string }[];
  superseded_by: string | null;
  supersedes: string[];
  needs_review: boolean;
  review_reasons: ReviewReason[];
  provenance: {
    tier: Tier | 'seed';
    authored_by: 'human' | 'model' | 'pipeline' | 'legacy-import';
    history: HistoryEntry[];
  };
  created_at: string;
  updated_at: string;
  notes?: string;
};

export type FactValue = {
  type: 'integer' | 'number' | 'string' | 'boolean' | 'region_list' | 'string_list' | 'money';
  value: unknown;
  unit?: string;
  currency?: string;
  note?: string;
};

export type FactSet = {
  schema_version: 1;
  fact_set_id: string;
  tier: 'A';
  generator: string;
  verified_at: string;
  source: {
    kind: 'ssm-public-parameter' | 'price-list-api' | 'botocore-model';
    url: string;
    fetched_at: string;
    content_hash: string;
    retrieved_by?: string;
    aws_account?: string;
    aws_region?: string;
  };
  /**
   * The fetched payload, retained so claims can be string-matched against their
   * source. `canonical` is exactly what `source.content_hash` was computed over,
   * so validate can re-hash it and prove the hash rather than trust it.
   */
  evidence: { canonical: unknown; text: string };
  facts: Record<string, FactValue>;
  previous?: Record<string, unknown>;
};

export type Category = { id: string; label: string };
