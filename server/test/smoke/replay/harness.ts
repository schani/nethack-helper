/**
 * Deterministic NetHack replay harness (tests only).
 *
 * Runs the installed nethack (or $FEED_REPLAY_BIN) in an isolated temporary
 * playground (NETHACKDIR) with a fixed RNG seed and clock (fixed-env.c
 * LD_PRELOAD shim + no ASLR), feeds it a scripted key sequence, waits for
 * the screen to settle after each key and records the screen.  With
 * `feed: true` the "+feed" processor is connected to a socket and its
 * events are collected; with `feed: false` NETHACK_FEED_SOCKET is unset so
 * the processor is inert.  Comparing the two recordings shows whether the
 * feed influences the game.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TerminalMirror } from '../../../src/game/terminal.ts';
import { FeedParser } from '../../../src/feed/parser.ts';
import type { FeedEvent } from '../../../../shared/feed-events.ts';

const require = createRequire(import.meta.url);
const pty = require('node-pty') as typeof import('node-pty');

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../../../..');
export const HACKDIR = path.join(ROOT, '.nethack/games/lib/nethackdir');

/** compile the LD_PRELOAD shim once (cached by source mtime) */
export function buildShim(): string {
  const src = path.join(here, 'fixed-env.c');
  const out = path.join(ROOT, '.cache/test/fixed-env.so');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs) {
    execFileSync('gcc', ['-shared', '-fPIC', '-O2', '-o', out, src, '-ldl']);
  }
  return out;
}

export interface ReplayOptions {
  feed: boolean;
  seed: number;
  /** one entry per step; each is written as one chunk */
  keys: string[];
  bin?: string;
  /** extra nethackrc lines */
  rc?: string[];
  settleMs?: number;
}

export interface ReplayResult {
  /** screen text after the start-up and after every step */
  screens: string[];
  events: FeedEvent[];
}

function makePlayground(): { dir: string; home: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-replay-'));
  for (const f of ['nhdat', 'symbols', 'license']) {
    if (fs.existsSync(path.join(HACKDIR, f))) fs.copyFileSync(path.join(HACKDIR, f), path.join(dir, f));
  }
  fs.mkdirSync(path.join(dir, 'save'));
  for (const f of ['record', 'logfile', 'xlogfile', 'livelog', 'perm']) fs.writeFileSync(path.join(dir, f), '');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  return { dir, home };
}

export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const shim = buildShim();
  const { dir, home } = makePlayground();
  const settleMs = opts.settleMs ?? 250;
  const rc = [
    fs.readFileSync(path.join(ROOT, 'nethack/nethackrc'), 'utf8'),
    'OPTIONS=role:Valkyrie,race:human,gender:female,align:neutral',
    ...(opts.rc ?? []),
  ].join('\n');
  fs.writeFileSync(path.join(home, '.nethackrc'), rc + '\n');

  const events: FeedEvent[] = [];
  let server: net.Server | null = null;
  const sock = path.join(dir, 'feed.sock');
  if (opts.feed) {
    server = net.createServer((s) => {
      const p = new FeedParser();
      s.on('data', (d) => events.push(...p.push(d)));
    });
    await new Promise<void>((r) => server!.listen(sock, () => r()));
  }

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    USER: process.env.USER ?? 'nethack',
    TERM: 'xterm-256color',
    LANG: 'C',
    NETHACKDIR: dir,
    LD_PRELOAD: shim,
    NH_FIXED_SEED: String(opts.seed),
    NH_FIXED_TIME: '1700049600',
  };
  if (opts.feed) env.NETHACK_FEED_SOCKET = sock;

  const mirror = new TerminalMirror(80, 24);
  const bin = opts.bin ?? path.join(HACKDIR, 'nethack');
  const proc = pty.spawn('setarch', [os.arch() === 'arm64' ? 'aarch64' : 'x86_64', '-R', bin, '-u', 'replay'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: dir,
    env,
  });
  let lastOutput = Date.now();
  let outputs = 0;
  let exited = false;
  proc.onData((d) => {
    lastOutput = Date.now();
    outputs++;
    mirror.write(d);
  });
  proc.onExit(() => (exited = true));

  const settle = async () => {
    // wait until the game has been silent for settleMs
    const start = Date.now();
    while (Date.now() - lastOutput < settleMs && Date.now() - start < 15000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise<void>((r) => mirror.barrier(r));
    // feed events are sent before the game blocks; let the socket drain
    await new Promise((r) => setTimeout(r, 20));
  };
  const screen = () => mirror.text().join('\n');

  const screens: string[] = [];
  try {
    for (let i = 0; i < 400 && outputs === 0; i++) await new Promise((r) => setTimeout(r, 25));
    await settle();
    screens.push(screen());
    for (const k of opts.keys) {
      if (exited) break;
      proc.write(k);
      lastOutput = Date.now();
      await settle();
      screens.push(screen());
    }
  } finally {
    if (!exited) {
      proc.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 100));
    }
    mirror.dispose();
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { screens, events };
}

/**
 * A short exploration: dismiss the intro, then run in every direction a few
 * times (running stops next to objects and features, so the hero passes
 * close to whatever lies in the first rooms), wait 20 turns (the pet roams
 * and may carry things off), redraw (^R reprints every remembered glyph,
 * including objects that are no longer there), and finally show the
 * discoveries list and inventory so object knowledge is part of the
 * recorded screens.
 */
export function explorationScript(rounds = 3): string[] {
  const keys: string[] = ['\r', '\r', '\x1b'];
  const dirs = ['L', 'J', 'H', 'K', 'Y', 'U', 'B', 'N'];
  for (let r = 0; r < rounds; r++) {
    for (const d of dirs) keys.push(d, '\x1b');
    keys.push('2', '0', 's', '\x1b', '\x12');
  }
  keys.push('\\', '\x1b', '\x1b', 'i', '\x1b', '\x1b');
  return keys;
}
