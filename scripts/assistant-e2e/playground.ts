/**
 * Isolated, reproducible game for assistant e2e tests: a throw-away
 * NETHACKDIR + HOME, a wrapper "nethack binary" that runs the installed game
 * with the replay harness's fixed seed/clock shim (server/test/smoke/replay)
 * and without ASLR, and a server instance on its own port.  Same seed + same
 * keys = same game, so scenarios can rely on the dungeon layout.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildShim } from '../../server/test/smoke/replay/harness.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
export const HACKDIR = path.join(ROOT, '.nethack/games/lib/nethackdir');
export const FIXED_TIME = '1794700800';

/** Character for the scenario: a Wizard (kitten pet) -- see find-seed.ts */
export const SCENARIO_RC = ['OPTIONS=role:Wizard,race:elf,gender:female,align:chaotic', 'OPTIONS=pettype:cat', 'OPTIONS=!tips'];
/** seed whose first room shows a fountain and a potion (found with find-seed.ts) */
export const SCENARIO_SEED = 33;

export interface Playground {
  dir: string;
  home: string;
  bin: string;
  rc: string;
}

export function makePlayground(opts: { seed: number; rc: string[] }): Playground {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-assistant-'));
  for (const f of ['nhdat', 'symbols', 'license']) fs.copyFileSync(path.join(HACKDIR, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'save'));
  for (const f of ['record', 'logfile', 'xlogfile', 'livelog', 'perm']) fs.writeFileSync(path.join(dir, f), '');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const rc = path.join(dir, 'nethackrc.template');
  fs.writeFileSync(rc, [fs.readFileSync(path.join(ROOT, 'nethack/nethackrc'), 'utf8'), ...opts.rc].join('\n') + '\n');
  const shim = buildShim();
  const arch = os.arch() === 'arm64' ? 'aarch64' : 'x86_64';
  const bin = path.join(dir, 'nethack-fixed.sh');
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nexport NETHACKDIR='${dir}' LD_PRELOAD='${shim}' NH_FIXED_SEED='${opts.seed}' NH_FIXED_TIME='${FIXED_TIME}'\n` +
      `exec setarch ${arch} -R '${path.join(HACKDIR, 'nethack')}' "$@"\n`,
    { mode: 0o755 },
  );
  return { dir, home, bin, rc };
}

export async function startServer(
  pg: Playground,
  port: number,
  player: string,
  extraEnv: Record<string, string> = {},
): Promise<{ proc: ChildProcess; base: string; log: () => string }> {
  let log = '';
  const proc = spawn(process.execPath, ['src/main.ts'], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NETHACK_BIN: pg.bin,
      NETHACK_PLAYER: player,
      NETHACK_HOME: pg.home,
      NETHACK_FEED_SOCKET_PATH: path.join(pg.dir, 'feed.sock'),
      NETHACK_MEMORY_DIR: path.join(pg.dir, 'memory'),
      NETHACKRC_TEMPLATE: pg.rc,
      ASSISTANT_LOG_DIR: path.join(ROOT, '.cache/assistant-e2e'),
      LOG: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (d) => (log += d));
  proc.stderr!.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const end = Date.now() + 15000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/session`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end || proc.exitCode !== null) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return { proc, base, log: () => log };
}

export async function stopServer(proc: ChildProcess) {
  if (proc.exitCode !== null) return;
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
}
