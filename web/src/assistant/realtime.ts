/**
 * OpenAI Realtime (GA) client over WebRTC, ported from voice-proto/web/main.ts.
 *
 *  - Our server mints a short-lived client secret; the browser uses it only
 *    for the SDP exchange with api.openai.com/v1/realtime/calls.
 *  - Everything on the "oai-events" data channel (tool calls paired with
 *    exactly one function_call_output, live game context snapshots, text
 *    turns, latency marks) is handled by the transport-agnostic
 *    RealtimeConversation in shared/assistant/realtime-core.ts, which the
 *    eval suite drives over a Realtime WebSocket from Node.
 *  - This class owns the transport: WebRTC peer connection, microphone,
 *    audio playback, and automatic reconnects (with a short recap of the
 *    conversation) after unexpected disconnects / session expiry.
 *  - There is no explicit start/stop: the session connects lazily on the
 *    first mic-on or typed message (typed text is queued until then).  The
 *    peer connection always has one sendrecv audio transceiver; the mic is
 *    acquired only when switched on and attached / detached with
 *    replaceTrack (no renegotiation).  Mic off stops the track, so nothing
 *    is captured or sent and the browser's recording indicator goes away.
 *
 * DOM-free: all rendering goes through the RealtimeView interface.
 */
import {
  RealtimeConversation,
  type AssistantBackend,
  type ConnState,
  type RealtimeHost,
  type RealtimeView,
  type VoiceDebug,
} from '../../../shared/assistant/realtime-core.ts';
import { assistantApi, type MintedSession } from './api.ts';

export type { ConnState, Consultation, RealtimeView, ToolCall, VoiceDebug } from '../../../shared/assistant/realtime-core.ts';

export interface StartOptions {
  model: string;
  voice: string;
  reasoning: string;
}

const MAX_RECONNECTS = 3;
/** after the mic closes, wait for in-flight audio / a late speech_started before finishing the turn */
const MIC_CLOSE_SETTLE_MS = 300;

/** the browser talks to our server's /api/assistant routes */
const backend: AssistantBackend = {
  tool: (name, args, callId, sessionId) => assistantApi.tool(name, args, callId, sessionId),
  context: () => assistantApi.context(),
  log: (entry) => assistantApi.log(entry),
  expert: (req, signal) => assistantApi.expert(req, signal),
};

type ConnectMode = 'fresh' | 'reconnect' | 'switch';

export class RealtimeClient implements RealtimeHost {
  private view: RealtimeView;
  /** current model / voice / reasoning (read at every connect) */
  private options: () => StartOptions;
  state: ConnState = 'idle';
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  /** the audio transceiver's sender; the mic track is swapped in / out with replaceTrack */
  private sender: RTCRtpSender | null = null;
  private audioEl: HTMLAudioElement | null = null;
  /** the user wants the mic on */
  micOn = false;
  /** the live microphone (only while micOn and getUserMedia succeeded) */
  private micStream: MediaStream | null = null;
  /** the last getUserMedia attempt failed (retried on the next mic-on) */
  private micFailed = false;
  /** bumped on every mic on/off: a getUserMedia that resolves late for a stale request is discarded */
  private micSeq = 0;
  private pttHeld = false;
  private micBeforePtt = false;
  private reconnects: number[] = [];
  private generation = 0;
  private statusDetail: string | null = null;
  readonly conversation: RealtimeConversation;
  readonly debug: VoiceDebug;

  constructor(view: RealtimeView, options: () => StartOptions) {
    this.view = view;
    this.options = options;
    this.conversation = new RealtimeConversation(view, backend, this);
    this.debug = this.conversation.debug;
  }

  get connected() {
    return this.state === 'connected';
  }
  get hasMic() {
    return !!this.micStream;
  }

  // ------------------------------------------------------------------ RealtimeHost

  get open() {
    return this.dc?.readyState === 'open';
  }

  send(event: Record<string, unknown>) {
    if (this.dc?.readyState !== 'open') return;
    this.dc.send(JSON.stringify(event));
  }

  transportLost(why: string) {
    this.onTransportLost(why);
  }

