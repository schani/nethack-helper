import { describe, expect, it } from 'vitest';
import { addUsage, emptyUsage, type TurnRecord } from '../../server/src/assistant/realtime-node.ts';
import { realtimeCost, responsesCost } from '../src/cost.ts';
import { COORDS, gradeTurn, wordCount } from '../src/graders.ts';
import { compareMarkdown, group, stat, summarize, wilson } from '../src/report.ts';
import type { CaseRun } from '../src/types.ts';
import { CachedKnowledge } from '../src/harness.ts';
import { ALL_CASES } from '../cases/index.ts';

function turn(answer: string, tools: string[] = [], extra: Partial<TurnRecord> = {}): TurnRecord {
  return {
    input: 'q',
    messages: [answer],
    answer,
    tools: tools.map((name, i) => ({ name, args: {}, ok: true, ms: 1, result: 'r', round: i + 1 })),
    responses: tools.length + 1,
    rounds: tools.length ? 1 : 0,
    latency: { first_text: 900, total: 1500 },
    usage: emptyUsage(),
    errors: [],
    unpaired: [],
    contexts: 0,
    ...extra,
  };
}
const failed = (checks: { name: string; pass: boolean }[]) => checks.filter((c) => !c.pass).map((c) => c.name);

describe('gradeTurn', () => {
  it('passes a good answer with the required tool', () => {
    const c = gradeTurn(turn('That f is your tame kitten, right next to you to the north.', ['look']), { tools: { first: ['look'] }, must: [/kitten/i] });
    expect(failed(c)).toEqual([]);
  });

  it('checks tool requirements: any / all / none / first / noTools', () => {
    const t = turn('ok', ['get_status', 'look']);
    expect(failed(gradeTurn(t, { tools: { any: ['get_inventory'] } }))).toEqual(['calls one of get_inventory']);
    expect(failed(gradeTurn(t, { tools: { all: ['look', 'get_inventory'] } }))).toEqual(['calls get_inventory']);
    expect(failed(gradeTurn(t, { tools: { none: ['look'] } }))).toEqual(['does not call look']);
    expect(failed(gradeTurn(t, { tools: { first: ['look'] } }))).toEqual(['first call is look']);
    expect(failed(gradeTurn(t, { tools: { noTools: true } }))).toEqual(['no tool calls']);
    expect(failed(gradeTurn(turn('ok'), { tools: { first: ['look'] } }))).toEqual(['first call is look']);
  });

  it('tools.orSnapshot accepts an answer grounded in the live-state snapshot', () => {
    const e = { tools: { any: ['get_status'], orSnapshot: /AC 9\b/ } };
    expect(failed(gradeTurn(turn('Your AC is 9.'), e, 'HP 11/11, Pw 9/9, AC 9, not hungry'))).toEqual([]);
    expect(failed(gradeTurn(turn('Your AC is 9.'), e, 'HP 11/11, AC 6'))).toEqual(['calls one of get_status']);
    expect(failed(gradeTurn(turn('Your AC is 9.'), e))).toEqual(['calls one of get_status']);
    expect(failed(gradeTurn(turn('Your AC is 9.', ['get_status']), e))).toEqual([]);
  });

  it('applies must / mustAny / mustNot regexes', () => {
    const t = turn("I can't tell what the fizzy potion is.");
    expect(failed(gradeTurn(t, { must: [/fizzy/], mustAny: [/can.t tell/, /unknown/], mustNot: [/potion of/] }))).toEqual([]);
    const bad = gradeTurn(turn("It's probably a potion of healing."), { mustNot: [/potion of/] });
    expect(failed(bad)).toEqual(['never says /potion of/']);
    expect(bad.find((c) => !c.pass)?.detail).toContain('"potion of"');
  });

  it('flags raw coordinates but not ordinary directions', () => {
    for (const s of ['It is at row 5, column 12.', 'at (40, 12)', 'x=40', 'the coordinates are 40,12']) expect(COORDS.test(s), s).toBe(true);
    for (const s of ['two squares to your left', 'a row of boulders', 'about 53 squares right and 7 up', 'level 2']) expect(COORDS.test(s), s).toBe(false);
    expect(failed(gradeTurn(turn('The stairs are at row 5, column 12.')))).toEqual(['no raw coordinates']);
    expect(failed(gradeTurn(turn('The stairs are at row 5.'), { allowCoords: true }))).toEqual([]);
  });

  it('flags unspeakable output: markdown, URLs, source paths, line numbers', () => {
    expect(failed(gradeTurn(turn('**Bold** claim')))).toEqual(['speakable: no markdown']);
    expect(failed(gradeTurn(turn('Options:\n- quaff\n- dip')))).toEqual(['speakable: no markdown']);
    expect(failed(gradeTurn(turn('See https://nethackwiki.com/wiki/Fountain')))).toContain('speakable: no url');
    expect(failed(gradeTurn(turn('It is in src/fountain.c')))).toEqual(['speakable: no source path']);
    expect(failed(gradeTurn(turn('around line 412 of the file')))).toEqual(['speakable: no line number']);
    expect(failed(gradeTurn(turn('In 5.0 the sink looks like a fountain.')))).toEqual([]);
  });

  it('limits length and tool rounds, and requires an answer without errors', () => {
    const long = Array.from({ length: 120 }, () => 'word').join(' ');
    expect(failed(gradeTurn(turn(long)))).toEqual(['at most 110 words']);
    expect(failed(gradeTurn(turn('short'), { maxWords: 0 }))).toEqual(['at most 0 words']);
    expect(failed(gradeTurn(turn('ok', ['look', 'look'], { rounds: 3 }), { maxRounds: 2 }))).toEqual(['at most 2 tool rounds']);
    expect(failed(gradeTurn(turn('', [], { errors: ['boom'] })))).toEqual(['answered']);
    expect(failed(gradeTurn(turn('ok', [], { unpaired: ['look:call_1'] })))).toEqual(['tool calls paired']);
  });

  it('counts words like a speaker would', () => {
    expect(wordCount("You're at full health: 11 out of 11 HP.")).toBe(9);
    expect(wordCount('')).toBe(0);
  });
});

