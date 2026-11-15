/**
 * Lazy connect + mic on/off e2e (own server on the smoke port 8797, seed 33 game):
 *
 *  1. fresh page, type a question and press Send without touching the mic: the session
 *     connects and answers, and getUserMedia is never called (no permission prompt);
 *  2. F2: mic on -> status "Listening", the fake mic (a WAV) asks a question by voice;
 *  3. F2: mic off -> the track is stopped (readyState "ended"), the sender has no track;
 *  4. typing still works with the mic off;
 *  5. hold F3 (push-to-talk): mic on while held, off (track ended) after release.
 *
 *   node scripts/assistant-e2e/mic.ts [--model gpt-realtime-2.1-mini] [--audio q.wav] [--screenshot dir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { AssistantBrowser, printTurn, sleep } from './browser.ts';
import { GameDriver } from './game.ts';
import { ROOT, SCENARIO_RC, SCENARIO_SEED, makePlayground, startServer, stopServer } from './playground.ts';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
};
const model = opt('--model') ?? 'gpt-realtime-2.1-mini';
const audio = path.resolve(opt('--audio') ?? path.join(ROOT, '.cache/assistant-e2e/audio/q-f.wav'));
const shotDir = opt('--screenshot');
const PORT = Number(process.env.SMOKE_PORT ?? 8797);

let failed = 0;
function check(name: string, ok: boolean, why: unknown = '') {
  if (!ok) failed++;
  console.log(`CHECK ${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${typeof why === 'string' ? why : JSON.stringify(why)}`}`);
}

/** count getUserMedia calls and keep the streams / peer connections the page creates */
const INSTRUMENT = `(() => {
  const w = window;
  w.__gum = [];
  w.__pcs = [];
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => { const s = await gum(c); w.__gum.push(s); return s; };
  const PC = w.RTCPeerConnection;
  w.RTCPeerConnection = function (...a) { const pc = new PC(...a); w.__pcs.push(pc); return pc; };
  w.RTCPeerConnection.prototype = PC.prototype;
  return 1;
})()`;

/** status, mic button, captured tracks and the live sender's track */
const PROBE = `(() => {
  const pc = window.__pcs.at(-1);
  const snd = pc && pc.connectionState !== 'closed' ? pc.getSenders().find((s) => !s.track || s.track.kind === 'audio') : undefined;
  return {
    state: voiceDebug.state,
    status: document.getElementById('as-status-text').textContent,
    mic: document.getElementById('as-mic').getAttribute('aria-pressed'),
    gum: window.__gum.length,
    tracks: window.__gum.flatMap((s) => s.getTracks().map((t) => t.readyState)),
    senderTrack: snd === undefined ? 'no-pc' : snd.track ? snd.track.readyState : null,
    pcs: window.__pcs.length,
    errors: voiceDebug.errors,
  };
})()`;
type Probe = { state: string; status: string; mic: string; gum: number; tracks: string[]; senderTrack: string | null; pcs: number; errors: string[] };

const key = (b: AssistantBrowser, type: 'keydown' | 'keyup', k: string) =>
  b.eval(`(window.dispatchEvent(new KeyboardEvent('${type}', { key: '${k}', code: '${k}', bubbles: true })), 1)`);

const pg = makePlayground({ seed: SCENARIO_SEED, rc: SCENARIO_RC });
const srv = await startServer(pg, PORT, 'micscenario');
const g = await GameDriver.connect(srv.base);
const b = new AssistantBrowser({ session: 'assistant-mic-e2e', audio });
try {
  await g.toCommand();
  await b.start(`${srv.base}/`, { model, mic: false });
  b.eval(INSTRUMENT);
  let p = b.eval<Probe>(PROBE);
  console.log('idle:', JSON.stringify(p));
  check('fresh page: not connected, mic off', p.state === 'idle' && p.mic === 'false' && p.status === 'Mic off', p);
  check('fresh page: input and Send enabled', b.eval<boolean>("!document.getElementById('as-input').disabled && !document.getElementById('as-send').disabled"));
  check('no start button', b.eval<boolean>("!document.getElementById('as-start')"));
  if (shotDir) fs.mkdirSync(shotDir, { recursive: true }), b.screenshot(path.resolve(shotDir, 'assistant-idle.png'));

  // 1. text on a fresh page
  let r = await b.ask("What's my HP?", 'ui');
  printTurn(r);
  p = b.eval<Probe>(PROBE);
  console.log('after text:', JSON.stringify(p));
  check('1 text: connected and answered', p.state === 'connected' && r.transcript.some((m) => m.role === 'assistant') && !r.errors.length, r.errors);
  check('1 text: no getUserMedia call', p.gum === 0, p);
  check('1 text: status says text only', p.status === 'Mic off · text only' && p.senderTrack === null, p);
  if (shotDir) b.screenshot(path.resolve(shotDir, 'assistant-text-only.png'));

  // 2. mic on (F2) and a spoken question
  key(b, 'keydown', 'F2');
  key(b, 'keyup', 'F2');
  await b.waitFor(() => b.eval<Probe>(PROBE).status === 'Listening', 10_000, 'Listening');
  p = b.eval<Probe>(PROBE);
  console.log('mic on:', JSON.stringify(p));
  check('2 mic on: Listening, one getUserMedia, live track on the sender', p.mic === 'true' && p.gum === 1 && p.senderTrack === 'live' && p.pcs === 1, p);
  if (shotDir) b.screenshot(path.resolve(shotDir, 'assistant-listening.png'));
  r = await b.ask('(spoken)', 'audio');
  printTurn(r);
  check('2 voice turn: transcribed and answered', r.transcript.some((m) => m.role === 'user' && m.text) && r.transcript.some((m) => m.role === 'assistant') && !r.errors.length, r.transcript);

  // 3. mic off (F2)
  key(b, 'keydown', 'F2');
  key(b, 'keyup', 'F2');
  await sleep(500);
  p = b.eval<Probe>(PROBE);
  console.log('mic off:', JSON.stringify(p));
  check('3 mic off: track ended, sender has no track, status updated', p.mic === 'false' && p.tracks.every((t) => t === 'ended') && p.senderTrack === null && p.status === 'Mic off · text only', p);

  // 4. text with the mic off
  r = await b.ask('What am I carrying?', 'ui');
  printTurn(r);
  p = b.eval<Probe>(PROBE);
  check('4 text with mic off: answered, no new getUserMedia, same connection', r.transcript.some((m) => m.role === 'assistant') && !r.errors.length && p.gum === 1 && p.pcs === 1, { p, errors: r.errors });

  // 5. push-to-talk
  key(b, 'keydown', 'F3');
  await b.waitFor(() => b.eval<Probe>(PROBE).status === 'Listening', 10_000, 'Listening (F3)');
  p = b.eval<Probe>(PROBE);
  check('5 F3 held: Listening, live track', p.senderTrack === 'live' && p.gum === 2, p);
  await sleep(1000);
  key(b, 'keyup', 'F3');
  await sleep(500);
  p = b.eval<Probe>(PROBE);
  console.log('after F3:', JSON.stringify(p));
  check('5 F3 released: mic off again, tracks ended', p.mic === 'false' && p.tracks.every((t) => t === 'ended') && p.senderTrack === null, p);
  if (shotDir) b.screenshot(path.resolve(shotDir, 'assistant-final.png'));
} finally {
  b.stop();
  b.close();
  g.close();
  await stopServer(srv.proc);
  fs.rmSync(pg.dir, { recursive: true, force: true });
}
console.log(`\n${failed ? `${failed} checks FAILED` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
