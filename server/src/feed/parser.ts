import { StringDecoder } from 'node:string_decoder';
import { FEED_EVENT_TYPES, type FeedEvent } from '../../../shared/feed-events.ts';

const KNOWN = new Set<string>(FEED_EVENT_TYPES);

export interface ParseError {
  line: string;
  error: string;
}

/**
 * Incremental NDJSON parser for the wc_feed stream.  Accepts arbitrary
 * chunk boundaries (including split UTF-8 sequences) and returns complete,
 * structurally valid events.  Bad lines are reported via `errors`, never
 * thrown.
 */
export class FeedParser {
  private decoder = new StringDecoder('utf8');
  private buf = '';
  readonly errors: ParseError[] = [];
  errorCount = 0;

  push(chunk: Buffer | string): FeedEvent[] {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const out: FeedEvent[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      const ev = this.parseLine(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** bytes buffered waiting for a newline */
  get pending(): number {
    return this.buf.length;
  }

  private parseLine(line: string): FeedEvent | null {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      this.fail(line, `invalid JSON: ${(e as Error).message}`);
      return null;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      this.fail(line, 'not an object');
      return null;
    }
    const rec = obj as Record<string, unknown>;
    if (typeof rec.t !== 'string' || !KNOWN.has(rec.t)) {
      this.fail(line, `unknown event type ${JSON.stringify(rec.t)}`);
      return null;
    }
    if (typeof rec.seq !== 'number') {
      this.fail(line, 'missing seq');
      return null;
    }
    return rec as unknown as FeedEvent;
  }

  private fail(line: string, error: string) {
    this.errorCount++;
    this.errors.push({ line: line.slice(0, 200), error });
    if (this.errors.length > 20) this.errors.shift();
  }
}
