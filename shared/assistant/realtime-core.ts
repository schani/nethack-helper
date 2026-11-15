/**
 * Transport-agnostic core of the voice assistant's Realtime conversation:
 * everything that happens on the event channel once a session is open.
 *
 * Shared by the browser client (WebRTC data channel, web/src/assistant/realtime.ts)
 * and the Node driver used by the eval suite (Realtime WebSocket,
 * server/src/assistant/realtime-node.ts), so evals exercise exactly the
 * production conversation logic:
 *
 *  - Function calls are run through the host's `tool()` and every call gets
 *    exactly one function_call_output (barge-in safe, see onResponseDone()).
 *  - Live game context: a compact snapshot is added as a system message
 *    right after connecting and refreshed (only if it changed) whenever the
 *    user starts a turn; the superseded snapshot item is deleted so the
 *    model never sees stale state.
 *  - Text turns, latency marks (first text / first audio), the recap used
 *    after a reconnect, and the debug record (window.voiceDebug in the browser).
 *
 * The host owns the transport (connect, reconnect, audio) and tells the core
 * when a session is attached / detached.  No DOM or Node APIs here.
 */

export type Json = Record<string, any>;

export type ConnState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface GameContext {
  text: string;
  turn: number;
}

export interface ToolResponse {
  ok: boolean;
  result: string;
  ms?: number;
}

export interface ToolCall {
  callId: string;
  name: string;
  args: string;
  responseId?: string;
  promise?: Promise<string>;
  /** set once the tool finished */
  result?: string;
  ok?: boolean;
  ms?: number;
  serverMs?: number;
  /** a function_call_output item for this call_id was sent */
  outputSent?: boolean;
  /** the response was interrupted before the result arrived; a late result is discarded */
  dropped?: boolean;
}

/** Rendering callbacks (the browser panel; a recorder in the Node driver). */
export interface RealtimeView {
  state(st: ConnState, detail: string): void;
  error(msg: string | null): void;
  system(text: string): void;
  /** a user turn (voice: key = item id, text may still be pending) */
  user(key: string, text: string, final: boolean): void;
  assistant(key: string, text: string, final: boolean, latency?: Json): void;
  tool(call: ToolCall): void;
  listening(on: boolean): void;
  mic(muted: boolean, available: boolean): void;
}

/** Server-side services the conversation needs (HTTP in the browser, in-process or HTTP in Node). */
export interface AssistantBackend {
  /** never throws: failures become an error result for the model */
  tool(name: string, args: Record<string, unknown>, callId: string, sessionId?: string): Promise<ToolResponse>;
  context(): Promise<GameContext>;
  log(entry: Record<string, unknown>): void;
}

/** What the core needs from the transport owner. */
export interface RealtimeHost {
  /** send a client event if the channel is open (silently dropped otherwise) */
  send(event: Json): void;
  readonly open: boolean;
  readonly state: ConnState;
  /** the transport is gone (e.g. the session expired) */
  transportLost(why: string): void;
  /** e2e: force the reconnect path */
  simulateDrop?(): void;
}

/** Exposed as window.voiceDebug for the e2e harness (same shape as voice-proto). */
export interface VoiceDebug {
  events: Json[];
  transcript: { role: string; text: string; ms?: Json; at?: number }[];
  tools: { name: string; args: string; ok: boolean; ms: number; preview: string; at?: number; responseId?: string }[];
  errors: string[];
  contexts: { at: number; turn: number; chars: number; replaced?: string }[];
  readonly state: ConnState;
  readonly activeResponse: string | null;
  /** assistant audio is playing (between output_audio_buffer.started and .stopped/.cleared) */
  readonly audioPlaying: boolean;
  unpaired(): string[];
  dropped(): string[];
  bargeIn: null | { text: string; on: 'item' | 'args' };
  sendText(text: string): void;
  /** e2e: force the reconnect path */
  simulateDrop(): void;
}

export const CONTEXT_MIN_INTERVAL_MS = 1000;

export interface ConversationOptions {
  /** clock (ms); performance.now by default */
  now?: () => number;
  /** max wait for a fresh snapshot before a text turn is sent (ms) */
  contextWaitMs?: number;
}

