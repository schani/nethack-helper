/**
 * Read-only, player-visible views of the game for the voice assistant.
 *
 * Everything here is derived from the derived game state (feed reducer +
 * persisted level memory) and the terminal text, i.e. only what the player
 * can see or remember: displayed/remembered map glyphs with NetHack's own
 * farlook descriptions, the status lines, inventory doname() texts, the
 * message log, and the `\` / ^O texts.  Positions are always phrased
 * relative to the hero (or as map regions on other levels), never as
 * coordinates.
 */
import type { GameState, InventoryItem, LevelMemory, MapCell } from '../../../../shared/feed-events.ts';
import { NEIGHBOURS, compass, describeOffset, mapRegion, parseDirection, roughOffset, screenDir, screenRegion, steps, type Offset } from './directions.ts';

export interface ScreenText {
  lines: string[];
}

export interface GameSnapshotInput {
  /** is a nethack process running? */
  running: boolean;
  state: GameState;
  screen: ScreenText;
}

/** Output-format options (used by eval variants; defaults are the production behaviour). */
export interface GameViewOptions {
  /**
   * Positions on levels the hero is not on: 'landmarks' (default) = screen region + rough offsets from the
   * staircases where the player arrives; 'region' = map region + exact offset from the up staircase (phase 3).
   */
  levelDirections?: 'region' | 'landmarks';
}

const MAP_COLS = 80;

/** Things nobody asks about: plain floor, corridors, walls, rock. */
const BORING = /^(floor of a room|dark part of a room|corridor|lit corridor|wall|stone|solid rock|unexplored area|unexplored|dark part of a room|doorway|ice|air|cloud|water|tree)$/;
const STRUCTURAL = /^(floor of a room|dark part of a room|corridor|lit corridor|wall|stone|solid rock|unexplored area|unexplored)$/;
/** dungeon features worth listing on level summaries */
const FEATURE =
  /\b(staircase|ladder|fountain|altar|sink|throne|grave|tree|portal|drawbridge|iron bars|lava|moat|pool|water|trap|web|magic|hole|door|vibrating square)\b/;
