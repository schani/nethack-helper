/** Game state: status, prompts / menus / --More--, conditions, game not running. */
import type { EvalCase } from '../src/types.ts';

export const cases: EvalCase[] = [
  {
    id: 'state-hp-hunger',
    tags: ['state', 'concise'],
    fixture: 'start-pet-adjacent',
    audio: true,
    turns: [
      {
        user: "What's my HP and am I hungry?",
        expect: { tools: { any: ['get_status'] }, must: [/11/], mustNot: [/\byou(?:'re| are) (?:getting )?hungry\b/i], maxWords: 45 },
      },
    ],
    truth: 'HP 11 of 11 (full). Not hungry.',
  },
  {
    id: 'state-where-am-i',
    tags: ['state'],
    fixture: 'minetown',
    turns: [{ user: 'Where am I right now?', expect: { tools: { any: ['get_status', 'list_levels', 'get_screen', 'look'] }, mustAny: [/mine/i], maxWords: 70 } }],
    truth: 'Dlvl 6 in the Gnomish Mines (this is Minetown: watchmen are present). A peaceful watchman is adjacent south.',
    rubric: 'Saying "level 6 of the Gnomish Mines" is enough; naming Minetown is a plus only if supported (watchman present, or Minetown is the usual mines level 5-8 with watchmen).',
  },
  {
    id: 'state-low-hp-trouble',
    tags: ['state', 'knowledge'],
    fixture: 'low-hp',
    audio: true,
    turns: [
      {
        user: "I'm getting beaten up. How bad is it and what should I do?",
        expect: { tools: { any: ['get_status'] }, must: [/\b4\b|four/i], maxWords: 90 },
      },
    ],
    truth:
      'HP 4 of 16 (25%), turn 12, a hostile jackal is adjacent (north-east); the hill orc is dead. Praying would NOT work yet: the prayer timeout starts at 300 and must be at most 200 for low-HP trouble, so on turn 12 it is far too soon (the god would be displeased, no help). Good advice: kill or flee the jackal (jackals are weak), retreat upstairs, eat/rest later; an unknown dark potion lies adjacent NW (unidentified).',
    rubric: 'Recommending prayer as safe or likely to work on turn 12 is a correctness failure (score <= 2). Mentioning prayer as an option only with a correct "too early" caveat is fine.',
  },
  {
    id: 'state-should-i-pray-early',
    tags: ['state', 'knowledge', 'hallucination'],
    fixture: 'low-hp',
    turns: [{ user: 'My HP is low, should I pray now?', expect: { tools: { any: ['get_status'] }, maxWords: 90 } }],
    truth:
      'Turn 12, HP 4/16 (counts as major trouble: HP 5 or less). The prayer timeout starts at 300 and must be at most 200 for major trouble, so praying on turn 12 is too soon: the god will be displeased and will not help. Correct answer: no, it is too early (roughly before turn 100-ish it will not work), deal with the jackal another way.',
    rubric: 'Pass only if it advises against praying now because it is too early in the game (the exact numbers are a spoiler-ish detail; mentioning that the prayer timeout starts high is fine). Saying "yes, pray, low HP is major trouble so your god will heal you" is wrong.',
  },
  {
    id: 'state-conditions',
    tags: ['state'],
    fixture: 'hungry-conditions',
    turns: [{ user: "Something feels off. What's wrong with me?", expect: { tools: { any: ['get_status'] }, must: [/hungry/i, /blind/i, /confus/i], maxWords: 90 } }],
    truth: 'Status: Hungry, Blind (just put on a blindfold) and Confused (just drank booze: "Ooph! This tastes like liquid fire!"). HP 16/16.',
  },
  {
    id: 'state-hungry-food',
    tags: ['state', 'inventory'],
    fixture: 'hungry-conditions',
    turns: [{ user: "I'm hungry, what can I eat?", expect: { tools: { any: ['get_inventory'] }, must: [/food ration/i], maxWords: 70 } }],
    truth: 'Inventory contains an uncursed food ration (and a blindfold being worn). Eating it fixes hunger; it takes several turns (5 turns) to eat.',
  },
  {
    id: 'state-yn-prompt',
    tags: ['state', 'prompt'],
    fixture: 'fountain-quaff-prompt',
    audio: true,
    turns: [{ user: 'What is the game asking me?', expect: { tools: { any: ['get_status', 'get_screen', 'get_messages'] }, must: [/drink|quaff/i, /fountain/i], maxWords: 70 } }],
    truth: 'The game asks "Drink from the fountain? [yn] (n)" because the hero is standing on a fountain and pressed q (quaff). y drinks from the fountain, n (default) lets them pick a potion from inventory instead.',
  },
  {
    id: 'state-yn-should-i',
    tags: ['state', 'prompt', 'spoiler'],
    fixture: 'fountain-quaff-prompt',
    turns: [{ user: 'Should I say yes?', expect: { tools: { any: ['get_status', 'get_screen', 'get_messages', 'look'] }, maxWords: 90 } }],
    truth: 'Pending: "Drink from the fountain? [yn] (n)". Quaffing from fountains is a gamble: mostly harmless, but it can summon water moccasins or a water demon, cause hallucination-like effects etc.; at low level a water demon is very dangerous. Typical advice: say no at XL 1.',
    rubric: 'A good answer gives a recommendation (usually no, it is risky at low level) without listing all outcomes; the full list of fountain effects is spoiler-level (offer it). Mentioning that a water demon can appear is common knowledge and acceptable.',
  },
  {
    id: 'state-more-prompt',
    tags: ['state', 'prompt', 'hallucination'],
    fixture: 'more-prompt',
    turns: [{ user: "What's going on, the game is stuck?", expect: { tools: { any: ['get_status', 'get_screen', 'get_messages'] }, must: [/more|enter|continue/i], maxWords: 80 } }],
    truth: 'Not stuck: the game shows --More-- after "You begin praying to Anhur. You finish your prayer." and waits for Enter. The next message is "The voice of Anhur rings out:" (what the god says is not shown yet). Praying on turn 6 is far too soon.',
    rubric: 'Must not invent what Anhur says or the outcome of the prayer (not visible yet). It may say the prayer was very early and the god may be displeased.',
  },
  {
    id: 'state-menu-open',
    tags: ['state', 'prompt'],
    fixture: 'menu-open',
    turns: [{ user: 'What is this menu? I want to give that scroll a name.', expect: { tools: { any: ['get_status', 'get_screen'] }, mustAny: [/\bo\b|type of an object/i], maxWords: 90 } }],
    truth:
      'The #call menu "What do you want to name?" is open: m monster, i particular object in inventory, o the type of an object in inventory, f type of object on floor, d type on discoveries list, a annotation for the level. To name the scroll type (so all scrolls labeled ASHPD SODALG show the name) pick o, then the scroll (letter p); i names only that one scroll.',
  },
  {
    id: 'state-not-running',
    tags: ['state', 'robustness'],
    fixture: 'not-running',
    audio: true,
    turns: [{ user: 'How many hit points do I have?', expect: { tools: { any: ['get_status'] }, mustAny: [/not running|no game|isn.t running|start/i], mustNot: [/\b1[0-9] hit points|you have \d+/i], maxWords: 50 } }],
    truth: 'The game is not running; there is no character data. The player can start/resume it with the button on the game screen.',
  },
  {
    id: 'state-not-running-general',
    tags: ['state', 'robustness', 'knowledge'],
    fixture: 'not-running',
    turns: [{ user: 'While the game is off: what does Elbereth do?', expect: { tools: { none: ['web_search'] }, mustAny: [/scare|flee|afraid|frighten/i], maxWords: 90 } }],
    truth: 'Engraving Elbereth scares most monsters (they flee and will not melee you while you stand on it); @ humans, minotaurs, shopkeepers/guards/priests and the Riders ignore it. Since 3.6 it erodes when you attack while standing on it (it gets erased).',
    rubric: 'General question; the game not running should not prevent answering. Mentioning the exceptions is a plus, not required.',
  },
  {
    id: 'state-char-creation',
    tags: ['state', 'prompt'],
    fixture: 'char-creation',
    turns: [{ user: 'What should I answer here?', expect: { tools: { any: ['get_status', 'get_screen', 'get_messages'] }, mustAny: [/pick|choose|random|role/i], maxWords: 90 } }],
    truth: 'Character creation: the game asks "Shall I pick character\'s race, role, gender and alignment for you? [ynaq]". y = random character, n = choose yourself, a = pick all randomly without confirmation (accept), q = quit. There is no map yet.',
    rubric: 'Explaining the choices and maybe suggesting a beginner-friendly role (e.g. Valkyrie or Samurai) is ideal.',
  },
  {
    id: 'state-last-message',
    tags: ['state'],
    fixture: 'unid-items',
    turns: [{ user: 'What did the last message say?', expect: { tools: { any: ['get_messages', 'get_status', 'get_screen'] }, mustAny: [/fox/i], maxWords: 60 } }],
    truth: 'Recent messages: "The fox bites!" then "The kitten misses the fox." A hostile fox is adjacent south-east; the hero has 13 of 16 HP.',
  },
];
