/** Loads cards, categories, facts and the card ID ledger from disk. */

import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Card, Category, FactSet } from './types.ts';
import { FactStore } from './facts.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const paths = {
  cards: join(ROOT, 'cards'),
  facts: join(ROOT, 'facts'),
  content: join(ROOT, 'content'),
  schema: join(ROOT, 'schema'),
  dist: join(ROOT, 'dist'),
  tests: join(ROOT, 'tests'),
  legacyHtml: join(ROOT, 'agentcore-flashcards.html'),
  /** Append-only record of every card id ever issued (FR-9: ids are never reused). */
  idLedger: join(ROOT, 'content', 'card-id-ledger.json'),
};

export function loadCards(): Card[] {
  const files = readdirSync(paths.cards).filter((f) => f.endsWith('.json')).sort();
  return files.map((f) => JSON.parse(readFileSync(join(paths.cards, f), 'utf8')) as Card);
}

export function saveCard(card: Card): void {
  writeFileSync(join(paths.cards, `${card.card_id}.json`), JSON.stringify(card, null, 2) + '\n', 'utf8');
}

export function loadCategories(): Category[] {
  const j = JSON.parse(readFileSync(join(paths.content, 'categories.json'), 'utf8')) as { categories: Category[] };
  return j.categories;
}

export function loadArt(): Record<string, string> {
  return JSON.parse(readFileSync(join(paths.content, 'art.json'), 'utf8')) as Record<string, string>;
}

export function loadFactStore(): FactStore {
  return new FactStore(paths.facts);
}

export function loadSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(paths.schema, name), 'utf8')) as Record<string, unknown>;
}

export function saveFactSet(fileName: string, set: FactSet): void {
  writeFileSync(join(paths.facts, fileName), JSON.stringify(set, null, 2) + '\n', 'utf8');
}

export function loadFactSetFile(fileName: string): FactSet | null {
  const p = join(paths.facts, fileName);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as FactSet;
}

export function loadIdLedger(): string[] {
  if (!existsSync(paths.idLedger)) return [];
  const j = JSON.parse(readFileSync(paths.idLedger, 'utf8')) as { issued: string[] };
  return j.issued;
}

export function saveIdLedger(issued: string[]): void {
  writeFileSync(
    paths.idLedger,
    JSON.stringify(
      {
        comment:
          'Append-only. Every card id ever issued. A card id is stable for the life of the concept and is NEVER reused, even after retirement (FR-9). validate.ts fails if an id disappears from cards/ without a tombstone.',
        issued: [...issued].sort(),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}
