// Browser client: OpenAI Realtime (GA) over WebRTC with an ephemeral client secret minted by our server.
// Function calls arrive on the "oai-events" data channel; we forward them to POST /api/tools/:name,
// return a function_call_output item and trigger a new response.

type Json = Record<string, any>;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  status: $("status"), statusText: $("status-text"), model: $<HTMLSelectElement>("model"), voice: $<HTMLSelectElement>("voice"),
  reasoning: $<HTMLSelectElement>("reasoning"), start: $<HTMLButtonElement>("start"), mute: $<HTMLButtonElement>("mute"),
  error: $("error"), log: $("log"), empty: $("empty"), composer: $<HTMLFormElement>("composer"), text: $<HTMLInputElement>("text"),
  send: $<HTMLButtonElement>("send"), vad: $("vad"),
};

type State = "idle" | "connecting" | "connected" | "error";

interface ToolCall {
  callId: string; name: string; args: string; el: HTMLElement; responseId?: string;
  promise?: Promise<string>;
  result?: string; // set once the tool finished
  outputSent?: boolean; // a function_call_output item for this call_id was sent
  dropped?: boolean; // the response was interrupted before the result arrived; a late result is discarded
}

const s = {
  state: "idle" as State,
  pc: null as RTCPeerConnection | null,
  dc: null as RTCDataChannel | null,
  mic: null as MediaStream | null,
  audioEl: null as HTMLAudioElement | null,
  muted: false,
  activeResponse: null as string | null,
  pendingCreate: false,
  userTurn: 0, // incremented whenever the user starts a new turn (speech or text); detects barge-in during tool calls
  responseTurn: new Map<string, number>(), // response id -> userTurn when it was created
  bubbles: new Map<string, HTMLElement>(), // item_id -> transcript bubble
  calls: new Map<string, ToolCall>(), // call_id -> tool call
  turnStart: 0, // perf time of end of user speech / text send
  turnT0: 0, // like turnStart but not reset after the first answer (for per-message timing in debug.transcript)
  turnMarks: { firstText: 0, firstAudio: 0 },
  sessionStart: 0,
};

// Exposed for e2e tests / debugging.
const debug = {
  events: [] as Json[],
  transcript: [] as { role: string; text: string; ms?: Json; at?: number }[],
  tools: [] as { name: string; args: string; ok: boolean; ms: number; preview: string; at?: number; responseId?: string }[],
  errors: [] as string[],
  get state() { return s.state; },
  get activeResponse() { return s.activeResponse; },
  /** call_ids of function calls that never got a function_call_output (should always be empty when idle). */
  unpaired: () => [...s.calls.values()].filter((c) => !c.outputSent).map((c) => `${c.name}:${c.callId}`),
  dropped: () => [...s.calls.values()].filter((c) => c.dropped).map((c) => `${c.name}:${c.callId}`),
  /** e2e: simulate a barge-in by sending `text` as soon as the model starts a function call ("item") or finishes its arguments ("args"). */
  bargeIn: null as null | { text: string; on: "item" | "args" },
};
(window as any).voiceDebug = debug;

// ---------------------------------------------------------------------------- UI helpers

function setState(st: State, text?: string) {
  s.state = st;
  els.status.dataset.state = st;
  els.statusText.textContent = text ?? { idle: "Idle", connecting: "Connecting…", connected: "Connected", error: "Error" }[st];
  const live = st === "connected";
  const busy = st === "connecting";
  els.start.textContent = live || busy ? "Stop session" : "Start session";
  els.start.classList.toggle("stop", live || busy);
  els.mute.disabled = !live || !s.mic;
  els.text.disabled = els.send.disabled = !live;
  for (const sel of [els.model, els.voice, els.reasoning]) sel.disabled = live || busy;
}

function showError(msg: string | null) {
  els.error.hidden = !msg;
  els.error.textContent = msg ?? "";
  if (msg) debug.errors.push(msg);
}

function append(el: HTMLElement) {
  els.empty.hidden = true;
  const stick = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 80;
  els.log.appendChild(el);
  if (stick) els.log.scrollTop = els.log.scrollHeight;
}

function scroll() {
  els.log.scrollTop = els.log.scrollHeight;
}

function bubble(role: "user" | "assistant" | "system", text: string, key?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  const body = document.createElement("span");
  body.className = "body";
  body.textContent = text;
  el.appendChild(body);
  if (key) s.bubbles.set(key, el);
  append(el);
  return el;
}

function bodyOf(el: HTMLElement) {
  return el.querySelector(".body") as HTMLElement;
}

