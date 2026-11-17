/**
 * Assistant game tools against synthetic feed state: spoken directions,
 * look targets, legends, levels, status / prompts, discoveries, snapshot.
 */
import { describe, expect, it } from 'vitest';
import { GameStateStore } from '../../src/feed/state.ts';
import { GameTools } from '../../src/assistant/game/tools.ts';
import { GameView, explainMessage, type GameViewOptions } from '../../src/assistant/game/view.ts';
import { describeOffset, mapRegion, parseDirection, roughOffset, screenRegion } from '../../src/assistant/game/directions.ts';
import type { FeedEvent, MapCell } from '../../../shared/feed-events.ts';

let seq = 0;
type EventInit = FeedEvent extends infer E ? (E extends FeedEvent ? Omit<E, 'seq'> : never) : never;
const ev = (e: EventInit): FeedEvent => ({ ...e, seq: ++seq }) as FeedEvent;
const cell = (x: number, y: number, ch: string, desc: string, look = desc, extra: Partial<MapCell> = {}): MapCell => ({
  x, y, ch, desc, look, glyph: 2000 + x, color: 7, ...extra,
});
const level = (dlevel: number, dungeon = 'The Dungeons of Doom', dnum = 0, depth = dlevel) =>
  ev({ t: 'level', dnum, dlevel, depth, dungeon, desc: `Dlvl:${depth}`, long_desc: `level ${depth}, ${dungeon}`, known: [] });

/** A small room: hero at (10,10), kitten east, fountain 2 NE, lichen 3 west 1 north, '>' far away, door north. */
function room(): MapCell[] {
  const cells: MapCell[] = [];
  for (let x = 5; x <= 15; x++) for (let y = 7; y <= 12; y++) cells.push(cell(x, y, '.', 'floor of a room'));
  for (let x = 4; x <= 16; x++) cells.push(cell(x, 6, '-', 'wall'), cell(x, 13, '-', 'wall'));
  const put = (c: MapCell) => {
    const i = cells.findIndex((o) => o.x === c.x && o.y === c.y);
    if (i >= 0) cells.splice(i, 1);
    cells.push(c);
  };
  put(cell(10, 10, '@', 'elven wizard called Tester', 'human or elf (elven wizard called Tester)', { flags: 1 }));
  put(cell(11, 10, 'f', 'tame kitten', 'a feline (tame kitten)', { flags: 0x10 }));
  put(cell(12, 8, '{', 'fountain', 'a fountain (fountain)'));
  put(cell(7, 9, 'F', 'lichen', 'a fungus or mold (lichen)'));
  put(cell(15, 12, '>', 'staircase down', 'a staircase down (staircase down)'));
  put(cell(10, 6, '+', 'closed door', 'a door (closed door)'));
  put(cell(14, 7, '!', 'a bubbly potion', 'a potion (a bubbly potion)'));
  return cells;
}

