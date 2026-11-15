/**
 * Assistant panel: mic on/off, model, connection state, transcript with
 * compact tool chips (details collapsed), text input.  There is no start
 * button: the session connects on the first mic-on or typed message.
 * Rendering only; the conversation logic lives in RealtimeClient.
 */
import { assistantApi, type AssistantConfig } from './api.ts';
import { RealtimeClient, type ConnState, type Consultation, type RealtimeView, type ToolCall } from './realtime.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Short, human label for a tool call chip: "look f", "wiki: Fountain", "map: level 1". */
export function chipLabel(name: string, argsJson: string): string {
  let a: Record<string, unknown> = {};
  try {
    a = JSON.parse(argsJson || '{}');
  } catch {
    /* partial args */
  }
  const q = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  switch (name) {
    case 'look':
      return `look ${q(a.target) || 'around'}`;
    case 'get_status':
      return 'status';
    case 'get_screen':
      return 'screen';
    case 'get_inventory':
      return 'inventory';
    case 'list_levels':
      return 'levels';
    case 'get_level_map':
      return `map ${q(a.level)}`.trim();
    case 'get_messages':
      return 'messages';
    case 'get_discoveries':
      return 'discoveries';
    case 'nethack_lookup':
      return `lookup ${q(a.name)}`;
    case 'fetch_wiki_page':
      return `wiki ${q(a.title)}${a.section ? ` § ${q(a.section)}` : ''}`;
    case 'web_search':
      return `web ${q(a.query)}`;
    case 'search_nethack_source':
      return `source /${q(a.pattern)}/`;
    case 'read_nethack_source':
      return `source ${q(a.path)}:${q(a.start_line)}`;
    case 'consult_expert':
      return 'ask expert';
    case 'cancel_expert':
      return 'cancel expert';
    default:
      return name;
  }
}

/** Label of a "Thinking deeply" chip for an expert consultation. */
export function expertLabel(c: Pick<Consultation, 'status' | 'startedAt' | 'finishedAt' | 'result' | 'interrupted'>, now: number): string {
  const secs = (to: number) => `${Math.max(0, Math.round((to - c.startedAt) / 1000))} s`;
  switch (c.status) {
    case 'running':
      return `Thinking deeply… ${secs(now)}`;
    case 'ready':
      return c.result?.ok ? `Expert answer ready (${secs(c.finishedAt ?? now)})` : 'Expert couldn’t finish';
    case 'delivering':
      return c.result?.ok ? `Expert answering (${secs(c.finishedAt ?? now)})` : 'Expert couldn’t finish';
    case 'delivered':
      return c.result?.ok ? `Expert answered (${secs(c.finishedAt ?? now)})${c.interrupted ? ', interrupted' : ''}` : 'Expert couldn’t finish';
    case 'cancelled':
      return 'Expert cancelled';
  }
}

export interface AssistantPanelOptions {
  /** give keyboard focus back to the game */
  focusGame(): void;
}

