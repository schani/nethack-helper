// web_search: OpenAI Responses API + hosted web_search tool.
// Ported from voice-proto/server/tools.ts (keep behaviour in sync).
import { ToolError, clip, str, withTimeout } from './util.ts';

const WEB_SEARCH_INSTRUCTIONS = `You are a research helper for a NetHack voice assistant.
NetHack 5.0.0 was released in May 2026; it is the former 3.7 development line and differs from 3.6 in many ways.
Search the web (prefer nethackwiki.com, then the official nethack.org / GitHub NetHack repo, then reputable community sources).
Return a concise factual answer of at most 120 words, plain text, no markdown tables, no headings.
If sources describe 3.6 (or older) behavior and 5.0 may differ, say so explicitly. If you could not find a reliable answer, say so.
Do not include URLs in the body; they are attached separately.`;

export interface WebSearchOptions {
  apiKey: () => string;
  model: string;
  timeoutMs: number;
}

export async function webSearch(args: Record<string, unknown>, opts: WebSearchOptions, signal?: AbortSignal): Promise<string> {
  const query = str(args.query, "query")!;
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: withTimeout(opts.timeoutMs, signal),
    headers: { Authorization: `Bearer ${opts.apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      instructions: WEB_SEARCH_INSTRUCTIONS,
      input: `NetHack question: ${query}`,
      tools: [{ type: "web_search", search_context_size: "low" }],
      reasoning: { effort: "none" },
      max_output_tokens: 1200,
      store: false,
    }),
  });
  const json: any = await res.json();
  if (!res.ok) throw new ToolError(`web search failed (${res.status}): ${json?.error?.message ?? "unknown error"}`);
  let text = "";
  const urls: string[] = [];
  for (const item of json.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type !== "output_text") continue;
      text += part.text;
      for (const a of part.annotations ?? []) {
        if (a.type === "url_citation" && a.url) {
          const u = a.url.replace(/[?&]utm_source=openai$/, "");
          if (!urls.includes(u)) urls.push(u);
        }
      }
    }
  }
  // Strip inline markdown citation links "([site](url))" — sources are listed separately.
  text = text.replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, "").replace(/\*\*/g, "").trim();
  if (!text) text = "No answer found.";
  return clip(text, 1500) + (urls.length ? `\nSources: ${urls.slice(0, 5).join(" , ")}` : "");
}

