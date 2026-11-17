/**
 * The game's actual key bindings for the assistant (get_keybindings).
 *
 * Source: the feed's 'keybindings' event, i.e. NetHack's own binding table as
 * this game has it right now (number_pad and its modes, BIND= lines,
 * rest_on_space), never a hard-coded list.  This module only renders key
 * codes readably, finds commands by what the player wants to do, and adds
 * notes about typing them in our browser client (web/src/keys.ts).
 */
import type { KeyBindingsEvent, KeyCommand } from '../../../../shared/feed-events.ts';

export type KeyBindings = Omit<KeyBindingsEvent, 't' | 'seq'>;

const PUNCT_NAMES: Record<string, string> = {
  ',': 'comma', '.': 'period', ':': 'colon', ';': 'semicolon', '\\': 'backslash', '/': 'slash', '_': 'underscore',
  '#': 'hash', '?': 'question mark', '&': 'ampersand', '<': 'less-than', '>': 'greater-than', '^': 'caret', '`': 'backtick',
  '@': 'at sign', '$': 'dollar', '*': 'asterisk', '(': 'open paren', ')': 'close paren', '[': 'open bracket', ']': 'close bracket',
  '=': 'equals', '"': 'double quote', "'": 'apostrophe', '+': 'plus', '-': 'minus', '!': 'exclamation mark', '|': 'bar',
  '~': 'tilde', '{': 'open brace', '}': 'close brace', '%': 'percent',
};

/** Control characters typed with Ctrl+<this> (0x00..0x1f) */
const CTRL_CHAR = (c: number) => String.fromCharCode(c + 64); // 0x04 -> 'D', 0x1f -> '_'

/** Ctrl+letter combos the browser keeps (close tab / new tab / new window), see BROWSER_RESERVED_CTRL in web/src/keys.ts */
export const BROWSER_RESERVED = new Set([0x17, 0x14, 0x0e]); // ^W ^T ^N

/** Readable name of one NetHack key code: "k", "D", "Ctrl+D", "Alt+p", "Alt+C", ", (comma)", "Space". */
export function keyLabel(code: number): string {
  const meta = code >= 128;
  const c = code & 0x7f;
  let base: string;
  if (c === 0x20) base = 'Space';
  else if (c === 0x1b) base = 'Esc';
  else if (c === 0x0d) base = 'Enter';
  else if (c === 0x7f) base = 'Backspace';
  else if (c < 0x20) base = `Ctrl+${CTRL_CHAR(c)}`;
  else base = String.fromCharCode(c);
  if (meta) return `Alt+${base}`;
  const spoken = PUNCT_NAMES[base];
  return spoken ? `${base} (${spoken})` : base;
}

/** Can this key be typed in our browser client, and how?  null = plainly typeable. */
export function webNote(code: number): string | null {
  const meta = code >= 128;
  const c = code & 0x7f;
  if (meta && (c < 0x20 || c === 0x7f)) return `${keyLabel(code)} cannot be typed in the browser client`;
  if (meta) {
    const ch = String.fromCharCode(c);
    const shifted = /[A-Z]/.test(ch) ? ` (Alt+Shift+${ch.toLowerCase()})` : '';
    return `${keyLabel(code)}${shifted}: hold Alt (Option on a Mac) and press ${shifted ? `Shift+${ch.toLowerCase()}` : ch}`;
  }
  if (BROWSER_RESERVED.has(c)) {
    const k = CTRL_CHAR(c);
    return `the browser keeps Ctrl+${k} for itself: click the ^${k} button under the game, or switch to Fullscreen (it captures Ctrl+W/T/N)`;
  }
  if (c === 0x1f) return 'Ctrl+_ is Ctrl+Shift+minus';
  return null;
}

/** Display order of a command's keys: plain keys, then Ctrl, then Alt (NetHack's own preference, cmd_from_func). */
function keyRank(code: number, cmd: KeyCommand, kb: KeyBindings): number {
  if (code >= 128) return 3;
  if (code < 0x20 || code === 0x7f) return 2;
  // '-' for fight and digits are number_pad leftovers NetHack itself doesn't advertise without number_pad
  if (!kb.number_pad && cmd.name === 'fight' && code === 0x2d) return 2.5;
  return 1;
}

