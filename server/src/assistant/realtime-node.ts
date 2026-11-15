/**
 * Node driver for the voice assistant over the OpenAI Realtime WebSocket
 * transport (server-side use: the eval suite, scripted tests).  It hosts the
 * same RealtimeConversation as the browser (shared/assistant/realtime-core.ts):
 * same session config, tool loop, live-context snapshots and text turns; only
 * the transport differs.
 *
 *  - text mode: output_modalities ['text']; questions are sent like the
 *    browser's text input (sendText).
 *  - audio mode: the question is streamed as 24 kHz PCM16 into the input
 *    audio buffer in real time, so server VAD, transcription and the audio
 *    answer behave like a spoken turn.  WebRTC's output_audio_buffer.* events
 *    do not exist on WebSockets; they are synthesized from the first
 *    response.output_audio.delta / response.done so the core's first-audio
 *    latency mark works unchanged.
 */
import WebSocket from 'ws';
import {
  RealtimeConversation,
  type AssistantBackend,
  type ConnState,
  type GameContext,
  type Json,
  type RealtimeHost,
  type RealtimeView,
  type ToolCall,
} from '../../../shared/assistant/realtime-core.ts';

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  input_text: number;
  input_audio: number;
  cached_text: number;
  cached_audio: number;
  output_text: number;
  output_audio: number;
  reasoning: number;
}

export const emptyUsage = (): Usage => ({
  input_tokens: 0, output_tokens: 0, input_text: 0, input_audio: 0, cached_text: 0, cached_audio: 0, output_text: 0, output_audio: 0, reasoning: 0,
});

export function addUsage(a: Usage, u: Json | undefined): Usage {
  if (!u) return a;
  const i = u.input_token_details ?? {};
  const c = i.cached_tokens_details ?? {};
  const o = u.output_token_details ?? {};
  a.input_tokens += u.input_tokens ?? 0;
  a.output_tokens += u.output_tokens ?? 0;
  a.input_text += i.text_tokens ?? 0;
  a.input_audio += i.audio_tokens ?? 0;
  a.cached_text += c.text_tokens ?? 0;
  a.cached_audio += c.audio_tokens ?? 0;
  a.output_text += o.text_tokens ?? 0;
  a.output_audio += o.audio_tokens ?? 0;
  a.reasoning += o.reasoning_tokens ?? 0;
  return a;
}

export interface TurnRecord {
  /** what was asked (text, or the intended text of a spoken question) */
  input: string;
  /** what the model heard (audio mode: the input transcription) */
  heard?: string;
  /** final assistant messages of this turn, in order (preambles included) */
  messages: string[];
  answer: string;
  tools: { name: string; args: Json; ok: boolean; ms: number; result: string; round: number }[];
  /** model responses in this turn; rounds = responses that called tools */
  responses: number;
  rounds: number;
  latency: { first_text?: number; first_audio?: number; total: number };
  usage: Usage;
  errors: string[];
  unpaired: string[];
  /** live-context snapshots added during this turn */
  contexts: number;
  /** expert consultations started during this turn (their results were awaited and spoken within the turn) */
  expert?: ExpertRecord[];
}

export interface ExpertRecord {
  id: string;
  question: string;
  status: string;
  ok: boolean;
  error?: string;
  /** expert run time (ms) */
  ms: number;
  rounds: number;
  tools: { name: string; args: Json; ok: boolean; ms: number }[];
  answer: string;
  keyFacts: string[];
  confidence: string;
  spoiler: boolean;
  spoilerDetails?: string;
  unknowns: string[];
  cost: number;
  usage?: { input: number; cached: number; output: number; reasoning: number };
  interrupted?: boolean;
}

export interface NodeSessionOptions {
  apiKey: string;
  /** full session config (buildSessionConfig output, variant overrides applied) */
  session: Json;
  backend: AssistantBackend;
  /** snapshot to add right after connecting (like the minted session's context) */
  initialContext: GameContext | null;
  mode: 'text' | 'audio';
  url?: string;
  /** give up on a turn after this long (ms) */
  turnTimeoutMs?: number;
}

