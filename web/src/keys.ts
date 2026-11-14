import type { InputKind } from '../../shared/feed-events.ts';

export interface KeyLike {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** vi-keys directions (number_pad:0, the default in nethack/nethackrc) */
const DIRS: Record<string, string> = {
  ArrowLeft: 'h',
  ArrowDown: 'j',
  ArrowUp: 'k',
  ArrowRight: 'l',
  Home: 'y',
  PageUp: 'u',
  End: 'b',
  PageDown: 'n',
  Clear: 's', // numpad 5 with NumLock off
};

const NUMPAD_DIGITS: Record<string, string> = {
  Numpad1: 'b',
  Numpad2: 'j',
  Numpad3: 'n',
  Numpad4: 'h',
  Numpad5: 's', // search / wait in place
  Numpad6: 'l',
  Numpad7: 'y',
  Numpad8: 'k',
  Numpad9: 'u',
};

/** prompts where the player is typing text: digits are digits, arrows mean nothing */
const TEXT_ENTRY: ReadonlySet<InputKind> = new Set<InputKind>(['getlin', 'askname', 'extcmd']);

/**
 * Translate a browser keydown into what NetHack (tty, vi-keys) expects.
 *  - returns a string: send it and swallow the event
 *  - returns '' : swallow the event, send nothing
 *  - returns null: let xterm.js do its normal encoding (letters, Ctrl-keys, Esc, Enter, …)
 */
export function translateKey(ev: KeyLike, awaiting: InputKind | null): string | null {
  if (ev.metaKey) return null;
  const text = awaiting !== null && TEXT_ENTRY.has(awaiting);
  const menu = awaiting === 'menu' || awaiting === 'dismiss' || awaiting === 'more';

  // numpad digits (NumLock on)
  // (key is a digit with NumLock on; some synthetic/remote input sends '')
  const numpadDigit = /^[0-9]$/.test(ev.key) || ev.key === '' || ev.key === 'Unidentified';
  if (ev.code in NUMPAD_DIGITS && numpadDigit) {
    if (text || ev.ctrlKey || ev.altKey) return null;
    const d = NUMPAD_DIGITS[ev.code];
    return ev.shiftKey ? d.toUpperCase() : d;
  }
  if (ev.code === 'Numpad0' && numpadDigit) return text ? null : 'i';
  if (ev.code === 'NumpadEnter') return '\r';

  // arrows / navigation keys (including numpad with NumLock off)
  if (ev.key in DIRS) {
    if (ev.ctrlKey || ev.altKey) return '';
    if (text) return '';
    if (menu) {
      // tty menus page with '>' and '<'
      if (ev.key === 'PageDown' || ev.key === 'ArrowDown' || ev.key === 'ArrowRight') return '>';
      if (ev.key === 'PageUp' || ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') return '<';
      if (ev.key === 'Home') return '^';
      if (ev.key === 'End') return '|';
      return '';
    }
    const d = DIRS[ev.key];
    // Shift+direction = run (capital letter)
    return ev.shiftKey ? d.toUpperCase() : d;
  }
  if (ev.key === 'Delete' || ev.key === 'Insert') return '';
  // function keys reach tty NetHack as escape sequences (F2 = ESC O Q) that
  // it would misread as Esc + commands; F2-F4 belong to the assistant
  if (/^F\d{1,2}$/.test(ev.key)) return '';
  return null;
}

/** base character of a physical key, independent of layout tricks like
 *  macOS Option producing 'å' for Option+A */
function baseChar(ev: KeyLike): string | null {
  let m = /^Key([A-Z])$/.exec(ev.code);
  if (m) return ev.shiftKey ? m[1] : m[1].toLowerCase();
  m = /^Digit([0-9])$/.exec(ev.code);
  if (m && !ev.shiftKey) return m[1];
  if (ev.key.length === 1 && ev.key >= ' ' && ev.key <= '~') return ev.key;
  return null;
}

/**
 * Alt/Option+key as a NetHack Meta key (M-d = #dip, M-C = #conduct, ...).
 * Returns the base character to send with the 8th bit set (the server does
 * that for `{ type: 'input', meta: true }`; nethackrc keeps `altmeta` off,
 * so tty expects 8-bit Meta rather than an ESC prefix), '' to swallow the
 * key (Alt+key while typing text), or null if this isn't a Meta key.
 */
export function translateMeta(ev: KeyLike, awaiting: InputKind | null): string | null {
  // Ctrl+Alt is AltGr on many layouts (typing @, {, ...): leave it alone
  if (!ev.altKey || ev.ctrlKey || ev.metaKey) return null;
  if (/^(Alt|AltGraph|Shift|Control|Meta)$/.test(ev.key)) return null;
  const ch = baseChar(ev);
  if (ch === null) return null;
  if (awaiting !== null && TEXT_ENTRY.has(awaiting)) return '';
  return ch;
}

/** Ctrl+letter combos browsers keep for themselves (close tab, new tab,
 *  new window) unless the page holds a Keyboard Lock in fullscreen. */
export const BROWSER_RESERVED_CTRL = ['W', 'T', 'N'] as const;
