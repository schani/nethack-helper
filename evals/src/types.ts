/** Eval case / variant / result types. Cases live in evals/cases/*.ts. */
import type { TurnRecord } from '../../server/src/assistant/realtime-node.ts';

export type Json = Record<string, any>;

export interface Expect {
  /** tool-call requirements for this turn */
  tools?: {
    /** at least one of these must be called */
    any?: string[];
    /** all of these must be called */
    all?: string[];
    /** none of these may be called */
    none?: string[];
    /** the first tool call must be one of these (e.g. look-first discipline) */
    first?: string[];
    /** no tool calls at all */
    noTools?: boolean;
  };
  /** regexes that must all match the answer */
  must?: RegExp[];
  /** at least one of these must match */
  mustAny?: RegExp[];
  /** none may match */
  mustNot?: RegExp[];
  /** spoken-length limit (words, all assistant messages of the turn); default 110 */
  maxWords?: number;
  /** max model tool rounds; default none */
  maxRounds?: number;
  /** allow raw coordinates / markdown (default: not allowed) */
  allowCoords?: boolean;
}

export interface Turn {
  user: string;
  expect?: Expect;
}

export interface EvalCase {
  id: string;
  /** e.g. state, look, directions, other-level, inventory, discoveries, knowledge, v5, spoiler, hidden-info, hallucination, concise, robustness, live */
  tags: string[];
  /** fixture id (evals/fixtures/<id>.json); ignored for live cases */
  fixture?: string;
  /** play this capture recipe on a live game (port 8797) instead of a frozen fixture */
  live?: string;
  turns: Turn[];
  /** ground truth for the judge (in addition to what the fixture's tools report) */
  truth?: string;
  /** case-specific grading guidance for the judge */
  rubric?: string;
  /** run in audio mode too (TTS question audio) */
  audio?: boolean;
  /** fault injection */
  faults?: {
    /** per-tool time limits (ms), e.g. { fetch_wiki_page: 1 } forces a timeout */
    timeouts?: Record<string, number>;
    /** game state reads throw this error (game tools fail) */
    gameError?: string;
  };
}

export interface Variant {
  name: string;
  description: string;
  model?: string;
  reasoning?: string;
  voice?: string;
  /** directory with instructions.md (+ instructions-mini.md); default server/prompts */
  promptsDir?: string;
  /** text appended to the instructions */
  instructionsAppend?: string;
  /** exact-text edits of the production instructions (each `find` must occur), applied in order */
  promptEdits?: { find: string; replace: string }[];
  /** deep-merged into the session config (turn_detection, tool_choice, max_output_tokens, ...) */
  session?: Json;
  /** tool description overrides */
  tools?: Record<string, { description?: string }>;
  /** game view options (tool output formats / snapshot) passed to GameTools */
  game?: Json;
  /** 'none': no live-context snapshots */
  snapshot?: 'default' | 'none';
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface JudgeScores {
  correctness: number;
  groundedness: number;
  spoiler: number;
  speakability: number;
  pass: boolean;
  rationale: string;
  issues: string[];
}

export interface CaseRun {
  case: string;
  tags: string[];
  rep: number;
  mode: 'text' | 'audio';
  turns: (TurnRecord & { checks: CheckResult[] })[];
  /** live-state snapshot the assistant was given at the start (null: none) */
  snapshot?: string | null;
  judge?: JudgeScores;
  judgeUsage?: { input: number; cached: number; output: number; model: string };
  pass: boolean;
  checksPass: boolean;
  error?: string;
  cost: { realtime: number; judge: number; tts: number };
  ms: number;
}
