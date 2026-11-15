/**
 * Deep-thinking expert: a slow, strong reasoning model (Responses API, EXPERT_MODEL at EXPERT_EFFORT) that the
 * realtime voice model consults in the background for questions that need multi-step reasoning over the 5.0
 * source, arithmetic (price identification, odds, damage), or unusual mechanics interactions.
 *
 * It gets the question, a short conversation excerpt (what the user asked, whether they agreed to spoilers) and
 * the live game snapshot, plus the assistant's own player-visible game tools and knowledge tools, run through
 * AssistantService.runTool (same executors, time limits and logging; no hidden game state).  Tool loop with a
 * round cap and a time budget: when the soft deadline passes, pending tool calls are skipped and the model must
 * answer with what it has.  Returns a spoken-ready answer plus key facts, confidence, unknowns and a spoiler flag
 * (structured output).  Every call is logged with timing, tokens and cost to <logDir>/expert-calls.jsonl.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { failure, type ExpertRequest, type ExpertResult } from '../../../shared/assistant/consultations.ts';
import { EXPERT, EXPERT_PRICES } from './config.ts';
import type { JsonlLog } from './log.ts';

export { EXPERT_TOOL, CANCEL_EXPERT_TOOL } from '../../../shared/assistant/consultations.ts';

/** Realtime session tools for the expert (answered by the conversation core, not by /api/assistant/tools). */
export const EXPERT_TOOL_DEFS = [
  {
    type: 'function',
    name: 'consult_expert',
    description:
      'Hand a hard question to a slow, careful NetHack expert: a strong reasoning model with the same game and knowledge tools ' +
      'that reads the 5.0 source and does the arithmetic. It works in the background for 20 to 90 seconds; this call returns at once ' +
      'and the answer arrives later as a system message starting with [Expert result], which you then tell the user. ' +
      'USE IT for: calculations (price identification from a shop price and Charisma, odds and chances, damage or survival estimates, ' +
      'carrying capacity, how many turns until something happens), unusual or combined mechanics ("what happens if I do X while Y"), ' +
      'weighing two options that needs several facts, and when your own tools gave conflicting or insufficient information. ' +
      "DO NOT use it for anything a single tool call answers (a monster's stats, what is next to the player, the player's status, what an " +
      'item does), for simple or common questions, or for spoiler-gated questions before the user agreed.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'Self-contained question with everything relevant from the conversation: the exact numbers the user or the game mentioned, ' +
            'what they want to decide, and whether they agreed to spoilers.',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'cancel_expert',
    description:
      'Cancel running expert consultations when the user says never mind, has moved on, or no longer needs the answer. ' +
      'Without consultation_id it cancels all of them.',
    parameters: {
      type: 'object',
      properties: { consultation_id: { type: 'string', description: 'Optional id from the consult_expert result, e.g. "x1".' } },
      additionalProperties: false,
    },
  },
] as const;

const SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: 'Spoken-ready answer, at most about 80 words.' },
    key_facts: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    spoiler: { type: 'boolean' },
    spoiler_details: { type: 'string' },
    unknowns: { type: 'array', items: { type: 'string' } },
  },
  required: ['answer', 'key_facts', 'confidence', 'spoiler', 'spoiler_details', 'unknowns'],
  additionalProperties: false,
} as const;

export interface ExpertToolRunner {
  (name: string, args: Record<string, unknown>, meta: { callId?: string; sessionId?: string; signal?: AbortSignal }): Promise<{ ok: boolean; result: string; ms: number }>;
}

export interface ExpertOptions {
  apiKey: () => string;
  /** function tools offered to the expert (game + knowledge) */
  tools: readonly { name: string; description: string; parameters: unknown }[];
  runTool: ExpertToolRunner;
  snapshot: () => { text: string; turn: number };
  promptsDir: string;
  log: JsonlLog;
  model?: string;
  effort?: string;
  timeoutMs?: number;
  maxRounds?: number;
  fetch?: typeof fetch;
}

