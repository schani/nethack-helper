/**
 * Assistant service: mints Realtime sessions, runs tool calls (game tools
 * against the game session service, knowledge tools against wiki / web /
 * source) with time limits and logging, and produces the live game context.
 * The API layer talks only to this class; the browser never sees
 * OPENAI_API_KEY, only short-lived client secrets.
 */
import path from 'node:path';
import type { AssistantPaths } from '../config.ts';
import {
  CLIENT_SECRET_TTL_S, DEFAULT_MODEL, DEFAULT_REASONING, DEFAULT_VOICE, REALTIME_MODELS, REASONING_EFFORTS, TIMEOUTS, VOICES,
  WEB_SEARCH_MODEL, apiKey,
} from './config.ts';
import { GAME_TOOL_DEFS, GameTools, type GameSource } from './game/tools.ts';
import { KNOWLEDGE_TOOL_DEFS, KnowledgeService } from './knowledge/index.ts';
import { ToolError } from './knowledge/util.ts';
import { JsonlLog } from './log.ts';
import { buildSessionConfig } from './session-config.ts';

export const TOOL_DEFS = [...GAME_TOOL_DEFS, ...KNOWLEDGE_TOOL_DEFS] as const;
export const TOOL_NAMES: readonly string[] = TOOL_DEFS.map((t) => t.name);

export interface ToolResult {
  ok: boolean;
  result: string;
  ms: number;
}

export interface MintedSession {
  value: string;
  expires_at: number;
  model: string;
  voice: string;
  reasoning: string;
  mint_ms: number;
  session_id?: string;
  /** compact game snapshot to add to the conversation right after connecting */
  context: { text: string; turn: number };
}

export class AssistantError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

const pick = <T extends string>(list: readonly T[], v: unknown, def: T): T => ((list as readonly unknown[]).includes(v) ? (v as T) : def);

export interface AssistantServiceOptions {
  game: GameSource;
  paths: AssistantPaths;
  /** override for tests */
  knowledge?: KnowledgeService;
  fetch?: typeof fetch;
  /** per-tool time limit overrides (ms), see TIMEOUTS */
  timeouts?: Record<string, number>;
}

export class AssistantService {
  readonly game: GameTools;
  readonly knowledge: KnowledgeService;
  private paths: AssistantPaths;
  private toolLog: JsonlLog;
  private transcriptLog: JsonlLog;
  private fetchFn: typeof fetch;
  private timeouts: Record<string, number>;

  constructor(opts: AssistantServiceOptions) {
    this.paths = opts.paths;
    this.game = new GameTools(opts.game);
    this.knowledge =
      opts.knowledge ??
      new KnowledgeService({
        srcDir: opts.paths.nethackSrcDir,
        apiKey,
        webSearchModel: WEB_SEARCH_MODEL,
        timeouts: { web_search: TIMEOUTS.web_search, fetch_wiki_page: TIMEOUTS.fetch_wiki_page, search_nethack_source: TIMEOUTS.search_nethack_source },
      });
    this.toolLog = new JsonlLog(path.join(opts.paths.logDir, 'tool-calls.jsonl'));
    this.transcriptLog = new JsonlLog(path.join(opts.paths.logDir, 'transcripts.jsonl'));
    this.fetchFn = opts.fetch ?? fetch;
    this.timeouts = { ...TIMEOUTS, ...opts.timeouts };
  }

  async config() {
    return {
      models: REALTIME_MODELS,
      defaultModel: DEFAULT_MODEL,
      voices: VOICES,
      defaultVoice: DEFAULT_VOICE,
      reasoningEfforts: REASONING_EFFORTS,
      defaultReasoning: DEFAULT_REASONING,
      tools: TOOL_NAMES,
      webSearchModel: WEB_SEARCH_MODEL,
      sourceAvailable: await this.knowledge.sourceAvailable(),
      apiKeyConfigured: !!process.env.OPENAI_API_KEY,
    };
  }

  /** Session config sent to OpenAI (exposed for tests / debugging). */
  sessionConfig(opts: { model: string; voice: string; reasoning: string }) {
    return buildSessionConfig({ ...opts, tools: TOOL_DEFS, promptsDir: this.paths.promptsDir });
  }

  /** Mint an ephemeral client secret for a WebRTC Realtime call. */
  async mint(body: { model?: unknown; voice?: unknown; reasoning?: unknown }): Promise<MintedSession> {
    const model = pick(REALTIME_MODELS, body.model, DEFAULT_MODEL);
    const voice = pick(VOICES, body.voice, DEFAULT_VOICE);
    const reasoning = pick(REASONING_EFFORTS, body.reasoning, DEFAULT_REASONING);
    let key: string;
    try {
      key = apiKey();
    } catch (e) {
      throw new AssistantError((e as Error).message, 503);
    }
    const session = await this.sessionConfig({ model, voice, reasoning });
    const t0 = performance.now();
    const res = await this.fetchFn('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUTS.mint),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: CLIENT_SECRET_TTL_S }, session }),
    }).catch((e: Error) => {
      throw new AssistantError(`could not reach OpenAI: ${e.message}`);
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) throw new AssistantError(json?.error?.message ?? `mint failed (${res.status})`);
    this.transcriptLog.write({ kind: 'mint', model, voice, reasoning, ms, session_id: json.session?.id });
    return {
      value: json.value,
      expires_at: json.expires_at,
      model,
      voice,
      reasoning,
      mint_ms: ms,
      session_id: json.session?.id,
      context: this.context(),
    };
  }

  /** Compact game snapshot for the model's context. */
  context(): { text: string; turn: number } {
    try {
      return this.game.snapshot();
    } catch (e) {
      return { text: `[Live game state] unavailable (${(e as Error).message})`, turn: 0 };
    }
  }

  /** Run one tool call with its time limit; never throws (errors become the result text). */
  async runTool(name: string, args: Record<string, unknown>, meta: { callId?: string; sessionId?: string } = {}): Promise<ToolResult & { known: boolean }> {
    const t0 = performance.now();
    const known = TOOL_NAMES.includes(name);
    let ok = true;
    let result: string;
    const limit = this.game.has(name) ? this.timeouts.game : (this.timeouts[name] ?? 10_000);
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      if (!known) throw new ToolError(`unknown tool '${name}'`);
      const work = this.game.has(name) ? Promise.resolve().then(() => this.game.run(name, args)) : this.knowledge.run(name, args, ac.signal);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort();
          reject(new ToolError(`${name} timed out after ${limit >= 1000 ? Math.round(limit / 1000) : (limit / 1000).toFixed(1)} s`));
        }, limit);
      });
      result = await Promise.race([work, timeout]);
    } catch (e: any) {
      ok = false;
      const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      result = e instanceof ToolError ? e.message : timeout ? `${name} timed out` : `internal error: ${e?.message ?? e}`;
      if (!(e instanceof ToolError) && !timeout) console.error(`assistant tool ${name} failed:`, e);
    } finally {
      clearTimeout(timer);
    }
    const ms = Math.round(performance.now() - t0);
    this.toolLog.write({ call_id: meta.callId, session_id: meta.sessionId, name, args, ok, ms, chars: result.length, preview: result.slice(0, 300) });
    return { ok, result, ms, known };
  }

  /** Browser posts finished transcript lines / events so runs can be inspected later. */
  logTranscript(entry: Record<string, unknown>) {
    this.transcriptLog.write(entry);
  }
}
