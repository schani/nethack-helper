import { describe, expect, it } from 'vitest';
import { translateKey, type KeyLike } from '../src/keys.ts';

const k = (key: string, code = key, mods: Partial<KeyLike> = {}): KeyLike => ({
  key, code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods,
});

describe('translateKey', () => {
  it('maps arrows and nav keys to vi-keys, shift to run', () => {
    expect(translateKey(k('ArrowLeft'), 'command')).toBe('h');
    expect(translateKey(k('ArrowDown'), 'command')).toBe('j');
    expect(translateKey(k('ArrowUp'), 'command')).toBe('k');
    expect(translateKey(k('ArrowRight'), 'command')).toBe('l');
    expect(translateKey(k('Home'), 'command')).toBe('y');
    expect(translateKey(k('PageDown'), 'key')).toBe('n');
    expect(translateKey(k('ArrowRight', 'ArrowRight', { shiftKey: true }), 'command')).toBe('L');
  });

  it('maps numpad digits to directions outside text prompts', () => {
    expect(translateKey(k('7', 'Numpad7'), 'command')).toBe('y');
    expect(translateKey(k('5', 'Numpad5'), 'command')).toBe('s');
    expect(translateKey(k('3', 'Numpad3'), null)).toBe('n');
    expect(translateKey(k('0', 'Numpad0'), 'command')).toBe('i');
    expect(translateKey(k('Enter', 'NumpadEnter'), 'command')).toBe('\r');
    // NumLock off: numpad sends navigation keys
    expect(translateKey(k('End', 'Numpad1'), 'command')).toBe('b');
    expect(translateKey(k('Clear', 'Numpad5'), 'command')).toBe('s');
  });

  it('leaves digits alone and swallows arrows while typing text', () => {
    expect(translateKey(k('4', 'Numpad4'), 'getlin')).toBeNull();
    expect(translateKey(k('ArrowLeft'), 'getlin')).toBe('');
    expect(translateKey(k('ArrowLeft'), 'extcmd')).toBe('');
  });

  it('pages menus with arrows', () => {
    expect(translateKey(k('ArrowDown'), 'menu')).toBe('>');
    expect(translateKey(k('PageUp'), 'menu')).toBe('<');
  });

  it('lets xterm handle letters, Esc, Enter and Ctrl-keys', () => {
    expect(translateKey(k('Escape'), 'command')).toBeNull();
    expect(translateKey(k('Enter'), 'command')).toBeNull();
    expect(translateKey(k('d', 'KeyD', { ctrlKey: true }), 'command')).toBeNull();
    expect(translateKey(k('4', 'Digit4'), 'command')).toBeNull();
    expect(translateKey(k('i', 'KeyI'), 'command')).toBeNull();
  });
});
