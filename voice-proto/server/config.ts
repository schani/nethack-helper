import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CACHE_DIR = join(ROOT, ".cache");
export const SRC_DIR = process.env.NETHACK_SRC_DIR ?? join(CACHE_DIR, "nethack-src");
export const PROMPT_FILE = join(ROOT, "prompts", "instructions.md");
export const TOOL_LOG = join(CACHE_DIR, "tool-calls.jsonl");
export const TRANSCRIPT_LOG = join(CACHE_DIR, "transcripts.jsonl");

export const PORT = Number(process.env.PORT ?? 8788);
export const HOST = process.env.HOST ?? "0.0.0.0";

export const REALTIME_MODELS = ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"] as const;
export const DEFAULT_MODEL = "gpt-realtime-2.1";
export const VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"] as const;
export const DEFAULT_VOICE = "marin";
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
export const DEFAULT_REASONING = "low";

/** Model used by the web_search tool (Responses API + hosted web_search). */
export const WEB_SEARCH_MODEL = process.env.WEB_SEARCH_MODEL ?? "gpt-5.5";

export const TIMEOUTS = {
  web_search: 25_000,
  fetch_wiki_page: 10_000,
  search_nethack_source: 8_000,
  read_nethack_source: 3_000,
  mint: 10_000,
};

export function apiKey(): string {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error("OPENAI_API_KEY is not set");
  return k;
}
