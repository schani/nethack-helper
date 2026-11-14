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
  // game tools read in-memory state; anything slower than this is a bug
  game: 2_000,
  mint: 10_000,
};

export function apiKey(): string {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error('OPENAI_API_KEY is not set');
  return k;
}
