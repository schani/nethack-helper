// End-to-end test: drives headless Chromium via agent-browser against the running server.
// For each question: open a fresh page, start a session (fake mic), send the question as TEXT through the
// data channel, wait for the assistant's final answer (after any tool calls), and print the transcript.
//
// The fake mic is muted in text mode (Chromium's fake device beeps, which would trigger VAD).
// "A||B" sends follow-up B in the same session after A's answer.
// "A|>B" barges in: B is sent the moment the model starts a function call while answering A (response still streaming);
// "A|>>B" sends B when the first call's arguments are complete (tool already running). Checks no call is left unpaired.
// --audio <wav>: instead of text, feed a WAV file as the fake microphone (tests VAD + input transcription);
//   the WAV should start with ~6s of silence (connect time) and end with long silence (Chromium loops it).
//
// --session <name>: agent-browser session name (use distinct names to run several e2e processes in parallel).
// --json <file>: also write per-turn results (transcript, tools, timings) as JSON.
// Per-turn metrics: first_audio = first audio of the first assistant message (often a preamble);
// final_at = when the LAST assistant message of the turn started (the actual answer); rounds = model responses that issued tools.
//
// Usage: node scripts/e2e.ts [url] [--model gpt-realtime-2.1-mini] [--screenshot path] [--audio file.wav] [--reasoning medium]
//        [--session name] [--json out.json] ["question" ...]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
const sessionOpt = opt("--session");
const jsonOut = opt("--json");
const showEvents = argv.includes("--events") ? (argv.splice(argv.indexOf("--events"), 1), true) : false;
const url = argv[0]?.startsWith("http") ? argv.shift()! : "http://localhost:8788/";
const questions = audioFile
  ? [`(spoken: ${audioFile})`]
  : argv.length
  ? argv
  : ["What does a genetic engineer do in NetHack 5?", "How do I solve the first Sokoban level?"];

const SESSION = sessionOpt ?? (audioFile ? "voiceproto-e2e-audio" : "voiceproto-e2e");
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
  let unpaired: string[] = [];
  let dropped: string[] = [];
  const timings: number[] = [];
  const turnMetrics: any[] = [];
  let result: any;
  for (const turn of turns) {
    const before = evalJs<number>("voiceDebug.transcript.filter(m => m.role === 'assistant').length");
    const tStart = evalJs<number>("voiceDebug.transcript.length");
    const toolsBefore = evalJs<number>("voiceDebug.tools.length");
    const tSend = Date.now();
    const barge = /^(.*?)\|(>>?)(.*)$/.exec(turn);
    if (barge && !audioFile) {
      evalJs(`(voiceDebug.bargeIn = ${JSON.stringify({ text: barge[3].trim(), on: barge[2] === ">>" ? "args" : "item" })}, 1)`);
      evalJs(`voiceDebug.sendText(${JSON.stringify(barge[1].trim())})`);
    } else if (!audioFile) evalJs(`voiceDebug.sendText(${JSON.stringify(turn)})`);
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
    ({ unpaired, dropped } = evalJs<any>("({unpaired: voiceDebug.unpaired(), dropped: voiceDebug.dropped()})"));
    const msgs = result.t.slice(tStart).filter((m: any) => m.role === "assistant");
    const tools = result.tools.slice(toolsBefore);
    turnMetrics.push({
      turn,
      first_audio: msgs[0]?.ms?.first_audio ?? null,
      final_at: msgs.length ? msgs[msgs.length - 1].at ?? null : null,
      done_ms: timings[timings.length - 1],
      tools: tools.length,
      rounds: new Set(tools.map((t: any) => t.responseId)).size,
      tool_names: tools.map((t: any) => t.name),
    });
  }
  const totalMs = timings.join("/");

  if (shot && idx === questions.length - 1) {
    mkdirSync(join(shot, ".."), { recursive: true });
    ab("set", "viewport", "1100", "900");
    ab("screenshot", shot);
  }
  const events = showEvents ? evalJs<any[]>("voiceDebug.events.filter(e => !/delta|audio_buffer|transcript|rate_limits|content_part|output_text|audio\\.done/.test(e.type))") : [];
  ab("click", "#start"); // stop session

  console.log(`\n=== Q${idx + 1}: ${question}`);
  console.log(`(model ${model ?? "default"}, reasoning ${reasoning ?? "default"}; connect ${connectMs} ms; answer(s) complete after ~${totalMs} ms)`);
  for (const m of result.t) {
    if (m.role === "user") { console.log(`USER: ${m.text}`); continue; }
    if (m.role === "tool") { console.log(`  TOOL${m.at !== undefined ? ` @${m.at}ms` : ""} ${m.text}`); continue; }
    const marks = { ...(m.ms ?? {}), ...(m.at !== undefined ? { at: m.at } : {}) };
    console.log(`ASSISTANT${Object.keys(marks).length ? ` [${Object.entries(marks).map(([k, v]) => `${k}=${v}ms`).join(" ")}]` : ""}: ${m.text}`);
  }
  for (const e of events) console.log(`EVENT ${JSON.stringify(e)}`);
  for (const tm of turnMetrics) console.log(`METRICS ${JSON.stringify(tm)}`);
  if (unpaired.length || dropped.length) console.log(`TOOL STATE: unpaired=${JSON.stringify(unpaired)} dropped=${JSON.stringify(dropped)}`);
  if (unpaired.length) result.errors.push(`unpaired function calls: ${unpaired.join(", ")}`);
  if (result.errors.length) console.log(`ERRORS: ${result.errors.join(" | ")}`);
  return { question, model: model ?? "default", tools: result.tools.length, errors: result.errors.length, errorText: result.errors, answers: result.t.filter((m: any) => m.role === "assistant").length, turns: turnMetrics, transcript: result.t };
}

const summary = [];
try {
  for (let i = 0; i < questions.length; i++) summary.push(await ask(questions[i], i));
} finally {
  try { ab("close"); } catch {}
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
const failed = summary.filter((r) => r.errors || !r.answers);
console.log(`\nSummary: ${summary.length} questions, ${summary.reduce((n, r) => n + r.tools, 0)} tool calls, ${failed.length} failures`);
process.exit(failed.length ? 1 : 0);
