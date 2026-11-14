/**
 * NDJSON event schema emitted by the "+feed" NetHack window-chain processor
 * (nethack/wc_feed.c), plus the derived game-state shape served by
 * GET /api/state and the browser <-> server websocket protocol.
 *
 * Shared by server/ and web/.  Keep in sync with wc_feed.c
 * (FEED_SCHEMA_VERSION there == FEED_SCHEMA_VERSION here).
 *
 * Conventions
 *  - One JSON object per line; every event has `t` (type) and `seq`
 *    (monotonic per game process, starting at 1).
 *  - Map coordinates are NetHack map coordinates: x in 1..79 (column 0 is
 *    never used), y in 0..20.  With the tty interface the cell is drawn at
 *    terminal column x-1, terminal row y+1 (row 0 is the message line).
 *  - Colors are NetHack color indexes (CLR_*): 0 black, 1 red, 2 green,
 *    3 brown, 4 blue, 5 magenta, 6 cyan, 7 gray, 8 no-color, 9 orange,
 *    10 bright green, 11 yellow, 12 bright blue, 13 bright magenta,
 *    14 bright cyan, 15 white.
 *  - Everything reported is what the player can legitimately know: map
 *    cells are the displayed/remembered glyphs, and descriptions come from
 *    NetHack's own farlook code (do_screen_description) applied to them.
 */

export const FEED_SCHEMA_VERSION = 1;

interface EventBase {
  /** event type */
  t: string;
  /** sequence number, monotonic within one nethack process */
  seq: number;
}

/** First event after the feed connects. */
export interface HelloEvent extends EventBase {
  t: 'hello';
  schema: number;
  pid: number;
  version_major: number;
  version_minor: number;
  patchlevel: number;
  /** map dimensions (COLNO, ROWNO) */
  cols: number;
  rows: number;
}

/** Hero arrived on a (different) level. Sent before the map_clear/map batch. */
export interface LevelEvent extends EventBase {
  t: 'level';
  /** dungeon branch number (0 = Dungeons of Doom, …) */
  dnum: number;
  /** level number within the branch */
  dlevel: number;
  /** absolute depth (what "Dlvl" shows) */
  depth: number;
  /** branch name, e.g. "The Dungeons of Doom", "The Gnomish Mines" */
  dungeon: string;
  /** short status-line form, e.g. "Dlvl:3", "Home 1", "Fort Ludios" */
  desc: string;
  /** long form, e.g. "level 3, the Gnomish Mines" */
  long_desc: string;
  /** level features the player has discovered (overview flags):
   *  oracle, bigroom, castle, valley, sanctum, ludios, roguelevel,
   *  sokoban_solved, bones, vibrating_square */
  known: string[];
  /** player's own #annotate text for the level */
  annotation?: string;
}

/** The map window was cleared (level change, full redraw). */
export interface MapClearEvent extends EventBase {
  t: 'map_clear';
  dnum?: number;
  dlevel?: number;
}

export interface MapCell {
  x: number;
  y: number;
  /** NetHack glyph number (version specific) */
  glyph: number;
  /** displayed character */
  ch: string;
  /** NetHack color index (see top of file) */
  color: number;
  /** MG_* glyph flags bitmask (omitted when 0): 0x1 hero, 0x2 corpse,
   *  0x4 invisible, 0x8 detected, 0x10 pet, 0x20 ridden, 0x40 statue,
   *  0x80 object pile, 0x400 "nothing", 0x800 unexplored,
   *  0x1000 male, 0x2000 female */
  flags?: number;
  /** short farlook description, e.g. "doorway", "tame kitten",
   *  "fountain", "human valkyrie called Kara" */
  desc: string;
  /** full farlook text without the symbol prefix, e.g.
   *  "a dog or other canine (tame little dog)" */
  look: string;
}

/** Changed map cells since the previous batch, flushed before input. */
export interface MapEvent extends EventBase {
  t: 'map';
  dnum: number;
  dlevel: number;
  cells: MapCell[];
  /** hero position */
  ux: number;
  uy: number;
}

/** Status line fields (from status_update; values as NetHack formats them). */
export type StatusKey =
  | 'title' | 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha' | 'align'
  | 'score' | 'encumbrance' | 'gold' | 'power' | 'power_max' | 'xp_level'
  | 'ac' | 'hit_dice' | 'time' | 'hunger' | 'hp' | 'hp_max' | 'level_desc'
  | 'exp_points' | 'weapon' | 'armor' | 'terrain' | 'version';

export interface StatusEvent extends EventBase {
  t: 'status';
  fields: Partial<Record<StatusKey, string>>;
  /** active conditions, e.g. ["Blind", "Conf", "Lev"] */
  conditions: string[];
  turn: number;
}

/** A message-window line (pline), raw_print, or restored history. */
export interface MsgEvent extends EventBase {
  t: 'msg';
  text: string;
  /** NetHack ATR_* attribute (omitted when 0) */
  attr?: number;
  /** absent for normal messages */
  source?: 'raw_print' | 'history' | 'message_menu';
  turn: number;
}

export type InventorySlot =
  | 'wielded' | 'wielded_primary' | 'wielded_secondary' | 'alternate'
  | 'quiver' | 'body_armor' | 'cloak' | 'helmet' | 'shield' | 'gloves'
  | 'boots' | 'shirt' | 'amulet' | 'left_ring' | 'right_ring' | 'eyewear'
  | 'saddle' | 'ball' | 'chain';

export interface InventoryItem {
  letter: string;
  /** full doname() text, e.g. "an uncursed +3 small shield (being worn)" */
  text: string;
  /** object class symbol, e.g. ")" */
  class_sym: string;
  /** object class name, e.g. "weapons" */
  class: string;
  quan: number;
  slots: InventorySlot[];
  worn: boolean;
  wielded: boolean;
}