function setMeta(el: HTMLElement, text: string) {
  let m = el.querySelector(".meta") as HTMLElement | null;
  if (!m) {
    m = document.createElement("span");
    m.className = "meta";
    el.appendChild(m);
  }
  m.textContent = text;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function logRemote(entry: Json) {
  fetch("/api/transcript", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry) }).catch(() => {});
}

// ---------------------------------------------------------------------------- session lifecycle

async function start() {
  showError(null);
  setState("connecting", "Minting session…");
  try {
    const t0 = performance.now();
    const tokenRes = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: els.model.value, voice: els.voice.value, reasoning: els.reasoning.value }),
    });
    const token = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(token.error ?? `session mint failed (${tokenRes.status})`);

    setState("connecting", "Connecting WebRTC…");
    const pc = new RTCPeerConnection();
    s.pc = pc;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    s.audioEl = audio;
    pc.ontrack = (e) => (audio.srcObject = e.streams[0]);
    pc.onconnectionstatechange = () => {
      if (s.pc !== pc) return;
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        showError(`WebRTC connection ${pc.connectionState}.`);
        stop("error");
      }
    };

    try {
      s.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      pc.addTrack(s.mic.getAudioTracks()[0], s.mic);
    } catch (err) {
      s.mic = null;
      pc.addTransceiver("audio", { direction: "recvonly" });
      bubble("system", `Microphone unavailable (${(err as Error).message}); text-only mode.`);
    }

    const dc = pc.createDataChannel("oai-events");
    s.dc = dc;
    dc.onmessage = (e) => onEvent(JSON.parse(e.data));
    dc.onclose = () => { if (s.dc === dc && s.state === "connected") { showError("Data channel closed."); stop("error"); } };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpRes = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/sdp" },
    });
    const answer = await sdpRes.text();
    if (!sdpRes.ok) {
      let msg = answer;
      try { msg = JSON.parse(answer).error?.message ?? answer; } catch {}
      throw new Error(`SDP exchange failed (${sdpRes.status}): ${msg}`);
    }
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
    await new Promise<void>((resolve, reject) => {
      if (dc.readyState === "open") return resolve();
      const to = setTimeout(() => reject(new Error("Timed out waiting for data channel")), 15000);
      dc.addEventListener("open", () => { clearTimeout(to); resolve(); }, { once: true });
    });
    s.sessionStart = performance.now();
    const connectMs = Math.round(performance.now() - t0);
    setState("connected", `Connected · ${token.model}`);
    bubble("system", `Session started: ${token.model}, voice ${token.voice}, reasoning ${token.reasoning} (mint ${token.mint_ms} ms, connect ${connectMs} ms)`);
    logRemote({ kind: "session", model: token.model, voice: token.voice, reasoning: token.reasoning, mint_ms: token.mint_ms, connect_ms: connectMs });
  } catch (err) {
    showError((err as Error).message);
    stop("error");
  }
}

function stop(next: State = "idle") {
  s.dc?.close();
  s.pc?.getSenders().forEach((snd) => snd.track?.stop());
  s.pc?.close();
  s.mic?.getTracks().forEach((t) => t.stop());
  if (s.audioEl) s.audioEl.srcObject = null;
  s.pc = null; s.dc = null; s.mic = null;
  s.activeResponse = null; s.pendingCreate = false; s.muted = false;
  els.mute.setAttribute("aria-pressed", "false");
  els.mute.textContent = "Mute mic";
  els.vad.hidden = true;
  if (s.state === "connected") bubble("system", "Session ended.");
  setState(next, next === "error" ? "Error" : undefined);
}

function send(event: Json) {
  if (s.dc?.readyState !== "open") return;
  debug.events.push({ t: Math.round(performance.now() - s.sessionStart), type: `>> ${event.type}`, ...(event.item?.type ? { item: event.item.type } : {}), ...(event.previous_item_id ? { after: event.previous_item_id } : {}) });
  s.dc.send(JSON.stringify(event));
}

function requestResponse() {
  if (s.activeResponse) { s.pendingCreate = true; return; }
  s.pendingCreate = false;
  send({ type: "response.create" });
}

// ---------------------------------------------------------------------------- server events

