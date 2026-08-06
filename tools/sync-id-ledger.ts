/**
 * Append every current card id to the append-only id ledger.
 *
 * The ledger is what makes FR-9 enforceable: ids are never reused, and a card
 * that vanishes from cards/ without a tombstone is a validate error rather than
 * a silent loss of knowledge. Ids are only ever ADDED here — this tool never
 * removes one.
 *
 * Usage: node tools/sync-id-ledger.ts
 */

import { loadCards, loadIdLedger, saveIdLedger } from '../src/lib/store.ts';

const existing = loadIdLedger();
const current = loadCards().map((c) => c.card_id);
const merged = [...new Set([...existing, ...current])].sort();

const added = merged.filter((id) => !existing.includes(id));
saveIdLedger(merged);

console.log(`id ledger: ${merged.length} id(s) on record${added.length ? `, added ${added.join(', ')}` : ', no change'}`);