/** Full inventory, sent whenever it may have changed. */
export interface InventoryEvent extends EventBase {
  t: 'inventory';
  items: InventoryItem[];
}

export type InputKind =
  | 'command'          // waiting for a command keystroke (nh_poskey in parse())
  | 'key'              // waiting for some other keystroke
  | 'yn'               // yn_function prompt
  | 'getlin'           // text entry prompt
  | 'extcmd'           // '#' extended command entry
  | 'menu'             // menu shown (see preceding 'menu' event)
  | 'more'             // --More-- on the message window
  | 'dismiss'          // text window / file being shown
  | 'player_selection' // character creation
  | 'askname';         // "Who are you?"

/** The game is about to block waiting for the player. */
export interface InputEvent extends EventBase {
  t: 'input';
  kind: InputKind;
  turn: number;
  /** hero position (when on a level) */
  ux?: number;
  uy?: number;
  /** yn / getlin prompt text */
  prompt?: string;
  /** yn: allowed answers, e.g. "ynq" */
  choices?: string;
  /** yn: default answer */
  default?: string;
}

/** Answer given to a yn prompt. */
export interface AnswerEvent extends EventBase {
  t: 'answer';
  kind: 'yn';
  prompt: string;
  value: string;
}

export interface MenuItem {
  text: string;
  /** accelerator if the core supplied one (tty assigns a-z itself otherwise) */
  ch?: string;
  selectable: boolean;
  selected?: boolean;
  attr?: number;
}

/** A menu is being displayed (inventory, pick-up list, options, …). */
export interface MenuEvent extends EventBase {
  t: 'menu';
  win: number;
  how: 'none' | 'one' | 'any';
  prompt: string;
  items: MenuItem[];
}

export interface MenuDoneEvent extends EventBase {
  t: 'menu_done';
  win: number;
  /** number of items picked, -1 if cancelled */
  count: number;
}

/** Text window contents (e.g. discoveries, ^X attributes, help pages). */
export interface TextEvent extends EventBase {
  t: 'text';
  win: number;
  kind: 'text' | 'menu_text';
  lines: string[];
}

export interface DisplayFileEvent extends EventBase {
  t: 'display_file';
  name: string;
}

/** Tombstone time: the hero died / quit / escaped (how = NetHack death code). */
export interface GameOverEvent extends EventBase {
  t: 'gameover';
  how: number;
  turn: number;
}

/** Window system shutting down (save, quit, death). */
export interface ExitEvent extends EventBase {
  t: 'exit';
  text: string;
}

export type FeedEvent =
  | HelloEvent | LevelEvent | MapClearEvent | MapEvent | StatusEvent
  | MsgEvent | InventoryEvent | InputEvent | AnswerEvent | MenuEvent
  | MenuDoneEvent | TextEvent | DisplayFileEvent | GameOverEvent | ExitEvent;

export type FeedEventType = FeedEvent['t'];

export const FEED_EVENT_TYPES: readonly FeedEventType[] = [
  'hello', 'level', 'map_clear', 'map', 'status', 'msg', 'inventory',
  'input', 'answer', 'menu', 'menu_done', 'text', 'display_file',
  'gameover', 'exit',
];

/* ------------------------------------------------------------------ */
/* Derived state (GET /api/state)                                      */

export interface LevelKeyed {
  dnum: number;
  dlevel: number;
}

export interface LevelInfo extends LevelKeyed {
  depth: number;
  dungeon: string;
  desc: string;
  long_desc: string;
  known: string[];
  annotation?: string;
}

export interface LevelMemory {
  /** "dnum:dlevel" */
  key: string;
  info: LevelInfo | null;
  /** remembered cells (anything not shown here is unexplored) */
  cells: MapCell[];
  /** ASCII rendering of the remembered map, ROWNO lines (index = y) */
  rows: string[];
  /** turn the hero was last on this level */
  lastSeenTurn: number;
}

export interface MessageEntry {
  seq: number;
  turn: number;
  text: string;
  source?: MsgEvent['source'];
}

export interface GameState {
  /** nethack process session */
  session: SessionInfo;
  feed: { connected: boolean; lastSeq: number; events: number; parseErrors: number; schema: number | null };
  turn: number;
  hero: { x: number; y: number } | null;
  status: { fields: StatusEvent['fields']; conditions: string[] } | null;
  awaiting: Omit<InputEvent, 't'> | null;
  currentLevel: string | null;
  levels: Record<string, LevelMemory>;
  messages: MessageEntry[];
  inventory: InventoryItem[];
  /** menu currently open (cleared on menu_done) */
  menu: Omit<MenuEvent, 't'> | null;
  /** last text window shown */
  lastText: Omit<TextEvent, 't'> | null;
  gameover: { how: number; turn: number } | null;
}

export interface SessionInfo {
  state: 'idle' | 'running' | 'exited';
  pid: number | null;
  player: string;
  startedAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  signal: number | null;
  /** number of times a nethack process has been started by this server */
  launches: number;
}

/* ------------------------------------------------------------------ */
/* Websocket protocol (/ws)                                            */

export type ServerMessage =
  /** full terminal snapshot (xterm serialize format) — sent on connect/restart */
  | { type: 'snapshot'; data: string; cols: number; rows: number; session: SessionInfo }
  /** live pty bytes */
  | { type: 'output'; data: string }
  /** session lifecycle change */
  | { type: 'session'; session: SessionInfo }
  /** throttled state view: like GameState but `levels` only holds the current level */
  | { type: 'state'; state: GameState };

export type ClientMessage =
  /** keystrokes to send to the game */
  | { type: 'input'; data: string }
  /** start a new game / resume the saved one (no-op while running) */
  | { type: 'start' };
