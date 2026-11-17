/**
 * "How do I …" key questions: the answer must be this game's actual binding (get_keybindings), never a key guessed
 * from memory.  Ground truth: the fixture's keybindings (production nethackrc, number_pad:0 / vi-keys), as reported
 * by the game itself.
 */
import type { EvalCase } from '../src/types.ts';

const KEYS_TOOL = { any: ['get_keybindings'] };
const VI_KEYS = 'This game has number_pad off (vi-keys): h j k l y u b n move, so k is "move north", not kick.';

export const cases: EvalCase[] = [
  {
    id: 'keys-kick',
    tags: ['keys'],
    fixture: 'start-pet-adjacent',
    audio: true,
    turns: [
      {
        user: 'How do I kick?',
        expect: {
          tools: KEYS_TOOL,
          mustAny: [/\b(?:ctrl|control)\s*[-+]?\s*d\b|\^d\b/i],
          mustNot: [/\b(?:press|hit|type|use)\s+(?:the\s+)?(?:letter\s+)?["'‘“]?k["'’”]?(?:\s+key)?(?:\b|$)/i, /\bletter k\b/i, /\bk key\b/i, /\bcheck (?:the )?help\b/i],
          maxWords: 40,
        },
      },
    ],
    truth: `Kick is Ctrl+D (Control D), or the extended command #kick; then give a direction. ${VI_KEYS}`,
    rubric: 'Correct key is Ctrl+D (or #kick). Recommending k, or telling the player to look it up in the help, is wrong.',
  },
  {
    id: 'keys-pray',
    tags: ['keys'],
    fixture: 'start-pet-adjacent',
    turns: [
      {
        user: 'How do I pray?',
        expect: {
          tools: KEYS_TOOL,
          mustAny: [/\b(?:alt|meta|option)\s*[-+]?\s*p\b|M-p\b|#\s*pray|pound pray|hash pray|type pray/i],
          mustNot: [/\b(?:ctrl|control)\s*[-+]?\s*p\b|\^p\b/i, /\b(?:press|hit)\s+(?:the\s+)?(?:letter\s+)?["']?p["']?(?:\s+key)?\b(?!\s*\+)/i],
          maxWords: 45,
        },
      },
    ],
    truth: 'Pray is Alt+P (Meta-p; in the browser hold Alt/Option and press p) or the extended command #pray, then confirm. Ctrl+P is previous message and p is pay, so those are wrong. Mentioning briefly that prayer only helps when in trouble and not prayed recently is fine; not required.',
    rubric: 'Correct: Alt+p or #pray. Wrong: Ctrl+P, plain p.',
  },
  {
    id: 'keys-pickup',
    tags: ['keys'],
    fixture: 'start-pet-adjacent',
    turns: [
      {
        user: 'What key picks things up?',
        expect: {
          tools: KEYS_TOOL,
          mustAny: [/comma|["'‘“(]\s*,\s*["'’”)]/i],
          mustNot: [/\b(?:press|hit|use|it'?s)\s+(?:the\s+)?(?:letter\s+)?["']?[gp]["']?(?:\s+key)?\b/i],
          maxWords: 35,
        },
      },
    ],
    truth: 'Pick up is the comma key (,), or #pickup.',
  },
  {
    id: 'keys-farlook',
    tags: ['keys'],
    fixture: 'start-pet-adjacent',
    turns: [
      {
        user: 'How do I look at something far away?',
        expect: {
          tools: KEYS_TOOL,
          mustAny: [/semicolon|(?<!back)slash/i],
          mustNot: [/(?<!semi)\bcolon\b/i],
          maxWords: 50,
        },
      },
    ],
    truth:
      'Press ; (semicolon, #glance), move the cursor onto the thing with the movement keys (m jumps to the next monster, o to the next object) and press . or , to select. / (slash, #whatis) works the same way. : (colon) only looks at your own square, so it is wrong here.',
    rubric: 'Correct: semicolon (or slash), then move the cursor and select. Naming colon as the way to look far away is wrong.',
  },
  {
    id: 'keys-discoveries',
    tags: ['keys'],
    fixture: 'start-pet-adjacent',
    turns: [
      {
        user: 'How do I see my discoveries?',
        expect: {
          tools: { any: ['get_keybindings', 'get_discoveries'] },
          mustAny: [/backslash|\\|#\s*known/i],
          mustNot: [/(?<!back)(?<!back )slash/i],
          maxWords: 40,
        },
      },
    ],
    truth: 'The \\ (backslash) key, or #known, lists the discovered object types (` / #knownclass shows one class).',
    rubric: 'Correct: backslash (or #known). Forward slash is wrong. Also listing the current discoveries is fine but not required.',
  },
];
