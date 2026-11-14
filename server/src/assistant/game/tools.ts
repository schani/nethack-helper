/**
 * Game tools for the assistant: thin adapters from tool calls to GameView,
 * backed by the game session service (state reducer, level memory, screen).
 */
import type { GameState } from '../../../../shared/feed-events.ts';
import { ToolError } from '../knowledge/util.ts';
import { GameView, type ScreenText } from './view.ts';

/** What the assistant needs from the game session service (read-only). */
export interface GameSource {
  readonly running: boolean;
  state(opts?: { allLevels?: boolean }): GameState;
  screen(): ScreenText;
}

const DIRECTION_RULE = 'Positions are given relative to the hero in compass and screen terms (north = up, east = right); speak them that way, never as coordinates.';

export const GAME_TOOL_DEFS = [
  {
    type: 'function',
    name: 'get_status',
    description:
      "The player's current status: name, role, race, alignment, location (dungeon branch, level, depth), turn, HP, power, AC, " +
      'experience level, gold, attributes, hunger, encumbrance, conditions (e.g. Blind, Conf, Stun), what the hero stands on, and ' +
      'what the game is waiting for right now (a command, a yes/no question with its text, a menu with its items and letters, ' +
      '--More--, or a text window with its contents). Use it for any question about the player\'s state ("how am I doing?", "am I hungry?", "what is it asking me?").',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'get_screen',
    description:
      'The current game screen as text (message line, map, status lines) plus a legend of every distinct symbol on the map with ' +
      'its description, and where the notable ones are relative to the hero. Use it to get the big picture of what the player sees. ' +
      DIRECTION_RULE,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'look',
    description:
      'Describe map squares relative to the hero, using what the player sees or remembers (NetHack\'s own farlook descriptions). ' +
      'target can be: "adjacent" (all eight neighbouring squares and what is underfoot); "here" (the hero\'s own square); ' +
      '"nearby" (notable things within radius, nearest first); a direction with optional distance ("north", "2 west", "up-left", "southeast 3"; ' +
      'without a distance it scans along that direction); a map symbol ("f", "{", ">", "F"; letters are case sensitive); or words from a description ' +
      '("fountain", "kitten", "stairs down", "potion", "my pet"). Call this BEFORE answering anything about something on the map ' +
      '("what\'s that f?", "what\'s next to me?", "is there a fountain here?"). ' +
      DIRECTION_RULE,
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'What to look at (see above). Default "adjacent".' },
        radius: { type: 'integer', description: 'For "nearby": how many squares around the hero (default 7).' },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_inventory',
    description:
      "The player's inventory with item letters, exactly as the game names each item (so unidentified items appear only by their " +
      'appearance, e.g. "a bubbly potion"), and what is worn and wielded.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'list_levels',
    description:
      'All dungeon levels the player has visited, with branch, depth, remembered features (stairs, altars, fountains, sinks, thrones, ' +
      'traps…), the player\'s own level annotations, and the dungeon overview exactly as Ctrl-O shows it (shops, temples, branches such ' +
      'as the Gnomish Mines or Sokoban entrance). Use for "what was on level 1?", "where was that altar?", "where are the Mines?".',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'get_level_map',
    description:
      'The remembered map of one level as text, with its features, objects and monsters (as last seen) and where they are: relative to the ' +
      'hero on the current level, otherwise as a map region and relative to the up staircase. ' +
      DIRECTION_RULE,
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'string', description: 'Which level: "current", a depth number like "1" or "3", "mines 3", "sokoban", etc.' },
      },
      required: ['level'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_messages',
    description: 'The most recent game messages (what the top line of the screen said), oldest first, with the turn of each.',
    parameters: {
      type: 'object',
      properties: { n: { type: 'integer', description: 'How many messages (default 10, max 50).' } },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_discoveries',
    description:
      "The player's object discoveries exactly as the game's \\ command lists them: identified object types, types the player has named " +
      '("called"), and the appearances seen. Use it before talking about which items the player has identified.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const;

export const GAME_TOOL_NAMES: readonly string[] = GAME_TOOL_DEFS.map((t) => t.name);

function int(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`argument '${name}' must be a number`);
  return Math.floor(n);
}

/** Runs game tools against the live game session (or any GameSource). */
export class GameTools {
  private source: GameSource;

  constructor(source: GameSource) {
    this.source = source;
  }

  has(name: string): boolean {
    return GAME_TOOL_NAMES.includes(name);
  }

  view(): GameView {
    return new GameView({ running: this.source.running, state: this.source.state({ allLevels: true }), screen: this.source.screen() });
  }

  run(name: string, args: Record<string, unknown>): string {
    const v = this.view();
    switch (name) {
      case 'get_status':
        return v.getStatus();
      case 'get_screen':
        return v.getScreen();
      case 'look': {
        const target = typeof args.target === 'string' ? args.target : 'adjacent';
        return v.look(target, int(args.radius, 'radius'));
      }
      case 'get_inventory':
        return v.getInventory();
      case 'list_levels':
        return v.listLevels();
      case 'get_level_map':
        return v.getLevelMap(typeof args.level === 'string' ? args.level : String(args.level ?? 'current'));
      case 'get_messages':
        return v.getMessages(int(args.n, 'n') ?? 10);
      case 'get_discoveries':
        return v.getDiscoveries();
      default:
        throw new ToolError(`unknown tool '${name}'`);
    }
  }

  /** compact live context for the model */
  snapshot(): { text: string; turn: number } {
    const v = this.view();
    return { text: v.snapshot(), turn: v.st.turn };
  }
}
