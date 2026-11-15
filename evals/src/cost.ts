/** Price list (USD per 1M tokens, developers.openai.com/api/docs/pricing, Nov 2026) and cost estimates. */
import type { Usage } from '../../server/src/assistant/realtime-node.ts';

const REALTIME: Record<string, { text: number; cachedText: number; textOut: number; audio: number; cachedAudio: number; audioOut: number }> = {
  'gpt-realtime-2.1': { text: 4, cachedText: 0.4, textOut: 24, audio: 32, cachedAudio: 0.4, audioOut: 64 },
  'gpt-realtime-2.1-mini': { text: 0.6, cachedText: 0.06, textOut: 2.4, audio: 10, cachedAudio: 0.3, audioOut: 20 },
};

const RESPONSES: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-5.5': { input: 5, cached: 0.5, output: 30 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
};

/** gpt-transcribe for spoken questions, per minute */
export const TRANSCRIBE_PER_MIN = 0.0045;
/** gpt-4o-mini-tts: ~$0.015 per minute of generated audio */
export const TTS_PER_MIN = 0.015;

export function realtimeCost(model: string, u: Usage): number {
  const p = REALTIME[model] ?? REALTIME['gpt-realtime-2.1'];
  return (
    ((u.input_text - u.cached_text) * p.text +
      u.cached_text * p.cachedText +
      (u.input_audio - u.cached_audio) * p.audio +
      u.cached_audio * p.cachedAudio +
      u.output_text * p.textOut +
      u.output_audio * p.audioOut) /
    1e6
  );
}

export function responsesCost(model: string, u: { input: number; cached: number; output: number }): number {
  const p = RESPONSES[model] ?? RESPONSES['gpt-5.5'];
  return ((u.input - u.cached) * p.input + u.cached * p.cached + u.output * p.output) / 1e6;
}
