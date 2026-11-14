import type { ITheme } from '@xterm/xterm';

/**
 * Light theme.  NetHack's tty port uses the 16 ANSI colors (setaf 0-15) and
 * the terminal default foreground for "gray" (CLR_GRAY / NO_COLOR).  Every
 * slot is remapped so it stays legible on a white background:
 *
 *   NetHack color      ANSI slot        here
 *   black              0 black          mid gray (dark room floor, black monsters)
 *   gray (default)     foreground       near black
 *   white              15 brightWhite   pure black (brighter than gray -> darker)
 *   brown              3 yellow         dark brown
 *   yellow             11 brightYellow  dark gold
 *   orange             9 brightRed      burnt orange
 *   bright *           9-14             saturated, darker than usual
 */
export const lightTheme: ITheme = {
  background: '#fdfdfb',
  foreground: '#2b2b2b',
  cursor: '#1a1a1a',
  cursorAccent: '#fdfdfb',
  selectionBackground: '#b8d4ff',
  selectionForeground: '#000000',

  black: '#7a7a7a',
  red: '#b3261e',
  green: '#2f6b12',
  yellow: '#7d4e12',
  blue: '#1d4ed8',
  magenta: '#8e2a8e',
  cyan: '#0b7285',
  white: '#4a4a4a',

  brightBlack: '#5f5f5f',
  brightRed: '#d1520b',
  brightGreen: '#1f9433',
  brightYellow: '#9a7400',
  brightBlue: '#3b6cf0',
  brightMagenta: '#b8329e',
  brightCyan: '#0a8399',
  brightWhite: '#000000',
};

export const fontFamily =
  '"DejaVu Sans Mono", "Menlo", "Consolas", "Liberation Mono", "Noto Sans Mono", monospace';
