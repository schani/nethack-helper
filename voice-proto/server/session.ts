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
  const instructions = await readFile(PROMPT_FILE, "utf8");
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
    max_output_tokens: 2048,
  };
}

