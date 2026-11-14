// End-to-end test: drives headless Chromium via agent-browser against the running server.
// For each question: open a fresh page, start a session (fake mic), send the question as TEXT through the
// data channel, wait for the assistant's final answer (after any tool calls), and print the transcript.
//
// The fake mic is muted in text mode (Chromium's fake device beeps, which would trigger VAD).
// "A||B" sends follow-up B in the same session after A's answer.
// --audio <wav>: instead of text, feed a WAV file as the fake microphone (tests VAD + input transcription);
//   the WAV should start with ~6s of silence (connect time) and end with long silence (Chromium loops it).
//
// Usage: node scripts/e2e.ts [url] [--model gpt-realtime-2.1-mini] [--screenshot path] [--audio file.wav] [--reasoning medium] ["question" ...]
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const model = opt("--model");
const shot = opt("--screenshot");
const audioFile = opt("--audio");
const reasoning = opt("--reasoning");
const url = argv[0]?.startsWith("http") ? argv.shift()! : "http://localhost:8788/";
const questions = audioFile
  ? [`(spoken: ${audioFile})`]
  : argv.length
  ? argv
  : ["What does a genetic engineer do in NetHack 5?", "How do I solve the first Sokoban level?"];

const SESSION = audioFile ? "voiceproto-e2e-audio" : "voiceproto-e2e";
const BROWSER_ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  ...(audioFile ? [`--use-file-for-fake-audio-capture=${audioFile}`] : []),
].join(",");

function ab(...args: string[]): string {
  return execFileSync("agent-browser", ["--session", SESSION, "--args", BROWSER_ARGS, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  }).trim();
}

function evalJs<T = any>(js: string): T {
  const out = ab("eval", `JSON.stringify(${js})`);
  let v: any = out;
  // agent-browser prints the JS result; it may be JSON-quoted once more.
  for (let i = 0; i < 2 && typeof v === "string"; i++) {
    try { v = JSON.parse(v); } catch { break; }
  }
  return v as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs: number, what: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(700);
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function ask(question: string, idx: number) {
  ab("open", url);
  await waitFor(() => evalJs<string>("document.querySelectorAll('#model option').length") as any > 0, 15_000, "config");
  if (model) ab("select", "#model", model);
  if (reasoning) ab("select", "#reasoning", reasoning);
  const t0 = Date.now();
  ab("click", "#start");
  await waitFor(() => {
    const st = evalJs<{ state: string; errors: string[] }>("({state: voiceDebug.state, errors: voiceDebug.errors})");
    if (st.state === "error") throw new Error(`session error: ${st.errors.join("; ")}`);
    return st.state === "connected";
  }, 30_000, "connected");
  const connectMs = Date.now() - t0;
  if (!audioFile) ab("click", "#mute");
  // "A||B" = follow-up B sent in the same session after A's answer completes.
  const turns = question.split("||").map((q) => q.trim()).filter(Boolean);
  const timings: number[] = [];
  let result: any;
  for (const turn of turns) {
    const before = evalJs<number>("voiceDebug.transcript.filter(m => m.role === 'assistant').length");
    const tSend = Date.now();
    if (!audioFile) evalJs(`voiceDebug.sendText(${JSON.stringify(turn)})`);
    // Done when: a new assistant message exists, no response active, no tool pending, and events quiet for 4s.
    let lastLen = -1;
    let stableSince = 0;
    result = await waitFor(() => {
      const d = evalJs<any>(
        "({t: voiceDebug.transcript, tools: voiceDebug.tools, active: voiceDebug.activeResponse, errors: voiceDebug.errors, n: voiceDebug.events.length, pendingTools: document.querySelectorAll('.tool .badge:not(.ok):not(.fail)').length})",
      );
      if (d.n !== lastLen) { lastLen = d.n; stableSince = Date.now(); }
      const assistantCount = d.t.filter((m: any) => m.role === "assistant").length;
      const quiet = Date.now() - stableSince > 4000;
      if (assistantCount > before && !d.active && d.pendingTools === 0 && quiet) return d;
      if (d.errors.length && quiet && !d.active) return d;
      return null;
    }, audioFile ? 90_000 : 120_000, "assistant answer");
    timings.push(Date.now() - tSend - 4000);
  }
  const totalMs = timings.join("/");

  if (shot && idx === questions.length - 1) {
    mkdirSync(join(shot, ".."), { recursive: true });
    ab("set", "viewport", "1100", "900");
    ab("screenshot", shot);
  }
  ab("click", "#start"); // stop session

  console.log(`\n=== Q${idx + 1}: ${question}`);
  console.log(`(model ${model ?? "default"}, reasoning ${reasoning ?? "default"}; connect ${connectMs} ms; answer(s) complete after ~${totalMs} ms)`);
  for (const m of result.t) {
    if (m.role === "user") { console.log(`USER: ${m.text}`); continue; }
    if (m.role === "tool") { console.log(`  TOOL ${m.text}`); continue; }
    console.log(`ASSISTANT${m.ms && Object.keys(m.ms).length ? ` [${Object.entries(m.ms).map(([k, v]) => `${k}=${v}ms`).join(" ")}]` : ""}: ${m.text}`);
  }
  if (result.errors.length) console.log(`ERRORS: ${result.errors.join(" | ")}`);
  return { question, tools: result.tools.length, errors: result.errors.length, answers: result.t.filter((m: any) => m.role === "assistant").length };
}

const summary = [];
try {
  for (let i = 0; i < questions.length; i++) summary.push(await ask(questions[i], i));
} finally {
  try { ab("close"); } catch {}
}
const failed = summary.filter((r) => r.errors || !r.answers);
console.log(`\nSummary: ${summary.length} questions, ${summary.reduce((n, r) => n + r.tools, 0)} tool calls, ${failed.length} failures`);
process.exit(failed.length ? 1 : 0);
