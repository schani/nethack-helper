import type {
  Awaiting,
  FeedEvent,
  GameEvent,
  GameIdentity,
  GameState,
  InventoryItem,
  LevelInfo,
  LevelMemory,
  MapCell,
  MessageEntry,
  PersistedMemory,
  SessionInfo,
} from '../../../shared/feed-events.ts';

export const MAP_COLS = 80; // COLNO
export const MAP_ROWS = 21; // ROWNO
export const MESSAGE_LIMIT = 200;

/** MG_UNEXPL glyph flag */
const MG_UNEXPL = 0x800;

interface LevelStore {
  key: string;
  info: LevelInfo | null;
  cells: Map<number, MapCell>; // key = y * MAP_COLS + x
  lastSeenTurn: number;
}

export const levelKey = (dnum: number, dlevel: number) => `${dnum}:${dlevel}`;

/** Filesystem-safe, stable id of a game: character name + birth time. */
export function gameIdOf(ev: Pick<GameEvent, 'name' | 'birthday'>): string {
  const name = ev.name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40) || 'player';
  return `${name}-${ev.birthday}`;
}

/**
 * A cell that tells the player nothing: unexplored, or blank solid rock
 * (magic mapping and walking along corridors "remember" lots of those).
 * Not stored.  Dark room floor etc. are kept.
 */
export function isBlankCell(c: MapCell): boolean {
  if ((c.flags ?? 0) & MG_UNEXPL) return true;
  return (c.ch === ' ' || c.ch === '') && /^(|stone|unexplored|unexplored area)$/.test(c.desc);
}

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

export interface GameStateStoreOptions {
  /** persisted memory of a game, if any (called when a game is announced) */
  loadMemory?: (id: string) => PersistedMemory | null;
}

