/**
 * The feed must not change the game.  Plays the same scripted game twice
 * with a fixed RNG seed and clock (see replay/harness.ts): once with the
 * "+feed" processor connected and describing every map cell, once with it
 * inert, and requires identical screens after every keystroke.
 *
 * Seed 10 walks the hero next to a potion and other objects in the first
 * room; the pre-sandbox feed (farlook evaluated in-process) diverged there
 * at step 4 (object_from_map() -> mksobj() -> next_ident() -> rnd() moved
 * the core RNG, so the pet and a newt ended up elsewhere).  Point
 * FEED_REPLAY_BIN at such a binary to see this test fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HACKDIR, explorationScript, replay } from './replay/harness.ts';
import type { MapEvent } from '../../../shared/feed-events.ts';

const bin = process.env.FEED_REPLAY_BIN || path.join(HACKDIR, 'nethack');
const SEEDS = (process.env.FEED_REPLAY_SEEDS ?? '10').split(',').map(Number);

describe('feed has no effect on the game (deterministic replay)', { timeout: 240000 }, () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: identical play with the feed on and off`, async () => {
      expect(fs.existsSync(bin), 'run nethack/build.sh first').toBe(true);
      const keys = explorationScript(3);
      const [off, on] = await Promise.all([
        replay({ feed: false, seed, keys, bin }),
        replay({ feed: true, seed, keys, bin }),
      ]);
      expect(off.screens.length).toBe(keys.length + 1);
      for (let i = 0; i < off.screens.length; i++) {
        expect(on.screens[i], `screen after step ${i} (${JSON.stringify(keys[i - 1])})`).toBe(off.screens[i]);
      }
      // the feed really was busy describing things
      const cells = on.events.filter((e): e is MapEvent => e.t === 'map').flatMap((e) => e.cells);
      expect(cells.length).toBeGreaterThan(100);
      expect(cells.filter((c) => c.ch === '!' && /potion/.test(c.desc)).length).toBeGreaterThan(0);
      expect(off.events).toHaveLength(0);

    });
  }
});
