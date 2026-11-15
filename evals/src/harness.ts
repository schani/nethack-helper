/**
 * Wires one eval conversation to the production assistant code:
 * AssistantService (real tool definitions, tool executors with their time
 * limits, snapshot builder) over a frozen fixture or a live game, the real
 * session config (prompts, tools, VAD...) with variant overrides, and the
 * shared RealtimeConversation via the Node WebSocket driver.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TOOL_DEFS, AssistantService } from '../../server/src/assistant/service.ts';
import { KnowledgeService } from '../../server/src/assistant/knowledge/index.ts';
import { ToolError } from '../../server/src/assistant/knowledge/util.ts';
import { TIMEOUTS, WEB_SEARCH_MODEL, apiKey } from '../../server/src/assistant/config.ts';
import { buildSessionConfig } from '../../server/src/assistant/session-config.ts';
import { loadConfig } from '../../server/src/config.ts';
import type { AssistantBackend, GameContext } from '../../shared/assistant/realtime-core.ts';
import { FixtureGameSource, type Fixture } from './fixtures.ts';
import type { EvalCase, Json, Variant } from './types.ts';
import { fetchWikiPage as fetchWikiPageV2 } from './legacy/wiki-v2.ts';
import { searchNethackSource as searchNethackSourceV2 } from './legacy/source-v2.ts';
import { V2_TOOL_DESCRIPTIONS } from './legacy/tools-v2.ts';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
export const CACHE_DIR = path.join(ROOT, '.cache/evals');
const serverCfg = loadConfig({ ...process.env, PORT: '0' });

export type KnowledgeMode = 'cache' | 'live' | 'offline';

/**
 * The production KnowledgeService with a read-through cache keyed by tool + arguments, so knowledge cases
 * are repeatable and cheap (web_search costs money and the wiki changes). 'live' bypasses the cache,
 * 'offline' never hits the network (cache misses become tool errors).
 */
/** Bump when fetch_wiki_page output changes, so cached results of the old format are not reused (v2 keys had no salt). */
const WIKI_FORMAT = 'wiki-html-1';
/** Local, deterministic tools: never cached (their output changes with the code, not with the outside world). */
const LOCAL_TOOLS = new Set(['search_nethack_source', 'read_nethack_source', 'nethack_lookup']);

export class CachedKnowledge extends KnowledgeService {
  private mode: KnowledgeMode;
  private dir: string;
  private legacy: boolean;
  hits = 0;
  misses = 0;

  constructor(mode: KnowledgeMode, opts: { legacy?: boolean; dir?: string } = {}) {
    const dir = opts.dir ?? path.join(CACHE_DIR, 'knowledge');
    super({
      srcDir: serverCfg.assistant.nethackSrcDir,
      apiKey,
      webSearchModel: WEB_SEARCH_MODEL,
      timeouts: { web_search: TIMEOUTS.web_search, fetch_wiki_page: TIMEOUTS.fetch_wiki_page, search_nethack_source: TIMEOUTS.search_nethack_source },
    });
    this.mode = mode;
    this.dir = dir;
    this.legacy = !!opts.legacy;
    fs.mkdirSync(dir, { recursive: true });
  }

  static key(name: string, args: Record<string, unknown>, salt = ''): string {
    const sorted = JSON.stringify(Object.keys(args).sort().map((k) => [k, args[k]]));
    return createHash('sha1').update(`${salt}${name}\n${sorted}`).digest('hex').slice(0, 20);
  }

  /** the production tools, or the frozen v2 ones */
  private async exec(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (this.legacy && name === 'fetch_wiki_page') return fetchWikiPageV2(args, TIMEOUTS.fetch_wiki_page, signal);
    if (this.legacy && name === 'search_nethack_source') return searchNethackSourceV2(serverCfg.assistant.nethackSrcDir, args, TIMEOUTS.search_nethack_source, signal);
    if (this.legacy && name === 'nethack_lookup') throw new ToolError(`unknown tool '${name}'`);
    return super.run(name, args, signal);
  }

  async run(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (LOCAL_TOOLS.has(name)) return this.exec(name, args, signal);
    const salt = !this.legacy && name === 'fetch_wiki_page' ? `${WIKI_FORMAT}\n` : '';
    const file = path.join(this.dir, `${name}-${CachedKnowledge.key(name, args, salt)}.json`);
    if (this.mode !== 'live' && fs.existsSync(file)) {
      this.hits++;
      const c = JSON.parse(fs.readFileSync(file, 'utf8')) as { ok: boolean; result: string };
      if (!c.ok) throw new ToolError(c.result);
      return c.result;
    }
    if (this.mode === 'offline') throw new ToolError(`${name} is unavailable (offline eval run, not cached)`);
    this.misses++;
    try {
      const result = await this.exec(name, args, signal);
      fs.writeFileSync(file, JSON.stringify({ name, args, ok: true, result }));
      return result;
    } catch (e) {
      // only cache deterministic tool errors (e.g. "no wiki page"), not timeouts / network failures
      if (e instanceof ToolError && !/timed out|network|ECONN|fetch failed|HTTP 5/i.test(e.message)) {
        fs.writeFileSync(file, JSON.stringify({ name, args, ok: false, result: e.message }));
      }
      throw e;
    }
  }
}

