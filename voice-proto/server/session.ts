import { readFile } from "node:fs/promises";
import { PROMPT_FILE } from "./config.ts";
import { TOOL_DEFS } from "./tools.ts";

/** Keywords that help gpt-transcribe spell NetHack jargon in the user transcript. */
const TRANSCRIBE_KEYWORDS = [
  "NetHack", "Sokoban", "Elbereth", "Mjollnir", "Excalibur", "Gehennom", "Medusa", "Vlad's Tower", "Juiblex",
  "Orcus", "Yendor", "Rodney", "Mines' End", "Minetown", "cockatrice", "lichen", "Grayswandir", "Stormbringer",
  "nymph", "leprechaun", "polymorph", "genocide", "wand of wishing", "quantum mechanic", "genetic engineer",
];

/**
 * Session config for POST /v1/realtime/client_secrets (GA interface).
 * Instructions are re-read from prompts/instructions.md on every mint so the prompt can be iterated live.
 */
export async function buildSessionConfig(opts: { model: string; voice: string; reasoning: string }) {
  let instructions = await readFile(PROMPT_FILE, "utf8");
  // Smaller models embellish tool results more; they get a stricter addendum (kept out of the main prompt so the
  // full model's answers and latency are not constrained by it).
  if (/mini/.test(opts.model)) instructions += await readFile(PROMPT_FILE.replace(/\.md$/, "-mini.md"), "utf8").catch(() => "");
  return {
    type: "realtime",
    model: opts.model,
    instructions,
    output_modalities: ["audio"],
    reasoning: { effort: opts.reasoning },
    audio: {
      input: {
        noise_reduction: { type: "near_field" },
        transcription: { model: "gpt-transcribe", keywords: TRANSCRIBE_KEYWORDS },
        turn_detection: { type: "semantic_vad", eagerness: "auto", create_response: true, interrupt_response: true },
      },
      output: { voice: opts.voice },
    },
    tools: TOOL_DEFS,
    tool_choice: "auto",
    // Let the model issue independent lookups (e.g. wiki + source) in one response; the client runs them concurrently.
    parallel_tool_calls: true,
    max_output_tokens: 2048,
  };
}

