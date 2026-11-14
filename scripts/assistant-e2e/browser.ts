/**
 * Headless Chromium (agent-browser) driver for the assistant panel, ported
 * from voice-proto/scripts/e2e.ts.  Questions go in as TEXT through the
 * Realtime data channel (voiceDebug.sendText); the fake mic is muted then
 * (Chromium's fake device beeps, which would trigger VAD).  With an audio
 * file the WAV is the fake microphone instead (tests VAD + transcription;
 * it should start with ~6 s of silence and end with long silence because
 * Chromium loops it).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';

export interface TurnResult {
  turn: string;
  transcript: { role: string; text: string; ms?: Record<string, number>; at?: number }[];
  tools: { name: string; args: string; ok: boolean; ms: number; preview: string; at?: number; responseId?: string }[];
  metrics: { first_audio: number | null; final_at: number | null; done_ms: number; tools: number; rounds: number; tool_names: string[] };
  errors: string[];
  unpaired: string[];
  dropped: string[];
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AssistantBrowser {
  readonly session: string;
  private args: string;
  readonly audio?: string;

  constructor(opts: { session: string; audio?: string }) {
    this.session = opts.session;
    this.audio = opts.audio;
    this.args = [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      ...(opts.audio ? [`--use-file-for-fake-audio-capture=${opts.audio}`] : []),
    ].join(',');
  }

  ab(...args: string[]): string {
    return execFileSync('agent-browser', ['--session', this.session, '--args', this.args, ...args], { encoding: 'utf8', timeout: 60_000 }).trim();
  }

  eval<T = any>(js: string): T {
    const out = this.ab('eval', `JSON.stringify(${js})`);
    let v: any = out;
    // agent-browser prints the JS result; it may be JSON-quoted once more
    for (let i = 0; i < 2 && typeof v === 'string'; i++) {
      try {
        v = JSON.parse(v);
      } catch {
        break;
      }
    }
    return v as T;
  }

  async waitFor<T>(fn: () => T | undefined | null | false, timeoutMs: number, what: string): Promise<T> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(700);
    }
    throw new Error(`timeout waiting for ${what}`);
  }

  /** open the page and start a session; returns connect time */
  async start(url: string, opts: { model?: string; width?: number; height?: number } = {}): Promise<number> {
    this.ab('open', url);
    this.ab('set', 'viewport', String(opts.width ?? 1400), String(opts.height ?? 900));
    await this.waitFor(() => this.eval<number>("document.querySelectorAll('#as-model option').length") > 0, 15_000, 'assistant config');
    if (opts.model) this.ab('select', '#as-model', opts.model);
    const t0 = Date.now();
    this.ab('click', '#as-start');
    await this.waitFor(() => {
      const st = this.eval<{ state: string; errors: string[] }>('({state: voiceDebug.state, errors: voiceDebug.errors})');
      if (st.state === 'error') throw new Error(`session error: ${st.errors.join('; ')}`);
      return st.state === 'connected';
    }, 30_000, 'connected');
    const ms = Date.now() - t0;
    if (!this.audio) this.ab('click', '#as-mic'); // mute the beeping fake mic in text mode
    return ms;
  }

  /** Ask one question (text, or wait for the spoken WAV); "A|>B" barges in with B when the first tool call starts. */
  async ask(turn: string): Promise<TurnResult> {
    const before = this.eval<number>("voiceDebug.transcript.filter(m => m.role === 'assistant').length");
    const tStart = this.eval<number>('voiceDebug.transcript.length');
    const toolsBefore = this.eval<number>('voiceDebug.tools.length');
    const tSend = Date.now();
    const barge = /^(.*?)\|(>>?)(.*)$/.exec(turn);
    if (barge && !this.audio) {
      this.eval(`(voiceDebug.bargeIn = ${JSON.stringify({ text: barge[3].trim(), on: barge[2] === '>>' ? 'args' : 'item' })}, 1)`);
      this.eval(`voiceDebug.sendText(${JSON.stringify(barge[1].trim())})`);
    } else if (!this.audio) this.eval(`voiceDebug.sendText(${JSON.stringify(turn)})`);
    // done when: a new assistant message exists, no response active, no audio playing, no tool running, events quiet for 4 s
    let lastLen = -1;
    let stableSince = 0;
    const d = await this.waitFor(() => {
      const r = this.eval<any>(
        "({t: voiceDebug.transcript, tools: voiceDebug.tools, active: voiceDebug.activeResponse, playing: voiceDebug.audioPlaying, errors: voiceDebug.errors, n: voiceDebug.events.length, running: document.querySelectorAll('.as-chip[data-status=running]').length})",
      );
      if (r.n !== lastLen) (lastLen = r.n), (stableSince = Date.now());
      const assistantCount = r.t.filter((m: any) => m.role === 'assistant').length;
      const quiet = Date.now() - stableSince > 4000;
      // also wait for the spoken answer to finish playing, so the next turn's latency is measured cleanly
      if (assistantCount > before && !r.active && !r.playing && r.running === 0 && quiet) return r;
      if (r.errors.length && quiet && !r.active) return r;
      return null;
    }, this.audio ? 90_000 : 120_000, 'assistant answer').catch((e) => {
      const dbg = this.eval<any>(
        "({active: voiceDebug.activeResponse, playing: voiceDebug.audioPlaying, state: voiceDebug.state, errors: voiceDebug.errors, last: voiceDebug.events.filter(e => !/delta/.test(e.type)).slice(-25)})",
      );
      throw new Error(`${(e as Error).message}\n${JSON.stringify(dbg, null, 1)}`);
    });
    const doneMs = Date.now() - tSend - 4000;
    const { unpaired, dropped } = this.eval<any>('({unpaired: voiceDebug.unpaired(), dropped: voiceDebug.dropped()})');
    const transcript = d.t.slice(tStart);
    const msgs = transcript.filter((m: any) => m.role === 'assistant');
    const tools = d.tools.slice(toolsBefore);
    return {
      turn,
      transcript,
      tools,
      metrics: {
        first_audio: msgs[0]?.ms?.first_audio ?? null,
        final_at: msgs.length ? (msgs[msgs.length - 1].at ?? null) : null,
        done_ms: doneMs,
        tools: tools.length,
        rounds: new Set(tools.map((t: any) => t.responseId)).size,
        tool_names: tools.map((t: any) => t.name),
      },
      errors: d.errors,
      unpaired,
      dropped,
    };
  }

  /** agent-browser may save elsewhere; copy the file to `path` */
  screenshot(path: string) {
    const out = this.ab('screenshot', path);
    const saved = /saved to (\S+)/.exec(out)?.[1];
    if (saved && saved !== path) copyFileSync(saved, path);
    return path;
  }

  stop() {
    try {
      this.ab('click', '#as-start');
    } catch {
      /* already gone */
    }
  }

  close() {
    try {
      this.ab('close');
    } catch {
      /* already closed */
    }
  }
}

export function printTurn(r: TurnResult, label = '') {
  console.log(`\n=== ${label}${r.turn}`);
  for (const m of r.transcript) {
    if (m.role === 'user') console.log(`USER: ${m.text}`);
    else if (m.role === 'tool') console.log(`  TOOL${m.at !== undefined ? ` @${m.at}ms` : ''} ${m.text}`);
    else {
      const marks = { ...(m.ms ?? {}), ...(m.at !== undefined ? { at: m.at } : {}) };
      console.log(`ASSISTANT${Object.keys(marks).length ? ` [${Object.entries(marks).map(([k, v]) => `${k}=${v}ms`).join(' ')}]` : ''}: ${m.text}`);
    }
  }
  console.log(`METRICS ${JSON.stringify(r.metrics)}`);
  if (r.unpaired.length || r.dropped.length) console.log(`TOOL STATE: unpaired=${JSON.stringify(r.unpaired)} dropped=${JSON.stringify(r.dropped)}`);
  if (r.errors.length) console.log(`ERRORS: ${r.errors.join(' | ')}`);
}