export function sortedKeys(cmd: KeyCommand, kb: KeyBindings): number[] {
  return [...cmd.keys].sort((a, b) => keyRank(a, cmd, kb) - keyRank(b, cmd, kb));
}

// ---------------------------------------------------------------- finding commands by intent

/** Ways players ask for a command (by NetHack 5.0 command name).  Names not in the game's table are ignored. */
const ALIASES: Record<string, string[]> = {
  pickup: ['pick up', 'pick things up', 'pick it up', 'pickup', 'take', 'grab', 'get item', 'collect', 'take item from floor'],
  look: ['look here', 'what is here', 'what is under me', 'look down', 'look at floor', 'what am i standing on', 'look at my square'],
  glance: ['look at something', 'look far', 'far away', 'farlook', 'far look', 'look at distance', 'what is that', 'identify symbol', 'examine', 'look at monster', 'look at map', 'inspect', 'look'],
  whatis: ['look at something', 'look far', 'far away', 'farlook', 'far look', 'what is that symbol', 'identify symbol', 'examine', 'inspect', 'look'],
  known: ['discoveries', 'discovered', 'identified', 'known items', 'what have i identified', 'list discoveries', 'see discoveries'],
  knownclass: ['discoveries by class', 'discoveries of one class'],
  pray: ['pray', 'prayer', 'god', 'ask god for help'],
  kick: ['kick', 'kick door', 'kick open'],
  search: ['search', 'hidden', 'secret door', 'secret passage', 'find traps', 'find hidden'],
  wait: ['rest', 'wait', 'pass turn', 'skip turn', 'do nothing'],
  travel: ['travel', 'go to', 'walk to', 'auto travel', 'move to place', 'autoexplore'],
  retravel: ['travel again'],
  overview: ['dungeon overview', 'levels visited', 'dungeon map', 'overview', 'list levels'],
  attributes: ['stats', 'attributes', 'character info', 'enlightenment', 'my status', 'intrinsics'],
  inventory: ['inventory', 'items', 'what am i carrying', 'list items', 'bag'],
  apply: ['use', 'use tool', 'apply', 'open bag', 'use pick axe', 'use key', 'light lamp', 'unlock'],
  loot: ['loot', 'open box', 'open chest', 'open container', 'take out of box', 'put into box'],
  wield: ['wield', 'equip weapon', 'hold weapon', 'ready weapon', 'switch weapon'],
  wear: ['wear', 'wear armor', 'put on armor', 'equip armor'],
  puton: ['put on', 'put on ring', 'put on amulet', 'wear ring', 'wear amulet', 'blindfold', 'accessory'],
  takeoff: ['take off', 'take off armor', 'remove armor', 'unequip'],
  remove: ['remove', 'remove ring', 'remove amulet', 'take off ring', 'remove accessory'],
  takeoffall: ['take off everything', 'remove all armor'],
  fire: ['fire', 'shoot', 'shoot arrow', 'fire quiver', 'ranged attack', 'shoot bow'],
  throw: ['throw', 'throw dagger', 'toss'],
  quiver: ['quiver', 'ready ammo', 'select ammunition'],
  eat: ['eat', 'food', 'eat corpse'],
  quaff: ['drink', 'quaff', 'drink potion', 'drink from fountain'],
  read: ['read', 'read scroll', 'read spellbook', 'read book'],
  zap: ['zap', 'zap wand', 'use wand'],
  cast: ['cast', 'cast spell', 'spell', 'magic'],
  showspells: ['list spells', 'known spells', 'spells i know'],
  engrave: ['engrave', 'write', 'write in dust', 'elbereth', 'write elbereth', 'engrave test'],
  offer: ['offer', 'sacrifice', 'sacrifice corpse'],
  chat: ['chat', 'talk', 'speak', 'talk to'],
  pay: ['pay', 'pay shopkeeper', 'buy'],
  open: ['open door', 'open'],
  close: ['close door', 'close', 'shut door'],
  force: ['force lock', 'force', 'break open lock'],
  untrap: ['untrap', 'disarm trap', 'disarm'],
  sit: ['sit', 'sit on throne', 'sit down'],
  ride: ['ride', 'mount', 'dismount', 'steed'],
  jump: ['jump', 'leap'],
  dip: ['dip', 'dip into fountain', 'dip into potion', 'excalibur'],
  rub: ['rub', 'rub lamp', 'rub stone', 'touchstone'],
  invoke: ['invoke', 'artifact power'],
  turn: ['turn undead', 'turn'],
  monster: ['monster ability', 'special ability', 'use ability while polymorphed', 'breathe'],
  enhance: ['enhance', 'skills', 'advance skill', 'weapon skills', 'train skill'],
  call: ['call', 'name item type', 'name type', 'call item'],
  name: ['name', 'rename', 'name monster', 'name item', 'name pet', 'christen'],
  annotate: ['annotate', 'note level', 'level note', 'name level'],
  down: ['go down', 'downstairs', 'down stairs', 'descend', 'stairs down', 'climb down', 'go downstairs'],
  up: ['go up', 'upstairs', 'up stairs', 'ascend', 'stairs up', 'climb up', 'go upstairs'],
  save: ['save', 'save game', 'save and quit', 'stop playing'],
  quit: ['quit', 'give up', 'end game'],
  options: ['options', 'settings', 'preferences', 'configure'],
  help: ['help', 'help menu'],
  whatdoes: ['what does key do', 'what does this key do', 'key help'],
  redraw: ['redraw', 'refresh screen'],
  prevmsg: ['previous message', 'message history', 'old messages', 'last message', 'repeat message', 'messages'],
  repeat: ['repeat', 'do again', 'repeat command', 'again'],
  conduct: ['conduct', 'conducts', 'challenges'],
  chronicle: ['chronicle', 'journal', 'major events'],
  terrain: ['terrain', 'map without monsters', 'show map only'],
  vanquished: ['vanquished', 'kills', 'monsters killed', 'kill list'],
  genocided: ['genocided', 'extinct'],
  swap: ['swap weapons', 'exchange weapons', 'switch weapons', 'secondary weapon'],
  twoweapon: ['two weapon', 'dual wield', 'two weapons'],
  drop: ['drop', 'drop item', 'put down'],
  droptype: ['drop many', 'drop multiple', 'drop several'],
  tip: ['tip', 'empty container', 'pour out'],
  wipe: ['wipe face', 'wipe', 'clean face'],
  showgold: ['gold', 'how much gold', 'money'],
  seeall: ['equipment', 'what am i wearing', 'worn items'],
  showtrap: ['identify trap', 'what trap'],
  fight: ['fight', 'attack', 'force fight', 'hit', 'attack peaceful', 'attack monster'],
  reqmenu: ['move without picking up', 'menu prefix'],
  autopickup: ['toggle autopickup', 'autopickup'],
  teleport: ['teleport', 'teleport at will'],
  version: ['version'],
  exploremode: ['explore mode', 'discovery mode'],
  herecmdmenu: ['what can i do here', 'actions here'],
  lookaround: ['describe surroundings', 'what is around me'],
};

