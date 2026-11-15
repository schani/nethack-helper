/** Inventory, discoveries, and hidden information (unidentified items, unseen things). */
import type { EvalCase } from '../src/types.ts';

const NO_IDENTITY = [/\b(?:it'?s|it is|that'?s|that is|probably|likely|must be|could well be) (?:a |an )?(?:potion|scroll|ring|wand|amulet) of\b/i];

export const cases: EvalCase[] = [
  {
    id: 'inv-carrying',
    tags: ['inventory', 'concise'],
    fixture: 'start-pet-adjacent',
    audio: true,
    turns: [{ user: 'What am I carrying?', expect: { tools: { any: ['get_inventory'] }, mustAny: [/quarterstaff|cloak/i], maxWords: 90 } }],
    truth: 'Blessed +1 quarterstaff (wielded), +0 cloak of magic resistance (worn), wand of locking, rings of sustain ability and +1 increase damage, potions of holy water, booze and oil, scrolls of destroy armor, magic mapping and identify, spellbooks of force bolt and confuse monster, magic marker, bell. All identified (wizard starting kit).',
    rubric: 'Spoken summary: highlights (weapon, armor, a few notable items) and offer the rest; reading all 15 items is too long (speakability <= 3).',
  },
  {
    id: 'inv-what-to-wear',
    tags: ['inventory', 'knowledge'],
    fixture: 'unid-items',
    turns: [{ user: 'Should I put on that ring?', expect: { tools: { any: ['get_inventory'] }, mustNot: NO_IDENTITY, maxWords: 90 } }],
    truth: 'i - an engagement ring, unidentified. Putting on unknown rings is risky (teleportitis, hunger, aggravate monster, polymorph, levitation; a cursed one cannot be removed). Common advice: test it first (e.g. drop on an altar for B/U/C) or wait.',
    rubric: 'Must not claim to know which ring it is. Giving the general risk and a safe approach is ideal; identification tricks are spoiler-level (ask first).',
  },
  {
    id: 'hidden-unid-potion',
    tags: ['hidden-info', 'spoiler'],
    fixture: 'shop',
    audio: true,
    turns: [{ user: 'What is this fizzy potion?', expect: { tools: { any: ['look', 'get_status', 'get_inventory', 'get_screen'] }, mustNot: NO_IDENTITY, mustAny: [/can.t (tell|know|be sure)|cannot (tell|know)|no way to (tell|know)|random|shuffled|unidentified|don.t know|not identified/i], maxWords: 90 } }],
    truth: 'Unidentified fizzy potion for sale at 333 zorkmids. Appearances are randomized per game. Price identification is possible (spoiler-level).',
    rubric: 'Pass: says it cannot tell from the appearance and (optionally) offers spoiler-level identification help such as price identification with a warning/question. Fail: names or hints at a specific potion type, or explains price-ID details without consent.',
  },
  {
    id: 'hidden-price-id-consent',
    tags: ['hidden-info', 'spoiler', 'multi-turn'],
    fixture: 'shop',
    turns: [
      { user: 'Can I figure out what this fizzy potion is somehow?', expect: { mustNot: NO_IDENTITY, mustAny: [/spoiler|want me to|would you like|shall i|do you want/i], maxWords: 90 } },
      { user: 'Yes, spoilers are fine. How does the price trick work here?', expect: { mustNot: NO_IDENTITY, mustAny: [/price|base|charisma|zorkmid|333/i], maxWords: 130 } },
    ],
    truth:
      'Price identification: shop prices are a base price times modifiers; potions are grouped by base price, so the price narrows the type down to a group. The sell price is 333 zorkmids; with the Valkyrie\'s Charisma 8 there is a one third surcharge, so the base would be 250, though a random 1/3 surcharge can also apply (so base could be 200 or 250...). Checking what the shopkeeper offers when you try to sell is the other half. The exact group membership is spoiler detail the user consented to.',
    rubric: 'Turn 1: must not explain the method yet; offers with a spoiler warning. Turn 2: consented, so it should explain concretely (base price groups, charisma modifier, sell offers) without asking again. Do not penalize omitting the exact potion list; penalize wrong statements (e.g. claiming the price uniquely identifies the potion).',
  },
  {
    id: 'hidden-wand-engrave',
    tags: ['hidden-info', 'spoiler'],
    fixture: 'unid-items',
    turns: [{ user: 'What does my forked wand do?', expect: { tools: { any: ['get_inventory'] }, mustNot: [...NO_IDENTITY, /engrave[- ]?(test|identif)/i], mustAny: [/can.t (tell|know)|cannot (tell|know)|don.t know|unidentified|not identified|random/i], maxWords: 90 } }],
    truth: 'j - a forked wand, unidentified; its type cannot be known from the appearance. Engrave-testing is a spoiler-level identification method (mention + ask).',
    rubric: 'Must not explain engrave-testing details without consent; mentioning that there are ways to identify it and asking is ideal.',
  },
  {
    id: 'hidden-called-potion',
    tags: ['hidden-info', 'discoveries'],
    fixture: 'unid-items',
    turns: [{ user: 'Is my maybe healing potion really a potion of healing?', expect: { tools: { any: ['get_inventory', 'get_discoveries'] }, mustNot: [/\byes\b.*\bhealing\b|it is (a )?(potion of )?healing/i], maxWords: 80 } }],
    truth: '"maybe healing" is the player\'s own name (#call) for the murky potion type; the type is NOT identified, so nobody can tell whether it is healing.',
  },
  {
    id: 'discoveries-list',
    tags: ['discoveries', 'inventory'],
    fixture: 'start-pet-adjacent',
    turns: [{ user: 'Which scrolls have I identified so far?', expect: { tools: { any: ['get_discoveries', 'get_inventory'] }, must: [/identify/i, /magic mapping/i, /destroy armor/i], maxWords: 80 } }],
    truth: 'Identified scrolls: destroy armor, magic mapping, identify (starting inventory). The discoveries also list a seen-but-unidentified scroll appearance ASHPD SODALG.',
  },
  {
    id: 'discoveries-called',
    tags: ['discoveries', 'hidden-info'],
    fixture: 'unid-items',
    turns: [{ user: 'What have I discovered so far?', expect: { tools: { any: ['get_discoveries'] }, mustNot: NO_IDENTITY, maxWords: 100 } }],
    truth: 'Discoveries show the Valkyrie\'s known items plus the player-named type: murky potion called "maybe healing". The wished potions/scrolls/ring/wand/amulet are unidentified.',
  },
  {
    id: 'hidden-unseen-level',
    tags: ['hidden-info', 'spoiler', 'hallucination'],
    fixture: 'deep-dlvl4',
    turns: [{ user: "What's on level 5?", expect: { tools: { any: ['list_levels', 'get_level_map'] }, mustAny: [/haven.t|not (been|visited|explored)|don.t know|no (map|memory)|unknown|not yet/i], maxWords: 70 } }],
    truth: 'Level 5 has not been visited, so nothing is known about it from the game. (Describing what could generally be there, e.g. possibly the Oracle between 5 and 9, would be a spoiler-ish guess.)',
  },
  {
    id: 'hidden-dark-potion-adjacent',
    tags: ['hidden-info', 'look'],
    fixture: 'low-hp',
    turns: [{ user: 'There is a potion right next to me. Could it heal me?', expect: { tools: { any: ['look', 'get_screen'] }, mustNot: NO_IDENTITY, maxWords: 90 } }],
    truth: 'A dark potion lies adjacent to the north-west; it is unidentified, so whether it heals is unknown (drinking unknown potions is a gamble). HP is 4/16 with a jackal adjacent.',
  },
  {
    id: 'hidden-pet-location-unseen',
    tags: ['hidden-info', 'hallucination'],
    fixture: 'hungry-conditions',
    turns: [{ user: 'Where is my kitten right now?', expect: { tools: { any: ['look', 'get_screen', 'get_messages'] }, maxWords: 80 } }],
    truth: 'The hero is blind (just put on a blindfold: "You can\'t see any more."), so the kitten is not shown on the map; its location is unknown. Nothing in the recent messages says where it is.',
    rubric: 'Must not claim a specific current position for the kitten. Mentioning blindness as the reason is ideal.',
  },
  {
    id: 'inv-encumbrance-check',
    tags: ['inventory', 'state', 'concise'],
    fixture: 'unid-items',
    turns: [{ user: 'Am I carrying too much?', expect: { tools: { any: ['get_status', 'get_inventory'] }, mustAny: [/no\b|not|unencumbered|fine|light/i], maxWords: 40 } }],
    truth: 'Unencumbered.',
  },
];
