import { loadConfig } from './config.ts';
import { GameSession } from './game/session.ts';
import { buildApp } from './api/app.ts';
import { AssistantService } from './assistant/service.ts';

const cfg = loadConfig();
const session = new GameSession(cfg);
await session.init();

const assistant = new AssistantService({ game: session, paths: cfg.assistant });
const app = await buildApp({ session, assistant, webDist: cfg.webDist, logger: process.env.LOG !== '0' });
await app.listen({ host: cfg.host, port: cfg.port });

if (cfg.autostart) session.start();

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  app.log.info(`${sig}: saving game (SIGHUP to nethack) and shutting down`);
  await session.shutdown();
  await app.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