function makeStore() {
  const store = new GameStateStore('Tester');
  store.session.state = 'running';
  store.setFeedConnected(true);
  store.apply(ev({ t: 'game', origin: 'new', name: 'Tester', birthday: 1, uuid: 'u', role: 'Wizard', race: 'elf', gender: 'female', alignment: 'chaotic', mode: 'normal', turn: 1 }));
  // level 1: visited first, has an altar and the up stairs
  store.apply(level(1));
  store.apply(ev({ t: 'map_clear', dnum: 0, dlevel: 1 }));
  store.apply(ev({
    t: 'map', dnum: 0, dlevel: 1, ux: 40, uy: 10,
    cells: [cell(20, 15, '<', 'staircase up'), cell(60, 4, '_', 'chaotic altar', 'an altar (chaotic altar)'), cell(40, 10, '@', 'elven wizard called Tester'), cell(41, 10, '.', 'floor of a room')],
  }));
  store.apply(ev({ t: 'underfoot', x: 40, y: 10, glyph: 2399, ch: '>', color: 7, desc: 'staircase down', look: 'a staircase down (staircase down)' }));
  // descend to level 2
  store.apply(level(2));
  store.apply(ev({ t: 'map_clear', dnum: 0, dlevel: 2 }));
  store.apply(ev({ t: 'map', dnum: 0, dlevel: 2, ux: 10, uy: 10, cells: room() }));
  store.apply(ev({ t: 'underfoot', x: 10, y: 10, glyph: 2398, ch: '<', color: 7, desc: 'staircase up', look: 'a staircase up (staircase up)' }));
  store.apply(ev({
    t: 'status', turn: 321, conditions: ['Conf'],
    fields: { title: 'Tester the Evoker', hp: '7', hp_max: '12', power: '3', power_max: '9', ac: '9', xp_level: '2', exp_points: '25', gold: '14', hunger: 'Hungry', encumbrance: '', level_desc: 'Dlvl:2', align: 'Chaotic', str: '9', dex: '13', con: '12', int: '18', wis: '12', cha: '10' },
  }));
  store.apply(ev({
    t: 'inventory',
    items: [
      { letter: 'a', text: 'a blessed +1 quarterstaff (weapon in hands)', class_sym: ')', class: 'weapons', quan: 1, slots: ['wielded'], worn: false, wielded: true },
      { letter: 'b', text: 'an uncursed +0 cloak of magic resistance (being worn)', class_sym: '[', class: 'armor', quan: 1, slots: ['cloak'], worn: true, wielded: false },
      { letter: 'p', text: 'a murky potion', class_sym: '!', class: 'potions', quan: 1, slots: [], worn: false, wielded: false },
    ],
  }));
  store.apply(ev({ t: 'msg', text: 'You see here a lichen corpse.', turn: 320 }));
  store.apply(ev({ t: 'msg', text: 'You feel somewhat dizzy.', turn: 321 }));
  store.apply(ev({ t: 'input', kind: 'command', turn: 321, ux: 10, uy: 10 }));
  store.apply(ev({ t: 'discoveries', lines: ['Discoveries, by order of discovery within each class', '', 'Potions', '  potion of healing (pink)', '  potion called fizzy (murky)'] }));
  store.apply(ev({ t: 'overview', lines: ['The Dungeons of Doom: levels 1 to 2', '   Level 1:', '      An altar.', '   Level 2: <- You are here.', '      A fountain.'] }));
  return store;
}

const screen = { lines: ['You feel somewhat dizzy.', '', ' -----------', 'Tester the Evoker  St:9', 'Dlvl:2 $:14 HP:7(12)'] };
function tools(opts: GameViewOptions = {}, store = makeStore(), running = true) {
  return new GameTools({ running, state: (o) => store.snapshot(o), screen: () => screen }, opts);
}

describe('directions', () => {
  it('phrases offsets in compass and screen terms, never coordinates', () => {
    expect(describeOffset({ dx: 1, dy: 0 })).toBe('adjacent, 1 square east (right)');
    expect(describeOffset({ dx: 0, dy: -3 })).toBe('3 squares north (up)');
    expect(describeOffset({ dx: -2, dy: 2 })).toBe('2 squares southwest (diagonally down-left)');
    expect(describeOffset({ dx: 5, dy: -1 })).toBe('5 east and 1 north (5 right, 1 up)');
    expect(describeOffset({ dx: 0, dy: 0 })).toBe('on your square');
  });

  it('parses spoken directions with optional distances', () => {
    expect(parseDirection('north')).toEqual({ unit: { dx: 0, dy: -1 }, distance: undefined });
    expect(parseDirection('2 west')).toEqual({ unit: { dx: -1, dy: 0 }, distance: 2 });
    expect(parseDirection('two squares to the up-left')).toEqual({ unit: { dx: -1, dy: -1 }, distance: 2 });
    expect(parseDirection('south east 3')).toEqual({ unit: { dx: 1, dy: 1 }, distance: 3 });
    expect(parseDirection('upper right')).toEqual({ unit: { dx: 1, dy: -1 }, distance: undefined });
    expect(parseDirection('fountain')).toBeNull();
    expect(parseDirection('stairs down')).toBeNull();
  });

  it('names map regions for other levels', () => {
    expect(mapRegion(5, 2)).toBe('the north-west part of the map');
    expect(mapRegion(40, 10)).toBe('the middle of the map');
    expect(mapRegion(70, 10)).toBe('the east side of the map');
    expect(screenRegion(66, 1)).toBe('the top-right part of the map');
    expect(screenRegion(40, 18)).toBe('the bottom middle of the map');
    expect(screenRegion(5, 10)).toBe('the left side of the map, middle height');
  });

  it('phrases far offsets roughly, the way a player would say them', () => {
    expect(roughOffset({ dx: 53, dy: -7 })).toBe('about 55 squares right and 7 up');
    expect(roughOffset({ dx: -38, dy: -11 })).toBe('about 40 squares left and 10 up');
    expect(roughOffset({ dx: 40, dy: 1 })).toBe('about 40 squares right and a little down');
    expect(roughOffset({ dx: 3, dy: 0 })).toBe('3 squares right');
    expect(roughOffset({ dx: 0, dy: -12 })).toBe('about 10 squares up');
    expect(roughOffset({ dx: 1, dy: -1 })).toBe('right next to it');
  });
});

