import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { FeedParser } from './parser.ts';
import type { FeedEvent } from '../../../shared/feed-events.ts';

export interface FeedListenerEvents {
  onEvent: (ev: FeedEvent) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onParseError?: (count: number) => void;
}

/**
 * Unix-socket server that the "+feed" chain processor inside nethack
 * connects to (path passed via NETHACK_FEED_SOCKET).  Only one game feed
 * is active at a time; a new connection replaces the old one.
 */
export class FeedListener {
  private server: net.Server | null = null;
  private conn: net.Socket | null = null;
  readonly socketPath: string;
  private handlers: FeedListenerEvents;

  constructor(socketPath: string, handlers: FeedListenerEvents) {
    this.socketPath = socketPath;
    this.handlers = handlers;
  }

  async listen(): Promise<void> {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      /* not there */
    }
    this.server = net.createServer((sock) => this.accept(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  private accept(sock: net.Socket) {
    if (this.conn) this.conn.destroy();
    this.conn = sock;
    const parser = new FeedParser();
    let reportedErrors = 0;
    this.handlers.onConnect?.();
    sock.on('data', (chunk) => {
      for (const ev of parser.push(chunk)) this.handlers.onEvent(ev);
      if (parser.errorCount !== reportedErrors) {
        reportedErrors = parser.errorCount;
        this.handlers.onParseError?.(reportedErrors);
      }
    });
    const done = () => {
      if (this.conn === sock) {
        this.conn = null;
        this.handlers.onDisconnect?.();
      }
    };
    sock.on('close', done);
    sock.on('error', done);
  }

  async close(): Promise<void> {
    this.conn?.destroy();
    this.conn = null;
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      /* ignore */
    }
  }
}
