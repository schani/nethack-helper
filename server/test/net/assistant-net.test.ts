/**
 * Assistant network tests: nethackwiki.com, OpenAI web search and real
 * Realtime client-secret minting (ported from voice-proto/test/tools.test.ts).
 * Run: npm run test:net (needs network; minting/web search need OPENAI_API_KEY).
 */
import { describe, expect, it } from 'vitest';
import { KnowledgeService } from '../../src/assistant/knowledge/index.ts';
import { AssistantService } from '../../src/assistant/service.ts';
import { TIMEOUTS, WEB_SEARCH_MODEL, apiKey } from '../../src/assistant/config.ts';
import { loadConfig } from '../../src/config.ts';
import { GameStateStore } from '../../src/feed/state.ts';

const cfg = loadConfig({});
const knowledge = new KnowledgeService({
  srcDir: cfg.assistant.nethackSrcDir,
  apiKey,
  webSearchModel: WEB_SEARCH_MODEL,
  timeouts: { web_search: TIMEOUTS.web_search, fetch_wiki_page: TIMEOUTS.fetch_wiki_page, search_nethack_source: TIMEOUTS.search_nethack_source },
});
const runTool = (name: string, args: Record<string, unknown>) => knowledge.run(name, args);
const hasKey = !!process.env.OPENAI_API_KEY;

describe('wiki tool', { timeout: 30_000 }, () => {
  it('fetches page with infobox', async () => {
    const r = await runTool('fetch_wiki_page', { title: 'Genetic engineer' });
    expect(r).toMatch(/^Wiki: Genetic engineer/);
    expect(r).toMatch(/monster infobox/);
    expect(r.length).toBeLessThan(9000);
    expect(r).toMatch(/NetHack 5\.0 changelog[\s\S]*'port away after polymorphing/);
  });
  it('renders tables as pipe rows', async () => {
    const r = await runTool('fetch_wiki_page', { title: 'Fountain', section: 'Quaffing' });
    expect(r).toMatch(/Probability \| Message \| Effect/);
    expect(r).toMatch(/water moccasin/);
  });
  it('approximate title resolves to the closest page in one call', async () => {
    const r = await runTool('fetch_wiki_page', { title: 'genetic enginer' });
    expect(r).toMatch(/^Wiki: Genetic engineer/);
    expect(r).toMatch(/closest match/);
  });
  it('section selection (with Solution -> Strategy alias)', async () => {
    expect(await runTool('fetch_wiki_page', { title: 'Elbereth', section: 'History' })).toMatch(/== History ==/);
    const s = await runTool('fetch_wiki_page', { title: 'Sokoban', section: 'Solution' });
    expect(s).toMatch(/== Strategy ==/);
    expect(s).toMatch(/Sokoban Level 1a/);
  });
  it('Sokoban level page returns a voice-ready step list, optionally mirrored', async () => {
    const r = await runTool('fetch_wiki_page', { title: 'Sokoban Level 1a', section: 'Solution' });
    expect(r).toMatch(/SOKOBAN SOLUTION for Sokoban Level 1a/);
    expect(r).toMatch(/1\. Boulder A \(2 right, 1 down from you; .*\): push down 1\./);
    expect(r).not.toMatch(/\|\^\|/);
    const m = await runTool('fetch_wiki_page', { title: 'Sokoban Level 1a', flip: 'left-right' });
    expect(m).toMatch(/2\. Boulder B \(directly to your left; .*\): push left 4\./);
  });
});

describe.skipIf(!hasKey)('OpenAI', () => {
  it('web_search returns a concise answer with sources', { timeout: 40_000 }, async () => {
    const r = await runTool('web_search', { query: 'NetHack 5.0.0 new monsters' });
    expect(r.length).toBeGreaterThan(50);
    expect(r.length).toBeLessThan(2500);
    expect(r).toMatch(/Sources: https?:\/\//);
  });
  it('mints ephemeral client secrets for both models with the full session config', { timeout: 30_000 }, async () => {
    const store = new GameStateStore('t');
    const svc = new AssistantService({ game: { running: false, state: (o) => store.snapshot(o), screen: () => ({ lines: [] }) }, paths: cfg.assistant });
    for (const model of ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini']) {
      const j = await svc.mint({ model });
      expect(j.value).toMatch(/^ek_/);
      expect(j.model).toBe(model);
      expect(JSON.stringify(j)).not.toContain(process.env.OPENAI_API_KEY!);
    }
  });
});