/**
 * In-memory model of everything the player knows, built by folding feed
 * events.  Level maps are kept per level so remembered levels survive
 * level changes; exportMemory()/the loadMemory option let the session
 * persist them across server restarts, keyed by the game identity the feed
 * announces ('game' event).
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
  /** last input request reported by the feed */
  private feedAwaiting: Omit<Awaiting, 'source'> | null = null;
  /** text of the message line while tty shows its own --More-- */
  private screenMore: string | null = null;
  private currentLevel: string | null = null;
  private levels = new Map<string, LevelStore>();
  private messages: MessageEntry[] = [];
  /** messages received from the current nethack process */
  private processMessages = 0;
  private inventory: InventoryItem[] = [];
  private menu: GameState['menu'] = null;
  private lastText: GameState['lastText'] = null;
  private gameover: GameState['gameover'] = null;
  private game: GameIdentity | null = null;
  private memoryRestored = false;
  /** bumped on every change; lets callers cheaply detect updates */
  version = 0;
  /** bumped when anything that is persisted changes */
  memoryVersion = 0;
  private opts: GameStateStoreOptions;

  constructor(player = 'player', opts: GameStateStoreOptions = {}) {
    this.session = freshSession(player);
    this.opts = opts;
  }

  /** Called when a new nethack process starts: the per-process feed state
   *  resets; remembered levels stay until the 'game' event says whether
   *  this is the same game. */
  resetForNewProcess() {
    this.feedConnected = false;
    this.lastSeq = 0;
    this.schema = null;
    this.feedAwaiting = null;
    this.screenMore = null;
    this.menu = null;
    this.lastText = null;
    this.gameover = null;
    this.processMessages = 0;
    this.version++;
  }

  setFeedConnected(connected: boolean) {
    this.feedConnected = connected;
    this.version++;
  }

  /** identity of the current game (null until announced by the feed) */
  get gameIdentity(): GameIdentity | null {
    return this.game;
  }

  /**
   * Reconcile with the terminal: `moreText` is the message line when the
   * screen shows --More-- at the cursor, else null.  tty raises --More-- on
   * message-line overflow without going through the window interface, so
   * the feed's last input request is stale then.  Returns true on change.
   */
  setScreenMore(moreText: string | null): boolean {
    if (moreText === this.screenMore) return false;
    this.screenMore = moreText;
    this.version++;
    return true;
  }

  get awaiting(): Awaiting | null {
    const fa = this.feedAwaiting;
    if (this.screenMore !== null && !(fa && (fa.kind === 'more' || fa.kind === 'dismiss'))) {
      return {
        seq: fa?.seq ?? this.lastSeq,
        kind: 'more',
        turn: this.turn,
        ...(this.hero ? { ux: this.hero.x, uy: this.hero.y } : {}),
        prompt: this.screenMore,
        source: 'screen',
      };
    }
    return fa ? { ...fa, source: 'feed' } : null;
  }

  private level(key: string): LevelStore {
    let l = this.levels.get(key);
    if (!l) {
      l = { key, info: null, cells: new Map(), lastSeenTurn: this.turn };
      this.levels.set(key, l);
    }
    return l;
  }

  private pushMessage(m: MessageEntry) {
    this.messages.push(m);
    this.processMessages++;
    if (this.messages.length > MESSAGE_LIMIT) this.messages.splice(0, this.messages.length - MESSAGE_LIMIT);
  }

  private startGame(ev: GameEvent) {
    const { t: _t, seq: _s, turn: _turn, ...rest } = ev;
    const identity: GameIdentity = { ...rest, id: gameIdOf(ev) };
    const thisProcess = this.messages.slice(this.messages.length - Math.min(this.processMessages, this.messages.length));
    const replayed = (m: MessageEntry) => m.source === 'history';

    if (this.game?.id === identity.id && ev.origin !== 'new') {
      // same game resumed under this server: memory is already here; the
      // message history NetHack replays on restore is a duplicate
      const older = this.messages.slice(0, this.messages.length - thisProcess.length);
      this.messages = [...older, ...thisProcess.filter((m) => !replayed(m))];
    } else {
      let mem = ev.origin === 'new' ? null : (this.opts.loadMemory?.(identity.id) ?? null);
      if (mem && mem.game.uuid && identity.uuid && mem.game.uuid !== identity.uuid) mem = null;
      this.levels.clear();
      this.currentLevel = null;
      this.memoryRestored = mem !== null;
      if (mem) {
        for (const l of mem.levels) {
          const cells = new Map<number, MapCell>();
          for (const c of l.cells) if (!isBlankCell(c)) cells.set(c.y * MAP_COLS + c.x, c);
          this.levels.set(l.key, { key: l.key, info: l.info, cells, lastSeenTurn: l.lastSeenTurn });
        }
        this.currentLevel = mem.currentLevel;
        this.messages = [...mem.messages, ...thisProcess.filter((m) => !replayed(m))].slice(-MESSAGE_LIMIT);
      } else {
        // a different (or brand-new) game: forget the previous one
        this.messages = thisProcess;
      }
    }
    this.game = identity;
    this.memoryVersion++;
  }

  apply(ev: FeedEvent) {
    this.events++;
    this.lastSeq = ev.seq;
    this.version++;
    switch (ev.t) {
      case 'hello':
        this.schema = ev.schema;
        break;
      case 'game':
        if (typeof ev.turn === 'number') this.turn = ev.turn;
        this.startGame(ev);
        break;
      case 'level': {
        const key = levelKey(ev.dnum, ev.dlevel);
        const { t: _t, seq: _s, ...info } = ev;
        const l = this.level(key);
        l.info = info;
        l.lastSeenTurn = this.turn;
        this.currentLevel = key;
        this.memoryVersion++;
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
          this.memoryVersion++;
        }
        break;
      }
      case 'map': {
        const key = levelKey(ev.dnum, ev.dlevel);
        const l = this.level(key);
        this.currentLevel = key;
        for (const c of ev.cells) {
          const idx = c.y * MAP_COLS + c.x;
          if (isBlankCell(c)) l.cells.delete(idx);
          else l.cells.set(idx, c);
        }
        this.hero = { x: ev.ux, y: ev.uy };
        l.lastSeenTurn = this.turn;
        this.memoryVersion++;
        break;
      }
      case 'status':
        this.status = { fields: ev.fields, conditions: ev.conditions };
        if (typeof ev.turn === 'number') this.turn = ev.turn;
        break;
      case 'msg':
        this.pushMessage({ seq: ev.seq, turn: ev.turn, text: ev.text, ...(ev.source ? { source: ev.source } : {}) });
        this.memoryVersion++;
        break;
      case 'inventory':
        this.inventory = ev.items;
        break;
      case 'input': {
        const { t: _t, ...rest } = ev;
        this.feedAwaiting = rest;
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
        this.feedAwaiting = null;
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

  /** What gets persisted for the current game (null until it is known). */
  exportMemory(): PersistedMemory | null {
    if (!this.game) return null;
    return {
      format: 1,
      game: this.game,
      savedAt: new Date().toISOString(),
      turn: this.turn,
      currentLevel: this.currentLevel,
      levels: [...this.levels.values()].map((l) => ({
        key: l.key,
        info: l.info,
        cells: [...l.cells.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c),
        lastSeenTurn: l.lastSeenTurn,
      })),
      messages: [...this.messages],
    };
  }

  snapshot(opts: { allLevels?: boolean } = {}): GameState {
    const allLevels = opts.allLevels ?? true;
    const levels: Record<string, LevelMemory> = {};
    for (const [key, l] of this.levels) {
      if (allLevels || key === this.currentLevel) levels[key] = this.levelView(l);
    }
    return {
      session: { ...this.session },
      game: this.game ? { ...this.game, memoryRestored: this.memoryRestored } : null,
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