export class AssistantPanel implements RealtimeView {
  readonly client: RealtimeClient;
  private opts: AssistantPanelOptions;
  private cfg: AssistantConfig | null = null;
  /** the server has no API key: nothing can be used */
  private unavailable = false;
  private els = {
    pane: $('assistant-pane'),
    status: $('as-status'),
    statusText: $('as-status-text'),
    model: $<HTMLSelectElement>('as-model'),
    voice: $<HTMLSelectElement>('as-voice'),
    voiceLabel: $('as-voice-label'),
    mic: $<HTMLButtonElement>('as-mic'),
    error: $('as-error'),
    log: $('as-log'),
    empty: $('as-empty'),
    composer: $<HTMLFormElement>('as-composer'),
    input: $<HTMLInputElement>('as-input'),
    send: $<HTMLButtonElement>('as-send'),
    listening: $('as-listening'),
  };
  private userEls = new Map<string, HTMLElement>();
  private assistantEls = new Map<string, HTMLElement>();
  private chipEls = new Map<string, HTMLDetailsElement>();
  /** chips of the current turn are collected in one row */
  private chipRow: HTMLElement | null = null;
  private expertEls = new Map<string, { el: HTMLDetailsElement; c: Consultation }>();
  private expertTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: AssistantPanelOptions) {
    this.opts = opts;
    this.client = new RealtimeClient(this, () => ({
      model: this.els.model.value || this.cfg?.defaultModel || 'gpt-realtime-2.1',
      voice: this.els.voice.value || this.cfg?.defaultVoice || 'marin',
      reasoning: this.cfg?.defaultReasoning ?? 'low',
    }));
    (window as unknown as { voiceDebug: unknown }).voiceDebug = this.client.debug;
    const e = this.els;
    e.mic.addEventListener('click', () => this.client.toggleMic());
    // a live session switches over (with a recap of the conversation so far)
    e.model.addEventListener('change', () => this.client.reconfigure());
    e.voice.addEventListener('change', () => this.client.reconfigure());
    e.composer.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = e.input.value;
      e.input.value = '';
      void this.client.sendText(text);
    });
    e.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        e.input.blur();
        this.opts.focusGame();
      }
    });
    this.state('idle', 'Mic off');
    this.mic(true, true);
    void this.loadConfig();
  }

  private async loadConfig() {
    try {
      const cfg = await assistantApi.config();
      this.cfg = cfg;
      const fill = (sel: HTMLSelectElement, opts: string[], def: string, label: (o: string) => string = (o) => o) => {
        sel.innerHTML = '';
        for (const o of opts) sel.add(new Option(label(o), o, o === def, o === def));
      };
      fill(this.els.model, cfg.models, cfg.defaultModel, (m) => m.replace(/^gpt-realtime-/, 'realtime ').replace(/-mini$/, ' mini'));
      fill(this.els.voice, cfg.voices, cfg.defaultVoice);
      this.els.voiceLabel.textContent = this.els.voice.value;
      this.els.voice.addEventListener('change', () => (this.els.voiceLabel.textContent = this.els.voice.value));
      if (!cfg.apiKeyConfigured) {
        this.error('The server has no OPENAI_API_KEY; the assistant is unavailable.');
        this.unavailable = true;
        this.render();
      }
    } catch (err) {
      this.error(`Could not load assistant config: ${(err as Error).message}`);
    }
  }

  focusInput() {
    this.els.input.focus();
  }

  // ------------------------------------------------------------------ RealtimeView

  state(st: ConnState, detail: string) {
    const e = this.els;
    e.status.dataset.state = st;
    e.statusText.textContent = detail;
    if (st !== 'connected') this.listening(false);
  }

  error(msg: string | null) {
    this.els.error.hidden = !msg;
    this.els.error.textContent = msg ?? '';
  }

  mic(muted: boolean, available: boolean) {
    const b = this.els.mic;
    this.els.status.dataset.mic = muted ? 'off' : 'on';
    b.setAttribute('aria-pressed', String(!muted));
    b.classList.toggle('muted', muted);
    b.querySelector('.label')!.textContent = muted ? (available ? 'Mic off' : 'No mic') : 'Mic on';
    b.title = muted ? 'Turn the microphone on (F2)' : 'Turn the microphone off (F2)';
    this.render();
  }

  private render() {
    const e = this.els;
    e.mic.disabled = e.input.disabled = e.send.disabled = this.unavailable;
    e.input.placeholder = this.unavailable ? 'Assistant unavailable (no API key on the server)' : 'Ask about your game…';
  }

  listening(on: boolean) {
    this.els.listening.hidden = !on;
  }

  system(text: string) {
    const el = document.createElement('div');
    el.className = 'as-msg system';
    el.textContent = text;
    this.append(el);
    this.chipRow = null;
  }

  user(key: string, text: string, final: boolean) {
    let el = this.userEls.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'as-msg user pending';
      el.textContent = '…';
      this.userEls.set(key, el);
      this.append(el);
      this.chipRow = null; // a new turn starts a new chip row
    }
    if (final) {
      el.classList.remove('pending');
      el.textContent = text;
    } else if (text) {
      if (el.classList.contains('pending')) {
        el.classList.remove('pending');
        el.textContent = '';
      }
      el.textContent += text;
    }
    this.stickToBottom();
  }

  assistant(key: string, text: string, final: boolean, latency?: Record<string, number>) {
    let el = this.assistantEls.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'as-msg assistant';
      this.assistantEls.set(key, el);
      this.append(el);
      this.chipRow = null;
    }
    el.textContent = text;
    if (final && latency) {
      const parts = [
        latency.first_audio !== undefined ? `first audio ${(latency.first_audio / 1000).toFixed(1)} s` : '',
        latency.at !== undefined ? `answer started ${(latency.at / 1000).toFixed(1)} s` : '',
      ].filter(Boolean);
      if (parts.length) el.title = `${parts.join(' · ')} after the end of your turn`;
    }
    this.stickToBottom();
  }

  tool(call: ToolCall) {
    let chip = this.chipEls.get(call.callId);
    if (!chip) {
      if (!this.chipRow) {
        this.chipRow = document.createElement('div');
        this.chipRow.className = 'as-chips';
        this.append(this.chipRow);
      }
      chip = document.createElement('details');
      chip.className = 'as-chip';
      chip.innerHTML = '<summary><span class="dot"></span><span class="label"></span></summary><pre></pre>';
      this.chipRow.appendChild(chip);
      this.chipEls.set(call.callId, chip);
    }
    const label = chipLabel(call.name, call.args);
    (chip.querySelector('.label') as HTMLElement).textContent = label;
    const status = call.dropped && call.result === undefined ? 'dropped' : call.result === undefined ? 'running' : call.ok ? 'ok' : 'fail';
    chip.dataset.status = status;
    chip.title = `${call.name} ${call.args || ''}${call.ms !== undefined ? `\n${call.ms} ms${call.serverMs !== undefined ? ` (server ${call.serverMs} ms)` : ''}` : ''}${status === 'dropped' ? '\ninterrupted' : ''}`;
    if (call.result !== undefined) (chip.querySelector('pre') as HTMLElement).textContent = call.result;
    this.stickToBottom();
  }

  /** "Thinking deeply… 12 s" chip with a cancel button; shows the expert's answer and sources when expanded */
  expert(c: Consultation) {
    let entry = this.expertEls.get(c.id);
    if (!entry) {
      const el = document.createElement('details');
      el.className = 'as-chip as-expert';
      el.innerHTML =
        '<summary><span class="dot"></span><span class="label"></span><button type="button" class="as-x" title="Cancel this consultation" aria-label="Cancel">×</button></summary><pre></pre>';
      el.querySelector('button')!.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.client.cancelConsultation(c.id);
      });
      if (!this.chipRow) {
        this.chipRow = document.createElement('div');
        this.chipRow.className = 'as-chips';
        this.append(this.chipRow);
      }
      this.chipRow.appendChild(el);
      entry = { el, c };
      this.expertEls.set(c.id, entry);
    }
    entry.c = c;
    this.renderExpert(entry);
    const running = [...this.expertEls.values()].some((x) => x.c.status === 'running');
    if (running && !this.expertTimer) {
      this.expertTimer = setInterval(() => {
        const live = [...this.expertEls.values()].filter((x) => x.c.status === 'running');
        for (const x of live) this.renderExpert(x);
        if (!live.length && this.expertTimer) {
          clearInterval(this.expertTimer);
          this.expertTimer = null;
        }
      }, 1000);
    }
    this.stickToBottom();
  }

  private renderExpert({ el, c }: { el: HTMLDetailsElement; c: Consultation }) {
    const r = c.result;
    const waiting = c.status === 'running' || c.status === 'ready' || c.status === 'delivering';
    el.dataset.status = waiting ? 'running' : c.status === 'cancelled' ? 'dropped' : r?.ok ? 'ok' : 'fail';
    (el.querySelector('.label') as HTMLElement).textContent = expertLabel(c, performance.now());
    (el.querySelector('.as-x') as HTMLElement).hidden = c.status !== 'running' && c.status !== 'ready';
    el.title = c.question;
    const lines = [`Q: ${c.question}`];
    if (r?.ok) {
      lines.push('', r.answer);
      if (r.keyFacts.length) lines.push('', ...r.keyFacts.map((f) => `• ${f}`));
      lines.push('', `confidence ${r.confidence}${r.unknowns.length ? `; unknown: ${r.unknowns.join(', ')}` : ''}`);
      if (r.tools.length) lines.push(`checked: ${r.tools.map((t) => chipLabel(t.name, JSON.stringify(t.args))).join(', ')}`);
      if (r.cost !== undefined) lines.push(`${(r.ms / 1000).toFixed(1)} s, ${r.rounds} rounds, $${r.cost.toFixed(3)}`);
    } else if (r) lines.push('', `failed: ${r.error}`);
    if (c.status === 'cancelled') lines.push('', `cancelled (${c.cancelReason ?? ''})`);
    (el.querySelector('pre') as HTMLElement).textContent = lines.join('\n');
  }

  // ------------------------------------------------------------------ helpers

  private append(el: HTMLElement) {
    this.els.empty.hidden = true;
    const log = this.els.log;
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.appendChild(el);
    if (stick) log.scrollTop = log.scrollHeight;
  }

  private stickToBottom() {
    const log = this.els.log;
    if (log.scrollHeight - log.scrollTop - log.clientHeight < 160) log.scrollTop = log.scrollHeight;
  }
}
