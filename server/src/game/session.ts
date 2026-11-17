import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { IPty } from 'node-pty';
import type { Config } from '../config.ts';
import { FeedListener } from '../feed/socket.ts';
import { GameStateStore } from '../feed/state.ts';
import { TerminalMirror } from './terminal.ts';
import { MemoryRepository } from './memory.ts';
import type { FeedEvent, GameState, MapCell, SessionInfo } from '../../../shared/feed-events.ts';

const require = createRequire(import.meta.url);
const pty = require('node-pty') as typeof import('node-pty');

/** What a connected client (the API layer) receives from the session. */
export interface SessionSubscriber {
  snapshot(data: string, cols: number, rows: number, session: SessionInfo): void;
  output(data: string): void;
  session(info: SessionInfo): void;
  /** throttled; current level only */
  state(state: GameState): void;
}

// Keys the browser may send that must never reach the game:
// ^Z would SIGTSTP nethack with nobody to resume it.  Non-ASCII can't be
// typed into NetHack (C locale); its UTF-8 bytes would read as Meta keys.
const BLOCKED_INPUT = /[\x1a\u0080-\uffff]/g;

const STATE_THROTTLE_MS = 150;
/** minimum time between two writes of the persisted game memory */
const PERSIST_INTERVAL_MS = 2000;

/** Encode keystrokes for the pty; `meta` sets the 8th bit of every byte
 *  (NetHack's M-<key> with the default `altmeta` off). */
export function encodeInput(data: string, meta = false): Buffer {
  const clean = data.replace(BLOCKED_INPUT, '');
  const bytes = Buffer.from(clean, 'latin1');
  if (meta) for (let i = 0; i < bytes.length; i++) bytes[i] |= 0x80;
  return bytes;
}

/**
 * Game session service: owns the nethack process (pty), its feed socket,
 * the authoritative terminal mirror and the derived game state.  The API
 * layer talks only to this class.
 */
export class GameSession {
  private proc: IPty | null = null;
  private feed: FeedListener;
  private mirror: TerminalMirror;
  readonly store: GameStateStore;
  private subscribers = new Set<SessionSubscriber>();
  private stateTimer: NodeJS.Timeout | null = null;
  private exitWaiters: Array<() => void> = [];
  private feedListeners = new Set<(ev: FeedEvent) => void>();
  readonly memory: MemoryRepository;
  private persistTimer: NodeJS.Timeout | null = null;
  private persistedVersion = -1;
  private lastPersist = 0;