describe('usage and cost', () => {
  it('sums realtime usage and prices cached tokens separately', () => {
    const u = addUsage(emptyUsage(), {
      input_tokens: 10000,
      output_tokens: 100,
      input_token_details: { text_tokens: 10000, audio_tokens: 0, cached_tokens: 6000, cached_tokens_details: { text_tokens: 6000, audio_tokens: 0 } },
      output_token_details: { text_tokens: 100, audio_tokens: 0, reasoning_tokens: 20 },
    });
    expect(u).toMatchObject({ input_text: 10000, cached_text: 6000, output_text: 100, reasoning: 20 });
    // 4000 * $4/M + 6000 * $0.4/M + 100 * $24/M
    expect(realtimeCost('gpt-realtime-2.1', u)).toBeCloseTo(0.016 + 0.0024 + 0.0024, 6);
    expect(realtimeCost('gpt-realtime-2.1-mini', u)).toBeLessThan(realtimeCost('gpt-realtime-2.1', u) / 5);
    expect(responsesCost('gpt-5.5', { input: 1000, cached: 0, output: 100 })).toBeCloseTo(0.005 + 0.003, 6);
  });
});

function run(id: string, rep: number, pass: boolean, tags = ['look'], judge = 5): CaseRun {
  return {
    case: id,
    tags,
    rep,
    mode: 'text',
    turns: [{ ...turn('ok', ['look']), latency: { first_text: 1000 + rep * 100, total: 2000 }, checks: [{ name: 'answered', pass }] }],
    judge: { correctness: judge, groundedness: judge, spoiler: 5, speakability: 5, pass, rationale: 'r', issues: [] },
    pass,
    checksPass: pass,
    cost: { realtime: 0.02, judge: 0.01, tts: 0 },
    ms: 1,
  };
}

