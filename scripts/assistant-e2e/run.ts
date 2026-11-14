/**
 * Generic assistant e2e against a running server (default: the main one on 8787;
 * the tools only read the game).  Each question gets a fresh session; "A||B" sends
 * follow-up B in the same session, "A|>B" / "A|>>B" barge in (see browser.ts).
 *
 *   node scripts/assistant-e2e/run.ts [url] [--model gpt-realtime-2.1-mini] [--audio file.wav]
 *        [--screenshot path] [--json out.json] [--session name] ["question" ...]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AssistantBrowser, printTurn, type TurnResult } from './browser.ts';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const model = opt('--model');
const audio = opt('--audio');
const shot = opt('--screenshot');
const jsonOut = opt('--json');
const session = opt('--session') ?? (audio ? 'assistant-e2e-audio' : 'assistant-e2e');
const url = argv[0]?.startsWith('http') ? argv.shift()! : 'http://localhost:8787/';
const questions = audio ? [`(spoken: ${audio})`] : argv.length ? argv : ["What's my HP and am I hungry?", 'What am I carrying?'];

const b = new AssistantBrowser({ session, audio });
const results: TurnResult[][] = [];
let failed = 0;
try {
  for (const [i, q] of questions.entries()) {
    const connectMs = await b.start(url, { model });
    console.log(`\n(session ${i + 1}: model ${model ?? 'default'}, connect ${connectMs} ms)`);
    const turns: TurnResult[] = [];
    for (const t of q.split('||').map((s) => s.trim()).filter(Boolean)) {
      if (t === '!drop') {
        // simulate a lost connection / expired session: the client must reconnect and recap
        const t0 = Date.now();
        b.eval('(voiceDebug.simulateDrop(), 1)');
        await b.waitFor(() => b.eval<string>('voiceDebug.state') === 'connected' && Date.now() - t0 > 600, 30_000, 'reconnected');
        if (!audio) b.ab('click', '#as-mic');
        console.log(`\n(dropped the connection; reconnected after ${Date.now() - t0} ms)`);
        continue;
      }
      const r = await b.ask(t);
      printTurn(r);
      turns.push(r);
      if (r.errors.length || r.unpaired.length || !r.transcript.some((m) => m.role === 'assistant')) failed++;
    }
    results.push(turns);
    const ctx = b.eval<any>("({contexts: voiceDebug.contexts, deletes: voiceDebug.events.filter(e => e.type === '>> conversation.item.delete').length, deleted: voiceDebug.events.filter(e => e.type === 'conversation.item.deleted').length})");
    console.log(`LIVE CONTEXT: ${ctx.contexts.length} snapshots added (${ctx.contexts.map((c: any) => `turn ${c.turn}, ${c.chars} chars`).join('; ')}), ${ctx.deletes} superseded deleted (${ctx.deleted} confirmed)`);
    if (shot && i === questions.length - 1) {
      mkdirSync(dirname(shot), { recursive: true });
      b.screenshot(shot);
    }
    b.stop();
  }
} finally {
  b.close();
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
console.log(`\nSummary: ${questions.length} sessions, ${failed} failed turns`);
process.exit(failed ? 1 : 0);
