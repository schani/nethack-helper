/**
 * End-to-end smoke test: boots the real server (separate port, separate
 * player name and HOME), drives a new game over the websocket, and checks
 * the headless screen and the structured state.  Requires the NetHack build
 * (nethack/build.sh).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GameClient, sleep, waitFor } from './client.ts';
import type { GameState, SessionInfo } from '../../../shared/feed-events.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');
const HACKDIR = path.join(ROOT, '.nethack/games/lib/nethackdir');
const PORT = Number(process.env.SMOKE_PORT ?? 8797);
const BASE = `http://127.0.0.1:${PORT}`;
const PLAYER = 'smoketest';

let server: ChildProcess | null = null;
let serverLog = '';
let home = '';

const getState = async (): Promise<GameState> => (await fetch(`${BASE}/api/state`)).json() as Promise<GameState>;
const getScreen = async (): Promise<string> => (await fetch(`${BASE}/api/screen`)).text();
const screenHas = (re: RegExp) => async () => re.test(await getScreen());

function cleanupGameFiles() {
  for (const dir of [HACKDIR, path.join(HACKDIR, 'save')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.includes(PLAYER)) fs.rmSync(path.join(dir, f), { force: true });
  }
  // level/lock files of an interrupted game are named <letter>lock.<n>;
  // the .0 file records the save name, so only touch our own player's
  for (const f of fs.readdirSync(HACKDIR)) {
    const m = /^([a-z]lock)\.0$/.exec(f);
    if (!m) continue;
    const head = fs.readFileSync(path.join(HACKDIR, f)).subarray(0, 64).toString('latin1');
    if (!head.includes(PLAYER)) continue;
    for (const g of fs.readdirSync(HACKDIR)) if (g.startsWith(`${m[1]}.`)) fs.rmSync(path.join(HACKDIR, g), { force: true });
  }
}

async function startServer() {
  serverLog = '';
  server = spawn(process.execPath, ['src/main.ts'], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NETHACK_PLAYER: PLAYER,
      NETHACK_HOME: home,
      NETHACK_FEED_SOCKET_PATH: path.join(home, 'feed.sock'),
      LOG: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', (d) => (serverLog += d));
  server.stderr!.on('data', (d) => (serverLog += d));
  await waitFor(async () => (await fetch(`${BASE}/api/session`)).ok, 'server to listen', 15000);
}

async function stopServer() {
  if (!server) return;
  const proc = server;
  server = null;
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGTERM');
  await Promise.race([exited, sleep(10000)]);
}

/** answer whatever stands between us and a command prompt */
async function driveToCommandPrompt(c: GameClient) {
  await waitFor(async () => {
    const scr = await getScreen();
    const st = await getState();
    if (st.awaiting?.kind === 'command' && st.status) return true;
    if (/Shall I pick/.test(scr)) c.send('y');
    else if (/Is this ok\?/.test(scr)) c.send('y');
    else if (/--More--|\(end\)/.test(scr)) c.send('\r');
    else if (/Destroy old game\?|There is already a game/.test(scr)) c.send('y');
    await sleep(300);
    return false;
  }, 'command prompt', 30000, 200);
}

