/**
 * Find a fixed seed whose first level suits the assistant scenario: a Wizard
 * (kitten pet, unidentified potions) starting in a room that shows a
 * fountain and the down staircase.
 *   node scripts/assistant-e2e/find-seed.ts [from] [to]
 */
import { SCENARIO_RC, makePlayground, startServer, stopServer } from './playground.ts';
import { GameDriver } from './game.ts';
import fs from 'node:fs';


const from = Number(process.argv[2] ?? 1);
const to = Number(process.argv[3] ?? 40);
const port = Number(process.argv[4] ?? 8797);
for (let seed = from; seed <= to; seed++) {
  const pg = makePlayground({ seed, rc: SCENARIO_RC });
  const srv = await startServer(pg, port, 'seedtest');
  try {
    const g = await GameDriver.connect(srv.base);
    await g.toCommand();
    const { st, cells, hero } = await g.cells();
    const has = (re: RegExp) => cells.filter((c) => re.test(c.desc));
    const fountain = has(/^fountain$/);
    const down = has(/^staircase down$/);
    const kitten = cells.find((c) => /kitten/.test(c.desc));
    const floorPotions = cells.filter((c) => c.ch === '!').map((c) => c.desc);
    const potions = st.inventory.filter((i) => i.class_sym === '!').map((i) => i.text);
    console.log(JSON.stringify({ seed, floorPotions, fountain: fountain.length, down: down.length, kittenAdjacent: !!kitten && Math.max(Math.abs(kitten.x - hero.x), Math.abs(kitten.y - hero.y)) === 1, potions: potions.length }));
    g.close();
  } finally {
    await stopServer(srv.proc);
    fs.rmSync(pg.dir, { recursive: true, force: true });
  }
}
