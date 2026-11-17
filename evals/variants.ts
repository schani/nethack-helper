/**
 * Named eval variants: overrides of the production assistant config.
 * `baseline` is whatever production currently uses (no overrides).
 * Add one variant per experiment and change one thing at a time.
 */
import type { Variant } from './src/types.ts';

const v = (name: string, description: string, rest: Omit<Variant, 'name' | 'description'> = {}): Variant => ({ name, description, ...rest });

/** Prompt edits (exact text of the phase-3 prompt, evals/prompts/phase3/instructions.md -> replacement). */
export const EDITS = {
  otherLevelDirections: {
    find: 'For other levels, use the region ("in the north-east part of the map") or the position relative to the up staircase.',
    replace:
      'For other levels, say where it is on the screen ("in the top-right part of the map") and give the rough distance from the staircase where the player will arrive on that level, as get_level_map phrases it (coming down they arrive on its up staircase, coming up on its down staircase), for example "it\'s in the top right, about 50 squares to the right and 7 up from where you arrive coming down". Round big numbers. If they want to go there, mention the travel command: underscore, then < or > puts the cursor on a staircase.',
  },
  quietTools: {
    find: 'Game tools are instant: when you only need game tools, call them right away without a preamble.',
    replace:
      'Game tools are instant: never announce them or say that you are checking ("let me look", "I\'ll pull up your map", "one moment"); call them right away and then just answer. Common, stable NetHack knowledge needs neither a knowledge tool nor a preamble: answer directly.',
  },
  aroundMe: {
    find: '  - "What\'s that f?", "what\'s next to me?", "is that a fountain?", "what\'s this?": look (target "f", "adjacent", "fountain", a direction like "2 north", or "here" for their own square).',
    replace:
      '  - "What\'s that f?", "what\'s next to me?", "is that a fountain?", "what\'s this?": look (target "f", "adjacent", "fountain", a direction like "2 north", or "here" for their own square). "What\'s around me?", "what can I see?", "which one should I fight?": look with target "nearby" (adjacent squares only show the eight neighbours).',
  },
  concise: {
    find: `This is spoken audio, so keep it short.
- Simple factual questions: one to three short sentences, then stop.
- Strategy or "how do I" questions: give the single most useful tip or the first step, then offer more ("Want the full rundown?").`,
    replace: `This is spoken audio, and every extra sentence makes the player wait. Answer first, in the first sentence; then stop.
- Simple factual questions: one or two short sentences (under about 40 words). No closing offers or "if you want" on simple facts.
- Strategy, advice or "how do I" questions: the single most useful tip or the first step in two or three sentences (under about 60 words), then at most one short offer ("Want more?").
- Even after the player asks for details or agrees to a spoiler, keep it to about 100 words per answer and continue on request.
- Do not narrate what you are doing, repeat the question, or add asides, warnings or flavor that were not asked for.`,
  },
  facts: {
    find: '# Seeing the Game',
    replace: `# Verified Controls and Facts (use them for advice; do not recite numbers unless asked)
- Controls: pray with #pray (or Alt+p); travel with _ (then < or > puts the cursor on a staircase); engrave with E; offer a sacrifice with #offer; look at a square with ; ; name things with #call (C): o names a whole object type in your inventory (all items of that appearance), i names only that one object, f an object type on the floor.
- Prayer: the prayer timeout starts at about 300 and drops by about 1 per turn. Prayer only helps when the player is in trouble and the timeout is low enough: below 200 for major trouble (HP at most 5 or below one seventh of maximum, Weak from hunger, food poisoning, stoning...), below 100 for minor trouble. So in roughly the first 100 turns of a game praying does not help even at very low HP. Never suggest praying on an altar of another alignment (it angers your god).
- Altars: dropping items on any altar shows whether they are blessed, uncursed or cursed; that is the safe use of a cross-aligned altar.

# Seeing the Game`,
  },
};

/**
 * The phase-3 production config (prompt frozen in evals/prompts/phase3, exact offsets from the up staircase on
 * other levels). The experiments below were run as edits of it; v2 (all winners) is the current production config.
 */
const PHASE3 = {
  promptsDir: 'evals/prompts/phase3',
  game: { levelDirections: 'region' },
  tools: {
    get_level_map: {
      description:
        'The remembered map of one level as text, with its features, objects and monsters (as last seen) and where they are: relative to the ' +
        'hero on the current level, otherwise as a map region and relative to the up staircase. ' +
        'Positions are given relative to the hero in compass and screen terms (north = up, east = right); speak them that way, never as coordinates.',
    },
  },
};
const V2_EDITS = [EDITS.facts, EDITS.otherLevelDirections, EDITS.aroundMe, EDITS.quietTools, EDITS.concise];

/**
 * v3 ablations. v3 = v2 + knowledge tools (wiki tables, 5.0 changelog appended, case-insensitive source search with whole
 * changelog entries, nethack_lookup) + prompt fixes (P9). evals/prompts/v2 is the frozen v2 production prompt.
 * prompt-only runs the v3 prompt on the frozen v2 knowledge tools, so its nethack_lookup references are edited out.
 */
