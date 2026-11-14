import { describe, expect, it } from 'vitest';
import { FeedParser } from '../../src/feed/parser.ts';

describe('FeedParser', () => {
  it('parses complete lines', () => {
    const p = new FeedParser();
    const evs = p.push('{"t":"hello","seq":1,"schema":1}\n{"t":"msg","seq":2,"text":"hi","turn":1}\n');
    expect(evs.map((e) => e.t)).toEqual(['hello', 'msg']);
    expect(p.pending).toBe(0);
  });

  it('buffers partial lines across chunks', () => {
    const p = new FeedParser();
    expect(p.push('{"t":"msg","seq":1,"te')).toEqual([]);
    expect(p.pending).toBeGreaterThan(0);
    const evs = p.push('xt":"You see here a scroll.","turn":5}\n{"t":"inp');
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ t: 'msg', text: 'You see here a scroll.' });
    expect(p.push('ut","seq":2,"kind":"command","turn":5}\n')).toMatchObject([{ t: 'input', kind: 'command' }]);
  });

  it('handles UTF-8 sequences split between Buffer chunks', () => {
    const p = new FeedParser();
    const line = Buffer.from('{"t":"msg","seq":1,"text":"Velkommen – é","turn":1}\n', 'utf8');
    const cut = line.indexOf(0xe2) + 1; // middle of the en dash
    expect(p.push(line.subarray(0, cut))).toEqual([]);
    const evs = p.push(line.subarray(cut));
    expect(evs[0]).toMatchObject({ text: 'Velkommen – é' });
  });

  it('decodes the \\u00XX escapes wc_feed uses for 8-bit bytes', () => {
    const p = new FeedParser();
    const evs = p.push('{"t":"msg","seq":1,"text":"caf\\u00e9 \\u0001","turn":1}\n');
    expect(evs[0]).toMatchObject({ text: 'café \u0001' });
  });

  it('skips blank, malformed and unknown lines without throwing', () => {
    const p = new FeedParser();
    const evs = p.push(
      '\n   \n{not json}\n[1,2]\n{"t":"bogus","seq":1}\n{"t":"msg"}\n{"t":"msg","seq":9,"text":"ok","turn":1}\n',
    );
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ seq: 9 });
    expect(p.errorCount).toBe(4);
    expect(p.errors.map((e) => e.error)).toEqual([
      expect.stringContaining('invalid JSON'),
      'not an object',
      expect.stringContaining('unknown event type'),
      'missing seq',
    ]);
  });
});