describe('report', () => {
  it('computes pass rates, spread, flaky cases, latency stats', () => {
    const g = group([run('a', 0, true), run('a', 1, false), run('b', 0, true), run('b', 1, true)]);
    expect(g.pass).toBe(0.75);
    expect(g.repPass).toEqual([1, 0.5]);
    expect(g.flaky).toBe(1);
    expect(g.cases).toBe(2);
    expect(g.firstText.median).toBe(1100);
    expect(g.words.median).toBe(1);
    expect(g.passCI[0]).toBeLessThan(0.75);
    expect(g.passCI[1]).toBeGreaterThan(0.75);
  });

  it('counts final-answer words apart from preambles', () => {
    const r = run('a', 0, true);
    r.turns[0] = { ...r.turns[0], messages: ['One sec.', 'Control D, then a direction.'], answer: 'One sec. Control D, then a direction.' };
    const g = group([r]);
    expect(g.words.median).toBe(5);
    expect(g.wordsAll.median).toBe(7);
  });

  it('stat and wilson behave on edge cases', () => {
    expect(stat([])).toEqual({ n: 0, median: null, p90: null, mean: null });
    expect(stat([3, 1, 2]).median).toBe(2);
    expect(wilson(0, 0)).toEqual([0, 0]);
    const [lo, hi] = wilson(10, 10);
    expect(hi).toBe(1);
    expect(lo).toBeGreaterThan(0.6);
  });

  it('summarizes per tag and lists regressions in comparisons', () => {
    const meta = { date: 'd', commit: 'c', mode: 'text', n: 2, judgeModel: 'j', wallMs: 1 };
    const a = summarize({ ...meta, id: 'A', variant: { name: 'base' } }, [run('x', 0, true, ['look']), run('x', 1, true, ['look']), run('y', 0, false, ['state']), run('y', 1, false, ['state'])]);
    const b = summarize({ ...meta, id: 'B', variant: { name: 'new' } }, [run('x', 0, false, ['look']), run('x', 1, false, ['look']), run('y', 0, true, ['state']), run('y', 1, true, ['state'])]);
    expect(a.tags.look.pass).toBe(1);
    expect(a.cases.y.pass).toBe(0);
    expect(a.cost.total).toBeCloseTo(0.12);
    const md = compareMarkdown(a, b);
    expect(md).toMatch(/## Regressions \(1\)\n\n- x: 100% -> 0%/);
    expect(md).toMatch(/## Improvements \(1\)\n\n- y: 0% -> 100%/);
    expect(md).toMatch(/\| look \| 100% \| 0% \| -100% \|/);
  });
});

describe('cases and knowledge cache', () => {
  it('every case has an id, tags and turns; ids are unique', () => {
    const ids = new Set<string>();
    for (const c of ALL_CASES) {
      expect(c.id).toMatch(/^[a-z0-9-]+$/);
      expect(c.tags.length).toBeGreaterThan(0);
      expect(c.turns.length).toBeGreaterThan(0);
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
    }
  });

  it('keys cases accept the actual binding and reject guessed ones', () => {
    const verdict = (id: string, answer: string) => {
      const c = ALL_CASES.find((x) => x.id === id)!;
      return gradeTurn(turn(answer, ['get_keybindings']), c.turns[0].expect).every((x) => x.pass);
    };
    expect(verdict('keys-kick', 'Control D, then pick a direction.')).toBe(true);
    expect(verdict('keys-kick', 'Press Ctrl+D, then a direction.')).toBe(true);
    expect(verdict('keys-kick', 'Usually you press the letter k. Check help with ? if unsure.')).toBe(false);
    expect(verdict('keys-kick', "Press k, then a direction.")).toBe(false);
    expect(verdict('keys-pray', 'Alt P, or type #pray and Enter.')).toBe(true);
    expect(verdict('keys-pray', 'Press Control P.')).toBe(false);
    expect(verdict('know-pray-how', 'Alt p; only when you’re in real trouble.')).toBe(true);
    expect(verdict('know-pray-how', 'Alt+P, or #pray.')).toBe(true);
    expect(verdict('keys-pickup', 'Comma.')).toBe(true);
    expect(verdict('keys-pickup', 'Press g to pick things up.')).toBe(false);
    expect(verdict('keys-farlook', 'Press semicolon, move the cursor onto it, then press period.')).toBe(true);
    expect(verdict('keys-farlook', 'Use the colon key.')).toBe(false);
    expect(verdict('keys-discoveries', 'Backslash.')).toBe(true);
    expect(verdict('keys-discoveries', 'Press the slash key.')).toBe(false);
    expect(verdict('keys-discoveries', 'Press forward slash.')).toBe(false);
  });

  it('cache keys do not depend on argument order', () => {
    expect(CachedKnowledge.key('fetch_wiki_page', { title: 'Fountain', section: 'Quaffing' })).toBe(CachedKnowledge.key('fetch_wiki_page', { section: 'Quaffing', title: 'Fountain' }));
    expect(CachedKnowledge.key('fetch_wiki_page', { title: 'Fountain' })).not.toBe(CachedKnowledge.key('fetch_wiki_page', { title: 'Sink' }));
  });
});