/** records what the browser panel would render */
class RecorderView implements RealtimeView {
  finals: { key: string; text: string; latency?: Json }[] = [];
  users: Map<string, string> = new Map();
  state() {}
  error() {}
  system() {}
  user(key: string, text: string, final: boolean) {
    if (final) this.users.set(key, text);
  }
  assistant(key: string, text: string, final: boolean, latency?: Json) {
    if (final) this.finals.push({ key, text, latency });
  }
  /** every tool call, in the order the model made them (results filled in when they finish) */
  calls: ToolCall[] = [];
  tool(call: ToolCall) {
    if (!this.calls.includes(call)) this.calls.push(call);
  }
  listening() {}
  mic() {}
}

export class NodeRealtimeSession implements RealtimeHost {
  state: ConnState = 'idle';
  private ws: WebSocket | null = null;
  readonly conversation: RealtimeConversation;
  private view = new RecorderView();
  private opts: NodeSessionOptions;
  /** per-response bookkeeping for the current turn */
  private turn: {
    responses: Json[];
    usage: Usage;
    errors: string[];
    lastDoneAt: number;
    finalSeen: boolean;
    audioStarted: Set<string>;
  } | null = null;
  private listeners = new Set<(ev: Json) => void>();
  sessionId?: string;

  private constructor(opts: NodeSessionOptions) {
    this.opts = opts;
    this.conversation = new RealtimeConversation(this.view, opts.backend, this);
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(event: Json) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }

  transportLost(why: string) {
    this.state = 'error';
    this.turn?.errors.push(`transport lost: ${why}`);
  }

  static async open(opts: NodeSessionOptions): Promise<NodeRealtimeSession> {
    const s = new NodeRealtimeSession(opts);
    await s.connect();
    return s;
  }

