import type {
  FeedEvent,
  GameState,
  InventoryItem,
  LevelInfo,
  LevelMemory,
  MapCell,
  MessageEntry,
  SessionInfo,
} from '../../../shared/feed-events.ts';

export const MAP_COLS = 80; // COLNO
export const MAP_ROWS = 21; // ROWNO
export const MESSAGE_LIMIT = 200;

interface LevelStore {
  key: string;
  info: LevelInfo | null;
  cells: Map<number, MapCell>; // key = y * MAP_COLS + x
  lastSeenTurn: number;
}

export const levelKey = (dnum: number, dlevel: number) => `${dnum}:${dlevel}`;

function freshSession(player: string): SessionInfo {
  return {
    state: 'idle',
    pid: null,
    player,
    startedAt: null,
    exitedAt: null,
    exitCode: null,
    signal: null,
    launches: 0,
  };
}

/**
 * In-memory model of everything the player knows, built by folding feed
 * events.  Level maps are kept per level so remembered levels survive
 * level changes (within one server lifetime).
 */
export class GameStateStore {
  session: SessionInfo;
  private feedConnected = false;
  private lastSeq = 0;
  private events = 0;
  parseErrors = 0;
  private schema: number | null = null;
  private turn = 0;
  private hero: { x: number; y: number } | null = null;
  private status: GameState['status'] = null;
  private awaiting: GameState['awaiting'] = null;
  private currentLevel: string | null = null;
  private levels = new Map<string, LevelStore>();
  private messages: MessageEntry[] = [];
  private inventory: InventoryItem[] = [];
  private menu: GameState['menu'] = null;
  private lastText: GameState['lastText'] = null;
  private gameover: GameState['gameover'] = null;
  /** bumped on every change; lets callers cheaply detect updates */
  version = 0;
  /** true until the first level event of a nethack process */
  private processFresh = true;

  constructor(player = 'player') {
    this.session = freshSession(player);
  }

  /** Called when a new nethack process starts: the per-process feed state
   *  resets, but remembered levels are kept (same game, resumed). */
  resetForNewProcess() {
    this.feedConnected = false;
    this.lastSeq = 0;
    this.schema = null;
    this.awaiting = null;
    this.menu = null;
    this.lastText = null;
    this.gameover = null;
    this.processFresh = true;
    this.version++;
  }

  setFeedConnected(connected: boolean) {
    this.feedConnected = connected;
    this.version++;
  }

  private level(key: string): LevelStore {
    let l = this.levels.get(key);
    if (!l) {
      l = { key, info: null, cells: new Map(), lastSeenTurn: this.turn };
      this.levels.set(key, l);
    }
    return l;
  }

  apply(ev: FeedEvent) {
    this.events++;
    this.lastSeq = ev.seq;
    this.version++;
    switch (ev.t) {
      case 'hello':
        this.schema = ev.schema;
        break;
      case 'level': {
        // First level of a process at turn 1 => a brand new game rather
        // than a restored save: drop the previous game's level memory.
        if (this.processFresh && this.turn <= 1) {
          this.levels.clear();
          this.currentLevel = null;
        }
        this.processFresh = false;
        const key = levelKey(ev.dnum, ev.dlevel);
        const { t: _t, seq: _s, ...info } = ev;
        const l = this.level(key);
        l.info = info;
        l.lastSeenTurn = this.turn;
        this.currentLevel = key;
        break;
      }
      case 'map_clear': {
        const key =
          ev.dnum !== undefined && ev.dlevel !== undefined
            ? levelKey(ev.dnum, ev.dlevel)
            : this.currentLevel;
        if (key) {
          this.level(key).cells.clear();
          this.currentLevel = key;
        }
        break;
      }
      case 'map': {
        const key = levelKey(ev.dnum, ev.dlevel);
        const l = this.level(key);
        this.currentLevel = key;
        for (const c of ev.cells) {
          const idx = c.y * MAP_COLS + c.x;
          // an unexplored glyph means "nothing remembered here"
          if ((c.flags ?? 0) & 0x800 || (c.ch === ' ' && c.desc.startsWith('unexplored')))
            l.cells.delete(idx);
          else l.cells.set(idx, c);
        }
        this.hero = { x: ev.ux, y: ev.uy };
        l.lastSeenTurn = this.turn;
        break;
      }
      case 'status':
        this.status = { fields: ev.fields, conditions: ev.conditions };
        if (typeof ev.turn === 'number') this.turn = ev.turn;
        break;
      case 'msg':
        this.messages.push({ seq: ev.seq, turn: ev.turn, text: ev.text, ...(ev.source ? { source: ev.source } : {}) });
        if (this.messages.length > MESSAGE_LIMIT) this.messages.splice(0, this.messages.length - MESSAGE_LIMIT);
        break;
      case 'inventory':
        this.inventory = ev.items;
        break;
      case 'input': {
        const { t: _t, ...rest } = ev;
        this.awaiting = rest;
        if (typeof ev.turn === 'number') this.turn = ev.turn;
        if (ev.ux !== undefined && ev.uy !== undefined) this.hero = { x: ev.ux, y: ev.uy };
        break;
      }
      case 'answer':
        break;
      case 'menu': {
        const { t: _t, ...rest } = ev;
        this.menu = rest;
        break;
      }
      case 'menu_done':
        this.menu = null;
        break;
      case 'text': {
        const { t: _t, ...rest } = ev;
        this.lastText = rest;
        break;
      }
      case 'display_file':
        break;
      case 'gameover':
        this.gameover = { how: ev.how, turn: ev.turn };
        break;
      case 'exit':
        this.awaiting = null;
        break;
    }
  }

  private levelView(l: LevelStore): LevelMemory {
    const cells = [...l.cells.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    const grid: string[][] = Array.from({ length: MAP_ROWS }, () => Array(MAP_COLS).fill(' '));
    for (const c of cells) {
      if (c.y >= 0 && c.y < MAP_ROWS && c.x >= 0 && c.x < MAP_COLS) grid[c.y][c.x] = c.ch || ' ';
    }
    return {
      key: l.key,
      info: l.info,
      cells,
      // column 0 is never used by NetHack; drop it so rows line up with the tty screen
      rows: grid.map((r) => r.slice(1).join('').replace(/\s+$/, '')),
      lastSeenTurn: l.lastSeenTurn,
    };
  }

  /** Cell at map coordinates on the current level, if remembered. */
  cellAt(x: number, y: number): MapCell | null {
    if (!this.currentLevel) return null;
    return this.levels.get(this.currentLevel)?.cells.get(y * MAP_COLS + x) ?? null;
  }

  snapshot(opts: { allLevels?: boolean } = {}): GameState {
    const allLevels = opts.allLevels ?? true;
    const levels: Record<string, LevelMemory> = {};
    for (const [key, l] of this.levels) {
      if (allLevels || key === this.currentLevel) levels[key] = this.levelView(l);
    }
    return {
      session: { ...this.session },
      feed: {
        connected: this.feedConnected,
        lastSeq: this.lastSeq,
        events: this.events,
        parseErrors: this.parseErrors,
        schema: this.schema,
      },
      turn: this.turn,
      hero: this.hero,
      status: this.status,
      awaiting: this.awaiting,
      currentLevel: this.currentLevel,
      levels,
      messages: [...this.messages],
      inventory: this.inventory,
      menu: this.menu,
      lastText: this.lastText,
      gameover: this.gameover,
    };
  }
}
