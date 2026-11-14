/** HTTP calls to our server's /api/assistant routes (never to OpenAI). */

export interface AssistantConfig {
  models: string[];
  defaultModel: string;
  voices: string[];
  defaultVoice: string;
  reasoningEfforts: string[];
  defaultReasoning: string;
  tools: string[];
  sourceAvailable: boolean;
  apiKeyConfigured: boolean;
}

export interface GameContext {
  text: string;
  turn: number;
}

export interface MintedSession {
  value: string;
  expires_at: number;
  model: string;
  voice: string;
  reasoning: string;
  mint_ms: number;
  session_id?: string;
  context: GameContext;
}

export interface ToolResponse {
  ok: boolean;
  result: string;
  ms?: number;
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const assistantApi = {
  config: async (): Promise<AssistantConfig> => json(await fetch('/api/assistant/config')),

  mint: async (opts: { model: string; voice: string; reasoning: string }): Promise<MintedSession> =>
    json(
      await fetch('/api/assistant/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      }),
    ),

  context: async (timeoutMs = 1500): Promise<GameContext> =>
    json(await fetch('/api/assistant/context', { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })),

  /** never throws: failures become an error result for the model */
  tool: async (name: string, args: Record<string, unknown>, callId: string, sessionId?: string): Promise<ToolResponse> => {
    try {
      const r = await fetch(`/api/assistant/tools/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args, call_id: callId, session_id: sessionId }),
        // server-side limits are at most 25 s; this only catches a hung connection
        signal: AbortSignal.timeout(40_000),
      });
      const j = (await r.json().catch(() => null)) as ToolResponse | null;
      return j ? { ok: !!j.ok, result: String(j.result ?? ''), ms: j.ms } : { ok: false, result: `HTTP ${r.status}` };
    } catch (e) {
      const err = e as Error;
      return { ok: false, result: err.name === 'TimeoutError' ? `${name} timed out` : `network error: ${err.message}` };
    }
  },

  log: (entry: Record<string, unknown>) => {
    fetch('/api/assistant/transcript', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    }).catch(() => {});
  },
};
