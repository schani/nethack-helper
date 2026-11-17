/**
 * Capture frozen game states for the assistant eval suite.
 *
 * Each recipe plays a reproducible game (fixed seed + clock, see
 * scripts/assistant-e2e/playground.ts) on its own server and saves what the
 * assistant's game tools read: GET /api/state (all levels) and the screen.
 * Debug (wizard) mode is used where normal play would be impractical (shops,
 * sinks, conditions); such captures are normalized to look like a normal
 * game (mode "normal", the hero's forced name "wizard" replaced).
 *
 *   node evals/fixtures/capture.ts [id ...] [--port 8798]       (re)capture fixtures (default: all)
 *   node evals/fixtures/capture.ts --list
 * Interactive development of a recipe (server stays up until killed):
 *   node evals/fixtures/capture.ts serve --seed 33 [--wizard] [--role Valkyrie] [--port 8798]
 *   node evals/fixtures/capture.ts keys '<keys>' [--port 8798]   send keys (JS escapes like \x06 allowed), print screen
 *   node evals/fixtures/capture.ts save <id> [--port 8798]       capture the running dev server
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameDriver, sleep } from '../../scripts/assistant-e2e/game.ts';
import { HACKDIR, ROOT, makePlayground, startServer, stopServer, type Playground } from '../../scripts/assistant-e2e/playground.ts';
import type { GameState } from '../../shared/feed-events.ts';
import type { Fixture } from '../src/fixtures.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'Agnes';

// ------------------------------------------------------------------ playground with optional wizard mode

function sysconfShim(): string {
  const src = path.join(here, 'sysconf-redirect.c');
  const out = path.join(ROOT, '.cache/evals/sysconf-redirect.so');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs) execFileSync('gcc', ['-shared', '-fPIC', '-O2', '-o', out, src, '-ldl']);
  return out;
}

export function roleRc(role = 'Wizard'): string[] {
  const rc: Record<string, string[]> = {
    Wizard: ['OPTIONS=role:Wizard,race:elf,gender:female,align:chaotic', 'OPTIONS=pettype:cat'],
    Valkyrie: ['OPTIONS=role:Valkyrie,race:human,gender:female,align:neutral', 'OPTIONS=pettype:cat'],
    Samurai: ['OPTIONS=role:Samurai,race:human,gender:male,align:lawful', 'OPTIONS=pettype:dog'],
    Priest: ['OPTIONS=role:Priest,race:human,gender:male,align:lawful', 'OPTIONS=pettype:dog'],
    Archeologist: ['OPTIONS=role:Archeologist,race:dwarf,gender:female,align:lawful', 'OPTIONS=pettype:dog'],
  };
  if (role === 'none') return ['OPTIONS=!tips'];
  return [...(rc[role] ?? rc.Wizard), 'OPTIONS=!tips'];
}

function playground(seed: number, role: string, wizard: boolean): Playground {
  const pg = makePlayground({ seed, rc: roleRc(role) });
  if (wizard) {
    // getpos autodescribe would log terrain names ("wall", "stone") as messages while teleporting
    fs.appendFileSync(pg.rc, 'OPTIONS=!autodescribe\n');
    const sc = path.join(pg.dir, 'sysconf');
    fs.writeFileSync(sc, fs.readFileSync(path.join(HACKDIR, 'sysconf'), 'utf8').replace(/^WIZARDS=.*$/m, 'WIZARDS=*'));
    const bin = fs
      .readFileSync(pg.bin, 'utf8')
      .replace(/LD_PRELOAD='([^']*)'/, `LD_PRELOAD='${sysconfShim()} $1' NH_SYSCONF='${sc}'`)
      .replace('"$@"', '-D "$@"');
    fs.writeFileSync(pg.bin, bin);
  }
  return pg;
}

// ------------------------------------------------------------------ helpers for recipes

export class Play {
  readonly g: GameDriver;
  /** message seq numbers: up to keepUntil (before the set-up) and after resumeAt are kept */
  keepUntil = -1;
  resumeAt = -1;
  constructor(g: GameDriver) {
    this.g = g;
  }
  private lastSeq = async () => (await this.st()).messages.at(-1)?.seq ?? 0;
  /** the set-up (wizard commands) starts now: its messages are dropped from the fixture */
  async beginSetup() {
    this.keepUntil = await this.lastSeq();
  }
  /** the set-up is over: messages from here on are kept */
  async endSetup() {
    this.resumeAt = await this.lastSeq();
  }
  async st() {
    return this.g.state();
  }
  /** send raw keys, then wait for the screen to settle */
  async raw(keys: string, ms = 400) {
    this.g.send(keys);
    await sleep(ms);
  }
  async cmd(keys: string) {
    await this.raw(keys, 300);
    await this.g.toCommand();
  }
  /** answer a getlin prompt (wish, create monster, level teleport) */
  async prompt(key: string, answer: string) {
    await this.raw(key, 500);
    await this.raw(answer + '\r', 700);
    await this.g.toCommand();
  }
  wish = (what: string) => this.prompt('\x17', what);
  /** wish and return the inventory letter of the new item (wished items may show only their appearance) */
  async wishGet(what: string): Promise<string> {
    const before = new Set((await this.st()).inventory.map((i) => `${i.letter}:${i.text}`));
    await this.wish(what);
    const it = (await this.st()).inventory.find((i) => !before.has(`${i.letter}:${i.text}`));
    if (!it) throw new Error(`wish for ${what} gave nothing`);
    return it.letter;
  }
  create = (what: string) => this.prompt('\x07', what);
  levelport = (n: number | string) => this.prompt('\x16', String(n));
  async mapLevel() {
    await this.cmd('\x06');
  }
  async identifyAll() {
    await this.raw('\x09', 600);
    await this.g.toCommand();
  }
  /** walk by vi-keys (each followed by returning to the command prompt) */
  async walk(keys: string) {
    for (const k of keys) await this.cmd(k);
  }
  async travel(re: RegExp | { x: number; y: number }) {
    await this.g.travelTo(re);
  }
  /** move the getpos cursor from the hero to (x, y) and pick it */
  private async pick(x: number, y: number) {
    const h = await this.hero();
    let dx = x - h.x;
    let dy = y - h.y;
    let keys = '';
    while (Math.abs(dx) >= 8) (keys += dx > 0 ? 'L' : 'H'), (dx -= 8 * Math.sign(dx));
    while (Math.abs(dy) >= 8) (keys += dy > 0 ? 'J' : 'K'), (dy -= 8 * Math.sign(dy));
    while (dx) (keys += dx > 0 ? 'l' : 'h'), (dx -= Math.sign(dx));
    while (dy) (keys += dy > 0 ? 'j' : 'k'), (dy -= Math.sign(dy));
    // one key at a time: getpos drops type-ahead
    for (const k of keys) await this.raw(k, 80);
    await this.raw('.', 600);
  }
  /** wizard mode: teleport to (x, y) */
  async teleport(x: number, y: number) {
    await this.raw('\x14', 500);
    await this.pick(x, y);
    await this.g.toCommand();
  }
  async rest(turns: number) {
    // counted search; interrupted when something appears
    await this.cmd(`${turns}s`);
  }
  async hero() {
    return (await this.g.cells()).hero;
  }
  async find(re: RegExp) {
    const { cells } = await this.g.cells();
    return cells.filter((c) => re.test(c.desc));
  }
}

