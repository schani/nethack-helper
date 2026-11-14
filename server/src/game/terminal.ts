import { createRequire } from 'node:module';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { SerializeAddon as SerializeAddonT } from '@xterm/addon-serialize';

// both packages are CommonJS bundles
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');

/**
 * Authoritative server-side copy of the game screen.  All pty output is
 * written here first; `onParsed` callbacks fire in write order, which lets
 * the session hand out snapshots that are exactly consistent with the
 * live byte stream that follows them.
 */
export class TerminalMirror {
  private term: HeadlessTerminal;
  private serializer: SerializeAddonT;

  readonly cols: number;
  readonly rows: number;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer as never);
  }

  /** Feed bytes; `parsed` runs once they are reflected in the buffer. */
  write(data: string, parsed?: () => void) {
    this.term.write(data, parsed);
  }

  /** Run `fn` after everything written so far has been parsed. */
  barrier(fn: () => void) {
    this.term.write('', fn);
  }

  /** Escape-sequence snapshot (colors, cursor, modes) for xterm.js clients. */
  serialize(): string {
    return this.serializer.serialize();
  }

  /** Plain text of the visible screen, one line per row. */
  text(): string[] {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
    }
    return lines;
  }

  cursor(): { x: number; y: number } {
    const buf = this.term.buffer.active;
    return { x: buf.cursorX, y: buf.cursorY };
  }

  reset() {
    this.term.reset();
  }

  dispose() {
    this.term.dispose();
  }
}