function onEvent(ev: Json) {
  debug.events.push({
    t: Math.round(performance.now() - s.sessionStart), type: ev.type,
    ...(ev.response?.id || ev.response_id ? { rid: ev.response?.id ?? ev.response_id } : {}),
    ...(ev.response?.status ? { status: ev.response.status, reason: ev.response.status_details?.reason } : {}),
    ...(ev.item?.type ? { item: ev.item.type, id: ev.item.id } : {}),
    ...(ev.error ? { code: ev.error.code, msg: ev.error.message } : {}),
  });
  switch (ev.type) {
    case "session.created":
    case "session.updated":
      break;

    case "input_audio_buffer.speech_started": {
      s.userTurn++;
      els.vad.hidden = false;
      if (!s.bubbles.has(ev.item_id)) bubble("user", "…", ev.item_id).classList.add("pending");
      break;
    }
    case "input_audio_buffer.speech_stopped":
      els.vad.hidden = true;
      s.turnStart = s.turnT0 = performance.now();
      s.turnMarks = { firstText: 0, firstAudio: 0 };
      break;

    case "conversation.item.input_audio_transcription.delta": {
      const el = s.bubbles.get(ev.item_id) ?? bubble("user", "", ev.item_id);
      if (el.classList.contains("pending")) { el.classList.remove("pending"); bodyOf(el).textContent = ""; }
      bodyOf(el).textContent += ev.delta ?? "";
      break;
    }
    case "conversation.item.input_audio_transcription.completed": {
      const el = s.bubbles.get(ev.item_id) ?? bubble("user", "", ev.item_id);
      el.classList.remove("pending");
      bodyOf(el).textContent = ev.transcript?.trim() || "(no speech recognized)";
      debug.transcript.push({ role: "user", text: ev.transcript });
      logRemote({ kind: "user", via: "voice", text: ev.transcript });
      break;
    }
    case "conversation.item.input_audio_transcription.failed": {
      const el = s.bubbles.get(ev.item_id);
      if (el) { el.classList.remove("pending"); bodyOf(el).textContent = "(transcription failed)"; }
      break;
    }

    case "response.created":
      s.activeResponse = ev.response?.id ?? "unknown";
      if (ev.response?.id) s.responseTurn.set(ev.response.id, s.userTurn);
      break;

    case "response.output_item.added": {
      const item = ev.item;
      if (item?.type === "function_call") {
        toolCard(item.call_id, item.name, ev.response_id);
        if (debug.bargeIn?.on === "item") { const t = debug.bargeIn.text; debug.bargeIn = null; sendText(t); }
      }
      break;
    }

    case "response.output_audio_transcript.delta":
    case "response.output_text.delta": {
      let el = s.bubbles.get(ev.item_id);
      if (!el) { el = bubble("assistant", "", ev.item_id); if (s.turnT0) el.dataset.at = String(Math.round(performance.now() - s.turnT0)); }
      bodyOf(el).textContent += ev.delta ?? "";
      if (s.turnStart && !s.turnMarks.firstText) s.turnMarks.firstText = performance.now();
      scroll();
      break;
    }
    case "response.output_audio_transcript.done":
    case "response.output_text.done": {
      const el = s.bubbles.get(ev.item_id) ?? bubble("assistant", "", ev.item_id);
      const text = ev.transcript ?? ev.text ?? bodyOf(el).textContent ?? "";
      bodyOf(el).textContent = text;
      const ms: Json = {};
      if (s.turnStart && s.turnMarks.firstText) ms.first_text = Math.round(s.turnMarks.firstText - s.turnStart);
      if (s.turnStart && s.turnMarks.firstAudio) ms.first_audio = Math.round(s.turnMarks.firstAudio - s.turnStart);
      if (ms.first_audio !== undefined || ms.first_text !== undefined) {
        setMeta(el, [ms.first_audio !== undefined ? `first audio ${secs(ms.first_audio)}` : "", ms.first_text !== undefined ? `first text ${secs(ms.first_text)}` : ""].filter(Boolean).join(" · ") + " after turn end");
      }
      // Only the first assistant message of a turn gets latency marks.
      s.turnStart = 0;
      const at = el.dataset.at !== undefined ? Number(el.dataset.at) : undefined;
      debug.transcript.push({ role: "assistant", text, ms, at });
      logRemote({ kind: "assistant", text, ms, at });
      break;
    }

    case "output_audio_buffer.started":
      if (s.turnStart && !s.turnMarks.firstAudio) s.turnMarks.firstAudio = performance.now();
      break;

    case "response.function_call_arguments.done": {
      const call = s.calls.get(ev.call_id) ?? toolCard(ev.call_id, ev.name, ev.response_id);
      call.args = ev.arguments ?? "{}";
      runCall(call);
      if (debug.bargeIn?.on === "args") { const t = debug.bargeIn.text; debug.bargeIn = null; sendText(t); }
      break;
    }

    case "response.done":
      onResponseDone(ev.response ?? {});
      break;

    case "error": {
      const msg = ev.error?.message ?? "Unknown realtime error";
      // Benign race: response.create while a response is active.
      if (ev.error?.code === "conversation_already_has_active_response") { s.pendingCreate = true; break; }
      // Benign race: we cancelled (user barged in by text) just as the response finished on its own.
      if (ev.error?.code === "response_cancel_not_active") break;
      showError(`Realtime error: ${msg}`);
      break;
    }
  }
}

