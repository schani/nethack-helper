import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FeedParser } from '../../src/feed/parser.ts';
import { GameStateStore, MESSAGE_LIMIT } from '../../src/feed/state.ts';
import type { FeedEvent, MapCell } from '../../../shared/feed-events.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, '../fixtures/new-game.ndjson'));

function replay(store = new GameStateStore('fixture')) {
  const p = new FeedParser();
  // feed in odd-sized chunks like a socket would
  for (let i = 0; i < fixture.length; i += 777) for (const ev of p.push(fixture.subarray(i, i + 777))) store.apply(ev);
  expect(p.errorCount).toBe(0);
  return store;
}

let seq = 0;
type EventInit = FeedEvent extends infer E ? (E extends FeedEvent ? Omit<E, 'seq'> : never) : never;
const ev = (e: EventInit): FeedEvent => ({ ...e, seq: ++seq }) as FeedEvent;
const cell = (x: number, y: number, ch: string, desc: string, extra: Partial<MapCell> = {}): MapCell => ({
  x, y, ch, desc, look: desc, glyph: 1000 + x, color: 7, ...extra,
});
const level = (dnum: number, dlevel: number) =>
  ev({ t: 'level', dnum, dlevel, depth: dlevel, dungeon: 'The Dungeons of Doom', desc: `Dlvl:${dlevel}`, long_desc: `level ${dlevel}`, known: [] });
const game = (origin: 'new' | 'restored', birthday: number, turn = 1, uuid = 'u-1') =>
  ev({ t: 'game', origin, name: 'fixture', birthday, uuid, role: 'Valkyrie', race: 'human', gender: 'female', alignment: 'neutral', mode: 'normal', turn });
const status = (turn: number) => ev({ t: 'status', fields: { hp: '10', hp_max: '12', time: String(turn) }, conditions: [], turn });

describe('GameStateStore with a recorded new-game feed', () => {
  const st = replay().snapshot();

  it('tracks status fields', () => {
    expect(st.status?.fields).toMatchObject({ title: 'Fixture the Stripling', align: 'Neutral', level_desc: 'Dlvl:1', xp_level: '1' });
    expect(Number(st.status?.fields.hp)).toBeGreaterThan(0);
    expect(st.status?.conditions).toEqual([]);
  });

  it('tracks the current level and the hero', () => {
    expect(st.currentLevel).toBe('0:1');
    expect(st.levels['0:1'].info).toMatchObject({ dungeon: 'The Dungeons of Doom', depth: 1, desc: 'Dlvl:1' });
    expect(st.hero).toEqual({ x: 36, y: 4 });
    expect(st.turn).toBe(4);
  });

  it('keeps per-tile farlook descriptions', () => {
    const cells = st.levels['0:1'].cells;
    const at = (x: number, y: number) => cells.find((c) => c.x === x && c.y === y);
    expect(at(36, 4)).toMatchObject({ ch: '@', desc: 'human valkyrie called fixture' });
    expect(at(36, 4)!.flags! & 0x1).toBe(1); // MG_HERO
    expect(at(34, 4)).toMatchObject({ ch: '<', desc: 'branch staircase up' });
    expect(cells.find((c) => c.ch === 'F')).toMatchObject({ desc: 'lichen, holding you', look: 'a fungus or mold (lichen, holding you)' });
    const pet = cells.find((c) => (c.flags ?? 0) & 0x10);
    expect(pet?.desc).toMatch(/^tame /);
    // ASCII map rows line up with cells (column 0 dropped)
    expect(st.levels['0:1'].rows[4][36 - 1]).toBe('@');
  });

  it('tracks inventory with slots', () => {
    expect(st.inventory.map((i) => i.letter)).toEqual(['a', 'b', 'c', 'd']);
    expect(st.inventory[0]).toMatchObject({ class: 'weapons', wielded: true, slots: ['wielded'] });
    expect(st.inventory[2]).toMatchObject({ text: expect.stringContaining('small shield'), worn: true, slots: ['shield'] });
  });

  it('tracks messages, input and menus', () => {
    expect(st.messages.map((m) => m.text)).toContain('The lichen touches you!');
    expect(st.awaiting).toMatchObject({ kind: 'command', turn: 4, ux: 36, uy: 4 });
    expect(st.menu).toBeNull(); // inventory menu was opened and closed
    expect(st.feed).toMatchObject({ lastSeq: 27, schema: 1 });
  });
});

