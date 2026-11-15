/**
 * Frozen game states (evals/fixtures/<id>.json, captured by
 * evals/fixtures/capture.ts) and a GameSource that serves one to the
 * production game tools / snapshot builder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameSource } from '../../server/src/assistant/game/tools.ts';
import type { GameState } from '../../shared/feed-events.ts';

export const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

export interface Fixture {
  id: string;
  description: string;
  recipe: { seed: number; role: string; wizard: boolean };
  /** is a nethack process running? */
  running: boolean;
  /** GET /api/state (all remembered levels) */
  state: GameState;
  /** GET /api/screen?format=json */
  screen: { lines: string[]; cursor?: { x: number; y: number }; cols?: number; rows?: number };
  /** ground-truth facts for graders / the judge */
  notes: string[];
}

const cache = new Map<string, Fixture>();

export function loadFixture(id: string): Fixture {
  let fx = cache.get(id);
  if (!fx) {
    const file = path.join(FIXTURE_DIR, `${id}.json`);
    if (!fs.existsSync(file)) throw new Error(`fixture '${id}' not found (${file}); capture it with evals/fixtures/capture.ts`);
    fx = JSON.parse(fs.readFileSync(file, 'utf8')) as Fixture;
    cache.set(id, fx);
  }
  return fx;
}

export function listFixtures(): string[] {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
}

/** Serves a frozen fixture exactly like GameSession serves the live game (deep copies: tools must not mutate it). */
export class FixtureGameSource implements GameSource {
  private fx: Fixture;
  /** fault injection for robustness cases */
  failWith?: string;

  constructor(fx: Fixture) {
    this.fx = fx;
  }

  get running() {
    return this.fx.running;
  }

  state(): GameState {
    if (this.failWith) throw new Error(this.failWith);
    return structuredClone(this.fx.state);
  }

  screen() {
    return { lines: [...this.fx.screen.lines] };
  }
}