/**
 * Tool-call bookkeeping. Every function_call the model emits gets exactly one function_call_output, so the
 * conversation never has a dangling call:
 *  - normal case: run the tools, append their outputs, then response.create so the model answers with them;
 *  - response interrupted (VAD barge-in or text sent while it was running -> status "cancelled"/"incomplete"):
 *    the user's new turn drives the next response (VAD auto-creates it / sendText creates it), so we do NOT
 *    request one. Calls whose result is already in are paired with the real result (usable by the next answer);
 *    unfinished or truncated calls are paired with a short "interrupted" output immediately and their late result
 *    is discarded. Outputs are inserted right after the call (previous_item_id) so they precede the new user message;
 *  - user started a new turn while a completed response's tools were still running: same insertion, no extra
 *    response.create (otherwise the model would answer twice).
 */
async function onResponseDone(resp: Json) {
  if (s.activeResponse === resp.id || s.activeResponse === "unknown") s.activeResponse = null;
  if (resp.status === "failed") {
    const d = resp.status_details?.error;
    showError(`Response failed: ${d?.message ?? d?.code ?? JSON.stringify(resp.status_details)}`);
  }
  const fnCalls: Json[] = (resp.output ?? []).filter((o: Json) => o.type === "function_call");
  // The user turn this response belongs to; if the user has started another turn since, the response is stale.
  const turnOfResponse = s.responseTurn.get(resp.id) ?? s.userTurn;
  if (fnCalls.length) {
    const completed = resp.status === "completed" || resp.status === undefined;
    const calls = fnCalls.map((fc) => {
      const call = s.calls.get(fc.call_id) ?? toolCard(fc.call_id, fc.name, resp.id);
      call.args = fc.arguments ?? call.args;
      return { fc, call };
    });
    if (completed) {
      for (const { call } of calls) runCall(call);
      await Promise.all(calls.map(({ call }) => call.promise));
      if (s.userTurn === turnOfResponse) {
        for (const { call } of calls) sendOutput(call, call.result!);
        requestResponse();
      } else {
        insertOutputs(calls.map(({ fc, call }) => ({ fc, call, output: call.result! })));
      }
    } else {
      const note = (c: ToolCall) =>
        `INTERRUPTED: the user spoke before this ${c.name} result was used, so it was not run to completion. ` +
        "Answer the user's latest message; call the tool again only if it is still needed.";
      insertOutputs(calls.map(({ fc, call }) => {
        const usable = fc.status !== "incomplete" && call.result !== undefined;
        if (!usable) markDropped(call);
        return { fc, call, output: usable ? call.result! : note(call) };
      }));
    }
  }
  if (s.pendingCreate && !s.activeResponse) requestResponse();
}

function sendOutput(call: ToolCall, output: string, previousItemId?: string, id?: string) {
  if (call.outputSent) return;
  call.outputSent = true;
  send({
    type: "conversation.item.create",
    ...(previousItemId ? { previous_item_id: previousItemId } : {}),
    item: { ...(id ? { id } : {}), type: "function_call_output", call_id: call.callId, output },
  });
}

/** Insert outputs directly after the last function_call item of the response, chained in order. */
function insertOutputs(list: { fc: Json; call: ToolCall; output: string }[]) {
  let prev: string | undefined = list[list.length - 1]?.fc.id;
  for (const { call, output } of list) {
    const id = `fco_${call.callId.replace(/[^A-Za-z0-9]/g, "").slice(-20)}`;
    sendOutput(call, output, prev, id);
    prev = id;
  }
}

function markDropped(call: ToolCall) {
  call.dropped = true;
  const badge = call.el.querySelector(".badge") as HTMLElement;
  if (badge && !call.result) { badge.textContent = "dropped (interrupted)"; badge.className = "badge fail"; }
  debug.transcript.push({ role: "tool", text: `${call.name} dropped: response interrupted before the result was used` });
}

// ---------------------------------------------------------------------------- tools