describe('look', () => {
  const t = tools();
  const look = (target: string, radius?: number) => t.run('look', { target, ...(radius ? { radius } : {}) });

  it('finds a symbol relative to the hero', () => {
    const out = look('the f');
    expect(out).toContain('f tame kitten (a feline): adjacent, 1 square east (right)');
    expect(out).not.toMatch(/\b(x|y)\s*=|\(\d+,\s*\d+\)|column|row/);
  });

  it('symbols are case sensitive', () => {
    expect(look('F')).toContain('F lichen (a fungus or mold): 3 west and 1 north (3 left, 1 up)');
    expect(look('{')).toContain('2 squares northeast (diagonally up-right)');
  });

  it('lists the eight neighbours and what is underfoot', () => {
    const out = look('adjacent');
    expect(out).toContain('east (right): f tame kitten');
    expect(out).toContain('north (up): . floor of a room');
    expect(out).toContain('Under you: < staircase up.');
  });

  it('looks in a direction, with and without distance', () => {
    expect(look('2 squares northeast')).toBe('2 squares northeast (diagonally up-right): { fountain.');
    const ray = look('north');
    expect(ray).toMatch(/^Looking north \(up\) from you:/);
    expect(ray).toContain('1 to 3 squares away: . floor of a room');
    expect(ray).toContain('4 squares away: + closed door');
  });

  it('matches words from descriptions, with synonyms', () => {
    expect(look('fountain')).toContain('{ fountain: 2 squares northeast');
    expect(look('stairs down')).toContain('> staircase down: 5 east and 2 south (5 right, 2 down)');
    expect(look('my pet')).toContain('tame kitten');
    expect(look('potion')).toContain('! a bubbly potion: 4 east and 3 north');
    expect(look('upstairs')).toContain('staircase up: under you');
    expect(look('dragon')).toMatch(/^Nothing matching "dragon"/);
  });

  it('lists notable things nearby, nearest first, skipping floor and walls', () => {
    const out = look('nearby', 3);
    const lines = out.split('\n');
    expect(lines[1]).toMatch(/^f tame kitten/);
    expect(out).toContain('fountain');
    expect(out).toContain('lichen');
    expect(out).not.toContain('staircase down'); // 5 away
    expect(out).not.toMatch(/floor of a room:/);
  });

  it('describes the hero square', () => {
    expect(look('here')).toContain('Under you the map remembers: < staircase up.');
  });

  it('reports a missing symbol', () => {
    expect(look('D')).toMatch(/no "D" on the current map/);
  });
});

describe('status, screen, inventory, messages', () => {
  const t = tools();

  it('get_status covers vitals, hunger, conditions and what the game waits for', () => {
    const out = t.run('get_status', {});
    expect(out).toContain('Tester the Evoker: chaotic female elf Wizard.');
    expect(out).toContain('HP 7 of 12 (58%)');
    expect(out).toContain('Hunger: Hungry.');
    expect(out).toContain('Encumbrance: unencumbered.');
    expect(out).toContain('Conditions: Conf.');
    expect(out).toContain('Standing on: < staircase up.');
    expect(out).toContain('Waiting for: A command');
  });

  it('get_status shows yes/no prompts and menus with their letters', () => {
    const store = makeStore();
    store.apply(ev({ t: 'input', kind: 'yn', prompt: 'Really attack the kitten?', choices: 'yn', default: 'n', turn: 321 }));
    expect(tools({}, store).run('get_status', {})).toContain('An answer to the question "Really attack the kitten?" (choices: y, n; default n).');
    store.apply(ev({ t: 'menu', win: 5, how: 'one', prompt: 'What do you want to eat?', items: [{ text: 'a food ration', ch: 'd', selectable: true }, { text: 'Comestibles', selectable: false }] }));
    store.apply(ev({ t: 'input', kind: 'menu', turn: 321 }));
    const out = tools({}, store).run('get_status', {});
    expect(out).toContain('A menu to pick one item from titled "What do you want to eat?"');
    expect(out).toContain('  d - a food ration');
  });

  it('get_status shows text windows', () => {
    const store = makeStore();
    store.apply(ev({ t: 'text', win: 4, kind: 'text', lines: ['Voluntary challenges:', 'You have never hit with a wielded weapon.'] }));
    store.apply(ev({ t: 'input', kind: 'dismiss', turn: 321 }));
    expect(tools({}, store).run('get_status', {})).toContain('  You have never hit with a wielded weapon.');
  });

  it('get_screen has the screen text and a legend of every symbol', () => {
    const out = t.run('get_screen', {});
    expect(out).toContain('You feel somewhat dizzy.');
    expect(out).toContain('@ you (elven wizard called Tester), standing on < staircase up');
    expect(out).toContain('{ fountain: 2 squares northeast');
    expect(out).toMatch(/\n\. floor of a room\n|\n\. floor of a room$/);
    expect(out).toMatch(/\n- wall/);
  });

  it('get_inventory lists doname texts by class, unidentified items by appearance only', () => {
    const out = t.run('get_inventory', {});
    expect(out).toContain('Potions:\n  p - a murky potion');
    expect(out).toContain('Wielded: a. Worn: b.');
  });

  it('get_messages returns the last n messages with turns', () => {
    expect(t.run('get_messages', { n: 1 })).toBe('Last 1 game messages, oldest first:\nturn 321: You feel somewhat dizzy.');
  });

  it('get_discoveries is the \\ list', () => {
    const out = t.run('get_discoveries', {});
    expect(out).toContain('  potion called fizzy (murky)');
    expect(out).not.toContain('Discoveries, by order');
  });
});