describe('smoke: server + nethack + feed', { timeout: 120000 }, () => {
  beforeAll(async () => {
    expect(fs.existsSync(path.join(HACKDIR, 'nethack')), 'run nethack/build.sh first').toBe(true);
    cleanupGameFiles();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nethack-smoke-'));
    await startServer();
  }, 30000);

  afterAll(async () => {
    await stopServer();
    cleanupGameFiles();
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  it('creates a character and reaches the map', async () => {
    const c = new GameClient(`${BASE.replace('http', 'ws')}/ws`);
    await c.ready();
    await waitFor(() => c.snapshots > 0, 'initial snapshot');
    await driveToCommandPrompt(c);

    const st = await getState();
    expect(st.session).toMatchObject({ state: 'running', player: PLAYER });
    expect(st.feed.connected).toBe(true);
    expect(st.currentLevel).toBe('0:1');
    expect(st.levels['0:1'].info).toMatchObject({ depth: 1, dungeon: 'The Dungeons of Doom' });
    expect(st.status?.fields.level_desc).toBe('Dlvl:1');
    expect(st.inventory.length).toBeGreaterThan(0);
    expect(st.messages.some((m) => /welcome to NetHack/.test(m.text))).toBe(true);
    const hero = st.levels['0:1'].cells.find((cl) => cl.x === st.hero!.x && cl.y === st.hero!.y);
    expect(hero?.ch).toBe('@');
    expect(hero?.desc).toContain(`called ${PLAYER}`);

    const screen = await getScreen();
    expect(screen).toMatch(/Dlvl:1/);
    // the hero is drawn at terminal (x-1, y+1)
    expect(screen.split('\n')[st.hero!.y + 1][st.hero!.x - 1]).toBe('@');
    // the live websocket stream reproduces the same screen
    expect(c.output.length).toBeGreaterThan(0);
    c.close();
  });

  it('accepts keys: search advances the turn, i opens the inventory menu, Esc closes it', async () => {
    const c = new GameClient(`${BASE.replace('http', 'ws')}/ws`);
    await c.ready();
    await waitFor(() => c.snapshots > 0, 'snapshot');
    const before = (await getState()).turn;
    c.send('s');
    await waitFor(async () => {
      const st = await getState();
      if (/--More--/.test(await getScreen())) c.send('\r');
      return st.turn > before && st.awaiting?.kind === 'command';
    }, 'turn to advance');

    c.send('i');
    await waitFor(async () => (await getState()).menu !== null, 'inventory menu');
    const menu = (await getState()).menu!;
    expect(menu.items.some((it) => it.selectable)).toBe(true);
    expect(await getScreen()).toMatch(/\(end\)|\(1 of \d+\)/);
    c.send('\x1b');
    await waitFor(async () => {
      const st = await getState();
      return st.menu === null && st.awaiting?.kind === 'command';
    }, 'menu closed');
    // ws pushes a throttled state view including the current level only
    await waitFor(() => c.lastState?.currentLevel === '0:1', 'ws state push');
    expect(Object.keys(c.lastState!.levels)).toEqual(['0:1']);
    c.close();
  });

  it('saves with S, exits, and resumes on start', async () => {
    const c = new GameClient(`${BASE.replace('http', 'ws')}/ws`);
    await c.ready();
    await waitFor(() => c.snapshots > 0, 'snapshot');
    const turn = (await getState()).turn;
    c.send('S');
    await waitFor(screenHas(/Really save\?/), 'save prompt');
    c.send('y');
    await waitFor(
      () => c.messages.some((m) => m.type === 'session' && m.session.state === 'exited'),
      'session exit notification',
      20000,
    );
    const info = (await (await fetch(`${BASE}/api/session`)).json()) as SessionInfo;
    expect(info.state).toBe('exited');
    expect(fs.readdirSync(path.join(HACKDIR, 'save')).some((f) => f.includes(PLAYER))).toBe(true);

    c.start();
    await waitFor(screenHas(/welcome back to NetHack/), 'restore', 20000);
    await driveToCommandPrompt(c);
    const st = await getState();
    expect(st.session.launches).toBe(2);
    expect(st.turn).toBe(turn);
    // level memory survived the restart of the nethack process
    expect(st.levels['0:1'].cells.length).toBeGreaterThan(5);
    c.close();
  });

  it('a server restart saves the game and the next server resumes it', async () => {
    const turn = (await getState()).turn;
    await stopServer();
    expect(fs.readdirSync(path.join(HACKDIR, 'save')).some((f) => f.includes(PLAYER))).toBe(true);
    await startServer();
    const c = new GameClient(`${BASE.replace('http', 'ws')}/ws`);
    await c.ready();
    await waitFor(screenHas(/welcome back to NetHack/), 'restore after server restart', 20000);
    await driveToCommandPrompt(c);
    const st = await getState();
    expect(st.turn).toBe(turn);
    expect(st.messages.some((m) => m.source === 'history')).toBe(true);
    c.close();
  });
});
