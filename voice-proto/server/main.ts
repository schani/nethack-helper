import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CACHE_DIR, DEFAULT_MODEL, DEFAULT_REASONING, DEFAULT_VOICE, HOST, PORT, REALTIME_MODELS,
  REASONING_EFFORTS, ROOT, TIMEOUTS, TOOL_LOG, TRANSCRIPT_LOG, VOICES, WEB_SEARCH_MODEL, apiKey,
} from "./config.ts";
import { TOOL_NAMES, ToolError, runTool, srcAvailable } from "./tools.ts";
import { buildSessionConfig } from "./session.ts";

await mkdir(CACHE_DIR, { recursive: true });

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 256 * 1024 });

app.get("/api/config", async () => ({
  models: REALTIME_MODELS,
  defaultModel: DEFAULT_MODEL,
  voices: VOICES,
  defaultVoice: DEFAULT_VOICE,
  reasoningEfforts: REASONING_EFFORTS,
  defaultReasoning: DEFAULT_REASONING,
  tools: TOOL_NAMES,
  webSearchModel: WEB_SEARCH_MODEL,
  sourceAvailable: await srcAvailable(),
}));

app.post<{ Body: { model?: string; voice?: string; reasoning?: string } }>("/api/session", async (req, reply) => {
  const body = req.body ?? {};
  const model = (REALTIME_MODELS as readonly string[]).includes(body.model ?? "") ? body.model! : DEFAULT_MODEL;
  const voice = (VOICES as readonly string[]).includes(body.voice ?? "") ? body.voice! : DEFAULT_VOICE;
  const reasoning = (REASONING_EFFORTS as readonly string[]).includes(body.reasoning ?? "") ? body.reasoning! : DEFAULT_REASONING;
  const session = await buildSessionConfig({ model, voice, reasoning });
  const t0 = performance.now();
  const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUTS.mint),
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 600 }, session }),
  });
  const json: any = await res.json();
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) {
    req.log.error({ status: res.status, error: json?.error }, "client secret mint failed");
    return reply.code(502).send({ error: json?.error?.message ?? `mint failed (${res.status})` });
  }
  req.log.info({ model, voice, reasoning, ms }, "minted realtime client secret");
  reply.header("Cache-Control", "no-store");
  // Only the short-lived ephemeral secret goes to the browser — never OPENAI_API_KEY.
  return { value: json.value, expires_at: json.expires_at, model, voice, reasoning, mint_ms: ms, session_id: json.session?.id };
});

app.post<{ Params: { name: string }; Body: { args?: Record<string, unknown>; call_id?: string } }>(
  "/api/tools/:name",
  async (req, reply) => {
    const { name } = req.params;
    const args = req.body?.args ?? {};
    const t0 = performance.now();
    let ok = true;
    let result: string;
    try {
      if (!TOOL_NAMES.includes(name as any)) throw new ToolError(`unknown tool '${name}'`);
      result = await runTool(name, args);
    } catch (e: any) {
      ok = false;
      const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
      result = e instanceof ToolError ? e.message : timeout ? `${name} timed out` : `internal error: ${e?.message ?? e}`;
      if (!(e instanceof ToolError)) req.log.error({ err: e, name }, "tool failed");
    }
    const ms = Math.round(performance.now() - t0);
    const entry = { ts: new Date().toISOString(), call_id: req.body?.call_id, name, args, ok, ms, chars: result.length, preview: result.slice(0, 300) };
    appendFile(TOOL_LOG, JSON.stringify(entry) + "\n").catch(() => {});
    req.log.info({ tool: name, ok, ms, chars: result.length }, "tool call");
    if (!TOOL_NAMES.includes(name as any)) reply.code(404);
    return { ok, result, ms };
  },
);

/** Browser posts finished transcript lines / events here so test runs can be inspected later. */
app.post<{ Body: Record<string, unknown> }>("/api/transcript", async (req) => {
  await appendFile(TRANSCRIPT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...req.body }) + "\n");
  return { ok: true };
});

app.get("/api/health", async () => ({ ok: true }));

const webDir = join(ROOT, "dist", "web");
if (existsSync(webDir)) {
  await app.register(fastifyStatic, { root: webDir, prefix: "/" });
} else {
  app.get("/", async (_req, reply) => reply.type("text/plain").send("UI not built: run `npm run build`."));
}

await app.listen({ port: PORT, host: HOST });