describe('GameStateStore level memory', () => {
  it('remembers previous levels across level changes', () => {
    const s = new GameStateStore();
    s.apply(status(1));
    s.apply(level(0, 1));
    s.apply(ev({ t: 'map_clear', dnum: 0, dlevel: 1 }));
    s.apply(ev({ t: 'map', dnum: 0, dlevel: 1, cells: [cell(10, 5, '{', 'fountain'), cell(11, 5, '@', 'you')], ux: 11, uy: 5 }));
    s.apply(status(50));
    // go downstairs: level event comes before the clear of the new level
    s.apply(level(0, 2));
    s.apply(ev({ t: 'map_clear', dnum: 0, dlevel: 2 }));
    s.apply(ev({ t: 'map', dnum: 0, dlevel: 2, cells: [cell(3, 3, '>', 'staircase down')], ux: 3, uy: 3 }));

    const snap = s.snapshot();
    expect(snap.currentLevel).toBe('0:2');
    expect(Object.keys(snap.levels).sort()).toEqual(['0:1', '0:2']);
    expect(snap.levels['0:1'].cells.map((c) => c.desc)).toEqual(['fountain', 'you']);
    expect(snap.levels['0:2'].cells).toHaveLength(1);
    expect(s.snapshot({ allLevels: false }).levels).toHaveProperty('0:2');
    expect(s.snapshot({ allLevels: false }).levels).not.toHaveProperty('0:1');
    expect(s.cellAt(3, 3)?.desc).toBe('staircase down');
  });

  it('drops cells that become unexplored and replaces changed ones', () => {
    const s = new GameStateStore();
    s.apply(status(1));
    s.apply(level(0, 1));
    s.apply(ev({ t: 'map', dnum: 0, dlevel: 1, cells: [cell(5, 5, 'd', 'jackal'), cell(6, 5, '.', 'floor of a room')], ux: 1, uy: 1 }));
    s.apply(ev({ t: 'map', dnum: 0, dlevel: 1, cells: [cell(5, 5, '.', 'floor of a room'), cell(6, 5, ' ', 'unexplored area', { flags: 0x800 })], ux: 1, uy: 1 }));
    const cells = s.snapshot().levels['0:1'].cells;
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ x: 5, desc: 'floor of a room' });
  });

  it('keeps level memory when the same game is restored, forgets it for a new game', () => {
    const s = new GameStateStore();
    s.apply(game('new', 1000));
    s.apply(status(1));
    s.apply(level(0, 1));
    s.apply(ev({ t: 'map', dnum: 0, dlevel: 1, cells: [cell(10, 5, '{', 'fountain')], ux: 1, uy: 1 }));
    s.apply(ev({ t: 'msg', text: 'Hello, welcome to NetHack!', turn: 1 }));
    s.apply(status(200));
    s.apply(level(0, 2));

    // the same game restored by a new process: memory of 0:1 is kept and
    // the message history NetHack replays is not duplicated
    s.resetForNewProcess();
    s.apply(ev({ t: 'hello', schema: 2, pid: 2, version_major: 5, version_minor: 0, patchlevel: 0, cols: 80, rows: 21 }));
    s.apply(ev({ t: 'msg', text: 'Hello, welcome to NetHack!', turn: 200, source: 'history' }));
    s.apply(ev({ t: 'msg', text: 'Restoring save file...', turn: 200 }));
    s.apply(game('restored', 1000, 200));
    s.apply(level(0, 2));
    expect(Object.keys(s.snapshot().levels).sort()).toEqual(['0:1', '0:2']);
    expect(s.snapshot().messages.map((m) => m.text)).toEqual(['Hello, welcome to NetHack!', 'Restoring save file...']);

    // a new character, even at a high turn count or with a game id seen
    // before: previous memory is dropped (decided by the feed, not the turn)
    s.resetForNewProcess();
    s.apply(ev({ t: 'msg', text: 'Hello again, welcome to NetHack!', turn: 1 }));
    s.apply(game('new', 2000));
    s.apply(level(0, 1));
    expect(Object.keys(s.snapshot().levels)).toEqual(['0:1']);
    expect(s.snapshot().levels['0:1'].cells).toHaveLength(0);
    expect(s.snapshot().messages.map((m) => m.text)).toEqual(['Hello again, welcome to NetHack!']);
    expect(s.snapshot().game).toMatchObject({ id: 'fixture-2000', origin: 'new', memoryRestored: false });
  });

  it('restores persisted memory for a restored game (server restart)', () => {
    const first = new GameStateStore();
    first.apply(game('new', 1234));
    first.apply(level(0, 1));
    first.apply(ev({ t: 'map', dnum: 0, dlevel: 1, cells: [cell(10, 5, '{', 'fountain')], ux: 10, uy: 5 }));
    first.apply(ev({ t: 'msg', text: 'You see a fountain.', turn: 3 }));
    first.apply(level(0, 2));
    first.apply(ev({ t: 'map', dnum: 0, dlevel: 2, cells: [cell(3, 3, '>', 'staircase down')], ux: 3, uy: 3 }));
    const saved = JSON.parse(JSON.stringify(first.exportMemory()));
    expect(saved.game.id).toBe('fixture-1234');

    const loads: string[] = [];
    const second = new GameStateStore('fixture', {
      loadMemory: (id) => {
        loads.push(id);
        return id === saved.game.id ? saved : null;
      },
    });
    second.resetForNewProcess();
    second.apply(ev({ t: 'msg', text: 'You see a fountain.', turn: 3, source: 'history' }));
    second.apply(game('restored', 1234, 40));
    second.apply(level(0, 2));
    const snap = second.snapshot();
    expect(loads).toEqual(['fixture-1234']);
    expect(snap.game).toMatchObject({ origin: 'restored', memoryRestored: true });
    expect(snap.levels['0:1'].cells.map((c) => c.desc)).toEqual(['fountain']);
    expect(snap.messages.map((m) => m.text)).toEqual(['You see a fountain.']); // history replay dropped

    // another game of the same name (different birthday) does not get it
    const third = new GameStateStore('fixture', { loadMemory: (id) => (id === saved.game.id ? saved : null) });
    third.apply(game('restored', 999));
    expect(third.snapshot().levels).toEqual({});
    // nor does a game whose NetHack uuid differs
    const fourth = new GameStateStore('fixture', { loadMemory: () => saved });
    fourth.apply(game('restored', 1234, 1, 'other-uuid'));
    expect(fourth.snapshot().game?.memoryRestored).toBe(false);
    // new games never load
    const fifth = new GameStateStore('fixture', { loadMemory: () => saved });
    fifth.apply(game('new', 1234));
    expect(fifth.snapshot().levels).toEqual({});
  });

  it('does not store blank stone or unexplored cells (magic mapping)', () => {
    const s = new GameStateStore();
    s.apply(level(0, 1));
    const cells: MapCell[] = [];
    for (let x = 1; x < 80; x++) for (let y = 0; y < 21; y++) cells.push(cell(x, y, ' ', 'stone'));
    cells.push(cell(5, 5, '#', 'corridor'), cell(6, 5, ' ', 'dark part of a room'), cell(7, 5, ' ', 'unexplored'));
    s.apply(ev({ t: 'map', dnum: 0, dlevel: 1, cells, ux: 5, uy: 5 }));
    const stored = s.snapshot().levels['0:1'].cells;
    expect(stored.map((c) => c.desc).sort()).toEqual(['corridor', 'dark part of a room']);
    // a remembered cell that turns blank is forgotten
    s.apply(ev({ t: 'map', dnum: 0, dlevel: 1, cells: [cell(5, 5, ' ', 'stone')], ux: 5, uy: 5 }));
    expect(s.snapshot().levels['0:1'].cells.map((c) => c.desc)).toEqual(['dark part of a room']);
  });

  it('reports a tty-raised --More-- seen on the screen over a stale feed prompt', () => {
    const s = new GameStateStore();
    s.apply(status(12));
    s.apply(ev({ t: 'input', kind: 'command', turn: 12, ux: 4, uy: 4 }));
    expect(s.snapshot().awaiting).toMatchObject({ kind: 'command', source: 'feed' });
    expect(s.setScreenMore('You hit the jackal.  The jackal bites!')).toBe(true);
    expect(s.setScreenMore('You hit the jackal.  The jackal bites!')).toBe(false);
    expect(s.snapshot().awaiting).toMatchObject({ kind: 'more', source: 'screen', prompt: 'You hit the jackal.  The jackal bites!', turn: 12 });
    s.setScreenMore(null);
    expect(s.snapshot().awaiting).toMatchObject({ kind: 'command', source: 'feed' });
    // a --More-- the feed already knows about stays the feed's
    s.apply(ev({ t: 'input', kind: 'more', turn: 12 }));
    s.setScreenMore('Something');
    expect(s.snapshot().awaiting).toMatchObject({ kind: 'more', source: 'feed' });
  });

  it('bounds the message buffer', () => {
    const s = new GameStateStore();
    for (let i = 0; i < MESSAGE_LIMIT + 50; i++) s.apply(ev({ t: 'msg', text: `m${i}`, turn: i }));
    const msgs = s.snapshot().messages;
    expect(msgs).toHaveLength(MESSAGE_LIMIT);
    expect(msgs.at(-1)?.text).toBe(`m${MESSAGE_LIMIT + 49}`);
  });

  it('records prompts, menus and game over', () => {
    const s = new GameStateStore();
    s.apply(ev({ t: 'input', kind: 'yn', prompt: 'Really save?', choices: 'yn', default: 'n', turn: 7 }));
    expect(s.snapshot().awaiting).toMatchObject({ kind: 'yn', prompt: 'Really save?' });
    s.apply(ev({ t: 'menu', win: 5, how: 'any', prompt: 'Pick up what?', items: [{ text: 'a dagger', ch: 'a', selectable: true }] }));
    expect(s.snapshot().menu?.prompt).toBe('Pick up what?');
    s.apply(ev({ t: 'menu_done', win: 5, count: 1 }));
    expect(s.snapshot().menu).toBeNull();
    s.apply(ev({ t: 'gameover', how: 0, turn: 9 }));
    s.apply(ev({ t: 'exit', text: '' }));
    expect(s.snapshot()).toMatchObject({ gameover: { how: 0, turn: 9 }, awaiting: null });
  });

  it('keeps the discoveries / overview / underfoot texts and resets them per process', () => {
    const s = new GameStateStore();
    s.apply(ev({ t: 'discoveries', lines: ['Discoveries', 'Potions', '  potion (ruby)'] }));
    s.apply(ev({ t: 'overview', lines: ['The Dungeons of Doom:', '   Level 1: <- You are here.'] }));
    s.apply(ev({ t: 'underfoot', x: 3, y: 4, glyph: 5, ch: '{', color: 4, desc: 'fountain', look: 'a fountain (fountain)' }));
    expect(s.snapshot()).toMatchObject({ discoveries: ['Discoveries', 'Potions', '  potion (ruby)'], underfoot: { x: 3, y: 4, desc: 'fountain' } });
    expect(s.snapshot().overview).toHaveLength(2);
    s.resetForNewProcess();
    expect(s.snapshot()).toMatchObject({ discoveries: null, overview: null, underfoot: null });
  });

  it('remembers what was under the hero when leaving a level', () => {
    const s = new GameStateStore();
    s.apply(level(0, 1));
    s.apply(ev({ t: 'map', dnum: 0, dlevel: 1, ux: 10, uy: 5, cells: [cell(10, 5, '@', 'you'), cell(11, 5, '.', 'floor of a room')] }));
    s.apply(ev({ t: 'underfoot', x: 10, y: 5, glyph: 2399, ch: '>', color: 7, desc: 'staircase down', look: 'a staircase down (staircase down)' }));
    s.apply(level(0, 2));
    s.apply(ev({ t: 'map_clear', dnum: 0, dlevel: 2 }));
    const l1 = s.snapshot().levels['0:1'];
    expect(l1.cells.find((c) => c.x === 10 && c.y === 5)).toMatchObject({ ch: '>', desc: 'staircase down', glyph: 2399 });
    expect(l1.rows[5][10 - 1]).toBe('>');
    expect(s.snapshot().underfoot).toBeNull();
    // an underfoot that is not where the hero is (stale) is not used
    s.apply(ev({ t: 'map', dnum: 0, dlevel: 2, ux: 20, uy: 5, cells: [cell(20, 5, '@', 'you')] }));
    s.apply(ev({ t: 'underfoot', x: 1, y: 1, glyph: 1, ch: '{', color: 4, desc: 'fountain', look: '' }));
    s.apply(level(0, 3));
    expect(s.snapshot().levels['0:2'].cells.find((c) => c.x === 20)).toMatchObject({ ch: '@' });
  });
});
