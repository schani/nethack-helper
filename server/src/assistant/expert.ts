/**
 * The thinker ("expert" in the code): a strong reasoning model (Responses API, EXPERT.model) that the realtime voice
 * model asks in the background with ask_thinker.  Two depths:
 *  - quick (default): everyday game-knowledge questions ("how do I open this locked box?", "is it safe to...",
 *    "what are my options?"), answered for the player's actual situation in about 5 to 15 seconds: low reasoning
 *    effort, at most a couple of parallel tool rounds, a soft deadline after which it must answer, no web search.
 *  - deep: multi-step reasoning over the 5.0 source, arithmetic (price identification, odds, damage), unusual
 *    mechanics interactions (EXPERT.effort, up to EXPERT.timeoutMs).
 *
 * It gets the question, a short conversation excerpt (what the user asked, whether they agreed to spoilers), the
 * player's situation read up front from the game tools (status, inventory, what is around, recent messages; saves a
 * tool round), plus the assistant's player-visible game tools and knowledge tools (wiki, nethack_lookup, the 5.0
 * source and changelog, the Guidebook, key bindings), run through AssistantService.runTool (same executors, time
 * limits and logging; no hidden game state).  Returns a spoken-ready answer plus key facts, confidence, unknowns and
 * a spoiler flag (structured output).  Answers it marks as general (not about this game, no spoilers) are cached by
 * normalized question, so a repeated question is answered at once.  Every call is logged with timing, tokens and cost
 * to <logDir>/expert-calls.jsonl.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { depthOf, failure, type Depth, type ExpertRequest, type ExpertResult } from '../../../shared/assistant/consultations.ts';
import { EXPERT, EXPERT_PRICES } from './config.ts';
import type { JsonlLog } from './log.ts';

export { EXPERT_TOOL, CANCEL_EXPERT_TOOL } from '../../../shared/assistant/consultations.ts';

/** Realtime session tools for the thinker (answered by the conversation core, not by /api/assistant/tools). */
export const EXPERT_TOOL_DEFS = [
  {
    type: 'function',
    name: 'ask_thinker',
    description:
      'Ask the thinker, a careful NetHack 5.0 expert that reads the Guidebook, the wiki and the 5.0 source and sees the player\'s ' +
      'inventory, status and surroundings, so its answer fits this player\'s situation. It works in the background; this call ' +
      'returns at once and the answer arrives later as a system message starting with [Thinker result], which you then relay. ' +
      'depth "quick" (about 5 to 15 seconds) for any game-knowledge question: how do I..., what does X do, is X safe, what are my ' +
      'options, how something works, what to do now. depth "deep" (20 to 90 seconds) for calculations (price identification, odds, ' +
      'damage, carrying capacity, turns until something happens) and unusual or combined mechanics. ' +
      'Not for questions about the current game state (HP, inventory, what is that, where were the stairs: use the game tools) ' +
      'or which key does something (get_keybindings).',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            "The user's question, self-contained: what they want to do or decide, the exact words of any game message or prompt they " +
            'mean, numbers they mentioned, and whether they agreed to spoilers. The thinker sees the game itself; no need to describe it.',
        },
        depth: {
          type: 'string',
          enum: ['quick', 'deep'],
          description:
            'deep whenever the player asks you to work something out, do the math, give the real or exact mechanics, odds or numbers, or asks a ' +
            'hypothetical with several conditions at once; quick for everything else.',
        },
      },
      required: ['question', 'depth'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'cancel_thinker',
    description:
      'Cancel running thinker questions when the user says never mind, has moved on, or no longer needs the answer. ' +
      'Without consultation_id it cancels all of them.',
    parameters: {
      type: 'object',
      properties: { consultation_id: { type: 'string', description: 'Optional id from the ask_thinker result, e.g. "x1".' } },
      additionalProperties: false,
    },
  },
] as const;