  private cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.memory = new MemoryRepository(cfg.memoryDir);
    this.store = new GameStateStore(cfg.playerName, { loadMemory: (id) => this.memory.load(id) });
    this.mirror = new TerminalMirror(cfg.cols, cfg.rows);
    this.feed = new FeedListener(cfg.feedSocket, {
      onEvent: (ev) => this.onFeedEvent(ev),
      onConnect: () => this.store.setFeedConnected(true),
      onDisconnect: () => {
        this.store.setFeedConnected(false);
        this.scheduleState();
      },
      onParseError: (n) => {
        this.store.parseErrors = n;
      },
    });
  }

  async init() {
    if (!fs.existsSync(this.cfg.nethackBin)) {
      throw new Error(`nethack binary not found at ${this.cfg.nethackBin}; run nethack/build.sh`);
    }
    await this.feed.listen();
  }

  get running(): boolean {
    return this.proc !== null;
  }

  info(): SessionInfo {
    return { ...this.store.session };
  }

  /** Start a new game, or resume the saved one (same player name). */
  start(): boolean {
    if (this.proc) return false;
    this.preparePlayground();
    this.mirror.reset();
    this.store.resetForNewProcess();

    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: this.cfg.playgroundHome,
      USER: process.env.USER ?? 'nethack',
      LOGNAME: process.env.USER ?? 'nethack',
      TERM: 'xterm-256color',
      LANG: 'C',
      NETHACK_FEED_SOCKET: this.cfg.feedSocket,
    };
    const proc = pty.spawn(this.cfg.nethackBin, ['-u', this.cfg.playerName], {
      name: 'xterm-256color',
      cols: this.cfg.cols,
      rows: this.cfg.rows,
      cwd: this.cfg.playgroundHome,
      env,
    });
    this.proc = proc;
    const s = this.store.session;
    s.state = 'running';
    s.pid = proc.pid;
    s.startedAt = new Date().toISOString();
    s.exitedAt = null;
    s.exitCode = null;
    s.signal = null;
    s.launches++;
    this.store.version++;

    // fresh screen for everyone
    this.mirror.barrier(() => {
      const snap = this.mirror.serialize();
      for (const sub of this.subscribers) sub.snapshot(snap, this.cfg.cols, this.cfg.rows, this.info());
    });

    proc.onData((data) => {
      if (this.proc !== proc) return;
      this.mirror.write(data, () => {
        for (const sub of this.subscribers) sub.output(data);
        this.reconcileScreen();
      });
    });
    proc.onExit(({ exitCode, signal }) => {
      if (this.proc !== proc) return;
      this.proc = null;
      s.state = 'exited';
      s.pid = null;
      s.exitedAt = new Date().toISOString();
      s.exitCode = exitCode;
      s.signal = signal ?? null;
      this.store.version++;
      this.persistNow();
      // let the last bytes reach the mirror/clients before announcing
      this.mirror.barrier(() => {
        for (const sub of this.subscribers) sub.session(this.info());
        this.scheduleState();
        const waiters = this.exitWaiters.splice(0);
        waiters.forEach((w) => w());
      });
    });
    for (const sub of this.subscribers) sub.session(this.info());
    return true;
  }

  /** Keystrokes from the player (`meta`: send as Meta/Alt keys). */
  write(data: string, opts: { meta?: boolean } = {}) {
    if (!this.proc) return;
    const bytes = encodeInput(data, opts.meta);
    if (bytes.length) this.proc.write(bytes);
  }

  /**
   * Stop the game.  SIGHUP makes NetHack save the game (hangup handler), so
   * this is what we use on server shutdown.
   */
  async stop(signal: 'SIGHUP' | 'SIGTERM' | 'SIGKILL' = 'SIGHUP', timeoutMs = 8000): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    proc.kill(signal);
    const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs));
    if ((await Promise.race([exited, timer])) === 'timeout' && this.proc === proc) {
      proc.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
    }
  }

  async shutdown() {
    await this.stop('SIGHUP');
    await this.feed.close();
    this.persistNow();
    this.mirror.dispose();
  }

  /** Register a client; it immediately gets a consistent snapshot. */
  subscribe(sub: SessionSubscriber): () => void {
    this.mirror.barrier(() => {
      sub.snapshot(this.mirror.serialize(), this.cfg.cols, this.cfg.rows, this.info());
      sub.state(this.store.snapshot({ allLevels: false, keybindings: false }));
      this.subscribers.add(sub);
    });
    return () => {
      this.subscribers.delete(sub);
    };
  }

  /** Observe raw feed events (used by tests / future assistant layer). */
  onFeed(fn: (ev: FeedEvent) => void): () => void {
    this.feedListeners.add(fn);
    return () => this.feedListeners.delete(fn);
  }

  state(opts?: { allLevels?: boolean; keybindings?: boolean }): GameState {
    return this.store.snapshot(opts);
  }

  cellAt(x: number, y: number): MapCell | null {
    return this.store.cellAt(x, y);
  }

  screen(): { lines: string[]; cursor: { x: number; y: number }; cols: number; rows: number } {
    return { lines: this.mirror.text(), cursor: this.mirror.cursor(), cols: this.cfg.cols, rows: this.cfg.rows };
  }

  private onFeedEvent(ev: FeedEvent) {
    this.store.apply(ev);
    if (ev.t === 'game' && ev.origin === 'new' && this.store.gameIdentity) {
      try {
        this.memory.pruneOthers(this.store.gameIdentity.id);
      } catch (e) {
        console.error('pruning game memory failed:', e);
      }
    }
    for (const fn of this.feedListeners) fn(ev);
    this.scheduleState();
    this.schedulePersist();
  }

  /** The authoritative screen says tty is showing its own --More--? */
  private reconcileScreen() {
    if (this.store.setScreenMore(this.mirror.moreAtCursor())) this.scheduleState();
  }

  /** Throttled, atomic write of the game memory (levels, messages). */
  private schedulePersist() {
    if (this.persistTimer || this.store.memoryVersion === this.persistedVersion || !this.store.gameIdentity) return;
    const wait = Math.max(0, this.lastPersist + PERSIST_INTERVAL_MS - Date.now());
    this.persistTimer = setTimeout(() => this.persistNow(), wait);
  }

  /** Write the game memory now if it changed. */
  persistNow() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (this.store.memoryVersion === this.persistedVersion) return;
    const mem = this.store.exportMemory();
    if (!mem) return;
    const version = this.store.memoryVersion;
    try {
      this.memory.save(mem);
      this.persistedVersion = version;
    } catch (e) {
      console.error('saving game memory failed:', e);
    }
    this.lastPersist = Date.now();
  }

  private scheduleState() {
    if (this.stateTimer || this.subscribers.size === 0) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      const st = this.store.snapshot({ allLevels: false, keybindings: false });
      for (const sub of this.subscribers) sub.state(st);
    }, STATE_THROTTLE_MS);
  }

  private preparePlayground() {
    fs.mkdirSync(this.cfg.playgroundHome, { recursive: true });
    const rc = path.join(this.cfg.playgroundHome, '.nethackrc');
    fs.copyFileSync(this.cfg.nethackrcTemplate, rc);
  }
}