export class RealtimeConversation {
  private view: RealtimeView;
  private backend: AssistantBackend;
  private host: RealtimeHost;
  private now: () => number;
  private contextWaitMs: number;
  activeResponse: string | null = null;
  audioPlaying = false;
  private pendingCreate = false;
  /** incremented whenever the user starts a new turn (speech or text); detects barge-in during tool calls */
  private userTurn = 0;
  private responseTurn = new Map<string, number>();
  private calls = new Map<string, ToolCall>();
  private assistantText = new Map<string, string>();
  private assistantAt = new Map<string, number>();
  private turnStart = 0;
  private turnT0 = 0;
  private turnMarks = { firstText: 0, firstAudio: 0 };
  /** first assistant message of the turn finished before its audio started: fill in first_audio later */
  private firstAudioPending: { entry: { ms?: Json }; t0: number } | null = null;
  private sessionStart = 0;
  sessionId: string | undefined;
  /** bumped on detach(): results of the old session must not be sent to the new one */
  private generation = 0;
  // live context
  private ctxText = '';
  private ctxItem: string | null = null;
  private ctxSeq = 0;
  private ctxLast = 0;
  private ctxInflight: Promise<void> | null = null;
  /** recap material for reconnects */
  history: { role: 'user' | 'assistant'; text: string }[] = [];
  readonly debug: VoiceDebug;

  constructor(view: RealtimeView, backend: AssistantBackend, host: RealtimeHost, opts: ConversationOptions = {}) {
    this.view = view;
    this.backend = backend;
    this.host = host;
    this.now = opts.now ?? (() => performance.now());
    this.contextWaitMs = opts.contextWaitMs ?? 400;
    const self = this;
    this.debug = {
      events: [],
      transcript: [],
      tools: [],
      errors: [],
      contexts: [],
      get state() {
        return self.host.state;
      },
      get activeResponse() {
        return self.activeResponse;
      },
      get audioPlaying() {
        return self.audioPlaying;
      },
      unpaired: () => [...self.calls.values()].filter((c) => !c.outputSent).map((c) => `${c.name}:${c.callId}`),
      dropped: () => [...self.calls.values()].filter((c) => c.dropped).map((c) => `${c.name}:${c.callId}`),
      bargeIn: null,
      sendText: (t: string) => void self.sendText(t),
      simulateDrop: () => self.host.simulateDrop?.(),
    };
  }

  // ------------------------------------------------------------------ session lifecycle

  /** A (new) session is open: optional recap of the previous one, then the initial snapshot. */
  attach(opts: { sessionId?: string; context: GameContext | null; isReconnect: boolean }) {
    this.sessionId = opts.sessionId;
    this.sessionStart = this.now();
    // fresh conversation on the server side: forget the previous context item
    this.ctxItem = null;
    this.ctxText = '';
    if (opts.isReconnect && this.history.length) this.sendRecap();
    this.applyContext(opts.context);
  }

  /** The transport is closed: nothing in flight can be answered in that conversation any more. */
  detach() {
    this.generation++;
    this.activeResponse = null;
    this.audioPlaying = false;
    this.pendingCreate = false;
    // calls of the old session can never be answered there
    for (const c of this.calls.values()) if (!c.outputSent) (c.outputSent = true), (c.dropped = true);
  }

  /** a user-initiated start: forget the previous conversation */
  reset() {
    this.history = [];
  }

  showError(msg: string) {
    this.view.error(msg);
    this.debug.errors.push(msg);
  }