const NO_LOOKUP_EDITS = [
  {
    find: `- A named monster, item, artifact, role or race, what a fountain, sink, throne or altar does, or how shop prices work: nethack_lookup first. It is instant, needs no preamble, and has the exact 5.0 data (stats, attacks, starting inventory, effect tables); a name that is not in the game comes back as not in NetHack 5.0. Add fetch_wiki_page (in parallel) only for strategy or explanations.
- A game concept, level, spell or strategy topic (Elbereth, Sokoban, prayer): fetch_wiki_page with that name. One wiki page usually answers it; it includes tables and the matching 5.0 changelog entries.`,
    replace:
      '- A named monster, item, artifact, role, spell, level, or game concept: fetch_wiki_page with that name. One wiki page usually answers it. If you also want 5.0 confirmation, call search_nethack_source in the same turn, in parallel.',
  },
  { find: 'Game tools and nethack_lookup are instant', replace: 'Game tools are instant' },
  { find: 'check it (nethack_lookup, the changelog)', replace: 'check it (the 5.0 changelog)' },
  { find: 'trust nethack_lookup and the 5.0 source and changelog first', replace: 'trust the 5.0 source and changelog first' },
  { find: 'fetch_wiki_page and nethack_lookup resolve approximate names themselves', replace: 'fetch_wiki_page resolves approximate titles itself' },
  { find: '; and lines that nethack_lookup marks SPOILER-LEVEL.', replace: '.' },
  { find: 'for example look plus nethack_lookup for the monster it shows.', replace: 'for example look plus fetch_wiki_page for the monster it shows.' },
];

export const VARIANTS: Record<string, Variant> = Object.fromEntries(
  [
    // ---- current production (server/prompts, default tool formats): use these for new experiments
    v('baseline', 'current production config (v5: v4 + much terser spoken answers; deep-thinking expert enabled)'),
    v('mini', 'production on gpt-realtime-2.1-mini (production prompt + mini addendum)', { model: 'gpt-realtime-2.1-mini' }),
    v('reasoning-minimal', 'production with reasoning effort minimal', { reasoning: 'minimal' }),
    v('reasoning-medium', 'production with reasoning effort medium', { reasoning: 'medium' }),
    v('no-snapshot', 'production without live-context snapshots (tools only)', { snapshot: 'none' }),
    // ---- v4 = v3 + get_keybindings (the game's actual key bindings) + concise style rewrite
    // ---- v5 = v4 + much terser spoken answers (style section with good/bad pairs, 2-4 word preambles, no add-ons)
    v('v4-prompt', 'the v4 production prompt (frozen in evals/prompts/v4: ~40-word answers, 3-6 word preambles) on current tools', { promptsDir: 'evals/prompts/v4' }),
    v('v3-prompt', 'the v3 production prompt (frozen in evals/prompts/v3: no get_keybindings rule, old verbosity section) on current tools', { promptsDir: 'evals/prompts/v3' }),
    // ---- deep-thinking expert (consult_expert -> gpt-6.1-terra, reasoning high, in the background)
    // runs: deep-noexp / deep-exp2 (tags deep, N=3: 37% -> 74%), core-noexp / core-exp (core, N=2: 82% -> 82%, expert never called)
    v('no-expert', 'production without the deep-thinking expert', { expert: false }),
    v('expert', 'production with the deep-thinking expert (consult_expert, gpt-6.1-terra high)', { expert: true }),
    // ---- v3 ablations (production = v3)
    v('v2-frozen', 'the v2 production config: frozen v2 prompt and v2 knowledge tools (no lookup, no wiki tables/changelog)', { promptsDir: 'evals/prompts/v2', knowledge: 'v2' }),
    v('tools-only', 'v3 knowledge tools (wiki tables + changelog, source search, nethack_lookup) with the frozen v2 prompt', { promptsDir: 'evals/prompts/v2' }),
    v('prompt-only', 'v3 prompt (lookup references edited out) with the frozen v2 knowledge tools', { knowledge: 'v2', promptEdits: NO_LOOKUP_EDITS }),
    // ---- experiment history, reproducible against the frozen phase-3 config
    v('phase3', 'phase-3 production config (the original eval baseline)', { ...PHASE3 }),
    v('level-landmarks', 'phase3 + get_level_map: other-level positions as screen region + rough offsets from the arrival staircases', {
      ...PHASE3,
      game: { levelDirections: 'landmarks' },
    }),
    v('landmarks-prompt', 'level-landmarks + prompt: speak other-level positions from the arrival staircase, mention travel', {
      ...PHASE3,
      game: { levelDirections: 'landmarks' },
      promptEdits: [EDITS.otherLevelDirections],
    }),
    v('quiet-tools', 'phase3 + prompt: never announce game tools; no knowledge tools/preambles for stable basics; "around me" = look nearby', {
      ...PHASE3,
      promptEdits: [EDITS.quietTools, EDITS.aroundMe],
    }),
    v('facts', 'phase3 + prompt: verified controls + prayer facts section', { ...PHASE3, promptEdits: [EDITS.facts] }),
    v('concise', 'phase3 + prompt: tighter verbosity rules (answer first, word budgets, no narration/asides)', { ...PHASE3, promptEdits: [EDITS.concise] }),
    v('v2', 'phase3 + landmarks-prompt + quiet-tools + concise + facts (adopted as production)', {
      ...PHASE3,
      game: { levelDirections: 'landmarks' },
      promptEdits: V2_EDITS,
    }),
    v('v2-minimal', 'v2 with reasoning effort minimal', { ...PHASE3, reasoning: 'minimal', game: { levelDirections: 'landmarks' }, promptEdits: V2_EDITS }),
    v('v2-mini', 'v2 on gpt-realtime-2.1-mini', { ...PHASE3, model: 'gpt-realtime-2.1-mini', game: { levelDirections: 'landmarks' }, promptEdits: V2_EDITS }),
  ].map((x) => [x.name, x]),
);