  private connect(): Promise<void> {
    const { session } = this.opts;
    const url = this.opts.url ?? `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(session.model)}`;
    this.state = 'connecting';
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.opts.apiKey}` } });
    this.ws = ws;
    return new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('timed out connecting to the Realtime API')), 20_000);
      ws.on('open', () => {
        const cfg = { ...session, output_modalities: this.opts.mode === 'text' ? ['text'] : ['audio'] };
        ws.send(JSON.stringify({ type: 'session.update', session: cfg }));
      });
      ws.on('message', (data) => {
        let ev: Json;
        try {
          ev = JSON.parse(String(data));
        } catch {
          return;
        }
        if (ev.type === 'session.created') this.sessionId = ev.session?.id;
        if (ev.type === 'session.updated' && this.state === 'connecting') {
          clearTimeout(to);
          this.state = 'connected';
          this.conversation.attach({ sessionId: this.sessionId, context: this.opts.initialContext, isReconnect: false });
          resolve();
        }
        if (ev.type === 'error' && this.state === 'connecting') {
          clearTimeout(to);
          reject(new Error(`Realtime error: ${ev.error?.message ?? JSON.stringify(ev.error)}`));
        }
        this.dispatch(ev);
      });
      ws.on('error', (e) => {
        clearTimeout(to);
        if (this.state === 'connecting') reject(e);
        else this.transportLost(e.message);
      });
      ws.on('close', () => {
        if (this.state === 'connected') this.transportLost('socket closed');
        this.state = 'idle';
      });
    });
  }

  private dispatch(ev: Json) {
    const t = this.turn;
    // WebSocket transport: synthesize WebRTC's playback events for the core
    if (ev.type === 'response.output_audio.delta' && t && !t.audioStarted.has(ev.response_id)) {
      t.audioStarted.add(ev.response_id);
      this.conversation.onEvent({ type: 'output_audio_buffer.started', response_id: ev.response_id });
    }
    if (ev.type === 'response.output_audio.delta' || ev.type === 'response.output_text.delta' || ev.type === 'response.output_audio_transcript.delta') {
      // deltas are only needed by the core (text accumulation, first-text mark)
      this.conversation.onEvent(ev);
      return;
    }
    this.conversation.onEvent(ev);
    if (ev.type === 'response.done') {
      if (t) {
        t.responses.push(ev.response ?? {});
        addUsage(t.usage, ev.response?.usage);
        t.lastDoneAt = Date.now();
        const calls = (ev.response?.output ?? []).some((o: Json) => o.type === 'function_call');
        if (!calls) t.finalSeen = true;
        if (ev.response?.status === 'failed') t.errors.push(`response failed: ${JSON.stringify(ev.response.status_details)}`);
      }
      if (t?.audioStarted.has(ev.response?.id)) this.conversation.onEvent({ type: 'output_audio_buffer.stopped', response_id: ev.response?.id });
    }
    if (ev.type === 'error' && t) {
      const code = ev.error?.code;
      if (code !== 'conversation_already_has_active_response' && code !== 'response_cancel_not_active' && !/ctx_/.test(String(ev.error?.message ?? ''))) {
        t.errors.push(`${code ?? 'error'}: ${ev.error?.message}`);
      }
    }
    for (const l of this.listeners) l(ev);
  }

  private beginTurn() {
    this.turn = { responses: [], usage: emptyUsage(), errors: [], lastDoneAt: 0, finalSeen: false, audioStarted: new Set() };
    return {
      transcript: this.conversation.debug.transcript.length,
      tools: this.conversation.debug.tools.length,
      finals: this.view.finals.length,
      calls: this.view.calls.length,
      contexts: this.conversation.debug.contexts.length,
      experts: this.conversation.experts.list.length,
    };
  }

  /** wait until the model gave its final answer of the turn and nothing is in flight */
  private async waitTurnDone(t0: number) {
    // expert consultations take up to ~90 s and are spoken within the turn
    const limit = this.opts.turnTimeoutMs ?? (this.opts.backend.expert ? 200_000 : 90_000);
    for (;;) {
      const t = this.turn!;
      const idle = !this.conversation.activeResponse && this.conversation.debug.unpaired().length === 0 && this.conversation.experts.settled;
      if (idle && t.finalSeen && Date.now() - t.lastDoneAt > 300) return;
      if (t.errors.length && idle && Date.now() - t.lastDoneAt > 1000 && t.responses.length) return;
      if (this.state !== 'connected') return;
      if (Date.now() - t0 > limit) {
        t.errors.push(`turn timed out after ${limit} ms`);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private collect(input: string, before: ReturnType<NodeRealtimeSession['beginTurn']>, t0: number, heard?: string): TurnRecord {
    const t = this.turn!;
    const d = this.conversation.debug;
    const finals = this.view.finals.slice(before.finals);
    const assistants = d.transcript.slice(before.transcript).filter((m) => m.role === 'assistant');
    const roundOf = new Map<string, number>();
    let r = 0;
    for (const resp of t.responses) if ((resp.output ?? []).some((o: Json) => o.type === 'function_call')) roundOf.set(resp.id, ++r);
    const tools = this.view.calls.slice(before.calls).map((c) => {
      let args: Json = {};
      try {
        args = JSON.parse(c.args || '{}');
      } catch {
        /* keep empty */
      }
      return { name: c.name, args, ok: !!c.ok, ms: c.ms ?? 0, result: c.result ?? (c.dropped ? '(dropped)' : '(no result)'), round: roundOf.get(c.responseId ?? '') ?? 0 };
    });
    const firstMs = assistants[0]?.ms ?? {};
    return {
      input,
      heard,
      messages: finals.map((f) => f.text),
      answer: finals.map((f) => f.text).join(' ').trim(),
      tools,
      responses: t.responses.length,
      rounds: r,
      latency: { first_text: firstMs.first_text, first_audio: firstMs.first_audio, total: (t.lastDoneAt || Date.now()) - t0 },
      usage: t.usage,
      errors: [...t.errors, ...d.errors.splice(0)],
      unpaired: d.unpaired(),
      contexts: d.contexts.length - before.contexts,
      expert: this.conversation.experts.list.slice(before.experts).map((c) => ({
        id: c.id,
        question: c.question,
        status: c.status,
        ok: !!c.result?.ok,
        ...(c.result?.error ? { error: c.result.error } : {}),
        ms: c.result?.ms ?? 0,
        rounds: c.result?.rounds ?? 0,
        tools: c.result?.tools ?? [],
        answer: c.result?.answer ?? '',
        keyFacts: c.result?.keyFacts ?? [],
        confidence: c.result?.confidence ?? '',
        spoiler: !!c.result?.spoiler,
        ...(c.result?.spoilerDetails ? { spoilerDetails: c.result.spoilerDetails } : {}),
        unknowns: c.result?.unknowns ?? [],
        cost: c.result?.cost ?? 0,
        usage: c.result?.usage,
        ...(c.interrupted ? { interrupted: true } : {}),
      })),
    };
  }

  /** Ask a typed question (the browser's text input path). */
  async ask(text: string): Promise<TurnRecord> {
    const before = this.beginTurn();
    const t0 = Date.now();
    await this.conversation.sendText(text);
    await this.waitTurnDone(t0);
    return this.collect(text, before, t0);
  }

  /**
   * Speak a question: stream 24 kHz mono PCM16 in real time (20 ms chunks), then silence until the
   * server VAD ends the turn; the core reacts to speech_started / speech_stopped like in the browser.
   */
  async speak(pcm: Buffer, intended: string): Promise<TurnRecord> {
    const before = this.beginTurn();
    const t0 = Date.now();
    let stopped = false;
    let stoppedAt = 0;
    let heard: string | undefined;
    const onEv = (ev: Json) => {
      if (ev.type === 'input_audio_buffer.speech_stopped') (stopped = true), (stoppedAt = Date.now());
      if (ev.type === 'conversation.item.input_audio_transcription.completed') heard = ev.transcript;
    };
    this.listeners.add(onEv);
    const CHUNK = 960; // 20 ms at 24 kHz, 16-bit
    const silence = Buffer.alloc(CHUNK);
    const start = Date.now();
    let sent = 0;
    const pace = async () => {
      const due = start + (sent * 20);
      const wait = due - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    };
    for (let off = 0; off < pcm.length; off += CHUNK) {
      await pace();
      this.send({ type: 'input_audio_buffer.append', audio: pcm.subarray(off, off + CHUNK).toString('base64') });
      sent++;
    }
    // trailing silence (VAD needs it to end the turn); keep the mic "open" like a real one
    const silenceUntil = Date.now() + 8000;
    while (!stopped && Date.now() < silenceUntil) {
      await pace();
      this.send({ type: 'input_audio_buffer.append', audio: silence.toString('base64') });
      sent++;
    }
    if (!stopped) this.turn!.errors.push('VAD never detected the end of speech');
    // keep sending silence while the answer is produced (a live mic would), so VAD state stays realistic
    let streaming = true;
    const bg = (async () => {
      while (streaming && this.open) {
        await pace();
        this.send({ type: 'input_audio_buffer.append', audio: silence.toString('base64') });
        sent++;
      }
    })();
    await this.waitTurnDone(t0);
    streaming = false;
    await bg;
    this.listeners.delete(onEv);
    // wait for the transcription if it arrives late
    for (let i = 0; i < 40 && heard === undefined; i++) await new Promise((r) => setTimeout(r, 50));
    // latency marks count from the end of speech (VAD), like the browser's
    return this.collect(intended, before, stoppedAt || t0, heard);
  }

  close() {
    this.state = 'idle';
    this.conversation.endSession();
    this.conversation.detach();
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
  }
}