const MONSTER_CH = /^[A-Za-z@&';:~]$/;

const keyOf = (x: number, y: number) => y * MAP_COLS + x;

export class GameView {
  readonly running: boolean;
  readonly st: GameState;
  readonly screen: ScreenText;
  private cellIndex: Map<number, MapCell>;
  private level: LevelMemory | null;
  readonly opts: GameViewOptions;

  constructor(input: GameSnapshotInput, opts: GameViewOptions = {}) {
    this.opts = opts;
    this.running = input.running;
    this.st = input.state;
    this.screen = input.screen;
    this.level = this.st.currentLevel ? (this.st.levels[this.st.currentLevel] ?? null) : null;
    this.cellIndex = new Map((this.level?.cells ?? []).map((c) => [keyOf(c.x, c.y), c]));
  }

  // ---------------------------------------------------------------- basics

  /** null if the game can be inspected, else a sentence saying why not */
  unavailable(): string | null {
    const s = this.st.session;
    if (!this.running) {
      if (s.state === 'exited') {
        const go = this.st.gameover ? ' The last game ended (the hero died, quit, or escaped).' : '';
        return `The game is not running right now (NetHack has exited${s.exitCode !== null ? `, exit code ${s.exitCode}` : ''}).${go} The player can start or resume it with the button on the game screen.`;
      }
      return 'The game is not running right now. The player can start or resume it with the button on the game screen.';
    }
    if (!this.st.feed.connected && !this.st.status) return 'The game is starting up; no game data yet.';
    return null;
  }

  /** no map yet (character creation, start-up) */
  noMap(): string | null {
    const u = this.unavailable();
    if (u) return u;
    if (!this.level || !this.st.hero) {
      const k = this.st.awaiting?.kind;
      if (k === 'player_selection' || k === 'askname') return 'The player is still creating their character; there is no map yet.';
      return 'There is no map yet (the game is still starting).';
    }
    return null;
  }

  private hero(): { x: number; y: number } {
    return this.st.hero!;
  }

  cell(x: number, y: number): MapCell | null {
    return this.cellIndex.get(keyOf(x, y)) ?? null;
  }

  private offsetOf(c: { x: number; y: number }): Offset {
    const h = this.hero();
    return { dx: c.x - h.x, dy: c.y - h.y };
  }

  private isHero(c: MapCell): boolean {
    const h = this.st.hero;
    return !!h && c.x === h.x && c.y === h.y;
  }

  /** "f tame kitten (a feline)" */
  static cellText(c: MapCell): string {
    const desc = c.desc || 'something unidentifiable';
    let extra = '';
    const m = /^(.*) \((.*)\)$/.exec(c.look ?? '');
    if (m && m[2] === c.desc && !/ or (the|a|an) | or .* or |many things/.test(m[1])) {
      const cls = m[1].trim();
      const words = cls.toLowerCase().replace(/^(an?|the) /, '');
      if (cls && !desc.toLowerCase().includes(words)) extra = ` (${cls})`;
    }
    const ch = c.ch && c.ch !== ' ' ? c.ch : '(blank)';
    return `${ch} ${desc}${extra}`;
  }

  /** what the hero stands on, if the map remembers something there */
  underfoot(): string | null {
    const u = this.st.underfoot;
    const h = this.st.hero;
    if (!u || !h || u.x !== h.x || u.y !== h.y || !u.desc) return null;
    return `${u.ch && u.ch !== ' ' ? u.ch + ' ' : ''}${u.desc}`;
  }

  /** Objects the game last listed on the hero's square (the map shows only the top one). */
  pileHere(): string | null {
    const p = this.st.pile;
    const h = this.st.hero;
    if (!p || !h || p.x !== h.x || p.y !== h.y || p.level !== this.st.currentLevel || !p.items.length) return null;
    return p.items.join('; ');
  }

  // ---------------------------------------------------------------- status

  private statusLines(): string[] {
    const st = this.st;
    const f = st.status?.fields ?? {};
    const g = st.game;
    const out: string[] = [];
    if (g) {
      out.push(
        `${f.title ?? g.name}: ${g.alignment} ${g.gender} ${g.race} ${g.role}${g.mode !== 'normal' ? ` (${g.mode} mode)` : ''}.`,
      );
    }
    const lvl = this.level?.info;
    out.push(
      `Location: ${f.level_desc ?? lvl?.desc ?? '?'}${lvl ? ` (${lvl.long_desc || lvl.dungeon}, depth ${lvl.depth})` : ''}; turn ${st.turn}.`,
    );
    const hp = f.hp !== undefined ? `HP ${f.hp} of ${f.hp_max}` : 'HP unknown';
    const hpPct = f.hp && f.hp_max && Number(f.hp_max) > 0 ? ` (${Math.round((100 * Number(f.hp)) / Number(f.hp_max))}%)` : '';
    out.push(
      `${hp}${hpPct}; power ${f.power ?? '?'} of ${f.power_max ?? '?'}; armor class ${f.ac ?? '?'} (lower is better); experience level ${f.xp_level ?? f.hit_dice ?? '?'}${f.exp_points ? ` (${f.exp_points} experience points)` : ''}; gold ${f.gold ?? '?'}.`,
    );
    out.push(
      `Attributes: strength ${f.str ?? '?'}, dexterity ${f.dex ?? '?'}, constitution ${f.con ?? '?'}, intelligence ${f.int ?? '?'}, wisdom ${f.wis ?? '?'}, charisma ${f.cha ?? '?'}; alignment ${f.align ?? '?'}.`,
    );
    out.push(`Hunger: ${f.hunger?.trim() ? f.hunger.trim() : 'not hungry'}. Encumbrance: ${f.encumbrance?.trim() ? f.encumbrance.trim() : 'unencumbered'}.`);
    const conds = st.status?.conditions ?? [];
    out.push(`Conditions: ${conds.length ? conds.join(', ') : 'none'}.`);
    if (f.score) out.push(`Score: ${f.score}.`);
    const uf = this.underfoot();
    if (uf) out.push(`Standing on: ${uf}.`);
    const pile = this.pileHere();
    if (pile) out.push(`Objects here (as the game last listed them): ${pile}.`);
    return out;
  }

  /** "What the game is waiting for" in words, including prompt/menu/text contents. */
  waitingFor(detail = true): string {
    const st = this.st;
    const a = st.awaiting;
    const top = (this.screen.lines[0] ?? '').trim();
    if (st.gameover) return 'The game is over (the hero died, quit or escaped); it is showing the end-of-game screens.';
    if (!a) return 'Nothing known (the game may be busy).';
    switch (a.kind) {
      case 'command':
        return 'A command: normal play, the player can move or act.';
      case 'key':
        return `A single key press${top ? `; the message line says: "${top}"` : ''} (for example a direction, an item letter, or a key to continue).`;
      case 'yn':
        return `An answer to the question "${a.prompt ?? top}"${a.choices ? ` (choices: ${a.choices.split('').join(', ')}` : ''}${a.default ? `; default ${a.default})` : a.choices ? ')' : ''}.`;
      case 'getlin':
        return `Typed text for the prompt "${a.prompt ?? top}".`;
      case 'extcmd':
        return 'An extended command name being typed after "#".';
      case 'more':
        return `The player to press Enter at --More-- after the message "${a.prompt || top.replace(/--More--\s*$/, '').trim()}".`;
      case 'menu': {
        const m = st.menu;
        if (!m) return 'A menu selection.';
        const how = m.how === 'none' ? 'a list to read (no selection)' : m.how === 'one' ? 'a menu to pick one item from' : 'a menu to pick items from';
        let s = `${how}${m.prompt ? ` titled "${m.prompt}"` : ''}${m.pages && m.pages > 1 ? `, ${m.pages} pages` : ''}.`;
        {
          const max = detail ? 60 : 15;
          const items = m.items.slice(0, max).map((it) => (it.ch && it.selectable ? `  ${it.ch} - ${it.text}${it.selected ? ' (selected)' : ''}` : `  ${it.text}`));
          s += `\nMenu contents:\n${items.join('\n')}${m.items.length > max ? `\n  …and ${m.items.length - max} more lines` : ''}`;
        }
        return s.charAt(0).toUpperCase() + s.slice(1);
      }
      case 'dismiss': {
        const t = st.lastText;
        let s = 'The player to dismiss a text window (Enter or Esc).';
        const max = detail ? 60 : 12;
        if (t?.lines.length) {
          s += `\nText window contents:\n${t.lines.slice(0, max).map((l) => `  ${l}`).join('\n')}${t.lines.length > max ? `\n  …and ${t.lines.length - max} more lines` : ''}`;
        }
        return s;
      }
      case 'player_selection':
        return 'Character creation (choosing role, race, gender, alignment).';
      case 'askname':
        return 'The player to type their character name.';
    }
  }

  getStatus(): string {
    const u = this.unavailable();
    if (u) return u;
    return [...this.statusLines(), `Waiting for: ${this.waitingFor(true)}`].join('\n');
  }

  // ---------------------------------------------------------------- screen

  getScreen(): string {
    const u = this.unavailable();
    if (u) return u;
    const lines = [...this.screen.lines];
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const text = lines.join('\n');
    const head =
      'Current screen (top line = messages, then the map, bottom two lines = status). Positions in the legend are relative to the hero (@).';
    return `${head}\n${text}\n\n${this.legend()}`;
  }

  /** Every distinct symbol on the current level map with what it is (and where, for notable things). */
  legend(): string {
    if (!this.level || !this.st.hero) return 'Legend: no map yet.';
    const groups = new Map<string, { ch: string; desc: string; cells: MapCell[] }>();
    for (const c of this.level.cells) {
      if (this.isHero(c)) continue;
      const k = `${c.ch}\u0000${c.desc}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { ch: c.ch, desc: c.desc, cells: [] }));
      g.cells.push(c);
    }
    const heroCell = this.cell(this.hero().x, this.hero().y);
    const rows: string[] = [`@ you${heroCell?.desc ? ` (${heroCell.desc})` : ''}${this.underfoot() ? `, standing on ${this.underfoot()}` : ''}`];
    const sorted = [...groups.values()].sort((a, b) => {
      const sa = STRUCTURAL.test(a.desc) ? 1 : 0;
      const sb = STRUCTURAL.test(b.desc) ? 1 : 0;
      if (sa !== sb) return sa - sb;
      return this.nearest(a.cells) - this.nearest(b.cells);
    });
    for (const g of sorted) {
      const label = GameView.cellText(g.cells[0]);
      if (STRUCTURAL.test(g.desc)) {
        rows.push(`${label}`);
        continue;
      }
      const near = [...g.cells].sort((a, b) => steps(this.offsetOf(a)) - steps(this.offsetOf(b)));
      const where = near.slice(0, 3).map((c) => describeOffset(this.offsetOf(c)));
      rows.push(`${label}: ${where.join('; ')}${near.length > 3 ? `; and ${near.length - 3} more` : ''}`);
    }
    return `Legend (symbol, what it is, where relative to you):\n${rows.join('\n')}`;
  }

  private nearest(cells: MapCell[]): number {
    return Math.min(...cells.map((c) => steps(this.offsetOf(c))));
  }

  // ---------------------------------------------------------------- look

  /**
   * Describe map squares relative to the hero.  `target` is free text:
   * "adjacent", "nearby", "here", a direction with optional distance
   * ("north", "2 west", "up-left"), a map symbol ("f", "the {") or words
   * from the description ("fountain", "kitten", "stairs down").
   */
  look(target: string, radius?: number): string {
    const nm = this.noMap();
    if (nm) return nm;
    const raw = (target ?? '').trim();
    const t = raw.replace(/^["'`]|["'`]$/g, '').trim();
    const lower = t.toLowerCase();
    const r = Math.max(1, Math.min(40, Math.floor(radius ?? 7)));

    if (!t || /^(adjacent|around( me)?|next to me|surroundings|neighbou?rs|everything adjacent|all adjacent|close by|beside me)$/.test(lower)) {
      return this.lookAdjacent();
    }
    if (/^(here|under me|underfoot|my square|me|myself|beneath me|where i am|where i stand|on my square)$/.test(lower)) {
      return this.lookHere();
    }
    if (/^(nearby|near|near me|nearby things|everything|everything nearby|visible|what can i see|all|whole level|level|everything on the level|the level)$/.test(lower)) {
      const whole = /all|level/.test(lower);
      return this.lookNearby(whole ? 80 : r);
    }
    const sym = /^(?:the |that |this |an? )?(\S)$/.exec(t);
    if (sym) return this.lookSymbol(sym[1]);
    const dir = parseDirection(t);
    if (dir) return this.lookDirection(dir.unit, dir.distance);
    return this.lookName(lower);
  }

  private lookHere(): string {
    const uf = this.underfoot();
    const hero = this.cell(this.hero().x, this.hero().y);
    const parts = [`You are ${hero?.desc ? `the @ (${hero.desc})` : 'the @'}.`];
    parts.push(uf ? `Under you the map remembers: ${uf}.` : 'Nothing special is remembered under you (or it is plain floor).');
    const pile = this.pileHere();
    if (pile) parts.push(`Objects here, as the game last listed them (the map shows only the top one): ${pile}.`);
    const msgs = this.recentMessages(4).filter((m) => /here|you see|there is|there are|you are standing|underfoot/i.test(m));
    if (msgs.length) parts.push(`Recent messages about this square: ${msgs.map((m) => `"${m}"`).join(' ')}`);
    return parts.join(' ');
  }

  lookAdjacent(): string {
    const h = this.hero();
    const rows = NEIGHBOURS.map((o) => {
      const c = this.cell(h.x + o.dx, h.y + o.dy);
      const what = c ? GameView.cellText(c) : 'nothing remembered (unexplored or solid rock)';
      return `${compass(o)} (${screenDir(o)}): ${what}`;
    });
    const uf = this.underfoot();
    return `Squares adjacent to you:\n${rows.join('\n')}\nUnder you: ${uf ?? 'nothing special remembered'}.`;
  }

  private lookNearby(r: number): string {
    const level = this.level!;
    const found = level.cells
      .filter((c) => !this.isHero(c) && !BORING.test(c.desc) && steps(this.offsetOf(c)) <= r)
      .sort((a, b) => steps(this.offsetOf(a)) - steps(this.offsetOf(b)));
    if (!found.length) return `Nothing notable within ${r} squares (only floor, corridors and walls).${this.underfoot() ? ` Under you: ${this.underfoot()}.` : ''}`;
    const max = 30;
    const rows = found.slice(0, max).map((c) => `${GameView.cellText(c)}: ${describeOffset(this.offsetOf(c))}`);
    return `${r >= 80 ? 'Notable things on this level' : `Notable things within ${r} squares`}, nearest first:\n${rows.join('\n')}${
      found.length > max ? `\n…and ${found.length - max} more` : ''
    }${this.underfoot() ? `\nUnder you: ${this.underfoot()}.` : ''}`;
  }

  private lookSymbol(ch: string): string {
    const level = this.level!;
    if (ch === '@') {
      const others = level.cells.filter((c) => c.ch === '@' && !this.isHero(c));
      const me = this.cell(this.hero().x, this.hero().y);
      const rows = others.map((c) => `${GameView.cellText(c)}: ${describeOffset(this.offsetOf(c))}`);
      return [`The @ ${me?.desc ? `(${me.desc}) ` : ''}is you.`, ...rows.map((r) => `Another @: ${r}`)].join('\n');
    }
    let found = level.cells.filter((c) => c.ch === ch && !this.isHero(c));
    let note = '';
    if (!found.length && /[a-z]/i.test(ch)) {
      const other = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
      found = level.cells.filter((c) => c.ch === other);
      if (found.length) note = `No "${ch}" on the map (letters are case sensitive); showing "${other}" instead.\n`;
    }
    if (!found.length) {
      return `There is no "${ch}" on the current map. Things near you:\n${this.lookNearby(5)}`;
    }
    found.sort((a, b) => steps(this.offsetOf(a)) - steps(this.offsetOf(b)));
    const rows = found.slice(0, 10).map((c) => `${GameView.cellText(c)}: ${describeOffset(this.offsetOf(c))}`);
    return `${note}${found.length === 1 ? 'There is one' : `There are ${found.length}`} "${found[0].ch}" on the map, nearest first:\n${rows.join('\n')}${
      found.length > 10 ? `\n…and ${found.length - 10} more` : ''
    }`;
  }

  private lookDirection(unit: Offset, distance?: number): string {
    const h = this.hero();
    const dirName = `${compass(unit)} (${screenDir(unit)})`;
    if (distance !== undefined) {
      const o = { dx: unit.dx * distance, dy: unit.dy * distance };
      const c = this.cell(h.x + o.dx, h.y + o.dy);
      return `${describeOffset(o)}: ${c ? GameView.cellText(c) : 'nothing remembered there (unexplored or solid rock)'}.`;
    }
    // walk the ray until a wall / the unknown, merging runs of the same thing
    const runs: { from: number; to: number; what: string }[] = [];
    for (let i = 1; i <= 40; i++) {
      const x = h.x + unit.dx * i;
      const y = h.y + unit.dy * i;
      if (x < 1 || x >= MAP_COLS || y < 0 || y > 20) break;
      const c = this.cell(x, y);
      const what = c ? GameView.cellText(c) : 'nothing remembered (unexplored or solid rock)';
      const last = runs[runs.length - 1];
      if (last && last.what === what) last.to = i;
      else runs.push({ from: i, to: i, what });
      if (!c || /wall|solid rock|stone|closed door|iron bars|tree|boulder/.test(c.desc)) break;
      if (runs.length >= 10) break;
    }
    const rows = runs.map((r) => `${r.from === r.to ? `${r.from}` : `${r.from} to ${r.to}`} ${r.from === 1 && r.to === 1 ? 'square' : 'squares'} away: ${r.what}`);
    return `Looking ${dirName} from you:\n${rows.join('\n')}`;
  }

  private lookName(q: string): string {
    const level = this.level!;
    const terms = expandTerms(q);
    const scored = level.cells
      .filter((c) => !this.isHero(c))
      .map((c) => ({ c, score: matchScore(`${c.desc} ${c.look}`.toLowerCase(), terms) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || steps(this.offsetOf(a.c)) - steps(this.offsetOf(b.c)));
    const uf = this.underfoot();
    const ufMatch = uf && matchScore(uf.toLowerCase(), terms) > 0;
    if (!scored.length && !ufMatch) {
      return `Nothing matching "${q}" is on the current map. Things near you:\n${this.lookNearby(5)}`;
    }
    const best = scored.length ? scored[0].score : 0;
    const hits = scored.filter((m) => m.score === best).slice(0, 10);
    const rows = hits.map(({ c }) => `${GameView.cellText(c)}: ${describeOffset(this.offsetOf(c))}`);
    if (ufMatch) rows.unshift(`${uf}: under you (you are standing on it)`);
    return `Matches for "${q}" on the current map, nearest first:\n${rows.join('\n')}`;
  }

  // ---------------------------------------------------------------- inventory

  getInventory(): string {
    const u = this.unavailable();
    if (u) return u;
    const inv = this.st.inventory;
    if (!inv.length) return 'The inventory is empty (or not known yet).';
    const byClass = new Map<string, InventoryItem[]>();
    for (const it of inv) {
      const k = it.class || 'other';
      if (!byClass.has(k)) byClass.set(k, []);
      byClass.get(k)!.push(it);
    }
    const out: string[] = [`Inventory (${inv.length} entries; exactly as the game names them, so unidentified items show only their appearance):`];
    for (const [cls, items] of byClass) {
      out.push(`${cls.charAt(0).toUpperCase() + cls.slice(1)}:`);
      for (const it of items) {
        const id = identification(it);
        out.push(`  ${it.letter} - ${it.text}${id ? `  [${id}]` : ''}`);
      }
    }
    const worn = inv.filter((i) => i.worn).map((i) => i.letter);
    const wielded = inv.filter((i) => i.wielded).map((i) => i.letter);
    out.push(`Wielded: ${wielded.length ? wielded.join(', ') : 'nothing (bare hands)'}. Worn: ${worn.length ? worn.join(', ') : 'nothing'}.`);
    return out.join('\n');
  }

  // ---------------------------------------------------------------- levels

  private sortedLevels(): LevelMemory[] {
    return Object.values(this.st.levels)
      .filter((l) => l.info)
      .sort((a, b) => a.info!.dnum - b.info!.dnum || a.info!.depth - b.info!.depth);
  }

  /** "2 fountains, staircase up, staircase down, altar (chaotic)" */
  static features(l: LevelMemory): string[] {
    const counts = new Map<string, number>();
    for (const c of l.cells) {
      const d = c.desc.toLowerCase();
      if (!FEATURE.test(d) || /^(doorway|broken door|open door|closed door|no door)$/.test(d)) continue;
      counts.set(c.desc, (counts.get(c.desc) ?? 0) + 1);
    }
    return [...counts.entries()].map(([d, n]) => (n > 1 ? `${n}× ${d}` : d));
  }

  static objects(l: LevelMemory): string[] {
    return l.cells.filter((c) => !MONSTER_CH.test(c.ch) && !FEATURE.test(c.desc) && !BORING.test(c.desc) && /^[)[!?/="(*%$`+0]$/.test(c.ch)).map((c) => c.desc);
  }

  listLevels(): string {
    const st = this.st;
    if (!st.game && !Object.keys(st.levels).length) return this.unavailable() ?? 'No levels visited yet.';
    const levels = this.sortedLevels();
    const out: string[] = [];
    if (!levels.length) out.push('No levels remembered yet.');
    for (const l of levels) {
      const i = l.info!;
      const here = l.key === st.currentLevel ? ' <- you are here' : '';
      const name = i.dungeon === 'The Dungeons of Doom' ? `Dungeon level ${i.dlevel}` : `${i.dungeon} level ${i.dlevel}`;
      const feats = GameView.features(l);
      const uf = l.key === st.currentLevel ? st.underfoot : null;
      if (uf && st.hero && uf.x === st.hero.x && uf.y === st.hero.y && FEATURE.test(uf.desc)) feats.push(`${uf.desc} (under you)`);
      const objs = GameView.objects(l);
      const known = i.known.length ? `; known: ${i.known.join(', ')}` : '';
      const ann = i.annotation ? `; player's note: "${i.annotation}"` : '';
      out.push(
        `${name} (${i.desc}, depth ${i.depth})${here}: ${feats.length ? feats.join(', ') : 'no special features remembered'}${
          objs.length ? `; ${objs.length} remembered object${objs.length > 1 ? 's' : ''}` : ''
        }${known}${ann}; last there on turn ${l.lastSeenTurn}.`,
      );
    }
    if (st.overview?.length) {
      out.push('', 'Dungeon overview, exactly as the game shows it with Ctrl-O:', ...st.overview.map((l) => `  ${l.trimEnd()}`));
    }
    out.push('', 'Use get_level_map with a level (e.g. "1", "mines 3", "current") for its map and feature positions.');
    return out.join('\n');
  }

  /** resolve "1", "dlvl 3", "current", "mines 2", "sokoban", "0:1" to a remembered level */
  resolveLevel(q: string): { level: LevelMemory | null; note: string } {
    const levels = this.sortedLevels();
    const s = (q ?? '').toLowerCase().trim();
    if (!s || /^(current|this|here|this level|current level)$/.test(s)) {
      const l = this.level;
      return { level: l, note: l ? '' : 'No current level.' };
    }
    const key = /^(\d+):(\d+)$/.exec(s);
    if (key) return { level: this.st.levels[s] ?? null, note: '' };
    const num = /(\d+)/.exec(s)?.[1];
    const wantsMines = /mine/.test(s);
    const wantsSoko = /soko/.test(s);
    const branchFilter = (l: LevelMemory) =>
      wantsMines ? /mines/i.test(l.info!.dungeon) : wantsSoko ? /sokoban/i.test(l.info!.dungeon) : /quest|ludios|gehennom|vlad|elemental|astral/.test(s) ? l.info!.dungeon.toLowerCase().includes(s.replace(/\s*\d+\s*/g, '').trim().split(' ')[0]) : true;
    let cands = levels.filter(branchFilter);
    if (num !== undefined) {
      const n = Number(num);
      // within a named branch "mines 2" may mean the 2nd mines level or depth 2; prefer depth, then branch level
      const byDepth = cands.filter((l) => l.info!.depth === n);
      const byDlevel = cands.filter((l) => l.info!.dlevel === n);
      cands = byDepth.length ? byDepth : byDlevel;
      // plain number: prefer the main dungeon
      if (!wantsMines && !wantsSoko && cands.length > 1) {
        const doom = cands.filter((l) => l.info!.dungeon === 'The Dungeons of Doom');
        const others = cands.filter((l) => !doom.includes(l)).map((l) => `${l.info!.dungeon} (${l.info!.desc})`);
        if (doom.length) return { level: doom[0], note: `(Also remembered at that depth: ${others.join(', ')}.)` };
      }
    }
    if (!cands.length) return { level: null, note: `No remembered level matches "${q}".` };
    return { level: cands[0], note: cands.length > 1 ? `(Several matches; showing ${cands[0].info!.dungeon} ${cands[0].info!.desc}.)` : '' };
  }

  getLevelMap(q: string): string {
    if (!Object.keys(this.st.levels).length) return this.unavailable() ?? 'No levels remembered yet.';
    const { level: l, note } = this.resolveLevel(q);
    if (!l) return `${note} Remembered levels: ${this.sortedLevels().map((x) => `${x.info!.dungeon} ${x.info!.desc}`).join('; ')}.`;
    const i = l.info;
    const isCurrent = l.key === this.st.currentLevel && !!this.st.hero;
    const rows = [...l.rows];
    let first = rows.findIndex((r) => r.trim());
    let last = rows.length - 1 - [...rows].reverse().findIndex((r) => r.trim());
    if (first < 0) first = last = 0;
    const body = rows.slice(first, last + 1).join('\n');
    const head = `${i ? `${i.dungeon}, ${i.desc} (depth ${i.depth})` : l.key}${isCurrent ? ' — the level you are on; @ is you' : ` — remembered map, last seen on turn ${l.lastSeenTurn}`}${i?.annotation ? `; player's note: "${i.annotation}"` : ''}.`;

    // notable things with positions
    const up = l.cells.find((c) => /staircase up|ladder up/.test(c.desc));
    const landmarks = !isCurrent && this.opts.levelDirections !== 'region' ? this.arrivalPoints(l) : null;
    const where = (c: MapCell) => {
      if (isCurrent) return describeOffset(this.offsetOf(c));
      if (landmarks) {
        const refs = landmarks
          .filter((r) => r.cell !== c)
          .map((r) => {
            const o = roughOffset({ dx: c.x - r.cell.x, dy: c.y - r.cell.y });
            return o === 'right next to it' ? `right next to ${r.label}` : `${o} from ${r.label}`;
          });
        return [`in ${screenRegion(c.x, c.y)}`, ...refs].join('; ');
      }
      const parts = [`in ${mapRegion(c.x, c.y)}`];
      if (up && up !== c) parts.push(`${describeOffset({ dx: c.x - up.x, dy: c.y - up.y }).replace(/^adjacent, /, '')} from the up staircase`);
      return parts.join(', ');
    };
    const notable = l.cells.filter((c) => !(isCurrent && this.isHero(c)) && !BORING.test(c.desc) && !/^(open door|broken door|no door|closed door)$/.test(c.desc));
    const feats = notable.filter((c) => FEATURE.test(c.desc));
    const things = notable.filter((c) => !FEATURE.test(c.desc));
    const fmt = (c: MapCell) => `${GameView.cellText(c)}: ${where(c)}`;
    const sections = [head, note, 'Map:', body];
    if (landmarks?.length) {
      sections.push(
        'Positions below are given from the staircases, because that is where the player arrives on this level ' +
          '(coming down: on its up staircase; coming up: on its down staircase). Speak them that way, e.g. ' +
          '"from where you arrive coming down, it is about 20 squares to the right and 8 up", and add the screen region.',
      );
    }
    const featLines = feats.slice(0, 30).map(fmt);
    const uf = isCurrent ? this.underfoot() : null;
    if (uf) featLines.unshift(`${uf}: under you`);
    sections.push(featLines.length ? `Features:\n${featLines.join('\n')}` : 'Features: none remembered.');
    if (things.length) sections.push(`Objects and monsters as last seen:\n${things.slice(0, 30).map(fmt).join('\n')}${things.length > 30 ? `\n…and ${things.length - 30} more` : ''}`);
    return sections.filter(Boolean).join('\n');
  }

  /** staircases of a remembered level, most useful arrival point first (relative to where the hero is now) */
  private arrivalPoints(l: LevelMemory): { cell: MapCell; label: string }[] {
    const find = (re: RegExp) => l.cells.find((c) => re.test(c.desc));
    const here = this.level?.info;
    const there = l.info;
    const up = find(/^(staircase|ladder) up$/);
    const down = find(/^(staircase|ladder) down$/);
    const branch = find(/^branch (staircase|ladder) (up|down)$/);
    const pts: { cell: MapCell; label: string }[] = [];
    // coming back from a branch (e.g. the Mines) you arrive on this level's branch staircase
    if (branch && here && there && here.dnum !== there.dnum) pts.push({ cell: branch, label: `the ${branch.desc} (where you arrive coming back from ${here.dungeon.replace(/^The /, 'the ')})` });
    const upLabel = 'the up staircase (where you arrive coming down)';
    const downLabel = 'the down staircase (where you arrive coming up)';
    const ups = up ? [{ cell: up, label: upLabel }] : branch && /up/.test(branch.desc) && !pts.length ? [{ cell: branch, label: there?.dlevel === 1 ? 'the up staircase (where the game started)' : upLabel }] : [];
    const downs = down ? [{ cell: down, label: downLabel }] : [];
    // the hero is deeper: they will come up and arrive on the down staircase
    const deeper = !!(here && there && here.depth > there.depth);
    pts.push(...(deeper ? [...downs, ...ups] : [...ups, ...downs]));
    return pts.slice(0, 2);
  }

  // ---------------------------------------------------------------- messages / discoveries

  recentMessages(n: number): string[] {
    return this.st.messages.slice(-n).map((m) => m.text);
  }

  getMessages(n = 10): string {
    const count = Math.max(1, Math.min(50, Math.floor(n) || 10));
    const msgs = this.st.messages.slice(-count);
    if (!msgs.length) return this.unavailable() ?? 'No messages yet.';
    return `Last ${msgs.length} game messages, oldest first:\n${msgs.map((m) => `turn ${m.turn}: ${m.text}${m.source === 'history' ? ' (from before the game was restored)' : ''}`).join('\n')}`;
  }

  getDiscoveries(): string {
    const d = this.st.discoveries;
    if (!d) return this.unavailable() ?? 'Discoveries are not available yet (they appear once the game is in progress).';
    const lines = d.filter((l, i) => !(i === 0 && /^Discoveries/.test(l)) && l.trim());
    if (!lines.length) return "The player hasn't discovered anything yet.";
    return [
      'Object discoveries, exactly as the game shows them with the \\ command. "*" marks types known without having been seen (e.g. from the role). "called X" is the player\'s own name for an unidentified type; "(appearance)" is how unidentified items of that type look:',
      ...lines.map((l) => `  ${l}`),
    ].join('\n');
  }

  // ---------------------------------------------------------------- live context

  /** Compact state for the model's context (a few hundred characters). */
  snapshot(): string {
    const u = this.unavailable();
    if (u) return `[Live game state] ${u}`;
    const st = this.st;
    const f = st.status?.fields ?? {};
    const g = st.game;
    const parts: string[] = [];
    const who = g ? `${g.name}, ${g.alignment} ${g.race} ${g.role}, XL ${f.xp_level ?? '?'}` : `XL ${f.xp_level ?? '?'}`;
    parts.push(`${who}. ${f.level_desc ?? '?'}${this.level?.info ? ` (${this.level.info.dungeon})` : ''}, turn ${st.turn}.`);
    parts.push(
      `HP ${f.hp ?? '?'}/${f.hp_max ?? '?'}, Pw ${f.power ?? '?'}/${f.power_max ?? '?'}, AC ${f.ac ?? '?'}, ${f.hunger?.trim() || 'not hungry'}, ${f.encumbrance?.trim() || 'unencumbered'}, conditions: ${
        st.status?.conditions.length ? st.status.conditions.join(' ') : 'none'
      }.`,
    );
    parts.push(`Waiting for: ${this.waitingFor(false)}`);
    if (this.level && st.hero) {
      const uf = this.underfoot();
      if (uf) parts.push(`Standing on: ${uf}.`);
      const pile = this.pileHere();
      if (pile) parts.push(`Objects here: ${pile}.`);
      const near = this.level.cells
        .filter((c) => !this.isHero(c) && !BORING.test(c.desc) && steps(this.offsetOf(c)) <= 6)
        .sort((a, b) => steps(this.offsetOf(a)) - steps(this.offsetOf(b)))
        .slice(0, 8)
        .map((c) => `${GameView.cellText(c)} (${describeOffset(this.offsetOf(c)).replace(/ \(.*\)$/, '')})`);
      parts.push(`Nearby: ${near.length ? near.join('; ') : 'nothing notable'}.`);
    }
    const msgs = st.messages.slice(-4).map((m) => `"${m.text}"`);
    if (msgs.length) parts.push(`Last messages: ${msgs.join(' ')}`);
    return `[Live game state, refreshed automatically; use the game tools for details]\n${parts.join('\n')}`;
  }
}

/**
 * Whether the item's TYPE is identified, judged only from the name the
 * player sees (classes whose identified names read "<class> of <type>").
 * Returns null when the name doesn't tell (weapons, armor, tools, gems...).
 */
export function identification(it: Pick<InventoryItem, 'text' | 'class_sym'>): string | null {
  const kind = { '!': 'potion', '?': 'scroll', '=': 'ring', '/': 'wand', '"': 'amulet', '+': 'spellbook' }[it.class_sym];
  if (!kind) return null;
  const t = it.text.toLowerCase();
  if (/\bcalled\b/.test(t)) return 'type not identified; "called" is your own name for it';
  if (new RegExp(`\\b${kind}s? of\\b`).test(t) || /amulet versus poison|imitation of the amulet|amulet of yendor|book of the dead/.test(t)) return null;
  return 'type not identified: only its appearance is known';
}

// ---------------------------------------------------------------- name matching

const SYNONYMS: Record<string, string[]> = {
  stairs: ['staircase', 'ladder'],
  staircase: ['staircase', 'ladder'],
  upstairs: ['staircase up', 'ladder up'],
  downstairs: ['staircase down', 'ladder down'],
  'stairs up': ['staircase up', 'ladder up'],
  'up stairs': ['staircase up', 'ladder up'],
  'stairs down': ['staircase down', 'ladder down'],
  'down stairs': ['staircase down', 'ladder down'],
  pet: ['tame'],
  'my pet': ['tame'],
  door: ['door'],
  exit: ['door', 'staircase'],
  monster: [],
  shopkeeper: ['shopkeeper', 'peaceful'],
  item: [],
};

function expandTerms(q: string): string[][] {
  const clean = q
    .replace(/^(the|that|this|a|an|my)\s+/g, '')
    .replace(/[?.!,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean in SYNONYMS && SYNONYMS[clean].length) return SYNONYMS[clean].map((s) => s.split(' '));
  const words = clean.split(' ').filter((w) => w.length > 1 && !['the', 'a', 'an', 'my', 'of', 'that', 'this', 'is', 'what', 'where'].includes(w));
  const singular = words.map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  return [singular];
}

function matchScore(text: string, alternatives: string[][]): number {
  let best = 0;
  for (const words of alternatives) {
    if (!words.length) continue;
    const hit = words.filter((w) => text.includes(w)).length;
    if (hit === words.length) best = Math.max(best, 10 + words.length);
    else if (hit > 0 && words.length > 1) best = Math.max(best, hit);
  }
  return best;
}
