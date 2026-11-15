import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Keywords that help gpt-transcribe spell NetHack jargon in the user transcript. */
const TRANSCRIBE_KEYWORDS = [
  'NetHack', 'Sokoban', 'Elbereth', 'Mjollnir', 'Excalibur', 'Gehennom', 'Medusa', "Vlad's Tower", 'Juiblex',
  'Orcus', 'Yendor', 'Rodney', "Mines' End", 'Minetown', 'cockatrice', 'lichen', 'Grayswandir', 'Stormbringer',
  'nymph', 'leprechaun', 'polymorph', 'genocide', 'wand of wishing', 'quantum mechanic', 'genetic engineer',
];

export interface SessionOptions {
  model: string;
  voice: string;
  reasoning: string;
  tools: readonly unknown[];
  promptsDir: string;
  /** the deep-thinking expert is offered: append expert.md to the instructions */
  expert?: boolean;
}

/** instructions.md (+ instructions-mini.md for mini models); re-read on every mint so the prompt can be iterated live. */
export async function loadInstructions(promptsDir: string, model: string, expert = false): Promise<string> {
  let instructions = await readFile(path.join(promptsDir, 'instructions.md'), 'utf8');
  if (expert) instructions += `\n${await readFile(path.join(promptsDir, 'expert.md'), 'utf8')}`;
  // Smaller models embellish tool results more; they get a stricter addendum (kept out of the main prompt so the
  // full model's answers and latency are not constrained by it).
  if (/mini/.test(model)) instructions += await readFile(path.join(promptsDir, 'instructions-mini.md'), 'utf8').catch(() => '');
  return instructions;
}

/** Session config for POST /v1/realtime/client_secrets (GA interface). Ported from voice-proto/server/session.ts. */
export async function buildSessionConfig(opts: SessionOptions) {
  const instructions = await loadInstructions(opts.promptsDir, opts.model, opts.expert);
  return {
    type: 'realtime',
    model: opts.model,
    instructions,
    output_modalities: ['audio'],
    reasoning: { effort: opts.reasoning },
    audio: {
      input: {
        noise_reduction: { type: 'near_field' },
        transcription: { model: 'gpt-transcribe', keywords: TRANSCRIBE_KEYWORDS },
        turn_detection: { type: 'semantic_vad', eagerness: 'auto', create_response: true, interrupt_response: true },
      },
      output: { voice: opts.voice },
    },
    tools: opts.tools,
    tool_choice: 'auto',
    // Let the model issue independent lookups (e.g. look + wiki) in one response; the client runs them concurrently.
    parallel_tool_calls: true,
    max_output_tokens: 2048,
    // Live game snapshots are added as system items over a long session; keep most of the conversation when the
    // context fills up instead of truncating a little on every turn (fewer prompt-cache busts).
    truncation: { type: 'retention_ratio', retention_ratio: 0.7 },
  };
}
