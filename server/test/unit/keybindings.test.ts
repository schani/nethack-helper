/**
 * get_keybindings: key labels, intent search and summaries over key binding
 * tables captured from the real game (feed 'keybindings' events):
 *   keybindings-vikeys.json   production nethackrc (number_pad:0)
 *   keybindings-numpad.json   number_pad:1 plus BIND=^K:kick and BIND=v:pray
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KeyBindingsView, keyLabel, webNote, type KeyBindings } from '../../src/assistant/game/keybindings.ts';
import { GameStateStore } from '../../src/feed/state.ts';
import { GameTools } from '../../src/assistant/game/tools.ts';
import type { FeedEvent } from '../../../shared/feed-events.ts';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as KeyBindings;
const vi = load('keybindings-vikeys.json');
const np = load('keybindings-numpad.json');

describe('keyLabel / webNote', () => {
  it('renders control, meta and punctuation keys readably', () => {
    expect(keyLabel(4)).toBe('Ctrl+D');
    expect(keyLabel(0x80 | 'p'.charCodeAt(0))).toBe('Alt+p');
    expect(keyLabel(0x80 | 'C'.charCodeAt(0))).toBe('Alt+C');
    expect(keyLabel(','.charCodeAt(0))).toBe(', (comma)');
    expect(keyLabel('k'.charCodeAt(0))).toBe('k');
    expect(keyLabel(0x0a)).toBe('Ctrl+J');
    expect(keyLabel(0x1f)).toBe('Ctrl+_');
    expect(keyLabel(0x7f)).toBe('Backspace');
    expect(keyLabel(0x20)).toBe('Space');
  });

  it('explains keys that need help in the browser client', () => {
    expect(webNote(4)).toBeNull(); // Ctrl+D reaches the game
    expect(webNote(0x14)).toMatch(/\^T button.*Fullscreen/);
    expect(webNote(0x80 | 'p'.charCodeAt(0))).toMatch(/hold Alt.*press p/);
    expect(webNote(0x80 | 'A'.charCodeAt(0))).toMatch(/Alt\+Shift\+a/);
  });
});

describe('KeyBindingsView.search (number_pad off, production)', () => {
  const v = new KeyBindingsView(vi);
  const first = (q: string) => v.search(q).split('\n')[1] ?? '';

  it('finds the actual key, not a guessed one', () => {
    expect(first('How do I kick?')).toMatch(/kick something: Ctrl\+D; or type #kick/);
    expect(v.search('kick')).not.toMatch(/: k\b/);
    expect(first('How do I pray?')).toMatch(/Alt\+p; or type #pray/);
    expect(first('What key picks things up?')).toMatch(/, \(comma\); or type #pickup/);
    expect(first('How do I see my discoveries?')).toMatch(/\\ \(backslash\); or type #known/);
    expect(first('#enhance')).toMatch(/Alt\+e; or type #enhance/);
  });

  it('looking far away: ; (and /), then the position picker keys', () => {
    const r = v.search('How do I look at something far away?');
    expect(r.split('\n')[1]).toMatch(/; \(semicolon\)/);
    expect(r).toMatch(/press \. \(period\) or , \(comma\) to select/);
    expect(r).not.toMatch(/look at what is here/);
  });

  it('movement uses the current direction keys', () => {
    const r = v.search('how do I move diagonally');
    expect(r).toMatch(/y northwest, k north, u northeast/);
    expect(r).toMatch(/Run in a direction until you run into something: H Y K U L N J B/);
    expect(r).toMatch(/Ctrl\+N/); // rush southeast ...
    expect(r).toMatch(/browser keeps Ctrl\+N/); // ... which the browser keeps
  });

  it('adds browser notes only when needed', () => {
    expect(v.search('kick')).not.toMatch(/Browser client/);
    expect(v.search('teleport')).toMatch(/\^T button/);
    expect(v.search('pray')).toMatch(/hold Alt/);
  });

  it('says so when nothing matches', () => {
    expect(v.search('xyzzy plugh')).toMatch(/No command matches/);
  });

  it('summary lists every group compactly', () => {
    const s = v.summary();
    expect(s).toMatch(/kick Ctrl\+D/);
    expect(s).toMatch(/pray Alt\+p/);
    expect(s).toMatch(/No key, only as #name then Enter: .*#quit/);
    expect(s.length).toBeLessThan(5000);
  });
});

describe('KeyBindingsView with number_pad and BIND lines', () => {
  const v = new KeyBindingsView(np);
  it('honors number_pad', () => {
    expect(v.search('move')).toMatch(/number_pad is on.*4 west, 7 northwest, 8 north/);
    expect(v.search('move')).toMatch(/Count prefix: n/);
    expect(v.search('kick').split('\n')[1]).toMatch(/kick something: k or Ctrl\+K or Ctrl\+D/);
  });
  it('honors BIND lines', () => {
    expect(v.search('pray').split('\n')[1]).toMatch(/: v or Alt\+p/);
  });
});

describe('get_keybindings tool', () => {
  it('reads the feed event through the state store', () => {
    const store = new GameStateStore('T');
    store.session.state = 'running';
    store.setFeedConnected(true);
    store.apply({ t: 'keybindings', seq: 1, ...vi } as FeedEvent);
    const tools = new GameTools({ running: true, state: (o) => store.snapshot(o), screen: () => ({ lines: [] }) });
    expect(tools.run('get_keybindings', { query: 'kick' })).toMatch(/Ctrl\+D/);
    expect(tools.run('get_keybindings', {})).toMatch(/^Key bindings of this game right now/);
    // the throttled websocket state leaves the table out
    expect(store.snapshot({ allLevels: false, keybindings: false })).not.toHaveProperty('keybindings');
    store.resetForNewProcess();
    expect(tools.run('get_keybindings', { query: 'kick' })).toMatch(/not available yet|starting up/);
  });
});
