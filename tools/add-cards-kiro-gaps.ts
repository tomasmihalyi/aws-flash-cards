/**
 * Close the three actionable coverage gaps — all Kiro, all IDE/CLI changelog
 * entries no card's subject matched.
 *
 * WHY THESE ARE AUTHORED AND NOT DRAFTED
 *
 * Tier B rewrites the PROSE of a card that already exists. These three are
 * "no card covers this", so there is nothing to rewrite. New cards are Tier C by
 * definition in the spec, which is the same reason the drafter cannot help here:
 * it is an authoring job, not a refresh.
 *
 * Each card is grounded in a day-precision Kiro changelog entry, and each leads
 * with the CONCEPT rather than the feature list — a card that enumerates a release
 * is a release note, and release notes are what the ingest already reads.
 *
 * Run: node tools/add-cards-kiro-gaps.ts [--dry-run]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCards, saveCard, paths } from '../src/lib/store.ts';
import type { Card, FactSet } from '../src/lib/types.ts';

const dryRun = process.argv.includes('--dry-run');
const NOW = new Date().toISOString();

/** The retained Kiro changelog fact set supplies the citation. */
function kiroSource(): Card['sources'][number] {
  const p = join(paths.facts, 'kiro.changelog.json');
  if (!existsSync(p)) throw new Error('facts/kiro.changelog.json is absent — run: npm run ingest:kiro');
  // The citation is taken from the fact set's own `source` block rather than
  // reconstructed, so the content_hash on the card is the hash `validate` will
  // re-check. Hand-writing it is how a provenance record drifts from its evidence.
  const set = JSON.parse(readFileSync(p, 'utf8')) as {
    source?: { url?: string; kind?: string; fetched_at?: string; content_hash?: string };
  };
  const s = set.source;
  if (!s?.content_hash || !s.fetched_at) {
    throw new Error('facts/kiro.changelog.json has no source.content_hash — re-run the ingest');
  }
  return {
    url: s.url ?? 'https://kiro.dev/changelog/',
    title: 'Kiro changelog',
    kind: 'vendor-changelog',
    fetched_at: s.fetched_at,
    content_hash: s.content_hash,
  } as Card['sources'][number];
}

type Spec = {
  card_id: string;
  title: string;
  hook: string;
  art: string;
  tags: string[];
  lead: string;
  kv: { k: string; v: string }[];
  hookline: string;
};

