import fs from 'node:fs';
import path from 'node:path';

/** Append-only JSONL log under .cache/ (tool calls with timing, transcripts). Never throws. */
export class JsonlLog {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      /* logging is best effort */
    }
  }

  write(entry: Record<string, unknown>) {
    fs.promises.appendFile(this.file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n').catch(() => {});
  }
}
