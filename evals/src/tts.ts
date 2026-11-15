/** Question audio for audio-mode evals: OpenAI TTS -> 24 kHz mono PCM16 (cached under .cache/evals/tts). */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from './harness.ts';

export const TTS_MODEL = 'gpt-4o-mini-tts';
const VOICES = ['alloy', 'ash', 'coral', 'sage', 'verse'];

export async function questionAudio(text: string, apiKey: string): Promise<{ pcm: Buffer; seconds: number; cached: boolean }> {
  const hash = createHash('sha1').update(text).digest('hex').slice(0, 16);
  const file = path.join(CACHE_DIR, 'tts', `${hash}.pcm`);
  if (fs.existsSync(file)) {
    const pcm = fs.readFileSync(file);
    return { pcm, seconds: pcm.length / 48000, cached: true };
  }
  const voice = VOICES[parseInt(hash.slice(0, 2), 16) % VOICES.length];
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice,
      input: text,
      response_format: 'pcm',
      instructions: 'A player casually asking a question out loud while playing a computer game. Natural pace.',
    }),
  });
  if (!res.ok) throw new Error(`TTS failed (${res.status}): ${await res.text()}`);
  // 300 ms of silence before the question, like a real mic
  const pcm = Buffer.concat([Buffer.alloc(14400), Buffer.from(await res.arrayBuffer())]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pcm);
  return { pcm, seconds: pcm.length / 48000, cached: false };
}
