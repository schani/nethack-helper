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
let memoryDir = '';
let firstGameId = '';

const getState = async (): Promise<GameState> => (await fetch(`${BASE}/api/state`)).json() as Promise<GameState>;
const getScreen = async (): Promise<string> => (await fetch(`${BASE}/api/screen`)).text();
const getScreenJson = async (): Promise<{ lines: string[]; cursor: { x: number; y: number } }> =>
  (await fetch(`${BASE}/api/screen?format=json`)).json() as never;
/** tty is showing --More-- at the cursor (what the game actually waits for) */
const moreAtCursor = async () => {
  const s = await getScreenJson();
  return s.lines[s.cursor.y].slice(0, s.cursor.x).trimEnd().endsWith('--More--');
};
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
      NETHACK_MEMORY_DIR: memoryDir,
      NETHACKRC_TEMPLATE: path.join(home, 'nethackrc.template'),
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
    memoryDir = path.join(home, 'memory');
    // fixed character (Valkyrie: known starting inventory) + pushweapon,
    // which makes wielding print two long messages -> tty's own --More--
    fs.writeFileSync(
      path.join(home, 'nethackrc.template'),
      fs.readFileSync(path.join(ROOT, 'nethack/nethackrc'), 'utf8') +
        '\nOPTIONS=role:Valkyrie,race:human,gender:female,align:neutral\nOPTIONS=pushweapon\n',
    );
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
    // the feed announced a brand-new game and its identity
    expect(st.game).toMatchObject({ origin: 'new', name: PLAYER, role: 'Valkyrie', memoryRestored: false });
    expect(st.game!.id).toBe(`${PLAYER}-${st.game!.birthday}`);
    firstGameId = st.game!.id;
    // blank solid rock is never stored
    expect(st.levels['0:1'].cells.some((cl) => cl.ch === ' ' && /^(stone|unexplored)/.test(cl.desc))).toBe(false);
    // level memory is persisted (throttled) under the game id
    await waitFor(() => fs.existsSync(path.join(memoryDir, `${firstGameId}.json`)), 'memory file', 5000);

    const screen = await getScreen();
    expect(screen).toMatch(/Dlvl:1/);
    // the hero is drawn at terminal (x-1, y+1)
    expect(screen.split('\n')[st.hero!.y + 1][st.hero!.x - 1]).toBe('@');
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

  it('reports a --More-- that tty raises by itself (message overflow)', async () => {
    const c = new GameClient(`${BASE.replace('http', 'ws')}/ws`);
    await c.ready();
    await waitFor(() => c.snapshots > 0, 'snapshot');
    // with pushweapon, wielding the dagger prints "b - ... dagger ..." and
    // "a - ... (alternate weapon; not wielded)": too long for one line, so
    // tty shows --More-- between them; the feed's last input request
    // ("What do you want to wield?") is stale at that point
    c.send('w');
    await waitFor(screenHas(/What do you want to wield/), 'wield prompt');
    expect(c.output).toContain('What do you want to wield'); // live stream
    c.send('b');
    await waitFor(moreAtCursor, 'tty --More--');
    const st = await waitFor(async () => {
      const s = await getState();
      return s.awaiting?.kind === 'more' ? s : null;
    }, 'awaiting more');
    expect(st.awaiting).toMatchObject({ kind: 'more', source: 'screen' });
    expect(st.awaiting!.prompt).toMatch(/dagger/);
    c.send('\r');
    await waitFor(async () => {
      const s = await getState();
      if (await moreAtCursor()) c.send('\r');
      return s.awaiting?.kind === 'command' && s.awaiting.source === 'feed';
    }, 'back at the command prompt');
    c.close();
  });

  it('reports the menu letters tty shows, on every page', async () => {
    const c = new GameClient(`${BASE.replace('http', 'ws')}/ws`);
    await c.ready();
    await waitFor(() => c.snapshots > 0, 'snapshot');
    c.send('O'); // options: two pages, letters assigned by tty (a-z per page)
    const menu = (await waitFor(async () => (await getState()).menu, 'options menu'))!;
    expect(menu.pages).toBeGreaterThanOrEqual(2);
    const assigned = menu.items.filter((it) => it.assigned);
    expect(assigned.length).toBeGreaterThan(20);
    for (let page = 1; page <= 2; page++) {
      if (page === 2) c.send('>');
      await waitFor(screenHas(new RegExp(`\\(${page} of ${menu.pages}\\)`)), `page ${page}`);
      const screen = await getScreen();
      const items = menu.items.filter((it) => it.page === page && it.ch);
      expect(items.length).toBeGreaterThan(5);
      expect(items.filter((it) => it.assigned)[0].ch).toBe('a'); // letters restart per page
      for (const it of items) expect(screen, `${it.ch} - ${it.text}`).toContain(`${it.ch} - ${it.text.trimEnd()}`);
    }
    c.send('\x1b');
    await waitFor(async () => (await getState()).awaiting?.kind === 'command', 'menu closed');
    c.close();
  });

  it('Meta keys reach the game as NetHack meta commands (M-C = #conduct)', async () => {
    const c = new GameClient(`${BASE.replace('http', 'ws')}/ws`);
    await c.ready();
    await waitFor(() => c.snapshots > 0, 'snapshot');
    c.ws.send(JSON.stringify({ type: 'input', data: 'C', meta: true }));
    await waitFor(screenHas(/Voluntary challenges/), 'conduct window');
    await driveToCommandPrompt(c);
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
    expect(st.game).toMatchObject({ origin: 'restored', id: firstGameId });
    // level memory survived the restart of the nethack process
    expect(st.levels['0:1'].cells.length).toBeGreaterThan(5);
    // the history NetHack replays on restore is not appended twice
    expect(st.messages.filter((m) => /welcome to NetHack!/.test(m.text))).toHaveLength(1);
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
    // level memory and the message log came back from disk
    expect(st.game).toMatchObject({ origin: 'restored', id: firstGameId, memoryRestored: true });
    expect(st.levels['0:1'].cells.length).toBeGreaterThan(5);
    expect(st.messages.some((m) => /welcome to NetHack!/.test(m.text) && m.source === undefined)).toBe(true);
    expect(st.messages.some((m) => /welcome back to NetHack/.test(m.text))).toBe(true);
    c.close();
  });

  it('a new game after quitting starts with fresh memory and drops the old one', async () => {
    const c = new GameClient(`${BASE.replace('http', 'ws')}/ws`);
    await c.ready();
    await waitFor(() => c.snapshots > 0, 'snapshot');
    await waitFor(async () => {
      const info = (await (await fetch(`${BASE}/api/session`)).json()) as SessionInfo;
      if (info.state === 'exited') return true;
      const scr = await getScreen();
      const st = await getState();
      if (st.awaiting?.kind === 'command' && !(await moreAtCursor())) c.send('#quit\r');
      else if (/\[ynq\]/.test(scr)) c.send('q');
      else if (/\[yn\]|Really quit/.test(scr)) c.send('y');
      else c.send('\r');
      await sleep(300);
      return false;
    }, 'game over', 30000, 200).catch(async (e) => {
      throw new Error(`${e}\n${await getScreen()}`);
    });
    c.start();
    await driveToCommandPrompt(c);
    const st = await getState();
    expect(st.game?.origin).toBe('new');
    expect(st.game?.id).not.toBe(firstGameId);
    expect(st.messages.some((m) => /welcome back/.test(m.text))).toBe(false);
    await waitFor(() => fs.existsSync(path.join(memoryDir, `${st.game!.id}.json`)), 'new memory file', 5000);
    expect(fs.existsSync(path.join(memoryDir, `${firstGameId}.json`))).toBe(false);
    c.close();
  });
});
