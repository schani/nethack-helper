import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { WebSocket } from 'ws';
import type { GameSession, SessionSubscriber } from '../game/session.ts';
import type { ClientMessage, ServerMessage } from '../../../shared/feed-events.ts';
import type { AssistantService } from '../assistant/service.ts';
import { registerAssistantRoutes } from './assistant.ts';

export interface AppOptions {
  session: GameSession;
  /** voice assistant routes (/api/assistant/*); omitted = no assistant */
  assistant?: AssistantService;
  webDist?: string;
  logger?: boolean;
}

/**
 * HTTP + websocket API.  Talks only to the GameSession service.
 *
 *   GET  /api/state            full derived game state (all remembered levels)
 *        ?level=current        only the current level's map
 *   GET  /api/screen           headless terminal text (text/plain)
 *        ?format=json          { lines, cursor, cols, rows }
 *   GET  /api/cell?x=&y=       remembered cell on the current level (map coords)
 *   GET  /api/session          process lifecycle info
 *   POST /api/session/start    start / resume (no-op while running)
 *   GET  /ws                   terminal stream, see ServerMessage/ClientMessage
 *   /api/assistant/*           voice assistant, see api/assistant.ts
 */
export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { session } = opts;
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  app.get('/api/state', async (req) => {
    const q = req.query as { level?: string };
    return session.state({ allLevels: q.level !== 'current' });
  });

  app.get('/api/screen', async (req, reply) => {
    const q = req.query as { format?: string };
    const scr = session.screen();
    if (q.format === 'json') return scr;
    reply.type('text/plain; charset=utf-8');
    return scr.lines.join('\n') + '\n';
  });

  app.get('/api/cell', async (req, reply) => {
    const q = req.query as { x?: string; y?: string };
    const x = Number(q.x), y = Number(q.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      reply.code(400);
      return { error: 'x and y (map coordinates) required' };
    }
    return { x, y, cell: session.cellAt(x, y) };
  });

  app.get('/api/session', async () => session.info());

  if (opts.assistant) registerAssistantRoutes(app, opts.assistant);

  app.post('/api/session/start', async () => {
    const started = session.start();
    return { started, session: session.info() };
  });

  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    const send = (msg: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const sub: SessionSubscriber = {
      snapshot: (data, cols, rows, info) => send({ type: 'snapshot', data, cols, rows, session: info }),
      output: (data) => send({ type: 'output', data }),
      session: (info) => send({ type: 'session', session: info }),
      state: (state) => send({ type: 'state', state }),
    };
    const unsubscribe = session.subscribe(sub);
    socket.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'input' && typeof msg.data === 'string') session.write(msg.data, { meta: msg.meta === true });
      else if (msg.type === 'start') session.start();
    });
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });

  if (opts.webDist && fs.existsSync(opts.webDist)) {
    await app.register(fastifyStatic, { root: opts.webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      reply.code(404).send({ error: 'not found' });
    });
  } else {
    app.get('/', async (_req, reply) => {
      reply.type('text/plain');
      return 'web/dist not built; run `npm run build`\n';
    });
  }

  return app;
}