  /** the new session starts empty: give it the last few exchanges */
  private sendRecap() {
    const lines = this.history.slice(-10).map((h) => `${h.role === 'user' ? 'User' : 'You'}: ${h.text.slice(0, 400)}`);
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: `The voice connection was re-established. Conversation so far (most recent last):\n${lines.join('\n')}` }],
      },
    });
  }

  // ------------------------------------------------------------------ live context

  applyContext(ctx: GameContext | null) {
    if (!ctx || !ctx.text || ctx.text === this.ctxText || !this.host.open) return;
    const id = `ctx_${Date.now().toString(36)}_${++this.ctxSeq}`;
    this.send({
      type: 'conversation.item.create',
      item: { id, type: 'message', role: 'system', content: [{ type: 'input_text', text: ctx.text }] },
    });
    const old = this.ctxItem;
    if (old) this.send({ type: 'conversation.item.delete', item_id: old });
    this.ctxItem = id;
    this.ctxText = ctx.text;
    this.ctxLast = this.now();
    this.debug.contexts.push({ at: Math.round(this.now() - this.sessionStart), turn: ctx.turn, chars: ctx.text.length, ...(old ? { replaced: old } : {}) });
  }

  /** Fetch a fresh snapshot and add it if the game changed (throttled; never throws). */
  refreshContext(): Promise<void> {
    if (this.ctxInflight) return this.ctxInflight;
    if (this.now() - this.ctxLast < CONTEXT_MIN_INTERVAL_MS) return Promise.resolve();
    this.ctxInflight = this.backend
      .context()
      .then((ctx) => this.applyContext(ctx))
      .catch(() => {})
      .finally(() => (this.ctxInflight = null));
    return this.ctxInflight;
  }

  // ------------------------------------------------------------------ events

  private send(event: Json) {
    if (!this.host.open) return;
    this.debug.events.push({
      t: Math.round(this.now() - this.sessionStart),
      type: `>> ${event.type}`,
      ...(event.item?.type ? { item: event.item.type } : {}),
      ...(event.previous_item_id ? { after: event.previous_item_id } : {}),
    });
    this.host.send(event);
  }

  private requestResponse() {
    if (this.activeResponse) {
      this.pendingCreate = true;
      return;
    }
    this.pendingCreate = false;
    this.send({ type: 'response.create' });
  }

  /** Handle one server event from the Realtime channel. */
  onEvent(ev: Json) {
    this.debug.events.push({
      t: Math.round(this.now() - this.sessionStart),
      type: ev.type,
      ...(ev.response?.id || ev.response_id ? { rid: ev.response?.id ?? ev.response_id } : {}),
      ...(ev.response?.status ? { status: ev.response.status, reason: ev.response.status_details?.reason } : {}),
      ...(ev.item?.type ? { item: ev.item.type, id: ev.item.id } : {}),
      ...(ev.error ? { code: ev.error.code, msg: ev.error.message } : {}),
    });
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.userTurn++;
        this.view.listening(true);
        this.view.user(ev.item_id, '', false);
        // the user's audio item is committed when they stop speaking, so a snapshot added now lands before it
        void this.refreshContext();
        break;
      case 'input_audio_buffer.speech_stopped':
        this.view.listening(false);
        this.turnStart = this.turnT0 = this.now();
        this.turnMarks = { firstText: 0, firstAudio: 0 };
        this.firstAudioPending = null;
        break;
      case 'conversation.item.input_audio_transcription.delta':
        this.view.user(ev.item_id, ev.delta ?? '', false);
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const text = (ev.transcript ?? '').trim();
        this.view.user(ev.item_id, text || '(no speech recognized)', true);
        this.debug.transcript.push({ role: 'user', text: ev.transcript });
        if (text) this.history.push({ role: 'user', text });
        this.backend.log({ kind: 'user', via: 'voice', text: ev.transcript });
        break;
      }
      case 'conversation.item.input_audio_transcription.failed':
        this.view.user(ev.item_id, '(transcription failed)', true);
        break;

      case 'response.created':
        this.activeResponse = ev.response?.id ?? 'unknown';
        if (ev.response?.id) this.responseTurn.set(ev.response.id, this.userTurn);
        break;

      case 'response.output_item.added':
        if (ev.item?.type === 'function_call') {
          this.toolCall(ev.item.call_id, ev.item.name, ev.response_id);
          this.maybeBargeIn('item');
        }
        break;

      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta': {
        const prev = this.assistantText.get(ev.item_id) ?? '';
        if (!this.assistantText.has(ev.item_id) && this.turnT0) this.assistantAt.set(ev.item_id, Math.round(this.now() - this.turnT0));
        const text = prev + (ev.delta ?? '');
        this.assistantText.set(ev.item_id, text);
        if (this.turnStart && !this.turnMarks.firstText) this.turnMarks.firstText = this.now();
        this.view.assistant(ev.item_id, text, false);
        break;
      }
      case 'response.output_audio_transcript.done':
      case 'response.output_text.done': {
        const text = ev.transcript ?? ev.text ?? this.assistantText.get(ev.item_id) ?? '';
        const ms: Json = {};
        if (this.turnStart && this.turnMarks.firstText) ms.first_text = Math.round(this.turnMarks.firstText - this.turnStart);
        if (this.turnStart && this.turnMarks.firstAudio) ms.first_audio = Math.round(this.turnMarks.firstAudio - this.turnStart);
        const at = this.assistantAt.get(ev.item_id);
        this.view.assistant(ev.item_id, text, true, { ...ms, ...(at !== undefined ? { at } : {}) });
        const entry = { role: 'assistant', text, ms, at };
        this.debug.transcript.push(entry);
        // audio usually starts before the transcript finishes, but not always for short preambles
        if (this.turnStart && ms.first_audio === undefined) this.firstAudioPending = { entry, t0: this.turnStart };
        // only the first assistant message of a turn gets latency marks
        this.turnStart = 0;
        if (text) this.history.push({ role: 'assistant', text });
        this.backend.log({ kind: 'assistant', text, ms, at });
        break;
      }
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.audioPlaying = false;
        break;
      case 'output_audio_buffer.started':
        this.audioPlaying = true;
        if (this.firstAudioPending) {
          const p = this.firstAudioPending;
          p.entry.ms = { ...p.entry.ms, first_audio: Math.round(this.now() - p.t0) };
          this.firstAudioPending = null;
        } else if (this.turnStart && !this.turnMarks.firstAudio) this.turnMarks.firstAudio = this.now();
        break;

      case 'response.function_call_arguments.done': {
        const call = this.toolCall(ev.call_id, ev.name, ev.response_id);
        call.args = ev.arguments ?? '{}';
        this.runCall(call);
        this.maybeBargeIn('args');
        break;
      }
      case 'response.done':
        void this.onResponseDone(ev.response ?? {});
        break;

      case 'error': {
        const code = ev.error?.code as string | undefined;
        const msg = (ev.error?.message as string | undefined) ?? 'Unknown realtime error';
        // benign races: response.create while one is active; cancel after it finished on its own
        if (code === 'conversation_already_has_active_response') {
          this.pendingCreate = true;
          break;
        }
        if (code === 'response_cancel_not_active') break;
        // deleting a superseded context item that is already gone (e.g. truncated away)
        if (/ctx_/.test(msg) || /ctx_/.test(String(ev.error?.param ?? ''))) break;
        if (code === 'session_expired' || /maximum duration|session.*expired/i.test(msg)) {
          this.host.transportLost('session expired');
          break;
        }
        this.showError(`Realtime error: ${msg}`);
        break;
      }
    }
  }

  private maybeBargeIn(on: 'item' | 'args') {
    if (this.debug.bargeIn?.on !== on) return;
    const t = this.debug.bargeIn.text;
    this.debug.bargeIn = null;
    void this.sendText(t);
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
  private async onResponseDone(resp: Json) {
    if (this.activeResponse === resp.id || this.activeResponse === 'unknown') this.activeResponse = null;
    if (resp.status === 'failed') {
      const d = resp.status_details?.error;
      this.showError(`Response failed: ${d?.message ?? d?.code ?? JSON.stringify(resp.status_details)}`);
    }
    const fnCalls: Json[] = (resp.output ?? []).filter((o: Json) => o.type === 'function_call');
    const turnOfResponse = this.responseTurn.get(resp.id) ?? this.userTurn;
    const gen = this.generation;
    if (fnCalls.length) {
      const completed = resp.status === 'completed' || resp.status === undefined;
      const calls = fnCalls.map((fc) => {
        const call = this.toolCall(fc.call_id, fc.name, resp.id);
        call.args = fc.arguments ?? call.args;
        return { fc, call };
      });
      if (completed) {
        for (const { call } of calls) this.runCall(call);
        await Promise.all(calls.map(({ call }) => call.promise));
        if (gen !== this.generation) return; // reconnected meanwhile: that conversation is gone
        if (this.userTurn === turnOfResponse) {
          for (const { call } of calls) this.sendOutput(call, call.result!);
          this.requestResponse();
        } else {
          this.insertOutputs(calls.map(({ fc, call }) => ({ fc, call, output: call.result! })));
        }
      } else {
        const note = (c: ToolCall) =>
          `INTERRUPTED: the user spoke before this ${c.name} result was used, so it was not run to completion. ` +
          "Answer the user's latest message; call the tool again only if it is still needed.";
        this.insertOutputs(
          calls.map(({ fc, call }) => {
            const usable = fc.status !== 'incomplete' && call.result !== undefined;
            if (!usable) this.markDropped(call);
            return { fc, call, output: usable ? call.result! : note(call) };
          }),
        );
      }
    }
    if (this.pendingCreate && !this.activeResponse) this.requestResponse();
  }

  private sendOutput(call: ToolCall, output: string, previousItemId?: string, id?: string) {
    if (call.outputSent) return;
    call.outputSent = true;
    this.send({
      type: 'conversation.item.create',
      ...(previousItemId ? { previous_item_id: previousItemId } : {}),
      item: { ...(id ? { id } : {}), type: 'function_call_output', call_id: call.callId, output },
    });
  }

  /** Insert outputs directly after the last function_call item of the response, chained in order. */
  private insertOutputs(list: { fc: Json; call: ToolCall; output: string }[]) {
    let prev: string | undefined = list[list.length - 1]?.fc.id;
    for (const { call, output } of list) {
      const id = `fco_${call.callId.replace(/[^A-Za-z0-9]/g, '').slice(-20)}`;
      this.sendOutput(call, output, prev, id);
      prev = id;
    }
  }

  private markDropped(call: ToolCall) {
    call.dropped = true;
    this.view.tool(call);
    this.debug.transcript.push({ role: 'tool', text: `${call.name} dropped: response interrupted before the result was used` });
  }

  // ------------------------------------------------------------------ tools

  private toolCall(callId: string, name: string, responseId?: string): ToolCall {
    const existing = this.calls.get(callId);
    if (existing) return existing;
    const call: ToolCall = { callId, name, args: '', responseId };
    this.calls.set(callId, call);
    this.view.tool(call);
    return call;
  }

  private runCall(call: ToolCall) {
    if (call.promise) return;
    let args: Json = {};
    try {
      args = JSON.parse(call.args || '{}');
    } catch {
      /* model sent bad JSON: run with no args, the tool reports what is missing */
    }
    this.view.tool(call);
    const t0 = this.now();
    const at = this.turnT0 ? Math.round(t0 - this.turnT0) : undefined;
    call.promise = this.backend.tool(call.name, args, call.callId, this.sessionId).then(({ ok, result, ms: serverMs }) => {
      const ms = Math.round(this.now() - t0);
      call.ok = ok;
      call.ms = ms;
      call.serverMs = serverMs;
      call.result = ok ? result : `ERROR: ${result}`;
      this.view.tool(call);
      this.debug.tools.push({ name: call.name, args: call.args, ok, ms, preview: result.slice(0, 200), at, responseId: call.responseId });
      this.debug.transcript.push({
        role: 'tool',
        at,
        text: `${call.name} ${call.args} -> ${ok ? 'ok' : 'FAIL'} ${ms}ms (${result.length} chars): ${result.replace(/\s+/g, ' ').slice(0, 150)}`,
      });
      this.backend.log({ kind: 'tool', name: call.name, args, ok, ms, chars: result.length });
      return call.result;
    });
  }

  // ------------------------------------------------------------------ text input

  async sendText(text: string) {
    if (!text.trim() || this.host.state !== 'connected') return;
    this.userTurn++;
    if (this.activeResponse) this.send({ type: 'response.cancel' });
    const key = `text_${Date.now().toString(36)}`;
    this.view.user(key, text, true);
    this.debug.transcript.push({ role: 'user', text });
    this.history.push({ role: 'user', text });
    this.backend.log({ kind: 'user', via: 'text', text });
    // make sure the model sees the game as it is now (bounded wait; usually ~10 ms)
    await Promise.race([this.refreshContext(), new Promise((r) => setTimeout(r, this.contextWaitMs))]);
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    this.turnStart = this.turnT0 = this.now();
    this.turnMarks = { firstText: 0, firstAudio: 0 };
    this.firstAudioPending = null;
    this.activeResponse = null; // cancelled (if any); response.done will follow
    this.pendingCreate = false; // this create supersedes any queued one
    this.send({ type: 'response.create' });
  }
}
