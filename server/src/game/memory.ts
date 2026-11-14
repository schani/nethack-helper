import fs from 'node:fs';
import path from 'node:path';
import type { PersistedMemory } from '../../../shared/feed-events.ts';

/**
 * On-disk store of per-game memory (remembered levels, message log), one
 * JSON file per game id ("<name>-<birthday>").  Writes are atomic: the
 * data goes to a temporary file in the same directory, is fsynced and then
 * renamed over the old file, so a crash leaves either the old or the new
 * version, never a torn one.
 */
export class MemoryRepository {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`bad game id ${JSON.stringify(id)}`);
    return path.join(this.dir, `${id}.json`);
  }

  load(id: string): PersistedMemory | null {
    const file = this.file(id);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    try {
      const mem = JSON.parse(raw) as PersistedMemory;
      if (mem?.format !== 1 || mem.game?.id !== id || !Array.isArray(mem.levels) || !Array.isArray(mem.messages)) return null;
      return mem;
    } catch {
      return null;
    }
  }

  save(mem: PersistedMemory): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.file(mem.game.id);
    const tmp = `${target}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(mem));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  }

  /** ids of the games stored for a character name */
  list(namePrefix?: string): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .filter((id) => !namePrefix || id.startsWith(`${namePrefix}-`));
  }

  /** NetHack keeps one game per character name: once a new game starts,
   *  the memory of older games under that name is useless. */
  pruneOthers(keepId: string): string[] {
    const prefix = keepId.slice(0, keepId.lastIndexOf('-'));
    const removed: string[] = [];
    for (const id of this.list(prefix)) {
      if (id === keepId || id.slice(0, id.lastIndexOf('-')) !== prefix) continue;
      fs.rmSync(this.file(id), { force: true });
      removed.push(id);
    }
    return removed;
  }
}
