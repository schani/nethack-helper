/**
 * Assistant panel: start/stop, mic, model, connection state, transcript with
 * compact tool chips (details collapsed), text input.  Rendering only; the
 * conversation logic lives in RealtimeClient.
 */
import { assistantApi, type AssistantConfig } from './api.ts';
import { RealtimeClient, type ConnState, type RealtimeView, type ToolCall } from './realtime.ts';

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
    default:
      return name;
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
  private els = {
    pane: $('assistant-pane'),
    status: $('as-status'),
    statusText: $('as-status-text'),
    model: $<HTMLSelectElement>('as-model'),
    voice: $<HTMLSelectElement>('as-voice'),
    voiceLabel: $('as-voice-label'),
    start: $<HTMLButtonElement>('as-start'),
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

  constructor(opts: AssistantPanelOptions) {
    this.opts = opts;
    this.client = new RealtimeClient(this);
    (window as unknown as { voiceDebug: unknown }).voiceDebug = this.client.debug;
    const e = this.els;
    e.start.addEventListener('click', () => this.toggleSession());
    e.mic.addEventListener('click', () => this.client.toggleMute());
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
    this.state('idle', 'Off');
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
      if (!cfg.apiKeyConfigured) this.error('The server has no OPENAI_API_KEY; the assistant cannot start.');
    } catch (err) {
      this.error(`Could not load assistant config: ${(err as Error).message}`);
    }
  }

  toggleSession() {
    const st = this.client.state;
    if (st === 'connected' || st === 'connecting' || st === 'reconnecting') this.client.stop();
    else
      void this.client.start({
        model: this.els.model.value || this.cfg?.defaultModel || 'gpt-realtime-2.1',
        voice: this.els.voice.value || this.cfg?.defaultVoice || 'marin',
        reasoning: this.cfg?.defaultReasoning ?? 'low',
      });
  }

  focusInput() {
    this.els.input.focus();
  }

  // ------------------------------------------------------------------ RealtimeView

  state(st: ConnState, detail: string) {
    const e = this.els;
    e.status.dataset.state = st;
    e.statusText.textContent = detail;
    const live = st === 'connected';
    const busy = st === 'connecting' || st === 'reconnecting';
    e.start.textContent = live || busy ? 'Stop' : 'Start';
    e.start.classList.toggle('stop', live || busy);
    e.start.title = live || busy ? 'End the voice session' : 'Start a voice session (F2)';
    e.input.disabled = e.send.disabled = !live;
    e.input.placeholder = live ? 'Ask about your game…' : 'Start the assistant to chat';
    e.model.disabled = e.voice.disabled = live || busy;
    if (!live) this.listening(false);
  }

  error(msg: string | null) {
    this.els.error.hidden = !msg;
    this.els.error.textContent = msg ?? '';
  }

  mic(muted: boolean, available: boolean) {
    const b = this.els.mic;
    const live = this.client?.state === 'connected';
    b.disabled = !live || !available;
    b.setAttribute('aria-pressed', String(!muted && available));
    b.classList.toggle('muted', muted || !available);
    b.querySelector('.label')!.textContent = !available && live ? 'No mic' : muted ? 'Mic off' : 'Mic on';
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