// ------------------------------------------------------------------ capture + normalization

async function grab(base: string, running = true): Promise<{ state: GameState; screen: Fixture['screen'] }> {
  const state = (await (await fetch(`${base}/api/state`)).json()) as GameState;
  const screen = (await (await fetch(`${base}/api/screen?format=json`)).json()) as Fixture['screen'];
  void running;
  return { state, screen };
}

/** make a debug-mode capture look like a normal game */
function normalize(fx: Fixture): Fixture {
  const st = fx.state;
  const fixName = (s: string) =>
    s
      .replace(/\bcalled wizard\b/g, `called ${NAME}`)
      .replace(/\bwizard(?= the [A-Z])/g, NAME)
      .replace(/^Wizard(?= the [A-Z])/, NAME)
      .replace(/(welcome (back )?to NetHack,? )wizard\b/gi, `$1${NAME}`)
      .replace(/\b(Hello|Goodbye|farewell),? wizard\b/gi, `$1 ${NAME}`)
      .replace(/\bwizard-(\d+)/g, `${NAME.toLowerCase()}-$1`)
      .replace(/(?<!(gnome|kobold|orc|dwarf) )\bwizard(?=[!,])/g, NAME);
  let json = JSON.stringify(st);
  json = json.replace(/"(?:[^"\\]|\\.)*"/g, (m) => JSON.stringify(fixName(JSON.parse(m) as string)));
  const ns = JSON.parse(json) as GameState;
  if (ns.game) {
    ns.game.mode = 'normal';
    ns.game.name = NAME;
  }
  ns.session.player = NAME;
  // debug-mode commands are not bound in a normal game
  if (ns.keybindings) ns.keybindings = { ...ns.keybindings, debug: false, commands: ns.keybindings.commands.filter((c) => c.kind !== 'debug') };
  // the title on the status line is "<Name> the <rank>"
  if (ns.status?.fields?.title) ns.status.fields.title = String(ns.status.fields.title).replace(/^\S+(?= the )/, NAME);
  // wizard-mode prompts and wizard-only messages are not part of a normal game
  ns.messages = ns.messages.filter((m) => !/For what do you wish|Create what kind of monster|To what level do you want|Unavailable command|wizard mode|debug mode/i.test(m.text) && !/^Count: \d+$/.test(m.text) && !/^An? (sink|\w+ altar|altar|throne|fountain|grave|tree)\.$/.test(m.text));
  const lines = fx.screen.lines.map((l) => fixName(l).replace(/^Wizard(?= the )/, NAME));
  return { ...fx, state: ns, screen: { ...fx.screen, lines } };
}