type Json = Record<string, any>;

const TOOL_RESULT_CHARS = 14_000;

export function expertCost(model: string, u: { input: number; cached: number; output: number }): number {
  const p = EXPERT_PRICES[model] ?? EXPERT_PRICES[EXPERT.model];
  if (!p) return 0;
  return ((u.input - u.cached) * p.input + u.cached * p.cached + u.output * p.output) / 1e6;
}

export class ExpertService {
  private o: ExpertOptions;
  readonly model: string;
  readonly effort: string;
  readonly timeoutMs: number;
  readonly maxRounds: number;
  private fetchFn: typeof fetch;

  constructor(o: ExpertOptions) {
    this.o = o;
    this.model = o.model ?? EXPERT.model;
    this.effort = o.effort ?? EXPERT.effort;
    this.timeoutMs = o.timeoutMs ?? EXPERT.timeoutMs;
    this.maxRounds = o.maxRounds ?? EXPERT.maxRounds;
    this.fetchFn = o.fetch ?? fetch;
  }

  private async instructions(): Promise<string> {
    return readFile(path.join(this.o.promptsDir, 'expert-system.md'), 'utf8');
  }

  /** Never throws: failures, timeouts and cancellation come back as ok:false. */
  async consult(req: ExpertRequest, outer?: AbortSignal): Promise<ExpertResult> {
    const t0 = performance.now();
    const elapsed = () => Math.round(performance.now() - t0);
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = outer ? AbortSignal.any([deadline, outer]) : deadline;
    // stop starting new tool rounds after this; leaves time for the final answer
    const softMs = Math.max(this.timeoutMs - 30_000, this.timeoutMs * 0.6);
    const snap = this.o.snapshot();
    const usage = { input: 0, cached: 0, output: 0, reasoning: 0 };
    const tools: ExpertResult['tools'] = [];
    let rounds = 0;
    let result: ExpertResult;
    try {
      const excerpt = req.excerpt.length
        ? req.excerpt.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n')
        : '(no earlier conversation)';
      const user =
        `QUESTION (passed on by the voice assistant): ${req.question}\n\n` +
        `CONVERSATION EXCERPT (most recent last; use it for what the user actually asked and whether they agreed to spoilers):\n${excerpt}\n\n` +
        `LIVE GAME SNAPSHOT (game turn ${snap.turn}):\n${snap.text}`;
      const base: Json = {
        model: this.model,
        reasoning: { effort: this.effort },
        store: true,
        tools: this.o.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })),
        parallel_tool_calls: true,
        text: { format: { type: 'json_schema', name: 'expert_answer', schema: SCHEMA, strict: true } },
        prompt_cache_key: 'nethack-expert-v1',
      };
      let resp = await this.call({ ...base, instructions: await this.instructions(), input: [{ role: 'user', content: user }] }, signal, usage);
      for (;;) {
        const calls: Json[] = (resp.output ?? []).filter((o: Json) => o.type === 'function_call');
        if (!calls.length) break;
        rounds++;
        const finalRound = rounds >= this.maxRounds || elapsed() > softMs;
        const outputs = await Promise.all(
          calls.map(async (fc) => {
            if (finalRound) return { type: 'function_call_output', call_id: fc.call_id, output: 'SKIPPED: the time / round budget is used up. Answer now with what you have, and lower your confidence if needed.' };
            let args: Json = {};
            try {
              args = JSON.parse(fc.arguments || '{}');
            } catch {
              /* the tool reports what is missing */
            }
            const r = await this.o.runTool(fc.name, args, { callId: fc.call_id, sessionId: req.sessionId ? `expert:${req.sessionId}` : 'expert', signal });
            tools.push({ name: fc.name, args, ok: r.ok, ms: r.ms });
            const text = r.ok ? r.result : `ERROR: ${r.result}`;
            return { type: 'function_call_output', call_id: fc.call_id, output: text.length > TOOL_RESULT_CHARS ? `${text.slice(0, TOOL_RESULT_CHARS)}\n…[truncated]` : text };
          }),
        );
        resp = await this.call(
          {
            ...base,
            ...(finalRound ? { tool_choice: 'none', reasoning: { effort: 'low' } } : {}),
            previous_response_id: resp.id,
            input: outputs,
          },
          signal,
          usage,
        );
        if (finalRound) break;
      }
      result = parseAnswer(outputText(resp));
    } catch (e) {
      const err = e as Error;
      const why = outer?.aborted ? 'cancelled' : deadline.aborted ? `timed out after ${Math.round(this.timeoutMs / 1000)} s` : err.message;
      result = failure(why, 0);
    }
    result.ms = elapsed();
    result.rounds = rounds;
    result.tools = tools;
    result.usage = usage;
    result.cost = expertCost(this.model, usage);
    result.model = this.model;
    result.snapshot = snap;
    this.o.log.write({
      kind: 'expert',
      consultation_id: req.consultationId,
      session_id: req.sessionId,
      model: this.model,
      effort: this.effort,
      question: req.question,
      ok: result.ok,
      error: result.error,
      ms: result.ms,
      rounds,
      tools: tools.map((t) => `${t.name}${t.ok ? '' : '!'}`),
      usage,
      cost: Number(result.cost.toFixed(5)),
      confidence: result.confidence,
      spoiler: result.spoiler,
      answer: result.answer,
    });
    return result;
  }

  private async call(body: Json, signal: AbortSignal, usage: { input: number; cached: number; output: number; reasoning: number }): Promise<Json> {
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.fetchFn('https://api.openai.com/v1/responses', {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${this.o.apiKey()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as Json;
      if (res.ok) {
        usage.input += j.usage?.input_tokens ?? 0;
        usage.cached += j.usage?.input_tokens_details?.cached_tokens ?? 0;
        usage.output += j.usage?.output_tokens ?? 0;
        usage.reasoning += j.usage?.output_tokens_details?.reasoning_tokens ?? 0;
        if (j.status === 'failed' || j.error) throw new Error(`expert response failed: ${j.error?.message ?? j.status}`);
        return j;
      }
      lastErr = j?.error?.message ?? `HTTP ${res.status}`;
      // retry rate limits and server errors only
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    throw new Error(`expert request failed: ${lastErr}`);
  }
}

function outputText(resp: Json): string {
  return (resp.output ?? [])
    .filter((o: Json) => o.type === 'message')
    .flatMap((o: Json) => o.content ?? [])
    .filter((c: Json) => c.type === 'output_text')
    .map((c: Json) => c.text)
    .join('');
}

export function parseAnswer(text: string): ExpertResult {
  let j: Json;
  try {
    j = JSON.parse(text);
  } catch {
    // not JSON (should not happen with structured output): use the text as the answer
    return text.trim()
      ? { ok: true, answer: text.trim().slice(0, 1200), keyFacts: [], confidence: 'low', spoiler: false, unknowns: [], ms: 0, rounds: 0, tools: [] }
      : failure('the expert returned no answer', 0);
  }
  if (!String(j.answer ?? '').trim()) return failure('the expert returned no answer', 0);
  return {
    ok: true,
    answer: String(j.answer).trim(),
    keyFacts: Array.isArray(j.key_facts) ? j.key_facts.map(String).slice(0, 8) : [],
    confidence: ['high', 'medium', 'low'].includes(j.confidence) ? j.confidence : 'medium',
    spoiler: !!j.spoiler,
    ...(String(j.spoiler_details ?? '').trim() ? { spoilerDetails: String(j.spoiler_details).trim() } : {}),
    unknowns: Array.isArray(j.unknowns) ? j.unknowns.map(String).slice(0, 6) : [],
    ms: 0,
    rounds: 0,
    tools: [],
  };
}