  simulateDrop() {
    this.onTransportLost('simulated drop');
  }

  /** Connect unless connected / connecting already (a failed connect is retried here). */
  ensureConnected() {
    if (this.state !== 'idle' && this.state !== 'error') return;
    this.reconnects = [];
    this.view.error(null);
    void this.connect('fresh');
  }

  // ------------------------------------------------------------------ lifecycle

  /** model / voice changed: a live session switches over (with a recap), otherwise nothing to do */
  reconfigure() {
    if (this.state === 'idle' || this.state === 'error') return;
    const mode: ConnectMode = this.state === 'connecting' ? 'fresh' : 'switch';
    this.teardown();
    void this.connect(mode);
  }

  private setState(st: ConnState, detail?: string) {
    this.state = st;
    this.statusDetail = detail ?? null;
    this.render();
  }

  /** status text reflects connection + mic together */
  private render() {
    const st = this.state;
    const text =
      this.statusDetail ??
      (st === 'connected'
        ? this.micOn
          ? this.micStream
            ? 'Listening'
            : 'Opening mic…'
          : 'Mic off · text only'
        : { idle: 'Mic off', connecting: 'Connecting…', connected: '', reconnecting: 'Reconnecting…', error: 'Error' }[st]);
    this.view.state(st, text);
    this.view.mic(!this.micOn, !this.micFailed);
  }

  private async connect(mode: ConnectMode) {
    const gen = ++this.generation;
    const opts = this.options();
    const isReconnect = mode !== 'fresh';
    this.setState(isReconnect ? 'reconnecting' : 'connecting', mode === 'switch' ? 'Switching…' : undefined);
    try {
      const t0 = performance.now();
      const token: MintedSession = await assistantApi.mint(opts);
      if (gen !== this.generation) return;
      const pc = new RTCPeerConnection();
      this.pc = pc;
      const audio = document.createElement('audio');
      audio.autoplay = true;
      this.audioEl = audio;
      pc.ontrack = (e) => (audio.srcObject = e.streams[0]);
      pc.onconnectionstatechange = () => {
        if (this.pc !== pc) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this.onTransportLost(`WebRTC ${pc.connectionState}`);
      };
      // always negotiate a send+receive audio line, so the mic can come and go without renegotiation
      this.sender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
      const track = this.micStream?.getAudioTracks()[0];
      if (track) await this.sender.replaceTrack(track);
      const dc = pc.createDataChannel('oai-events');
      this.dc = dc;
      dc.onmessage = (e) => this.conversation.onEvent(JSON.parse(e.data as string));
      dc.onclose = () => {
        if (this.dc === dc && this.state === 'connected') this.onTransportLost('data channel closed');
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdpRes = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        body: offer.sdp,
        headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/sdp' },
      });
      const answer = await sdpRes.text();
      if (!sdpRes.ok) {
        let msg = answer;
        try {
          msg = JSON.parse(answer).error?.message ?? answer;
        } catch {
          /* plain text */
        }
        throw new Error(`SDP exchange failed (${sdpRes.status}): ${msg}`);
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      await new Promise<void>((resolve, reject) => {
        if (dc.readyState === 'open') return resolve();
        const to = setTimeout(() => reject(new Error('Timed out waiting for the data channel')), 15000);
        dc.addEventListener('open', () => (clearTimeout(to), resolve()), { once: true });
      });
      if (gen !== this.generation) return;
      const connectMs = Math.round(performance.now() - t0);
      // a fresh connect after an earlier session (e.g. one that failed) also gets the recap
      this.conversation.attach({ sessionId: token.session_id, context: token.context, isReconnect: isReconnect || this.conversation.history.length > 0 });
      this.setState('connected');
      if (mode === 'reconnect') this.view.system('Reconnected.');
      if (mode === 'switch') this.view.system(`Switched to ${token.model}, voice ${token.voice}.`);
      assistantApi.log({ kind: 'session', model: token.model, voice: token.voice, reasoning: token.reasoning, mint_ms: token.mint_ms, connect_ms: connectMs, reconnect: isReconnect });
    } catch (err) {
      if (gen !== this.generation) return;
      this.teardown();
      if (isReconnect && this.scheduleReconnect(`reconnect failed: ${(err as Error).message}`)) return;
      this.fail((err as Error).message, 'Error');
    }
  }