describe('levels', () => {
  const t = tools();

  it('list_levels shows visited levels with features (including what was under the hero) and the overview', () => {
    const out = t.run('list_levels', {});
    expect(out).toMatch(/Dungeon level 1 \(Dlvl:1, depth 1\): (staircase up|.*chaotic altar).*staircase down/);
    expect(out).toContain('Dungeon level 2 (Dlvl:2, depth 2) <- you are here');
    expect(out).toContain('staircase up (under you)');
    expect(out).toContain('      An altar.');
  });

  it('get_level_map for another level speaks from the arrival staircases, not the hero', () => {
    const out = t.run('get_level_map', { level: '1' });
    expect(out).toContain('remembered map');
    // the hero is deeper (Dlvl 2): coming back up they arrive on level 1's down staircase, so that reference comes first
    expect(out).toContain(
      '_ chaotic altar: in the top-right part of the map; about 20 squares right and 6 up from the down staircase (where you arrive coming up); ' +
        'about 40 squares right and 10 up from the up staircase (where you arrive coming down)',
    );
    expect(out).toContain('Positions below are given from the staircases');
    // the down stairs the hero left from are remembered, not the hero
    expect(out).toContain('> staircase down: in the middle of the map; about 20 squares right and 5 up from the up staircase');
    expect(out).not.toContain('@');
  });

  it('get_level_map can still use the phase-3 region format', () => {
    const old = tools({ levelDirections: 'region' });
    const out = old.run('get_level_map', { level: '1' });
    expect(out).toContain('_ chaotic altar: in the north-east part of the map, 40 east and 11 north (40 right, 11 up) from the up staircase');
    expect(out).toContain('> staircase down: in the middle of the map');
  });

  it('get_level_map for the current level is hero-relative', () => {
    const out = t.run('get_level_map', { level: 'current' });
    expect(out).toContain('the level you are on');
    expect(out).toContain('< staircase up: under you');
    expect(out).toContain('> staircase down: 5 east and 2 south');
  });

  it('resolves branch names and reports unknown levels', () => {
    expect(t.run('get_level_map', { level: 'mines 3' })).toMatch(/No remembered level matches/);
    const v = t.view();
    expect(v.resolveLevel('dlvl 2').level?.key).toBe('0:2');
  });
});

describe('availability and live context', () => {
  it('says so when the game is not running', () => {
    const store = makeStore();
    store.session.state = 'exited';
    store.session.exitCode = 0;
    const t = tools({}, store, false);
    for (const name of ['get_status', 'get_screen', 'look', 'get_inventory']) {
      expect(t.run(name, { target: 'f' })).toMatch(/^The game is not running right now/);
    }
    expect(t.snapshot().text).toMatch(/not running/);
  });

  it('snapshot is compact and current', () => {
    const { text, turn } = tools().snapshot();
    expect(turn).toBe(321);
    expect(text.length).toBeLessThan(900);
    expect(text).toContain('HP 7/12');
    expect(text).toContain('Hungry');
    expect(text).toContain('conditions: Conf');
    expect(text).toContain('f tame kitten (a feline) (adjacent, 1 square east)');
    expect(text).toContain('"You feel somewhat dizzy."');
  });

  it('cellText adds the monster class from farlook only when it is informative', () => {
    expect(GameView.cellText(cell(1, 1, 'f', 'tame kitten', 'a feline (tame kitten)'))).toBe('f tame kitten (a feline)');
    expect(GameView.cellText(cell(1, 1, '!', 'a ruby potion', 'a potion (a ruby potion)'))).toBe('! a ruby potion');
    expect(GameView.cellText(cell(1, 1, '.', 'doorway', 'a doorway or the floor of a room (doorway)'))).toBe('. doorway');
  });
});

