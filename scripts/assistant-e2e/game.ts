/** Drives a game on a test server over its websocket (keys) and HTTP API (state). */
import { GameClient, sleep, waitFor } from '../../server/test/smoke/client.ts';
import type { GameState, MapCell } from '../../shared/feed-events.ts';

export class GameDriver {
  readonly base: string;
  readonly client: GameClient;

  private constructor(base: string) {
    this.base = base;
    this.client = new GameClient(`${base.replace('http', 'ws')}/ws`);
  }

  static async connect(base: string): Promise<GameDriver> {
    const d = new GameDriver(base);
    await d.client.ready();
    await waitFor(() => d.client.snapshots > 0, 'snapshot');
    return d;
  }

  async state(): Promise<GameState> {
    return (await fetch(`${this.base}/api/state`)).json() as Promise<GameState>;
  }

  async screen(): Promise<string> {
    return (await fetch(`${this.base}/api/screen`)).text();
  }

  send(keys: string) {
    this.client.send(keys);
  }

  /** answer intro screens / --More-- until the game waits for a command */
  async toCommand(timeoutMs = 30000) {
    await waitFor(
      async () => {
        const scr = await this.screen();
        const st = await this.state();
        if (st.awaiting?.kind === 'command' && st.status && !/--More--/.test(scr)) return true;
        if (/Shall I pick|Is this ok\?/.test(scr)) this.send('y');
        else if (/--More--|\(end\)/.test(scr)) this.send('\r');
        else if (st.awaiting && st.awaiting.kind !== 'command') this.send('\x1b');
        await sleep(250);
        return false;
      },
      'command prompt',
      timeoutMs,
      150,
    );
  }

  /** send keys one by one, returning to the command prompt after each */
  async keys(seq: string[]) {
    for (const k of seq) {
      this.send(k);
      await sleep(150);
      await this.toCommand();
    }
  }

  async cells(): Promise<{ st: GameState; cells: MapCell[]; hero: { x: number; y: number } }> {
    const st = await this.state();
    return { st, cells: st.levels[st.currentLevel!]?.cells ?? [], hero: st.hero! };
  }

  /** walk (vi-keys, one step at a time) until the hero stands on (x, y); gives up after `max` steps */
  async walkTo(x: number, y: number, max = 60) {
    for (let i = 0; i < max; i++) {
      const { hero } = await this.cells();
      const dx = Math.sign(x - hero.x);
      const dy = Math.sign(y - hero.y);
      if (!dx && !dy) return;
      const key = ({ '-1,-1': 'y', '0,-1': 'k', '1,-1': 'u', '-1,0': 'h', '1,0': 'l', '-1,1': 'b', '0,1': 'j', '1,1': 'n' } as Record<string, string>)[`${dx},${dy}`];
      await this.keys([key]);
    }
    throw new Error(`could not walk to ${x},${y}`);
  }

  /**
   * Travel (the `_` command) to the first remembered cell whose description
   * matches `re`, fighting hostile monsters that block the way.
   */
  async travelTo(re: RegExp | { x: number; y: number }, maxRounds = 120) {
    const DIRKEY: Record<string, string> = { '-1,-1': 'y', '0,-1': 'k', '1,-1': 'u', '-1,0': 'h', '1,0': 'l', '-1,1': 'b', '0,1': 'j', '1,1': 'n' };
    let last = '';
    let target: { x: number; y: number } | undefined = re instanceof RegExp ? undefined : re;
    const want = re instanceof RegExp ? re : /$^/;
    for (let round = 0; round < maxRounds; round++) {
      await this.toCommand();
      const { st, cells, hero } = await this.cells();
      const stuck = last === `${hero.x},${hero.y}`;
      last = `${hero.x},${hero.y}`;
      target ??= cells.find((c) => want.test(c.desc)) ?? (st.underfoot && want.test(st.underfoot.desc) ? st.underfoot : undefined);
      if (!target) throw new Error(`nothing matching ${re} on the map`);
      if (target.x === hero.x && target.y === hero.y) return;
      const tgt = target;
      const hostile = cells.find(
        (c) => /^[A-Za-z]$/.test(c.ch) && !/tame|peaceful/.test(c.desc) && Math.max(Math.abs(c.x - hero.x), Math.abs(c.y - hero.y)) === 1,
      );
      if (hostile) {
        this.send('F' + DIRKEY[`${hostile.x - hero.x},${hostile.y - hero.y}`]);
        await sleep(300);
        continue;
      }
      // boulders block travel: push one that lies toward the target; if something is behind it, wait
      const boulder =
        stuck &&
        cells.find(
          (c) => c.desc === 'boulder' && Math.abs(c.x - hero.x) + Math.abs(c.y - hero.y) === 1 && Math.sign(tgt.x - hero.x) === c.x - hero.x && (c.y === hero.y || Math.sign(tgt.y - hero.y) === c.y - hero.y),
        );
      if (boulder) {
        const blocked = /cannot move it|in vain|won't fit|there's no room/i.test(st.messages.slice(-3).map((m) => m.text).join(' '));
        this.send(blocked ? 's' : DIRKEY[`${boulder.x - hero.x},${boulder.y - hero.y}`]);
        await sleep(300);
        continue;
      }
      // travel stops in front of closed doors: open (or, if locked, kick) the adjacent one
      const door = stuck && cells.find((c) => c.desc === 'closed door' && Math.abs(c.x - hero.x) + Math.abs(c.y - hero.y) === 1);
      if (door) {
        const locked = /locked/.test(st.messages.at(-1)?.text ?? '');
        this.send((locked ? '\x04' : 'o') + DIRKEY[`${door.x - hero.x},${door.y - hero.y}`]);
        await sleep(300);
        continue;
      }
      this.send('_');
      await waitFor(async () => {
        const scr = await this.screen();
        if (/--More--/.test(scr.split('\n')[0])) this.send('\r');
        return /Where do you want to travel/.test(scr) && !/--More--/.test(scr.split('\n')[0]);
      }, 'travel prompt', 5000, 150);
      await sleep(150);
      const scr = (await (await fetch(`${this.base}/api/screen?format=json`)).json()) as { cursor: { x: number; y: number } };
      let dx = target.x - (scr.cursor.x + 1);
      let dy = target.y - (scr.cursor.y - 1);
      let keys = '';
      while (Math.abs(dx) >= 8) (keys += dx > 0 ? 'L' : 'H'), (dx -= 8 * Math.sign(dx));
      while (Math.abs(dy) >= 8) (keys += dy > 0 ? 'J' : 'K'), (dy -= 8 * Math.sign(dy));
      while (dx) (keys += dx > 0 ? 'l' : 'h'), (dx -= Math.sign(dx));
      while (dy) (keys += dy > 0 ? 'j' : 'k'), (dy -= Math.sign(dy));
      this.send(keys + '.');
      await sleep(600);
    }
    throw new Error(`could not travel to ${re instanceof RegExp ? re : JSON.stringify(re)}`);
  }

  /** pick up the object on the hero's square whose name matches `re` (handles the pick-up menu) */
  async pickUp(re: RegExp) {
    this.send(',');
    await sleep(500);
    const st = await this.state();
    if (st.awaiting?.kind === 'menu' && st.menu) {
      const item = st.menu.items.find((i) => i.selectable && i.ch && re.test(i.text));
      if (!item) throw new Error(`nothing matching ${re} to pick up: ${st.menu.items.map((i) => i.text).join('; ')}`);
      this.send(item.ch!);
      await sleep(200);
      this.send('\r');
      await sleep(500);
    }
    await this.toCommand();
  }

  close() {
    this.client.close();
  }
}

export { sleep, waitFor };