  /** gave up: show the error, close the mic; the next mic-on / message tries again */
  private fail(msg: string, detail: string) {
    this.conversation.showError(msg);
    this.micOn = false;
    this.closeMic();
    this.setState('error', detail);
  }

  /** close transport, keep conversation UI and the mic (a reconnect reattaches it) */
  private teardown() {
    this.generation++;
    this.dc?.close();
    this.pc?.close();
    if (this.audioEl) this.audioEl.srcObject = null;
    this.pc = null;
    this.dc = null;
    this.sender = null;
    this.conversation.detach();
    this.view.listening(false);
  }

  private onTransportLost(why: string) {
    if (this.state !== 'connected' && this.state !== 'reconnecting') return;
    this.teardown();
    if (!this.scheduleReconnect(why)) this.fail(`Connection lost (${why}).`, 'Disconnected');
  }

  /** returns false when the reconnect budget is used up */
  private scheduleReconnect(why: string): boolean {
    const now = Date.now();
    this.reconnects = this.reconnects.filter((t) => now - t < 120_000);
    if (this.reconnects.length >= MAX_RECONNECTS) return false;
    this.reconnects.push(now);
    const delay = [500, 2000, 5000][this.reconnects.length - 1] ?? 5000;
    this.view.system(`Connection lost (${why}); reconnecting…`);
    this.setState('reconnecting');
    const gen = this.generation;
    setTimeout(() => {
      if (gen === this.generation) void this.connect('reconnect');
    }, delay);
    return true;
  }

  // ------------------------------------------------------------------ mic

  /** Mic on: connect if needed and open the microphone.  Mic off: stop it (nothing captured or sent). */
  setMic(on: boolean) {
    if (on === this.micOn) return;
    this.micOn = on;
    if (on) {
      this.micFailed = false;
      this.ensureConnected();
      void this.openMic();
    } else this.closeMic();
    this.render();
  }

  toggleMic() {
    this.setMic(!this.micOn);
  }

  /** push-to-talk: mic open while held (connecting first if needed), previous state restored on release */
  pushToTalk(down: boolean) {
    if (down === this.pttHeld) return;
    this.pttHeld = down;
    if (down) {
      this.micBeforePtt = this.micOn;
      this.setMic(true);
    } else this.setMic(this.micBeforePtt);
  }

  private async openMic() {
    const seq = ++this.micSeq;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (seq !== this.micSeq || !this.micOn) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.micStream = stream;
      await this.sender?.replaceTrack(stream.getAudioTracks()[0]);
    } catch (err) {
      if (seq !== this.micSeq) return;
      this.micOn = false;
      this.micFailed = true;
      this.view.system(`Microphone unavailable (${(err as Error).message}); typing still works.`);
    }
    this.render();
  }

  private closeMic() {
    this.micSeq++;
    const stream = this.micStream;
    this.micStream = null;
    void this.sender?.replaceTrack(null).catch(() => {});
    stream?.getTracks().forEach((t) => t.stop());
    if (!stream) return;
    // an utterance in progress would never end for the VAD: finish the turn
    const gen = this.generation;
    setTimeout(() => {
      if (gen === this.generation && !this.micOn) this.conversation.micClosed();
    }, MIC_CLOSE_SETTLE_MS);
  }

  // ------------------------------------------------------------------ live context / text

  /** Fetch a fresh snapshot and add it if the game changed (throttled; never throws). */
  refreshContext(): Promise<void> {
    return this.conversation.refreshContext();
  }

  /** a typed message; connects first if needed (the text is queued until then) */
  sendText(text: string) {
    return this.conversation.sendText(text);
  }

  /** the panel's cancel button on a "Thinking deeply" chip */
  cancelConsultation(id: string) {
    this.conversation.cancelConsultation(id);
  }
}
