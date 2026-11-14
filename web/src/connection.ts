import type { ClientMessage, ServerMessage } from '../../shared/feed-events.ts';

/** Websocket to the game server with automatic reconnect. */
export class Connection {
  private ws: WebSocket | null = null;
  private retryMs = 500;
  private handler: (msg: ServerMessage) => void;
  onStatus: (connected: boolean) => void = () => {};

  constructor(handler: (msg: ServerMessage) => void) {
    this.handler = handler;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 500;
      this.onStatus(true);
    };
    ws.onmessage = (e) => {
      try {
        this.handler(JSON.parse(e.data as string) as ServerMessage);
      } catch (err) {
        console.error('bad server message', err);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onStatus(false);
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    };
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
