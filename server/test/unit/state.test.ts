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

  it('keeps level memory when a saved game is restored, forgets it for a new game', () => {
    const s = new GameStateStore();
    s.apply(status(1));
    s.apply(level(0, 1));
    s.apply(ev({ t: 'map', dnum: 0, dlevel: 1, cells: [cell(10, 5, '{', 'fountain')], ux: 1, uy: 1 }));
    s.apply(status(200));
    s.apply(level(0, 2));

    // restore at turn 200: memory of 0:1 is kept
    s.resetForNewProcess();
    s.apply(ev({ t: 'hello', schema: 1, pid: 2, version_major: 5, version_minor: 0, patchlevel: 0, cols: 80, rows: 21 }));
    s.apply(status(200));
    s.apply(level(0, 2));
    expect(Object.keys(s.snapshot().levels).sort()).toEqual(['0:1', '0:2']);

    // brand-new character (turn 1): previous game's levels are dropped
    s.resetForNewProcess();
    s.apply(status(1));
    s.apply(level(0, 1));
    expect(Object.keys(s.snapshot().levels)).toEqual(['0:1']);
    expect(s.snapshot().levels['0:1'].cells).toHaveLength(0);
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
});