function toolCard(callId: string, name: string, responseId?: string): ToolCall {
  const existing = s.calls.get(callId);
  if (existing) return existing;
  const el = document.createElement("div");
  el.className = "tool";
  el.innerHTML = `<div class="head"><span class="name"></span><span class="badge">calling…</span><span class="args"></span></div>`;
  (el.querySelector(".name") as HTMLElement).textContent = `⚙ ${name}`;
  append(el);
  const call: ToolCall = { callId, name, args: "", el, responseId };
  s.calls.set(callId, call);
  return call;
}

function runCall(call: ToolCall) {
  if (call.promise) return;
  let args: Json = {};
  try { args = JSON.parse(call.args || "{}"); } catch { /* model sent bad JSON */ }
  (call.el.querySelector(".args") as HTMLElement).textContent = Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("  ");
  const t0 = performance.now();
  const at = s.turnT0 ? Math.round(t0 - s.turnT0) : undefined;
  call.promise = fetch(`/api/tools/${encodeURIComponent(call.name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ args, call_id: call.callId }),
  })
    .then(async (r) => {
      const j = await r.json().catch(() => ({ ok: false, result: `HTTP ${r.status}` }));
      return { ok: !!j.ok, result: String(j.result ?? ""), serverMs: j.ms as number | undefined };
    })
    .catch((e) => ({ ok: false, result: `network error: ${e.message}`, serverMs: undefined }))
    .then(({ ok, result, serverMs }) => {
      const ms = Math.round(performance.now() - t0);
      const badge = call.el.querySelector(".badge") as HTMLElement;
      badge.textContent = `${ok ? "ok" : "failed"} · ${ms} ms${serverMs !== undefined ? ` (server ${serverMs})` : ""} · ${result.length} chars`;
      badge.className = `badge ${ok ? "ok" : "fail"}`;
      const det = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent = result.replace(/\s+/g, " ").slice(0, 140);
      const pre = document.createElement("pre");
      pre.textContent = result;
      det.append(sum, pre);
      call.el.appendChild(det);
      call.result = ok ? result : `ERROR: ${result}`;
      if (call.dropped) badge.textContent += " · discarded (interrupted)";
      debug.tools.push({ name: call.name, args: call.args, ok, ms, preview: result.slice(0, 200), at, responseId: call.responseId });
      debug.transcript.push({ role: "tool", at, text: `${call.name} ${call.args} -> ${ok ? "ok" : "FAIL"} ${ms}ms (${result.length} chars): ${result.replace(/\s+/g, " ").slice(0, 150)}` });
      logRemote({ kind: "tool", name: call.name, args, ok, ms, chars: result.length, preview: result.slice(0, 200) });
      return ok ? result : `ERROR: ${result}`;
    });
}

// ---------------------------------------------------------------------------- text input / controls

function sendText(text: string) {
  if (!text.trim() || s.state !== "connected") return;
  s.userTurn++;
  if (s.activeResponse) send({ type: "response.cancel" });
  bubble("user", text);
  debug.transcript.push({ role: "user", text });
  logRemote({ kind: "user", via: "text", text });
  send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  s.turnStart = s.turnT0 = performance.now();
  s.turnMarks = { firstText: 0, firstAudio: 0 };
  s.activeResponse = null; // cancelled (if any); response.done will follow
  s.pendingCreate = false; // this create supersedes any queued one
  send({ type: "response.create" });
}
(debug as any).sendText = sendText;

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  sendText(els.text.value);
  els.text.value = "";
});

els.start.addEventListener("click", () => (s.state === "connected" || s.state === "connecting" ? stop() : start()));

els.mute.addEventListener("click", () => {
  if (!s.mic) return;
  s.muted = !s.muted;
  s.mic.getAudioTracks().forEach((t) => (t.enabled = !s.muted));
  els.mute.setAttribute("aria-pressed", String(s.muted));
  els.mute.textContent = s.muted ? "Mic muted" : "Mute mic";
});

async function init() {
  try {
    const cfg = await (await fetch("/api/config")).json();
    const fill = (sel: HTMLSelectElement, opts: string[], def: string) => {
      sel.innerHTML = "";
      for (const o of opts) sel.add(new Option(o, o, o === def, o === def));
    };
    fill(els.model, cfg.models, cfg.defaultModel);
    fill(els.voice, cfg.voices, cfg.defaultVoice);
    fill(els.reasoning, cfg.reasoningEfforts, cfg.defaultReasoning);
    if (!cfg.sourceAvailable) showError("NetHack source not found on server — run scripts/setup.sh (source tools will fail).");
  } catch (e) {
    showError(`Could not load config: ${(e as Error).message}`);
  }
  setState("idle");
}
init();
