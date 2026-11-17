/** Realtime models, voices and tool timeouts for the voice assistant (ported from voice-proto/server/config.ts). */

export const REALTIME_MODELS = ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini'] as const;
export const DEFAULT_MODEL = 'gpt-realtime-2.1';
export const VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'] as const;
export const DEFAULT_VOICE = 'marin';
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
export const DEFAULT_REASONING = 'low';

/** Model used by the web_search tool (Responses API + hosted web_search). */
export const WEB_SEARCH_MODEL = process.env.WEB_SEARCH_MODEL ?? 'gpt-5.5';

/** Lifetime of the ephemeral client secret (only needed to open the WebRTC call). */
export const CLIENT_SECRET_TTL_S = 600;

/** Per-tool time limits (ms); the service aborts and reports a timeout to the model after this. */
export const TIMEOUTS: Record<string, number> = {
  web_search: 25_000,
  fetch_wiki_page: 10_000,
  search_nethack_source: 8_000,
  read_nethack_source: 3_000,
  nethack_lookup: 3_000,
  // game tools read in-memory state; anything slower than this is a bug
  game: 2_000,
  mint: 10_000,
};

export function apiKey(): string {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error('OPENAI_API_KEY is not set');
  return k;
}

/**
 * Deep-thinking expert (consult_expert): a slow, strong reasoning model the realtime model consults in the
 * background (server/src/assistant/expert.ts).  ASSISTANT_EXPERT=0/1 overrides `enabled`.
 */
export const EXPERT = {
  // adopted after evals: deep set 37% -> 74% pass, core set unchanged (never called there); see evals/variants.ts
  enabled: process.env.ASSISTANT_EXPERT !== undefined ? process.env.ASSISTANT_EXPERT !== '0' : true,
  model: process.env.EXPERT_MODEL ?? 'gpt-6.1-terra',
  effort: process.env.EXPERT_EFFORT ?? 'medium',
  /** whole consultation, tool rounds included (ms) */
  timeoutMs: Number(process.env.EXPERT_TIMEOUT_MS ?? 90_000),
  /** max tool rounds before it must answer */
  maxRounds: Number(process.env.EXPERT_MAX_ROUNDS ?? 8),
};

/** USD per 1M tokens (developers.openai.com/api/docs/pricing, Nov 2026) for expert cost logging. */
export const EXPERT_PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-6.1-terra': { input: 1, cached: 0.05, output: 5 },
  'gpt-6.1-sol': { input: 2, cached: 0.1, output: 10 },
  'gpt-5.5': { input: 5, cached: 0.5, output: 30 },
};