/** Map-position commands: after the key, the player moves a cursor and selects. */
const PICKS_POSITION = new Set(['glance', 'whatis', 'travel', 'teleport', 'terrain']);

const STOP = new Set(
  'how do i can you what which key keys is the a an to for of on in my me press button use command commands do does that this some something thing things it at with way'.split(' '),
);

const MOVE_WORDS = /\b(move|moving|walk|walking|run|running|rush|rushing|direction|directions|diagonal|diagonally|movement|step|go (?:north|south|east|west|left|right|up|down)|north|south|east|west|arrow keys?|number ?pad|numpad|vi[- ]?keys)\b/;

function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 3 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('es') && !w.endsWith('ses')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function normalize(q: string): string {
  return q
    .toLowerCase()
    .replace(/what's/g, 'what is')
    .replace(/[^a-z0-9#\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s)
    .split(' ')
    .filter((w) => w && !STOP.has(w))
    .map(stem);
}

interface Scored {
  cmd: KeyCommand;
  score: number;
}

function scoreCommand(cmd: KeyCommand, q: string, qt: string[]): number {
  const name = cmd.name.toLowerCase();
  const bare = q.replace(/^#/, '');
  if (bare === name) return 1000;
  let score = 0;
  // phrases players use
  for (const a of ALIASES[cmd.name] ?? []) {
    const at = tokens(a);
    if (!at.length) continue;
    if (normalize(a) === bare) score = Math.max(score, 400 + at.length);
    else if (at.every((w) => qt.includes(w))) score = Math.max(score, 100 + 10 * at.length);
  }
  // words of the query in the command name / description
  const desc = tokens(cmd.desc);
  let hits = 0;
  for (const w of qt) {
    if (w === stem(name)) hits += 30;
    else if (desc.includes(w)) hits += 8;
    else if (w.length >= 4 && desc.some((d) => d.startsWith(w))) hits += 4;
  }
  return score + hits;
}

// ---------------------------------------------------------------- rendering

const DIR_NAMES = ['west', 'northwest', 'north', 'northeast', 'east', 'southeast', 'south', 'southwest'] as const;

export class KeyBindingsView {
  readonly kb: KeyBindings;
  private byName: Map<string, KeyCommand>;

  constructor(kb: KeyBindings) {
    this.kb = kb;
    this.byName = new Map(kb.commands.filter((c) => !c.param).map((c) => [c.name, c]));
  }

  command(name: string): KeyCommand | undefined {
    return this.byName.get(name);
  }

  /** "Ctrl+D" / "Alt+p" / ", (comma) or #pickup" style: every way to give this command */
  ways(cmd: KeyCommand): string {
    const keys = sortedKeys(cmd, this.kb).map(keyLabel);
    const ext = cmd.kind === 'move' ? '' : `#${cmd.name}`;
    if (!keys.length) return ext ? `no key; type ${ext} and press Enter` : 'no key';
    return ext ? `${keys.join(' or ')}; or type ${ext} and press Enter` : keys.join(' or ');
  }

  private notesFor(cmds: KeyCommand[]): string[] {
    const notes = new Set<string>();
    const keys = [...new Set(cmds.flatMap((c) => c.keys))];
    const alt = keys.filter((k) => k >= 128 && (k & 0x7f) >= 0x20 && (k & 0x7f) !== 0x7f);
    if (alt.length > 1) notes.add('Alt+key: hold Alt (Option on a Mac) and press the key (for Alt+capital letter also hold Shift)');
    for (const k of keys) {
      if (alt.length > 1 && alt.includes(k)) continue;
      const n = webNote(k);
      if (n) notes.add(n);
    }
    return [...notes];
  }

  private special(name: string): string | null {
    const s = this.kb.special.find((x) => x.name === name);
    return s ? keyLabel(s.key) : null;
  }

  /** what to do after a map-position command */
  private pickHint(): string {
    const pick = this.special('getpos.pick') ?? '.';
    const quick = this.special('getpos.pick.quick');
    const mon = this.special('getpos.mon.next');
    const obj = this.special('getpos.obj.next');
    return `then move the cursor with the movement keys${mon ? ` (${mon} jumps to the next monster` : ''}${obj ? `, ${obj} to the next object` : ''}${mon ? ')' : ''} and press ${pick}${quick ? ` or ${quick}` : ''} to select`;
  }

  /** movement: walking, running, rushing, prefixes */
  movement(): string[] {
    const kb = this.kb;
    const out: string[] = [];
    const walk = DIR_NAMES.map((d) => this.command(`move${d}`));
    const keyOf = (c: KeyCommand | undefined) => (c && c.keys.length ? keyLabel(sortedKeys(c, kb)[0]) : '?');
    out.push(
      `Movement (number_pad is ${kb.number_pad ? 'on: digits move' : 'off: letters move, vi-keys'}): ${DIR_NAMES.map((d, i) => `${keyOf(walk[i])} ${d}`).join(', ')}; ` +
        `< goes up stairs, > goes down. Moving into a monster attacks it.`,
    );
    const runs = DIR_NAMES.map((d) => this.command(`run${d}`));
    const rushes = DIR_NAMES.map((d) => this.command(`rush${d}`));
    // what NetHack's own key list (dokeylist) says about them
    if (runs.some((c) => c?.keys.length)) out.push(`Run in a direction until you run into something: ${DIR_NAMES.map((_, i) => keyOf(runs[i])).join(' ')} (same direction order).`);
    if (rushes.some((c) => c?.keys.length)) out.push(`Rush in a direction until something interesting is seen: ${DIR_NAMES.map((_, i) => keyOf(rushes[i])).join(' ')}.`);
    const pre = ['rush', 'run', 'fight', 'reqmenu']
      .map((n) => this.command(n))
      .filter((c): c is KeyCommand => !!c && c.keys.length > 0)
      .map((c) => `${sortedKeys(c, kb).map(keyLabel).join(' or ')} = ${c.desc.replace(/^prefix: /, '')}`);
    if (pre.length) out.push(`Prefixes, pressed before a direction: ${pre.join('; ')}.`);
    if (!kb.number_pad) out.push('In this browser client the arrow keys and the numeric keypad also move (Shift+arrow runs).');
    const notes = this.notesFor([...runs, ...rushes].filter((c): c is KeyCommand => !!c));
    if (notes.length) out.push(`Browser client: ${notes.join('; ')}.`);
    const count = this.special('count');
    out.push(kb.number_pad ? `Count prefix: ${count ?? 'n'} then digits, e.g. n20s searches 20 times.` : 'Count: type digits before a command, e.g. 20s searches 20 times.');
    return out;
  }

  /** answer for "how do I <query>" */
  search(query: string): string {
    const q = normalize(query);
    const qt = tokens(query);
    const kb = this.kb;
    const out: string[] = [];
    const scored: Scored[] = kb.commands
      .filter((c) => c.kind !== 'move' && !c.unavailable)
      .map((cmd) => ({ cmd, score: scoreCommand(cmd, q, qt) }))
      .filter((s) => s.score >= 8)
      .sort((a, b) => b.score - a.score);
    const best = scored[0]?.score ?? 0;
    let top = scored.filter((s) => s.score >= Math.max(8, best * 0.5)).slice(0, 4);
    const wantsMove = MOVE_WORDS.test(q) && (!top.length || best < 100 || /\b(move|walk|run|rush|direction|diagonal)/.test(q));
    // "how do I move diagonally": only word overlap with other commands' descriptions
    if (wantsMove && best < 100) top = [];
    out.push(`Key bindings of this game right now, for "${query.trim()}" (exact; capital letters mean Shift+letter):`);
    for (const { cmd } of top) {
      let line = `- ${cmd.desc}${cmd.param ? ` "${cmd.param}"` : ''}: ${this.ways(cmd)}`;
      if (PICKS_POSITION.has(cmd.name)) line += `; ${this.pickHint()}`;
      out.push(line);
    }
    if (wantsMove) out.push(...this.movement().map((l) => `- ${l}`));
    if (!top.length && !wantsMove) {
      out.push(`No command matches "${query.trim()}". Call get_keybindings without a query for the full list, or name the action differently.`);
      return out.join('\n');
    }
    const notes = this.notesFor(top.map((s) => s.cmd));
    if (notes.length) out.push(`Browser client: ${notes.join('; ')}.`);
    if (top.some((s) => !s.cmd.keys.length || s.cmd.keys.some((k) => k >= 128)))
      out.push('Extended commands: type # then the name and press Enter (a few letters are enough if it autocompletes).');
    return out.join('\n');
  }

  /** compact grouped list of everything */
  summary(): string {
    const kb = this.kb;
    const out: string[] = ['Key bindings of this game right now, from its own command table (capital letters mean Shift+letter):'];
    out.push(...this.movement());
    const list = (cmds: KeyCommand[]) => cmds.map((c) => `${c.name} ${sortedKeys(c, kb).map(keyLabel).join('/')}`).join(', ');
    const keyed = kb.commands.filter((c) => c.keys.length && !c.unavailable && c.kind !== 'move' && c.kind !== 'prefix');
    out.push(`Actions: ${list(keyed.filter((c) => c.kind === 'game'))}.`);
    out.push(`Information and settings (no game time): ${list(keyed.filter((c) => c.kind === 'general'))}.`);
    const dbg = keyed.filter((c) => c.kind === 'debug');
    if (dbg.length) out.push(`Debug mode: ${list(dbg)}.`);
    const keyless = kb.commands.filter((c) => !c.keys.length && c.kind !== 'move' && !c.unavailable);
    if (keyless.length) out.push(`No key, only as #name then Enter: ${keyless.map((c) => `#${c.name}`).join(', ')}.`);
    out.push(
      'Browser client: Alt+key = hold Alt (Option on a Mac) and press the key; the browser keeps Ctrl+W, Ctrl+T and Ctrl+N, so use the ^W ^T ^N buttons under the game or Fullscreen mode; every other Ctrl+letter works directly.',
    );
    return out.join('\n');
  }
}
