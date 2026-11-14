import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRepository } from '../../src/game/memory.ts';
import { encodeInput } from '../../src/game/session.ts';
import { TerminalMirror } from '../../src/game/terminal.ts';
import type { PersistedMemory } from '../../../shared/feed-events.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-mem-'));
  dirs.push(d);
  return d;
};
const mem = (name: string, birthday: number, turn = 1): PersistedMemory => ({
  format: 1,
  game: { id: `${name}-${birthday}`, origin: 'new', name, birthday, uuid: 'x', role: 'Valkyrie', race: 'human', gender: 'female', alignment: 'neutral', mode: 'normal' },
  savedAt: new Date(0).toISOString(),
  turn,
  currentLevel: '0:1',
  levels: [{ key: '0:1', info: null, cells: [], lastSeenTurn: turn }],
  messages: [],
});

describe('MemoryRepository', () => {
  it('saves atomically and loads by game id', () => {
    const dir = path.join(tmp(), 'nested');
    const repo = new MemoryRepository(dir);
    expect(repo.load('Kara-1')).toBeNull();
    repo.save(mem('Kara', 1, 5));
    repo.save(mem('Kara', 1, 9));
    expect(repo.load('Kara-1')?.turn).toBe(9);
    // no temporary files left behind
    expect(fs.readdirSync(dir)).toEqual(['Kara-1.json']);
  });

  it('ignores corrupt or foreign files', () => {
    const dir = tmp();
    const repo = new MemoryRepository(dir);
    fs.writeFileSync(path.join(dir, 'Kara-1.json'), '{"format":1,"game":');
    expect(repo.load('Kara-1')).toBeNull();
    fs.writeFileSync(path.join(dir, 'Kara-2.json'), JSON.stringify(mem('Kara', 3)));
    expect(repo.load('Kara-2')).toBeNull(); // id inside doesn't match
    expect(() => repo.load('../etc/passwd')).toThrow();
  });

  it('prunes older games of the same character only', () => {
    const repo = new MemoryRepository(tmp());
    repo.save(mem('Kara', 1));
    repo.save(mem('Kara', 2));
    repo.save(mem('Kara_x', 3));
    repo.save(mem('Bob', 4));
    expect(repo.pruneOthers('Kara-2').sort()).toEqual(['Kara-1']);
    expect(repo.list().sort()).toEqual(['Bob-4', 'Kara-2', 'Kara_x-3']);
  });
});

describe('encodeInput', () => {
  it('passes ASCII, drops ^Z and non-ASCII, sets the 8th bit for meta', () => {
    expect([...encodeInput('ab\x1b\r')]).toEqual([0x61, 0x62, 0x1b, 0x0d]);
    expect([...encodeInput('a\x1aé€b')]).toEqual([0x61, 0x62]);
    expect([...encodeInput('d', true)]).toEqual([0xe4]); // M-d = #dip
    expect([...encodeInput('?', true)]).toEqual([0xbf]);
  });
});

describe('TerminalMirror.moreAtCursor', () => {
  const write = (m: TerminalMirror, s: string) => new Promise<void>((r) => m.write(s, r));
  it('detects --More-- left of the cursor', async () => {
    const m = new TerminalMirror(80, 24);
    await write(m, 'You hit the newt.  The newt is killed!--More--');
    expect(m.moreAtCursor()).toBe('You hit the newt.  The newt is killed!');
    // cursor moved away (message dismissed, map drawn): no longer waiting
    await write(m, '\x1b[1;1H\x1b[K\x1b[5;10H@');
    expect(m.moreAtCursor()).toBeNull();
    // --More-- somewhere else on screen but not at the cursor
    await write(m, '\x1b[1;1HOld text --More--\x1b[10;1H');
    expect(m.moreAtCursor()).toBeNull();
    m.dispose();
  });
});