const SCHEMA = {
  type: 'object',
  properties: {
    options: {
      type: 'array',
      description:
        'Worked out before the answer: every method that could work for what the player wants (or the candidate answers), ' +
        'including ones needing things the player lacks; each judged for this player.',
      items: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'What to do, with the command.' },
          usable_now: { type: 'boolean', description: 'The player can do this right now with what they have and where they are.' },
          risk: { type: 'string', description: 'Its risk or cost in a few words ("" if none).' },
        },
        required: ['method', 'usable_now', 'risk'],
        additionalProperties: false,
      },
    },
    answer: { type: 'string', description: 'Spoken-ready answer (quick: at most about 45 words; deep: at most about 80).' },
    key_facts: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    spoiler: { type: 'boolean' },
    spoiler_details: { type: 'string' },
    unknowns: { type: 'array', items: { type: 'string' } },
    cacheable: { type: 'boolean', description: "true only if the answer is general NetHack knowledge: the same for any player and game state, no spoilers." },
  },
  required: ['options', 'answer', 'key_facts', 'confidence', 'spoiler', 'spoiler_details', 'unknowns', 'cacheable'],
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
  /** the player's situation read from the game tools (status, inventory, surroundings, messages), given up front */
  situation?: () => string;
  /** tools the quick mode may not use (slow ones) */
  quickExclude?: readonly string[];
  promptsDir: string;
  log: JsonlLog;
  model?: string;
  effort?: string;
  timeoutMs?: number;
  maxRounds?: number;
  quick?: Partial<typeof EXPERT.quick>;
  cacheTtlMs?: number;
  fetch?: typeof fetch;
}

interface ModeSettings {
  effort: string;
  timeoutMs: number;
  /** stop starting new tool rounds after this (ms) */
  softMs: number;
  maxRounds: number;
}

