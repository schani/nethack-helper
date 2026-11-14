import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');

export interface Config {
  host: string;
  port: number;
  /** installed nethack binary (built by nethack/build.sh) */
  nethackBin: string;
  /** HOME for the nethack process; holds .nethackrc */
  playgroundHome: string;
  /** template copied to <playgroundHome>/.nethackrc on every launch */
  nethackrcTemplate: string;
  feedSocket: string;
  /** where per-game level memory / message logs are persisted */
  memoryDir: string;
  playerName: string;
  cols: number;
  rows: number;
  webDist: string;
  /** start a game as soon as the server boots */
  autostart: boolean;
  assistant: AssistantPaths;
}

export interface AssistantPaths {
  /** pristine NetHack 5.0.0 checkout for the source tools (scripts/setup-nethack-src.sh) */
  nethackSrcDir: string;
  /** instructions*.md */
  promptsDir: string;
  /** tool-call / transcript logs */
  logDir: string;
}

export function loadConfig(env = process.env): Config {
  const prefix = path.join(ROOT, '.nethack');
  return {
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 8787),
    nethackBin: env.NETHACK_BIN ?? path.join(prefix, 'games/lib/nethackdir/nethack'),
    playgroundHome: env.NETHACK_HOME ?? path.join(prefix, 'home'),
    nethackrcTemplate: env.NETHACKRC_TEMPLATE ?? path.join(ROOT, 'nethack/nethackrc'),
    feedSocket: env.NETHACK_FEED_SOCKET_PATH ?? path.join(ROOT, '.cache/run', `feed-${process.pid}.sock`),
    memoryDir: env.NETHACK_MEMORY_DIR ?? path.join(prefix, 'memory'),
    playerName: env.NETHACK_PLAYER ?? 'Wanderer',
    cols: 80,
    rows: 24,
    webDist: path.join(ROOT, 'web/dist'),
    autostart: (env.NETHACK_AUTOSTART ?? '1') !== '0',
    assistant: {
      nethackSrcDir: env.NETHACK_SRC_DIR ?? path.join(ROOT, '.cache/nethack-src'),
      promptsDir: env.ASSISTANT_PROMPTS_DIR ?? path.join(ROOT, 'server/prompts'),
      logDir: env.ASSISTANT_LOG_DIR ?? path.join(ROOT, '.cache/assistant'),
    },
  };
}
