import WebSocket from 'ws';
import type { ServerMessage, GameState } from '../../../shared/feed-events.ts';

/** Minimal websocket game client used by the smoke test and ad-hoc scripts. */
export class GameClient {
  ws: WebSocket;
  output = '';
  snapshots = 0;
  lastState: GameState | null = null;
  messages: ServerMessage[] = [];
  private opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      this.messages.push(msg);
      if (msg.type === 'output') this.output += msg.data;
      else if (msg.type === 'snapshot') this.snapshots++;
      else if (msg.type === 'state') this.lastState = msg.state;
    });
  }

  ready() {
    return this.opened;
  }

  send(data: string) {
    this.ws.send(JSON.stringify({ type: 'input', data }));
  }

  start() {
    this.ws.send(JSON.stringify({ type: 'start' }));
  }

  close() {
    this.ws.close();
  }
}

export async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 10000, everyMs = 100): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