/** cache key: the question without case, punctuation and filler words */
export function cacheKey(depth: Depth, question: string): string {
  const q = question
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, ' ')
    .split(' ')
    .filter((w) => w && !/^(a|an|the|please|hey|so|um|uh|ok|okay|nethack|5|0)$/.test(w))
    .join(' ');
  return `${depth}|${q}`;
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
  readonly quick: ModeSettings;
  private fetchFn: typeof fetch;
  private cache = new Map<string, { at: number; result: ExpertResult }>();
  readonly cacheTtlMs: number;

  constructor(o: ExpertOptions) {
    this.o = o;
    this.model = o.model ?? EXPERT.model;
    this.effort = o.effort ?? EXPERT.effort;
    this.timeoutMs = o.timeoutMs ?? EXPERT.timeoutMs;
    this.maxRounds = o.maxRounds ?? EXPERT.maxRounds;
    this.quick = { ...EXPERT.quick, ...o.quick };
    this.cacheTtlMs = o.cacheTtlMs ?? EXPERT.cacheTtlMs;
    this.fetchFn = o.fetch ?? fetch;
  }

  settings(depth: Depth): ModeSettings {
    if (depth === 'quick') return this.quick;
    // deep: stop new tool rounds 30 s before the deadline (at least 40% of the budget left for the answer)
    return { effort: this.effort, timeoutMs: this.timeoutMs, softMs: Math.max(this.timeoutMs - 30_000, this.timeoutMs * 0.6), maxRounds: this.maxRounds };
  }

  private cached(depth: Depth, question: string): ExpertResult | null {
    const key = cacheKey(depth, question);
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > this.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }
    return hit.result;
  }

  private remember(depth: Depth, question: string, r: ExpertResult, cacheable: boolean) {
    if (!this.cacheTtlMs || !cacheable || !r.ok || r.spoiler || r.confidence === 'low') return;
    if (this.cache.size >= 500) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(cacheKey(depth, question), { at: Date.now(), result: r });
  }

  private async instructions(): Promise<string> {
    return readFile(path.join(this.o.promptsDir, 'expert-system.md'), 'utf8');
  }

  /** Never throws: failures, timeouts and cancellation come back as ok:false. */
  async consult(req: ExpertRequest, outer?: AbortSignal): Promise<ExpertResult> {
    const t0 = performance.now();
    const elapsed = () => Math.round(performance.now() - t0);
    const depth = depthOf(req.depth);
    const mode = this.settings(depth);
    const snap = this.o.snapshot();
    const hit = this.cached(depth, req.question);
    if (hit) {
      const r: ExpertResult = { ...hit, ms: elapsed(), rounds: 0, tools: [], usage: { input: 0, cached: 0, output: 0, reasoning: 0 }, cost: 0, cached: true, depth, snapshot: snap };
      this.o.log.write({ kind: 'expert', consultation_id: req.consultationId, session_id: req.sessionId, depth, cached: true, question: req.question, ok: true, ms: r.ms, answer: r.answer });
      return r;
    }
    const deadline = AbortSignal.timeout(mode.timeoutMs);
    const signal = outer ? AbortSignal.any([deadline, outer]) : deadline;
    const usage = { input: 0, cached: 0, output: 0, reasoning: 0 };
    const tools: ExpertResult['tools'] = [];
    let rounds = 0;
    let result: ExpertResult;
    let cacheable = false;
    try {
      const excerpt = req.excerpt.length
        ? req.excerpt.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n')
        : '(no earlier conversation)';
      let situation = '';
      try {
        situation = this.o.situation?.() ?? '';
      } catch {
        /* game state unavailable: the snapshot says so */
      }
      const user =
        `MODE: ${depth}\n\n` +
        `QUESTION (passed on by the voice assistant): ${req.question}\n\n` +
        `CONVERSATION EXCERPT (most recent last; use it for what the user actually asked and whether they agreed to spoilers):\n${excerpt}\n\n` +
        `LIVE GAME SNAPSHOT (game turn ${snap.turn}):\n${snap.text}` +
        (situation ? `\n\nPLAYER'S SITUATION (read from the game tools just now):\n${situation}` : '');
      const offered = depth === 'quick' ? this.o.tools.filter((t) => !(this.o.quickExclude ?? []).includes(t.name)) : this.o.tools;
      // instructions go into every request: with previous_response_id the API does not carry them over
      const base: Json = {
        instructions: await this.instructions(),
        model: this.model,
        reasoning: { effort: mode.effort },
        store: true,
        tools: offered.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })),
        parallel_tool_calls: true,
        text: { format: { type: 'json_schema', name: 'expert_answer', schema: SCHEMA, strict: true } },
        prompt_cache_key: 'nethack-thinker-v1',
      };
      let resp = await this.call({ ...base, input: [{ role: 'user', content: user }] }, signal, usage);
      for (;;) {
        const calls: Json[] = (resp.output ?? []).filter((o: Json) => o.type === 'function_call');
        if (!calls.length) break;
        rounds++;
        const finalRound = rounds >= mode.maxRounds || elapsed() > mode.softMs;
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
      const text = outputText(resp);
      result = parseAnswer(text);
      cacheable = parseCacheable(text);
    } catch (e) {
      const err = e as Error;
      const why = outer?.aborted ? 'cancelled' : deadline.aborted ? `timed out after ${Math.round(mode.timeoutMs / 1000)} s` : err.message;
      result = failure(why, 0);
    }
    result.ms = elapsed();
    result.rounds = rounds;
    result.tools = tools;
    result.usage = usage;
    result.cost = expertCost(this.model, usage);
    result.model = this.model;
    result.depth = depth;
    result.snapshot = snap;
    this.remember(depth, req.question, result, cacheable);
    this.o.log.write({
      kind: 'expert',
      consultation_id: req.consultationId,
      session_id: req.sessionId,
      model: this.model,
      depth,
      effort: mode.effort,
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
      cacheable,
      answer: result.answer,
      options: result.options,
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

/** the thinker marked its answer as general knowledge (safe to reuse for the same question) */
function parseCacheable(text: string): boolean {
  try {
    return JSON.parse(text).cacheable === true;
  } catch {
    return false;
  }
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
    ...(Array.isArray(j.options) && j.options.length
      ? { options: j.options.slice(0, 8).map((o: Json) => ({ method: String(o?.method ?? ''), usable_now: !!o?.usable_now, risk: String(o?.risk ?? '') })) }
      : {}),
    confidence: ['high', 'medium', 'low'].includes(j.confidence) ? j.confidence : 'medium',
    spoiler: !!j.spoiler,
    ...(String(j.spoiler_details ?? '').trim() ? { spoilerDetails: String(j.spoiler_details).trim() } : {}),
    unknowns: Array.isArray(j.unknowns) ? j.unknowns.map(String).slice(0, 6) : [],
    ms: 0,
    rounds: 0,
    tools: [],
  };
}