describe('identification hints (from the visible item name only)', () => {
  it('marks unidentified potion/scroll/ring/wand/amulet/spellbook types', async () => {
    const { identification } = await import('../../src/assistant/game/view.ts');
    const id = (text: string, class_sym: string) => identification({ text, class_sym });
    expect(id('a smoky potion', '!')).toMatch(/not identified/);
    expect(id('2 uncursed potions of healing', '!')).toBeNull();
    expect(id('a scroll labeled FOOBIE BLETCH', '?')).toMatch(/not identified/);
    expect(id('a potion called fizzy', '!')).toMatch(/your own name/);
    expect(id('a wand of striking (0:5)', '/')).toBeNull();
    expect(id('an amulet versus poison', '"')).toBeNull();
    expect(id('a +0 pair of buckled boots', '[')).toBeNull();
  });
  it('get_inventory shows the hint', () => {
    expect(tools().run('get_inventory', {})).toContain('p - a murky potion  [type not identified: only its appearance is known]');
  });
});

describe('objects piled under the hero', () => {
  function pileStore() {
    const store = makeStore();
    store.apply(ev({ t: 'text', win: 5, kind: 'menu_text', lines: ['Things that are here:', 'a lichen corpse', 'a scroll labeled VAS CORP BET MANI'] }));
    store.apply(ev({ t: 'input', kind: 'dismiss', turn: 321, ux: 10, uy: 10 }));
    return store;
  }

  it('lists every object the game showed, not just the top one', () => {
    const t = tools({}, pileStore());
    const here = t.run('look', { target: 'here' });
    expect(here).toContain('a lichen corpse; a scroll labeled VAS CORP BET MANI');
    expect(t.run('get_status', {})).toContain('Objects here (as the game last listed them): a lichen corpse; a scroll labeled VAS CORP BET MANI.');
  });

  it('puts an open text window into the live snapshot', () => {
    const snap = tools({}, pileStore()).snapshot().text;
    expect(snap).toContain('Text window contents:');
    expect(snap).toContain('a scroll labeled VAS CORP BET MANI');
  });

  it('forgets the listing after picking something up or moving away', () => {
    const picked = pileStore();
    picked.apply(ev({ t: 'inventory', items: [] }));
    expect(tools({}, picked).run('look', { target: 'here' })).not.toContain('VAS CORP');
    const moved = pileStore();
    moved.apply(ev({ t: 'input', kind: 'command', turn: 322, ux: 11, uy: 10 }));
    expect(tools({}, moved).run('look', { target: 'here' })).not.toContain('VAS CORP');
  });
});

describe('message conventions', () => {
  it('spells out inventory and floor messages', () => {
    expect(explainMessage('f - 8 rocks.')).toBe('f - 8 rocks. [now in your inventory as item f]');
    expect(explainMessage('$ - 2 gold pieces (3 in total).')).toContain('[now in your inventory as item $]');
    expect(explainMessage('You see here 8 rocks.')).toContain('[on the floor where you stood then]');
    expect(explainMessage('The jackal bites!')).toBe('The jackal bites!');
  });

  it('look here does not resurrect old floor messages after picking up and moving on', () => {
    const store = makeStore();
    store.apply(ev({ t: 'msg', text: 'You see here 8 rocks.', turn: 322 }));
    store.apply(ev({ t: 'msg', text: 'f - 8 rocks.', turn: 323 }));
    store.apply(ev({ t: 'inventory', items: [] }));
    store.apply(ev({ t: 'input', kind: 'command', turn: 330, ux: 11, uy: 10 }));
    const here = tools({}, store).run('look', { target: 'here' });
    expect(here).not.toContain('rocks');
    expect(tools({}, store).run('get_messages', { n: 2 })).toContain('f - 8 rocks. [now in your inventory as item f]');
  });
});
