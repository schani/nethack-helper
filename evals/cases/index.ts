/** All eval cases, validated (unique ids, fixtures / live recipes exist). */
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURE_DIR } from '../src/fixtures.ts';
import type { EvalCase } from '../src/types.ts';
import { cases as deep } from './deep.ts';
import { cases as items } from './items.ts';
import { cases as keys } from './keys.ts';
import { cases as knowledge } from './knowledge.ts';
import { cases as look } from './look.ts';
import { cases as policy } from './policy.ts';
import { cases as state } from './state.ts';

export const ALL_CASES: EvalCase[] = [...state, ...look, ...items, ...knowledge, ...policy, ...deep, ...keys];

/** A fixed ~40-case subset spanning every category, for cheaper single-change experiments (--set core). */
export const CORE: string[] = [
  'state-hp-hunger', 'state-low-hp-trouble', 'state-should-i-pray-early', 'state-yn-prompt', 'state-menu-open', 'state-not-running', 'state-char-creation', 'state-more-prompt',
  'look-f-next-to-me', 'look-adjacent-all', 'look-fountain-this', 'look-sink-not-fountain', 'look-altar-alignment', 'look-shopkeeper', 'look-stairs-current', 'look-fight-order',
  'other-mines-entrance', 'other-down-stairs-lvl1', 'other-main-stairs-lvl2', 'other-scroll-shop-where',
  'inv-carrying', 'hidden-unid-potion', 'hidden-price-id-consent', 'hidden-called-potion', 'discoveries-list',
  'know-floating-eye', 'know-pray-how', 'v5-genetic-engineer', 'v5-valkyrie-spear', 'v5-elbereth-changed',
  'spoiler-sokoban-ask', 'spoiler-quest', 'spoiler-consent-persists', 'hall-wand-of-wishing', 'hall-false-killed', 'concise-early-wizard',
  'robust-wiki-down', 'robust-game-tools-fail',
];

export async function loadCases(): Promise<EvalCase[]> {
  const { RECIPES } = await import('../fixtures/recipes.ts');
  const seen = new Set<string>();
  for (const c of ALL_CASES) {
    if (seen.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
    seen.add(c.id);
    if (c.live) {
      if (!RECIPES.some((r) => r.id === c.live)) throw new Error(`case ${c.id}: unknown live recipe ${c.live}`);
    } else if (!fs.existsSync(path.join(FIXTURE_DIR, `${c.fixture ?? 'start-pet-adjacent'}.json`))) {
      throw new Error(`case ${c.id}: fixture ${c.fixture} not found`);
    }
    if (!c.turns.length) throw new Error(`case ${c.id}: no turns`);
  }
  for (const id of CORE) if (!seen.has(id)) throw new Error(`CORE lists unknown case ${id}`);
  return ALL_CASES;
}
