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
 *  - The feed never changes the game: farlook/doname texts are computed in
 *    a throw-away forked copy of the game process (see wc_feed.c), so
 *    describing a cell does not mark objects as seen, consume the RNG, etc.
 */

export const FEED_SCHEMA_VERSION = 3;

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

/**
 * Identity of the game being played.  Sent once per nethack process, when
 * the move loop starts (before the first `level` event).
 */
export interface GameEvent extends EventBase {
  t: 'game';
  /** started fresh (character creation) or restored from a save file;
   *  'unknown' should not happen */
  origin: 'new' | 'restored' | 'unknown';
  /** character name (plname) */
  name: string;
  /** u.ubirthday: unix time the character was created; with `name` this
   *  identifies the game across save/restore */
  birthday: number;
  /** NetHack's per-game UUID (svn.nhuuid; may be empty) */
  uuid: string;
  role: string;
  race: string;
  gender: string;
  alignment: string;
  mode: 'normal' | 'explore' | 'debug';
  turn: number;
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
  /** selection letter shown on screen: the core's accelerator, or the one
   *  tty assigned itself (a-z, A-Z, restarting on every page) */
  ch?: string;
  /** true when `ch` was assigned by tty rather than by the game core */
  assigned?: boolean;
  /** 1-based tty menu page the item is shown on (letters are only valid
   *  on their own page) */
  page?: number;
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
  /** number of tty pages ('>' / '<' to flip) */
  pages?: number;
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

/**
 * The player's object discoveries, exactly as the `\\` (#known) command
 * would show them right now: a header line, class headings, and one line
 * per known/called object type ("* " prefix = known without having been
 * seen, e.g. role knowledge), plus artifacts and relics.  Computed by
 * running the command in the feed's throw-away child; sent on change.
 */
export interface DiscoveriesEvent extends EventBase {
  t: 'discoveries';
  lines: string[];
}

/**
 * The dungeon overview, exactly as the ^O (#overview) command would show
 * it right now: branch headings ("The Dungeons of Doom: levels 1 to 4"),
 * "Level N:" lines with annotations and "<- You are here.", and indented
 * feature lines ("A fountain.", "Stairs down to the Gnomish Mines.").
 * Sent on change.
 */
export interface OverviewEvent extends EventBase {
  t: 'overview';
  lines: string[];
}

/**
 * What the map remembers under the hero (shown once the hero steps off;
 * the same thing ':' reports), e.g. "fountain", "staircase down", the top
 * object of a pile.  `desc` is empty when nothing is remembered there
 * (plain floor is reported as "floor of a room").  Sent on change.
 */
export interface UnderfootEvent extends EventBase {
  t: 'underfoot';
  x: number;
  y: number;
  /** remembered glyph (levl[x][y].glyph) and how it is drawn */
  glyph: number;
  ch: string;
  color: number;
  desc: string;
  look: string;
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
  | HelloEvent | GameEvent | LevelEvent | MapClearEvent | MapEvent | StatusEvent
  | MsgEvent | InventoryEvent | InputEvent | AnswerEvent | MenuEvent
  | MenuDoneEvent | TextEvent | DisplayFileEvent | GameOverEvent | ExitEvent
  | DiscoveriesEvent | OverviewEvent | UnderfootEvent;

export type FeedEventType = FeedEvent['t'];

export const FEED_EVENT_TYPES: readonly FeedEventType[] = [
  'hello', 'game', 'level', 'map_clear', 'map', 'status', 'msg', 'inventory',
  'input', 'answer', 'menu', 'menu_done', 'text', 'display_file',
  'gameover', 'exit', 'discoveries', 'overview', 'underfoot',
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
  /** remembered cells.  Anything not listed is blank: unexplored, or
   *  solid rock shown as blank (e.g. after magic mapping) */
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

/** GameEvent plus a stable id used to key persisted memory */
export interface GameIdentity extends Omit<GameEvent, 't' | 'seq' | 'turn'> {
  /** "<name>-<birthday>" (filesystem safe) */
  id: string;
}

/** What the game is waiting for.  `source` tells whether this came from the
 *  feed, or from the terminal screen when tty raised a --More-- by itself
 *  (message line overflow), which the feed cannot see. */
export type Awaiting = Omit<InputEvent, 't'> & { source: 'feed' | 'screen' };

/** Level memory and message log persisted per game (server data dir). */
export interface PersistedMemory {
  format: 1;
  game: GameIdentity;
  savedAt: string;
  turn: number;
  currentLevel: string | null;
  levels: Array<{ key: string; info: LevelInfo | null; cells: MapCell[]; lastSeenTurn: number }>;
  messages: MessageEntry[];
}

export interface GameState {
  /** nethack process session */
  session: SessionInfo;
  /** the game being played (null until the feed announces it) */
  game: (GameIdentity & { memoryRestored: boolean }) | null;
  feed: { connected: boolean; lastSeq: number; events: number; parseErrors: number; schema: number | null };
  turn: number;
  hero: { x: number; y: number } | null;
  status: { fields: StatusEvent['fields']; conditions: string[] } | null;
  awaiting: Awaiting | null;
  currentLevel: string | null;
  levels: Record<string, LevelMemory>;
  messages: MessageEntry[];
  inventory: InventoryItem[];
  /** menu currently open (cleared on menu_done) */
  menu: Omit<MenuEvent, 't'> | null;
  /** last text window shown */
  lastText: Omit<TextEvent, 't'> | null;
  gameover: { how: number; turn: number } | null;
  /** what `\\` would show (null until the feed reports it) */
  discoveries: string[] | null;
  /** what ^O would show (null until the feed reports it) */
  overview: string[] | null;
  /** remembered map feature/object under the hero (null: unknown) */
  underfoot: Omit<UnderfootEvent, 't' | 'seq'> | null;
  /** objects last listed at a spot ("Things that are here" / "You see here") */
  pile: { level: string; x: number; y: number; turn: number; items: string[] } | null;
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
  /** keystrokes to send to the game.  `data` is 7-bit: anything else can't
   *  be typed into NetHack (C locale) and would be misread as Meta keys, so
   *  the server drops it.  `meta: true` sends every character as a Meta key
   *  (8th bit set, what NetHack expects with altmeta off), e.g. M-d = #dip. */
  | { type: 'input'; data: string; meta?: boolean }
  /** start a new game / resume the saved one (no-op while running) */
  | { type: 'start' };
