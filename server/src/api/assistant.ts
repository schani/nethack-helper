import type { FastifyInstance } from 'fastify';
import { AssistantError, type AssistantService } from '../assistant/service.ts';

/**
 * Assistant routes.  Talk only to the AssistantService.
 *
 *   GET  /api/assistant/config        models, voices, tool names, source availability
 *   POST /api/assistant/session       mint an ephemeral Realtime client secret (+ initial game context)
 *   POST /api/assistant/tools/:name   run a tool call: { args, call_id, session_id } -> { ok, result, ms }
 *   GET  /api/assistant/context       compact live game snapshot { text, turn }
 *   POST /api/assistant/transcript    append a transcript/event line to the log
 */
export function registerAssistantRoutes(app: FastifyInstance, assistant: AssistantService) {
  app.get('/api/assistant/config', async () => assistant.config());

  app.post<{ Body: { model?: string; voice?: string; reasoning?: string } }>('/api/assistant/session', async (req, reply) => {
    try {
      const minted = await assistant.mint(req.body ?? {});
      req.log.info({ model: minted.model, ms: minted.mint_ms }, 'minted realtime client secret');
      reply.header('Cache-Control', 'no-store');
      return minted;
    } catch (e) {
      const status = e instanceof AssistantError ? e.status : 500;
      req.log.error({ err: e }, 'client secret mint failed');
      return reply.code(status).send({ error: (e as Error).message });
    }
  });

  app.post<{ Params: { name: string }; Body: { args?: Record<string, unknown>; call_id?: string; session_id?: string } }>(
    '/api/assistant/tools/:name',
    async (req, reply) => {
      const args = req.body?.args && typeof req.body.args === 'object' ? req.body.args : {};
      const r = await assistant.runTool(req.params.name, args, { callId: req.body?.call_id, sessionId: req.body?.session_id });
      req.log.info({ tool: req.params.name, ok: r.ok, ms: r.ms, chars: r.result.length }, 'assistant tool call');
      if (!r.known) reply.code(404);
      return { ok: r.ok, result: r.result, ms: r.ms };
    },
  );

  app.get('/api/assistant/context', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return assistant.context();
  });

  app.post<{ Body: Record<string, unknown> }>('/api/assistant/transcript', { bodyLimit: 64 * 1024 }, async (req) => {
    assistant.logTranscript(req.body && typeof req.body === 'object' ? req.body : {});
    return { ok: true };
  });
}
