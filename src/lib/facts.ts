/**
 * Fact store + slot resolution.
 *
 * This module is the enforcement point for the system's central rule: a number,
 * price, date or region list can only reach a card through a fact set written by
 * a deterministic ingest job. There is no code path by which authored prose can
 * introduce one, and no code path by which a missing fact silently becomes an
 * empty string.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Card, FactSet, FactValue } from './types.ts';

export class FactStore {
  private facts = new Map<string, { value: FactValue; set: FactSet }>();

  constructor(dir: string) {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      const set = JSON.parse(readFileSync(join(dir, f), 'utf8')) as FactSet;
      for (const [id, value] of Object.entries(set.facts)) {
        if (this.facts.has(id)) {
          throw new Error(`fact "${id}" defined twice — second definition in ${f}`);
        }
        this.facts.set(id, { value, set });
      }
    }
  }

  has(id: string): boolean {
    return this.facts.has(id);
  }

  get(id: string): { value: FactValue; set: FactSet } | undefined {
    return this.facts.get(id);
  }

  ids(): string[] {
    return [...this.facts.keys()].sort();
  }

  /** Fact sets backing a list of fact ids, deduplicated. */
  setsFor(ids: string[]): FactSet[] {
    const seen = new Map<string, FactSet>();
    for (const id of ids) {
      const hit = this.facts.get(id);
      if (hit) seen.set(hit.set.fact_set_id, hit.set);
    }
    return [...seen.values()].sort((a, b) => a.fact_set_id.localeCompare(b.fact_set_id));
  }
}

/**
 * Renders a fact for inclusion in prose. Formatting is deterministic code, never
 * a model decision — that is what lets a price appear in a sentence without
 * violating the "no model-generated numbers" rule.
 */
export function formatFact(id: string, f: FactValue): string {
  switch (f.type) {
    case 'integer':
      if (!Number.isInteger(f.value)) throw new Error(`fact ${id}: type integer but value is ${String(f.value)}`);
      return String(f.value);
    case 'number':
      return trimNumber(Number(f.value));
    case 'money': {
      const n = Number(f.value);
      if (!Number.isFinite(n)) throw new Error(`fact ${id}: money value is not finite`);
      const sym = (f.currency ?? 'USD') === 'USD' ? '$' : `${f.currency} `;
      return sym + trimNumber(n);
    }
    case 'boolean':
      return f.value ? 'yes' : 'no';
    case 'string':
      return String(f.value);
    case 'region_list':
    case 'string_list': {
      const list = f.value as string[];
      return list.join(', ');
    }
    default:
      throw new Error(`fact ${id}: unknown type ${String(f.type)}`);
  }
}

/** Fixed-notation, trailing zeros trimmed. 0.005 → "0.005", 0.25 → "0.25". */
function trimNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(10).replace(/0+$/, '');
  if (s.endsWith('.')) s = s.slice(0, -1);
  return s;
}

export const FACT_RE = /\{\{fact:([a-z0-9][a-z0-9._-]*)\}\}/g;
export const SLOT_RE = /\{\{slot:([a-z0-9][a-z0-9_-]*)\}\}/g;

export type ResolveResult =
  | { ok: true; text: string; factIds: string[] }
  | { ok: false; missing: string[] };

/** Resolve a slot template against the fact store. Fails on ANY missing fact. */
export function resolveTemplate(template: string, store: FactStore): ResolveResult {
  const missing: string[] = [];
  const used: string[] = [];
  const text = template.replace(FACT_RE, (_m, id: string) => {
    const hit = store.get(id);
    if (!hit) {
      missing.push(id);
      return '';
    }
    used.push(id);
    return formatFact(id, hit.value);
  });
  if (missing.length) return { ok: false, missing };
  return { ok: true, text, factIds: [...new Set(used)].sort() };
}

/**
 * Expand {{slot:…}} references in a card's prose using each slot's `rendered`
 * value. The build reads nothing but `rendered`, which is what keeps it
 * deterministic and offline-capable.
 */
export function expandSlots(text: string, card: Card): string {
  return text.replace(SLOT_RE, (_m, name: string) => {
    const slot = card.slots[name];
    if (!slot) {
      throw new Error(`card ${card.card_id}: prose references unknown slot "${name}"`);
    }
    return slot.rendered;
  });
}

/** Every slot reference appearing anywhere in a card's prose. */
export function slotRefs(card: Card): string[] {
  const fields = [
    card.title,
    card.hook,
    card.back.lead,
    card.back.hookline,
    ...card.back.kv.flatMap((r) => [r.k, r.v]),
  ];
  const out = new Set<string>();
  for (const f of fields) for (const m of f.matchAll(SLOT_RE)) out.add(m[1]);
  return [...out].sort();
}
