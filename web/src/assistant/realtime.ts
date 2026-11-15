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

export type { ConnState, RealtimeView, ToolCall, VoiceDebug } from '../../../shared/assistant/realtime-core.ts';

export interface StartOptions {
  model: string;
  voice: string;
  reasoning: string;
}

const MAX_RECONNECTS = 3;

/** the browser talks to our server's /api/assistant routes */
const backend: AssistantBackend = {
  tool: (name, args, callId, sessionId) => assistantApi.tool(name, args, callId, sessionId),
  context: () => assistantApi.context(),
  log: (entry) => assistantApi.log(entry),
};

export class RealtimeClient implements RealtimeHost {
  private view: RealtimeView;
  state: ConnState = 'idle';
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  muted = false;
  private pttHeld = false;
  private mutedBeforePtt = false;
  private opts: StartOptions | null = null;
  /** user stopped the session (no auto-reconnect) */
  private stopping = false;
  private reconnects: number[] = [];
  private generation = 0;
  readonly conversation: RealtimeConversation;
  readonly debug: VoiceDebug;

  constructor(view: RealtimeView) {
    this.view = view;
    this.conversation = new RealtimeConversation(view, backend, this);
    this.debug = this.conversation.debug;
  }

  get connected() {
    return this.state === 'connected';
  }
  get hasMic() {
    return !!this.mic;
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

  // ------------------------------------------------------------------ lifecycle

  async start(opts: StartOptions) {
    if (this.state === 'connected' || this.state === 'connecting') return;
    this.opts = opts;
    this.stopping = false;
    this.conversation.reset();
    this.reconnects = [];
    this.view.error(null);
    await this.connect(false);
  }

  stop() {
    this.stopping = true;
    const was = this.state;
    this.teardown();
    if (was === 'connected' || was === 'reconnecting') this.view.system('Session ended.');
    this.setState('idle');
  }

  private setState(st: ConnState, detail?: string) {
    this.state = st;
    const text =
      detail ?? { idle: 'Off', connecting: 'Connecting…', connected: 'Listening', reconnecting: 'Reconnecting…', error: 'Error' }[st];
    this.view.state(st, text);
    this.view.mic(this.muted, !!this.mic);
  }

  private async connect(isReconnect: boolean) {
    const gen = ++this.generation;
    const opts = this.opts!;
    this.setState(isReconnect ? 'reconnecting' : 'connecting', isReconnect ? 'Reconnecting…' : 'Starting…');
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
      try {
        this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        this.mic.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
        pc.addTrack(this.mic.getAudioTracks()[0], this.mic);
      } catch (err) {
        this.mic = null;
        pc.addTransceiver('audio', { direction: 'recvonly' });
        if (!isReconnect) this.view.system(`Microphone unavailable (${(err as Error).message}); text only.`);
      }
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
      this.conversation.attach({ sessionId: token.session_id, context: token.context, isReconnect });
      this.setState('connected', 'Listening');
      if (isReconnect) this.view.system('Reconnected.');
      assistantApi.log({ kind: 'session', model: token.model, voice: token.voice, reasoning: token.reasoning, mint_ms: token.mint_ms, connect_ms: connectMs, reconnect: isReconnect });
    } catch (err) {
      if (gen !== this.generation) return;
      this.teardown();
      if (isReconnect && this.scheduleReconnect(`reconnect failed: ${(err as Error).message}`)) return;
      this.conversation.showError((err as Error).message);
      this.setState('error', 'Error');
    }
  }

  /** close transport, keep conversation UI */
  private teardown() {
    this.generation++;
    this.dc?.close();
    this.pc?.getSenders().forEach((snd) => snd.track?.stop());
    this.pc?.close();
    this.mic?.getTracks().forEach((t) => t.stop());
    if (this.audioEl) this.audioEl.srcObject = null;
    this.pc = null;
    this.dc = null;
    this.mic = null;
    this.conversation.detach();
    this.view.listening(false);
  }

  private onTransportLost(why: string) {
    if (this.stopping || (this.state !== 'connected' && this.state !== 'reconnecting')) return;
    this.teardown();
    if (!this.scheduleReconnect(why)) {
      this.conversation.showError(`Connection lost (${why}).`);
      this.setState('error', 'Disconnected');
    }
  }

  /** returns false when the reconnect budget is used up */
  private scheduleReconnect(why: string): boolean {
    const now = Date.now();
    this.reconnects = this.reconnects.filter((t) => now - t < 120_000);
    if (this.reconnects.length >= MAX_RECONNECTS || !this.opts) return false;
    this.reconnects.push(now);
    const delay = [500, 2000, 5000][this.reconnects.length - 1] ?? 5000;
    this.view.system(`Connection lost (${why}); reconnecting…`);
    this.setState('reconnecting', 'Reconnecting…');
    const gen = this.generation;
    setTimeout(() => {
      if (gen === this.generation && !this.stopping) void this.connect(true);
    }, delay);
    return true;
  }

  // ------------------------------------------------------------------ mic

  setMuted(muted: boolean) {
    this.muted = muted;
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.view.mic(this.muted, !!this.mic);
  }

  toggleMute() {
    this.setMuted(!this.muted);
  }

  /** push-to-talk: mic open while held, previous mute state restored on release */
  pushToTalk(down: boolean) {
    if (down === this.pttHeld) return;
    this.pttHeld = down;
    if (down) {
      this.mutedBeforePtt = this.muted;
      this.setMuted(false);
    } else {
      this.setMuted(this.mutedBeforePtt);
    }
  }

  // ------------------------------------------------------------------ live context / text

  /** Fetch a fresh snapshot and add it if the game changed (throttled; never throws). */
  refreshContext(): Promise<void> {
    return this.conversation.refreshContext();
  }

  sendText(text: string) {
    return this.conversation.sendText(text);
  }
}
