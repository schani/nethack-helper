/** Deterministic per-turn checks (tool usage, regexes, speakability, length). Pure functions: unit-tested. */
import type { TurnRecord } from '../../server/src/assistant/realtime-node.ts';
import type { CheckResult, Expect } from './types.ts';

export const DEFAULT_MAX_WORDS = 110;

/** raw map coordinates / grid talk the assistant must never say */
export const COORDS = /\b(?:row|column|col)s? (?:number )?\d+|\bcoordinates?\b|\b[xy] ?[=:] ?\d+|\(\s*\d+\s*,\s*\d+\s*\)/i;
/** things that cannot be spoken: markdown, URLs, source paths, line numbers */
export const UNSPEAKABLE: [string, RegExp][] = [
  ['markdown', /\*\*|__|`|^\s*#{1,6}\s|^\s*[-*•]\s|^\s*\d+\.\s+\S/m],
  ['url', /https?:\/\/|www\.|\.com\b|\.org\b/i],
  ['source path', /\b(?:src|dat|doc|include)\/[\w./-]+|\b\w+\.(?:c|h|lua|txt)\b/],
  ['line number', /\blines? \d{2,}/i],
];

export function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

const names = (t: TurnRecord) => t.tools.map((x) => x.name);

export function gradeTurn(turn: TurnRecord, expect: Expect = {}): CheckResult[] {
  const out: CheckResult[] = [];
  const answer = turn.answer;
  const called = names(turn);
  const add = (name: string, pass: boolean, detail?: string) => out.push({ name, pass, ...(pass ? {} : { detail }) });

  add('answered', !!answer.trim() && !turn.errors.length, turn.errors.join('; ') || 'no answer');
  add('tool calls paired', !turn.unpaired.length, turn.unpaired.join(', '));

  const t = expect.tools ?? {};
  if (t.any?.length) add(`calls one of ${t.any.join('/')}`, called.some((n) => t.any!.includes(n)), `called: ${called.join(', ') || 'none'}`);
  for (const n of t.all ?? []) add(`calls ${n}`, called.includes(n), `called: ${called.join(', ') || 'none'}`);
  for (const n of t.none ?? []) add(`does not call ${n}`, !called.includes(n), `called: ${called.join(', ')}`);
  if (t.first?.length) add(`first call is ${t.first.join('/')}`, !!called.length && t.first.includes(called[0]), `called: ${called.join(', ') || 'none'}`);
  if (t.noTools) add('no tool calls', !called.length, `called: ${called.join(', ')}`);

  for (const re of expect.must ?? []) add(`says ${re}`, re.test(answer), answer.slice(0, 300));
  if (expect.mustAny?.length) add(`says one of ${expect.mustAny.map(String).join(' | ')}`, expect.mustAny.some((re) => re.test(answer)), answer.slice(0, 300));
  for (const re of expect.mustNot ?? []) {
    const m = re.exec(answer);
    add(`never says ${re}`, !m, m ? `"${m[0]}" in: ${answer.slice(0, 300)}` : '');
  }

  if (!expect.allowCoords) {
    const m = COORDS.exec(answer);
    add('no raw coordinates', !m, m?.[0]);
    for (const [what, re] of UNSPEAKABLE) {
      const u = re.exec(answer);
      add(`speakable: no ${what}`, !u, u?.[0]);
    }
  }
  const max = expect.maxWords ?? DEFAULT_MAX_WORDS;
  const words = wordCount(answer);
  add(`at most ${max} words`, words <= max, `${words} words`);
  if (expect.maxRounds !== undefined) add(`at most ${expect.maxRounds} tool rounds`, turn.rounds <= expect.maxRounds, `${turn.rounds} rounds`);
  return out;
}