const SPECS: Spec[] = [
  {
    card_id: 'CA-09',
    title: 'When your agent config needs a migration',
    hook: 'Your agent definition is a file. What happens when its format changes?',
    art: 'migrate',
    tags: ['coding-agents', 'kiro', 'cli', 'configuration'],
    lead:
      'Kiro shipped `/upgrade-agent` to move V2 custom agent configurations to a universal format. The command is the unremarkable part. What it tells you is that an agent definition has become a versioned artifact with a migration path — which means it is infrastructure, not preference, and belongs in review like anything else that ships.',
    kv: [
      {
        k: 'What the command does',
        v: 'Migrates a V2 custom agent configuration to the universal format, in place. One command, not a rewrite.',
      },
      {
        k: 'Why a migration tool is the signal',
        v: 'Nobody writes an upgrade path for a file people are expected to hand-edit and throw away. A migration command is what a vendor ships when the file is long-lived enough that breaking it would cost users real work.',
      },
      {
        k: 'What follows for a team',
        v: 'If the config is a versioned artifact, it needs the treatment: checked in, reviewed, and pinned per project rather than living in one developer\'s home directory. A shared agent nobody reviewed is a shared prompt nobody reviewed.',
      },
    ],
    hookline:
      'A tool that migrates a config is a vendor telling you the config matters. Treat it like code, because they already do.',
  },
  {
    card_id: 'CA-10',
    title: 'Opening someone else’s repo is an input',
    hook: 'You cloned an unfamiliar repository and opened it. What did you just feed your agent?',
    art: 'policy',
    // The feature vocabulary lives in the tags, not the title. check-coverage
    // matches title + tags + service, so a conceptual title stays conceptual while
    // the card remains findable by the words the changelog entry actually used.
    tags: ['coding-agents', 'kiro', 'security', 'prompt-injection', 'mcp', 'agent-plugin', 'session-pinning'],
    lead:
      'Alongside Agent Plugin support and session pinning, Kiro changed how spec hovers and MCP installs handle **untrusted workspace content**. That is the sentence worth stopping on: a workspace you did not write is attacker-controlled input, and anything in it that an agent reads — a spec file, an MCP server definition, a hover — is a channel into your session.',
    kv: [
      {
        k: 'The surface',
        v: 'A repository can carry a spec, a hook, or an MCP server config. An agent that reads those on open is executing someone else\'s instructions before you have read a line of their code.',
      },
      {
        k: 'Why an MCP install is the sharpest edge',
        v: 'A spec hover shows you text. An MCP server definition adds TOOLS. Auto-trusting one from an unfamiliar repository hands a stranger the ability to name what your agent can do.',
      },
      {
        k: 'What to carry into a review',
        v: 'Ask where workspace trust is decided and what happens before it is. "We prompt on first open" is a real answer; "the config is just data" is not — data an agent reads is instructions.',
      },
    ],
    hookline:
      'Cloning a repo is reading untrusted input. The agent reads it too, and it is more credulous than you are.',
  },
  {
    card_id: 'CA-11',
    title: 'Meeting the developer at the error',
    hook: 'Why does an "Ask Kiro to Fix" quick fix matter more than it sounds?',
    art: 'code',
    // 'hook' singular, deliberately: the stemmer takes the first five characters,
    // so 'hooks' stems to "hooks" and never matches a heading that says "Hook".
    tags: ['coding-agents', 'kiro', 'ide', 'developer-experience', 'editor-actions', 'hook'],
    lead:
      'Kiro added an editor context submenu, a guided form for creating hooks, and an **Ask Kiro to Fix** quick fix on errors and warnings. Individually those are conveniences. Together they move the agent from a panel you switch to into the place the problem already is — and the distance between noticing a defect and asking for help is most of what decides whether anyone asks.',
    kv: [
      {
        k: 'The pattern',
        v: 'The agent appears on the squiggle, in the context menu, and in a form — at the point of the problem, rather than in a chat you have to go and find.',
      },
      {
        k: 'Why a guided form for hooks',
        v: 'A hook is powerful and easy to get subtly wrong. A form is an admission that the blank file was the barrier, and that discoverability beats expressiveness for a feature most people never enable.',
      },
      {
        k: 'What to watch for',
        v: 'Convenience at the error site raises how often an agent is invoked on small things. That is the intent, and it is also where an unreviewed suggestion is most likely to be accepted without reading — the same reason a quick fix is useful.',
      },
    ],
    hookline:
      'The agent that gets used is the one already where you are looking. That is also the one whose output you skim.',
  },
];

function build(spec: Spec, source: Card['sources'][number]): Card {
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
    back: { lead: spec.lead, kv: spec.kv, hookline: spec.hookline },
    // No slots: nothing here is a number a deterministic source could supply.
    // A card with no governed value is honest about that rather than inventing one.
    slots: {},
    facts_used: [],
    sources: [source],
    verified_at: source.fetched_at,
    confidence: 'medium',
    depends_on: [],
    aka: [],
    superseded_by: null,
    supersedes: [],
    needs_review: false,
    review_reasons: [],
    signed_off: null,
    provenance: {
      tier: 'C',
      authored_by: 'human',
      history: [
        {
          at: NOW,
          tier: 'C',
          action: 'import',
          generator: 'tools/add-cards-kiro-gaps.ts',
          reason: `Authored to close an actionable check-coverage gap: the Kiro changelog entry this card covers matched no existing card's subject. New cards are Tier C by definition.`,
        },
      ],
    },
    created_at: NOW,
    updated_at: NOW,
  } as unknown as Card;
}

function main(): void {
  const existing = new Set(loadCards().map((c) => c.card_id));
  const source = kiroSource();

  for (const spec of SPECS) {
    if (existing.has(spec.card_id)) {
      console.log(`skip  ${spec.card_id} — already exists`);
      continue;
    }
    const card = build(spec, source);
    if (!dryRun) saveCard(card);
    console.log(`${dryRun ? 'would add' : 'added'}  ${card.card_id}  ${card.title}`);
  }

  if (dryRun) console.log('\n--dry-run: nothing written');
  else console.log('\nNext: node tools/sync-id-ledger.ts && npm run check');
}

if (import.meta.filename === process.argv[1]) main();
