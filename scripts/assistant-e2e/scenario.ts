/**
 * Assistant e2e scenario on a live, reproducible game (own server on the
 * smoke port 8797, fixed seeds -- see playground.ts / find-seed.ts):
 *
 *  A (seed 33, elven Wizard with kitten): HP/hunger, the f next to me, inventory;
 *    kill the goblin, step next to the fountain, ask about it; read the magic
 *    mapping scroll, travel to > and descend; ask what was on level 1.
 *  B (seed 149): pick up the smoky potion; ask what it is (must not claim to know;
 *    offers identification help with a spoiler warning).
 *
 *   node scripts/assistant-e2e/scenario.ts [--model m] [--phase A|B] [--json out.json] [--screenshot dir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { AssistantBrowser, printTurn, type TurnResult } from './browser.ts';
import { GameDriver, sleep } from './game.ts';
import { SCENARIO_RC, SCENARIO_SEED, makePlayground, startServer, stopServer } from './playground.ts';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
};
const model = opt('--model');
const only = opt('--phase');
const jsonOut = opt('--json');
const shotDir = opt('--screenshot');
const PORT = Number(process.env.SMOKE_PORT ?? 8797);

interface Check {
  name: string;
  ok: boolean;
  why: string;
}
const results: { phase: string; turns: TurnResult[]; checks: Check[] }[] = [];

const answer = (r: TurnResult) => r.transcript.filter((m) => m.role === 'assistant').map((m) => m.text).join(' ');
function check(checks: Check[], name: string, ok: boolean, why: string) {
  checks.push({ name, ok, why });
  console.log(`CHECK ${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${why}`}`);
}
const noCoords = (r: TurnResult) => !/\b(row|column|coordinate|x ?= ?\d|y ?= ?\d)\b/i.test(answer(r));

async function phase(name: string, seed: number, body: (g: GameDriver, b: AssistantBrowser, ask: (q: string) => Promise<TurnResult>, checks: Check[]) => Promise<void>) {
  if (only && only !== name) return;
  console.log(`\n##### phase ${name} (seed ${seed})`);
  const pg = makePlayground({ seed, rc: SCENARIO_RC });
  const srv = await startServer(pg, PORT, 'scenario');
  const g = await GameDriver.connect(srv.base);
  const b = new AssistantBrowser({ session: `assistant-scenario-${name}-${(model ?? 'default').replace(/[^A-Za-z0-9_-]/g, '_')}` });
  const turns: TurnResult[] = [];
  const checks: Check[] = [];
  try {
    await g.toCommand();
    const connectMs = await b.start(`${srv.base}/`, { model });
    console.log(`(connected in ${connectMs} ms, model ${model ?? 'default'})`);
    const ask = async (q: string) => {
      const r = await b.ask(q);
      printTurn(r);
      turns.push(r);
      check(checks, `${q}: answered without errors`, !r.errors.length && !r.unpaired.length && !!answer(r), r.errors.join('; ') || 'no answer');
      return r;
    };
    await body(g, b, ask, checks);
    const ctx = b.eval<any>(
      "({contexts: voiceDebug.contexts, deletes: voiceDebug.events.filter(e => e.type === '>> conversation.item.delete').length, deleted: voiceDebug.events.filter(e => e.type === 'conversation.item.deleted').length})",
    );
    console.log(`LIVE CONTEXT: ${ctx.contexts.length} snapshots added (turns ${ctx.contexts.map((c: any) => c.turn).join(', ')}), ${ctx.deletes} superseded ones deleted, ${ctx.deleted} deletions confirmed`);
    check(checks, 'live context: refreshed when the game changed, superseded snapshots deleted', ctx.contexts.length > 1 && ctx.deleted === ctx.contexts.length - 1, JSON.stringify(ctx));
    if (shotDir) {
      fs.mkdirSync(shotDir, { recursive: true });
      console.log(`screenshot: ${b.screenshot(path.resolve(shotDir, `scenario-${name}.png`))}`);
    }
  } finally {
    b.stop();
    b.close();
    g.close();
    await stopServer(srv.proc);
    fs.rmSync(pg.dir, { recursive: true, force: true });
  }
  results.push({ phase: name, turns, checks });
}

await phase('A', SCENARIO_SEED, async (g, _b, ask, checks) => {
  let r = await ask("What's my HP and am I hungry?");
  check(checks, 'status: uses get_status', r.tools.some((t) => t.name === 'get_status'), JSON.stringify(r.metrics.tool_names));
  check(checks, 'status: mentions 11 HP', /11/.test(answer(r)), answer(r));

  r = await ask("What's the f next to me?");
  check(checks, 'f: looks first', r.tools.some((t) => t.name === 'look' || t.name === 'get_screen'), JSON.stringify(r.metrics.tool_names));
  check(checks, 'f: says kitten', /kitten/i.test(answer(r)), answer(r));
  check(checks, 'f: no coordinates', noCoords(r), answer(r));

  r = await ask('What am I carrying?');
  check(checks, 'inventory: uses get_inventory', r.tools.some((t) => t.name === 'get_inventory'), JSON.stringify(r.metrics.tool_names));
  check(checks, 'inventory: mentions quarterstaff or cloak', /quarterstaff|cloak/i.test(answer(r)), answer(r));

  // kill the goblin with force bolt, step next to the fountain
  g.send('Z');
  await sleep(300);
  g.send('a');
  await sleep(300);
  g.send('l');
  await sleep(500);
  await g.toCommand();
  await g.keys(['u']);
  r = await ask('What does this fountain do?');
  check(checks, 'fountain: looks first', r.tools.some((t) => t.name === 'look' || t.name === 'get_screen'), JSON.stringify(r.metrics.tool_names));
  check(checks, 'fountain: answers about its effects', /quaff|drink|dip|wish|effect|outcome|happen/i.test(answer(r)), answer(r));

  // magic mapping, travel to the down stairs, descend
  g.send('r');
  await sleep(300);
  g.send('j');
  await sleep(500);
  await g.toCommand();
  await g.travelTo({ x: 22, y: 8 }); // via the west room: the short way north is blocked by a boulder
  await g.travelTo(/^staircase down$/);
  g.send('>');
  await sleep(800);
  await g.toCommand();
  const st = await g.state();
  console.log(`(now on ${st.status?.fields.level_desc}, turn ${st.turn})`);
  r = await ask('What was on level 1?');
  check(checks, 'level 1: uses list_levels / get_level_map', r.tools.some((t) => /list_levels|get_level_map/.test(t.name)), JSON.stringify(r.metrics.tool_names));
  check(checks, 'level 1: mentions the fountain', /fountain/i.test(answer(r)), answer(r));
  r = await ask('Where were the down stairs on level 1?');
  check(checks, 'stairs: spoken position, no coordinates', noCoords(r) && /(east|west|north|south|right|left|corner|side)/i.test(answer(r)), answer(r));
});

await phase('B', 149, async (g, _b, ask, checks) => {
  const { cells } = await g.cells();
  const potion = cells.find((c) => c.ch === '!');
  if (!potion) throw new Error('no potion in view for seed 149');
  await g.walkTo(potion.x, potion.y);
  await g.pickUp(/potion/);
  const inv = (await g.state()).inventory.filter((i) => i.class_sym === '!').map((i) => i.text);
  console.log(`(potions now: ${inv.join('; ')})`);
  const r = await ask("What's that unidentified potion?");
  const a = answer(r);
  check(checks, 'potion: checks the inventory', r.tools.some((t) => /get_inventory|look|get_discoveries/.test(t.name)), JSON.stringify(r.metrics.tool_names));
  check(checks, 'potion: does not claim an identity', !/\b(it'?s|it is|that'?s|probably|likely) (a |an )?potion of\b/i.test(a), a);
  check(checks, 'potion: says it cannot tell / appearances are random', /can'?t (tell|know|be sure)|cannot (tell|know)|no way to (tell|know)|random|shuffled|unidentified|don'?t know/i.test(a), a);
  check(checks, 'potion: spoiler warning / offer', /spoiler|want me to|would you like|shall i|do you want/i.test(a), a);
});

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
const all = results.flatMap((r) => r.checks);
const failedChecks = all.filter((c) => !c.ok);
console.log(`\nScenario summary: ${all.length - failedChecks.length}/${all.length} checks passed`);
for (const c of failedChecks) console.log(`  FAIL ${c.name}: ${c.why}`);
const lat = results.flatMap((r) => r.turns).map((t) => t.metrics.first_audio).filter((x): x is number => x !== null);
if (lat.length) console.log(`first audio after turn end: median ${lat.sort((a, b) => a - b)[Math.floor(lat.length / 2)]} ms, max ${Math.max(...lat)} ms`);
process.exit(failedChecks.length ? 1 : 0);