function deepMerge(a: Json, b: Json): Json {
  const out: Json = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v;
  }
  return out;
}

export const DEFAULTS = { model: 'gpt-realtime-2.1', reasoning: 'low', voice: 'marin' };

export function resolvedVariant(v: Variant) {
  return {
    model: v.model ?? DEFAULTS.model,
    reasoning: v.reasoning ?? DEFAULTS.reasoning,
    voice: v.voice ?? DEFAULTS.voice,
    promptsDir: v.promptsDir ? path.resolve(ROOT, v.promptsDir) : serverCfg.assistant.promptsDir,
  };
}

/** The production session config (same function as /api/assistant/session) with the variant's overrides. */
export async function sessionFor(v: Variant): Promise<Json> {
  const r = resolvedVariant(v);
  const descriptions = { ...(v.knowledge === 'v2' ? V2_TOOL_DESCRIPTIONS : {}), ...Object.fromEntries(Object.entries(v.tools ?? {}).map(([k, x]) => [k, x.description])) };
  const tools = TOOL_DEFS.filter((t) => !v.disableTools?.includes(t.name) && !(v.knowledge === 'v2' && t.name === 'nethack_lookup')).map((t) =>
    descriptions[t.name] ? { ...t, description: descriptions[t.name]! } : t,
  );
  let s: Json = await buildSessionConfig({ model: r.model, voice: r.voice, reasoning: r.reasoning, tools, promptsDir: r.promptsDir });
  for (const e of v.promptEdits ?? []) {
    if (!s.instructions.includes(e.find)) throw new Error(`variant ${v.name}: prompt edit target not found: ${e.find.slice(0, 80)}`);
    s.instructions = s.instructions.replace(e.find, e.replace);
  }
  if (v.instructionsAppend) s.instructions += `\n\n${v.instructionsAppend}`;
  if (v.session) s = deepMerge(s, v.session);
  return s;
}

export interface Backend {
  backend: AssistantBackend;
  initialContext: GameContext | null;
  close(): Promise<void>;
}

/** In-process backend over a frozen fixture: exactly what the HTTP routes call. */
export function fixtureBackend(fx: Fixture, c: EvalCase, v: Variant, knowledge: KnowledgeService, logDir: string): Backend {
  const source = new FixtureGameSource(fx);
  if (c.faults?.gameError) source.failWith = c.faults.gameError;
  const service = new AssistantService({
    game: source,
    paths: { ...serverCfg.assistant, logDir },
    knowledge,
    timeouts: c.faults?.timeouts,
    gameOptions: v.game,
  });
  const none = v.snapshot === 'none';
  const backend: AssistantBackend = {
    tool: async (name, args, callId, sessionId) => {
      // a fault time limit <= 1 ms always fails, also for tools that answer synchronously (nethack_lookup)
      const limit = c.faults?.timeouts?.[name];
      if (limit !== undefined && limit <= 1) return { ok: false, result: `${name} timed out after 0.0 s`, ms: 1 };
      const r = await service.runTool(name, args, { callId, sessionId });
      return { ok: r.ok, result: r.result, ms: r.ms };
    },
    context: async () => (none ? { text: '', turn: 0 } : service.context()),
    log: () => {},
  };
  return { backend, initialContext: none ? null : service.context(), close: async () => {} };
}

/** Backend over a live server's /api/assistant routes (what the browser does). */
export function httpBackend(base: string, v: Variant): AssistantBackend {
  const none = v.snapshot === 'none';
  return {
    tool: async (name, args, callId, sessionId) => {
      try {
        const r = await fetch(`${base}/api/assistant/tools/${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ args, call_id: callId, session_id: sessionId }),
          signal: AbortSignal.timeout(40_000),
        });
        const j = (await r.json().catch(() => null)) as { ok: boolean; result: string; ms?: number } | null;
        return j ? { ok: !!j.ok, result: String(j.result ?? ''), ms: j.ms } : { ok: false, result: `HTTP ${r.status}` };
      } catch (e) {
        return { ok: false, result: `network error: ${(e as Error).message}` };
      }
    },
    context: async () => (none ? { text: '', turn: 0 } : ((await (await fetch(`${base}/api/assistant/context`)).json()) as GameContext)),
    log: () => {},
  };
}
