/**
 * Assistant knowledge tools (ported from voice-proto/test/tools.test.ts) and the
 * assistant service / HTTP routes, without network: wiki parsing helpers, the
 * Sokoban step formatter, the local 5.0.0 source tools, tool time limits and
 * logging, session minting with a fake OpenAI endpoint.
 * Network tests (wiki, web search, real minting) live in test/net.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { parseInfobox, splitSections } from '../../src/assistant/knowledge/wiki.ts';
import { formatSokobanSolution, parseFlip } from '../../src/assistant/knowledge/sokoban.ts';
import { KNOWLEDGE_TOOL_DEFS, KnowledgeService } from '../../src/assistant/knowledge/index.ts';
import { ToolError } from '../../src/assistant/knowledge/util.ts';
import { AssistantService, TOOL_DEFS } from '../../src/assistant/service.ts';
import { registerAssistantRoutes } from '../../src/api/assistant.ts';
import { loadConfig } from '../../src/config.ts';
import { GameStateStore } from '../../src/feed/state.ts';

const cfg = loadConfig({});
const SRC = cfg.assistant.nethackSrcDir;
const hasSrc = fs.existsSync(path.join(SRC, 'src'));
const knowledge = new KnowledgeService({
  srcDir: SRC,
  apiKey: () => 'sk-test',
  webSearchModel: 'none',
  timeouts: { web_search: 1000, fetch_wiki_page: 1000, search_nethack_source: 8000 },
});
const runTool = (name: string, args: Record<string, unknown>) => knowledge.run(name, args);

describe('wiki helpers', () => {
  it('parseInfobox extracts and cleans monster template', () => {
    const wt = '{{monster\n |name=genetic engineer\n |attacks=[[Claw attack|Claw]] 1d4 [[polymorph]]\n |reference=[https://x y]\n}}\nText';
    const out = parseInfobox(wt);
    expect(out).toMatch(/\[monster infobox\]/);
    expect(out).toMatch(/attacks: Claw 1d4 polymorph/);
    expect(out).not.toMatch(/reference/);
  });
  it('splitSections splits on wiki headings', () => {
    const secs = splitSections('Intro text\n== Strategy ==\nDo X\n=== Sub ===\nY\n== History ==\nZ');
    expect(secs.map((s) => s.heading)).toEqual(['(intro)', 'Strategy', 'Sub', 'History']);
    expect(secs[0].text).toBe('Intro text');
  });
});

describe('tool definitions', () => {
  it('are valid realtime function tools with unique names', () => {
    const names = new Set<string>();
    for (const t of TOOL_DEFS) {
      expect(t.type).toBe('function');
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.parameters.type).toBe('object');
      names.add(t.name);
    }
    expect(names.size).toBe(TOOL_DEFS.length);
    expect(TOOL_DEFS.length).toBe(KNOWLEDGE_TOOL_DEFS.length + 9);
  });
});

describe('sokoban solution formatter', () => {
  const B = "'''";
  const wt = [
    "Intro.", "", "==Strategy==", "All boulders are replaced by letters so they can be referred to.", "",
    "First, open the way:", "",
    ` ------- ${B}A${B} d`,
    ` |<.@..| ${B}B${B} rr`,
    " |^.AB.|",
    " |^....|",
    " -------", "",
    "Finish:", "",
    ` ------- ${B}B${B} lll*`, " |<.>..|", " |^....|", " |^..B.|", " -------", "",
    "==Next level==", "x",
  ].join("\n");
  it('parseFlip normalizes spoken variants', () => {
    expect(parseFlip(undefined)).toBe('none');
    expect(parseFlip('left-right')).toBe('left-right');
    expect(parseFlip('horizontal')).toBe('left-right');
    expect(parseFlip('up_down')).toBe('up-down');
    expect(parseFlip('both')).toBe('both');
  });
  it('steps describe boulders relative to the player and arrival stairs', () => {
    const out = formatSokobanSolution(wt, 'Sokoban Level 9z')!;
    expect(out).toMatch(/1\. Boulder A \(directly below you; 1 down from the arrival stairs\): push down 1\./);
    expect(out).toMatch(/2\. Boulder B \(directly to your right; 1 right, 1 down from the arrival stairs\): push right 2\./);
    expect(out).toMatch(/3\. Boulder B \(\d+ (left|right).*\): push left 3, into a hole\./);
    expect(out).toMatch(/STAGE: Finish:\n3\. Boulder B .*push left 3, into a hole\./);
    expect(out).toMatch(/flip="none": up staircase 2 left \(same row\)/);
    expect(out).toMatch(/NETHACK 5\.0 NOTE/);
    expect(out).not.toMatch(/replaced by letters/);
  });
  it('flip mirrors positions and directions', () => {
    const out = formatSokobanSolution(wt, 'Sokoban Level 9z', 'left-right')!;
    expect(out).toMatch(/1\. Boulder A \(directly below you; 1 down from the arrival stairs\): push down 1\./);
    expect(out).toMatch(/2\. Boulder B \(directly to your left;.*push left 2\./);
    expect(out).toMatch(/ALREADY MIRRORED for flip="left-right"/);
  });
  it('returns null without a parsable solution', () => {
    expect(formatSokobanSolution('no strategy here', 'Sokoban Level 1a')).toBeNull();
  });
});

describe.skipIf(!hasSrc)('source tools (clean 5.0.0 checkout; scripts/setup-nethack-src.sh)', () => {
  it('searches the pristine tree, not our patched build tree', async () => {
    const r = await runTool('search_nethack_source', { pattern: 'wc_feed|feed_procs', path_glob: 'win/' });
    expect(r).toMatch(/^No matches/);
  });
  it('search finds genetic engineer in monsters.h and the 5.0 changelog', async () => {
    const r = await runTool('search_nethack_source', { pattern: 'genetic engineer', path_glob: 'include/ doc/fixes5-0-0.txt' });
    expect(r).toMatch(/include\/monsters\.h:\d+:/);
    expect(r).toMatch(/doc\/fixes5-0-0\.txt:\d+:/);
  });
  it('search caps output', async () => {
    const r = await runTool('search_nethack_source', { pattern: 'the' });
    expect(r.length).toBeLessThanOrEqual(4300);
    expect(r).toMatch(/showing first 40/);
  });
  it('invalid regex falls back to literal', async () => {
    expect(await runTool('search_nethack_source', { pattern: 'enl_foo(', path_glob: 'src/*.c' })).toMatch(/searched literally/);
  });
  it('path_glob is forgiving: bad entries skipped, bare file names matched anywhere', async () => {
    const r = await runTool('search_nethack_source', { pattern: 'genetic engineer', path_glob: 'include/monsters.h fixes5-0-0.txt src/nonexistent' });
    expect(r).toMatch(/include\/monsters\.h:\d+:/);
    expect(r).toMatch(/doc\/fixes5-0-0\.txt:\d+:/);
    expect(r).toMatch(/skipped nonexistent path_glob entries: src\/nonexistent/);
    await expect(runTool('search_nethack_source', { pattern: 'x', path_glob: 'src/nope' })).rejects.toThrow(/no such path/);
  });
  it('read returns numbered lines and caps range', async () => {
    expect(await runTool('read_nethack_source', { path: 'include/monsters.h', start_line: 1, end_line: 1000 })).toMatch(/^include\/monsters\.h lines 1-120 of \d+/);
  });
  it('read rejects traversal', async () => {
    await expect(runTool('read_nethack_source', { path: '../../package.json', start_line: 1 })).rejects.toThrow(/without '\.\.'/);
    await expect(runTool('read_nethack_source', { path: 'src/../../../server/main.ts', start_line: 1 })).rejects.toThrow(/without '\.\.'/);
    await expect(runTool('search_nethack_source', { pattern: 'x', path_glob: '../*' })).rejects.toThrow(/'\.\.'/);
    await expect(runTool('read_nethack_source', { path: '.git/config', start_line: 1 })).rejects.toThrow(/not allowed|no such file/);
  });
});

// ---------------------------------------------------------------- service + routes

function service(opts: { running?: boolean; knowledge?: KnowledgeService; fetch?: typeof fetch; timeouts?: Record<string, number> } = {}) {
  const store = new GameStateStore('t');
  store.session.state = opts.running === false ? 'exited' : 'running';
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-log-'));
  const svc = new AssistantService({
    game: { running: opts.running ?? true, state: (o) => store.snapshot(o), screen: () => ({ lines: [''] }) },
    paths: { ...cfg.assistant, logDir },
    knowledge: opts.knowledge ?? knowledge,
    fetch: opts.fetch,
    timeouts: opts.timeouts,
  });
  const app = Fastify();
  registerAssistantRoutes(app, svc);
  return { svc, app, logDir };
}

class SlowKnowledge extends KnowledgeService {
  async run(name: string, _args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (name === 'fetch_wiki_page') {
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    throw new ToolError('nope');
  }
}

describe('assistant service and routes', () => {
  it('POST /api/assistant/tools/:name runs a game tool and logs it with timing', async () => {
    const { app, logDir } = service();
    const res = await app.inject({ method: 'POST', url: '/api/assistant/tools/get_status', payload: { args: {}, call_id: 'c1' } });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.ok).toBe(true);
    expect(typeof j.ms).toBe('number');
    await new Promise((r) => setTimeout(r, 50));
    const log = fs.readFileSync(path.join(logDir, 'tool-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log[0]).toMatchObject({ name: 'get_status', call_id: 'c1', ok: true });
    expect(typeof log[0].ms).toBe('number');
  });

  it('game tools say when the game is not running', async () => {
    const { app } = service({ running: false });
    const j = (await app.inject({ method: 'POST', url: '/api/assistant/tools/look', payload: { args: { target: 'f' } } })).json();
    expect(j.ok).toBe(true);
    expect(j.result).toMatch(/not running/);
  });

  it('unknown tool -> 404 with ok=false; bad args -> ok=false with message', async () => {
    const { app } = service();
    const r = await app.inject({ method: 'POST', url: '/api/assistant/tools/rm_rf', payload: {} });
    expect(r.statusCode).toBe(404);
    expect(r.json().ok).toBe(false);
    const j = (await app.inject({ method: 'POST', url: '/api/assistant/tools/read_nethack_source', payload: { args: {} } })).json();
    expect(j.ok).toBe(false);
    expect(j.result).toMatch(/missing required argument 'path'|not installed/);
  });

  it('enforces tool time limits', async () => {
    const { svc } = service({ knowledge: new SlowKnowledge({ srcDir: SRC, apiKey: () => 'x', webSearchModel: 'x', timeouts: { web_search: 1, fetch_wiki_page: 1, search_nethack_source: 1 } }), timeouts: { fetch_wiki_page: 200 } });
    const t0 = Date.now();
    const r = await svc.runTool('fetch_wiki_page', { title: 'x' });
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/timed out/);
    expect(r.result).toMatch(/after 0 s|timed out/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('GET /api/assistant/context returns the compact snapshot', async () => {
    const { app } = service();
    const j = (await app.inject({ method: 'GET', url: '/api/assistant/context' })).json();
    expect(j.text).toMatch(/^\[Live game state/);
    expect(typeof j.turn).toBe('number');
  });

  it('POST /api/assistant/session mints via OpenAI and never returns the API key', async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-secret-test';
    let sent: any = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      sent = { url, headers: init.headers, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ value: 'ek_test', expires_at: 123, session: { id: 'sess_1' } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const { app } = service({ fetch: fakeFetch });
      for (const model of ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini']) {
        const res = await app.inject({ method: 'POST', url: '/api/assistant/session', payload: { model } });
        expect(res.statusCode).toBe(200);
        const j = res.json();
        expect(j).toMatchObject({ value: 'ek_test', model, session_id: 'sess_1' });
        expect(j.context.text).toMatch(/Live game state/);
        expect(res.body).not.toContain('sk-secret-test');
        expect(sent.url).toBe('https://api.openai.com/v1/realtime/client_secrets');
        const s = sent.body.session;
        expect(s.type).toBe('realtime');
        expect(s.audio.input.turn_detection.type).toBe('semantic_vad');
        expect(s.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['look', 'get_status', 'fetch_wiki_page', 'web_search']));
        expect(s.instructions).toMatch(/# Seeing the Game/);
        expect(s.instructions).toMatch(/never state or guess the identity of an unidentified item/);
        expect(s.instructions).toMatch(/released on May 2, 2026/);
        if (/mini/.test(model)) expect(s.instructions).toMatch(/Extra Accuracy Rules/);
        else expect(s.instructions).not.toMatch(/Extra Accuracy Rules/);
      }
      // garbage model names fall back to the default
      const j = (await app.inject({ method: 'POST', url: '/api/assistant/session', payload: { model: 'gpt-evil' } })).json();
      expect(j.model).toBe('gpt-realtime-2.1');
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  it('reports mint failures as errors', async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-x';
    try {
      const fakeFetch = (async () => new Response(JSON.stringify({ error: { message: 'bad session' } }), { status: 400 })) as unknown as typeof fetch;
      const { app } = service({ fetch: fakeFetch });
      const res = await app.inject({ method: 'POST', url: '/api/assistant/session', payload: {} });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('bad session');
    } finally {
      process.env.OPENAI_API_KEY = prev;
    }
  });
});