export interface Recipe {
  id: string;
  description: string;
  seed: number;
  role?: string;
  wizard?: boolean;
  /** start the server without starting a game */
  noGame?: boolean;
  /** do not answer start-up prompts (character creation) */
  rawStart?: boolean;
  steps(p: Play): Promise<void>;
  /** leave the prompt/menu the steps opened (default: return to the command prompt) */
  keepPrompt?: boolean;
  notes: string[];
}

import { RECIPES } from './recipes.ts';

/** Start a game server for the recipe and play its steps; the game stays up until close(). */
export async function playRecipe(r: Recipe, port: number): Promise<{ base: string; play: Play | null; close(): Promise<void> }> {
  const pg = playground(r.seed, r.role ?? 'Wizard', !!r.wizard);
  const srv = await startServer(pg, port, NAME, r.noGame ? { NETHACK_AUTOSTART: '0' } : {});
  let g: GameDriver | null = null;
  const close = async () => {
    g?.close();
    await stopServer(srv.proc);
    fs.rmSync(pg.dir, { recursive: true, force: true });
  };
  try {
    if (r.noGame) return { base: srv.base, play: null, close };
    g = await GameDriver.connect(srv.base);
    if (r.rawStart) await sleep(2500);
    else await g.toCommand();
    const p = new Play(g);
    await r.steps(p);
    if (!r.keepPrompt) await g.toCommand();
    await sleep(600);
    return { base: srv.base, play: p, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/** The fixture for the game the recipe left on `base` (normalized if it used debug mode). */
export async function snapshotFixture(r: Recipe, base: string, p: Play | null): Promise<Fixture> {
  const { state, screen } = await grab(base);
  const recipe = { seed: r.seed, role: r.role ?? 'Wizard', wizard: !!r.wizard };
  if (r.noGame) return { id: r.id, description: r.description, recipe, running: false, state, screen, notes: r.notes };
  if (p && p.keepUntil >= 0 && p.resumeAt >= 0) state.messages = state.messages.filter((m) => m.seq <= p.keepUntil || m.seq > p.resumeAt);
  const fx: Fixture = { id: r.id, description: r.description, recipe, running: true, state, screen, notes: r.notes };
  return r.wizard ? normalize(fx) : fx;
}

async function capture(r: Recipe, port: number): Promise<Fixture> {
  const game = await playRecipe(r, port);
  try {
    return await snapshotFixture(r, game.base, game.play);
  } finally {
    await game.close();
  }
}

export function saveFixture(fx: Fixture) {
  const file = path.join(here, `${fx.id}.json`);
  fs.writeFileSync(file, JSON.stringify(fx) + '\n');
  return file;
}

// ------------------------------------------------------------------ CLI

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  };
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    if (i < 0) return false;
    argv.splice(i, 1);
    return true;
  };
  const port = Number(opt('--port') ?? 8798);
  const base = `http://127.0.0.1:${port}`;
  const cmd = argv[0];
  if (cmd === 'serve') {
    const seed = Number(opt('--seed') ?? 33);
    const role = opt('--role') ?? 'Wizard';
    const wizard = flag('--wizard');
    const pg = playground(seed, role, wizard);
    const srv = await startServer(pg, port, NAME);
    console.log(`serving seed ${seed} (${role}${wizard ? ', wizard mode' : ''}) on ${srv.base}; playground ${pg.dir}`);
    const stop = async () => {
      await stopServer(srv.proc);
      fs.rmSync(pg.dir, { recursive: true, force: true });
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    setInterval(() => {}, 1 << 30);
    return;
  }
  if (cmd === 'keys') {
    const g = await GameDriver.connect(base);
    const keys = (argv[1] ?? '').replace(/\\x([0-9a-f]{2})|\\r|\\e/gi, (m, h) => (h ? String.fromCharCode(parseInt(h, 16)) : m === '\\r' ? '\r' : '\x1b'));
    for (const k of keys) {
      g.send(k);
      await sleep(Number(opt('--delay') ?? 120));
    }
    await sleep(600);
    const st = await g.state();
    console.log(await g.screen());
    console.log(JSON.stringify({ awaiting: st.awaiting?.kind, prompt: st.awaiting?.prompt, hero: st.hero, turn: st.turn, hp: `${st.status?.fields.hp}/${st.status?.fields.hp_max}`, cond: st.status?.conditions, hunger: st.status?.fields.hunger, lvl: st.status?.fields.level_desc }));
    g.close();
    return;
  }
  if (cmd === 'save') {
    const { state, screen } = await grab(base);
    const fx = normalize({ id: argv[1], description: argv[2] ?? '', recipe: { seed: -1, role: '?', wizard: true }, running: true, state, screen, notes: [] });
    console.log(saveFixture(fx));
    return;
  }
  if (flag('--list')) {
    for (const r of RECIPES) console.log(`${r.id.padEnd(24)} ${r.description}`);
    return;
  }
  const ids = argv.length ? argv : RECIPES.map((r) => r.id);
  let failed = 0;
  for (const id of ids) {
    const r = RECIPES.find((x) => x.id === id);
    if (!r) {
      console.error(`unknown recipe ${id}`);
      failed++;
      continue;
    }
    const t0 = Date.now();
    try {
      const fx = await capture(r, port);
      console.log(`${id}: ${saveFixture(fx)} (${Math.round((Date.now() - t0) / 1000)} s, turn ${fx.state.turn}, ${fx.state.status?.fields.level_desc ?? 'no status'}, awaiting ${fx.state.awaiting?.kind ?? '-'})`);
    } catch (e) {
      failed++;
      console.error(`${id}: FAILED: ${(e as Error).stack}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
