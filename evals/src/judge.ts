/**
 * LLM judge (OpenAI Responses API, structured output).  It sees the
 * conversation with every tool call and result, ground truth derived from the
 * fixture with the production game tools, and the case's own truth / rubric.
 */
import { GameTools } from '../../server/src/assistant/game/tools.ts';
import type { TurnRecord } from '../../server/src/assistant/realtime-node.ts';
import type { Fixture } from './fixtures.ts';
import type { EvalCase, JudgeScores } from './types.ts';

export const RUBRIC = `You grade answers of an in-game voice assistant for NetHack 5.0 (the former 3.7 development line, released May 2026). It talks to the player by voice while they play and sees their game only through tools (game tools are read-only views of what the player can see or remember) and a live-state snapshot. Answers are spoken aloud.

The assistant's rules (from its prompt):
- Look at the game before answering about the current game; never guess what is on the screen. Simple stats that are in the live-state snapshot (HP, AC, hunger, conditions, the pending prompt, what the hero stands on, recent messages) may be answered straight from the snapshot without a tool call.
- Speak positions relative to the player's character (compass or up/down/left/right plus number of squares), never coordinates. On other levels: region of the map or relative to the up staircase / landmarks.
- Unidentified items: never state or guess an unidentified item's identity (not even "probably"); appearances are randomized per game. Identification methods (price-ID, engrave-testing, ...) are spoiler-level: mention and ask first.
- Spoiler policy: spoiler-level info (identification methods; special level layouts/solutions such as Sokoban; quest details including the nemesis and quest artifact names; endgame details; exact hidden formulas and odds; full lists of random effects like fountain quaffing; anything about levels/monsters the player hasn't seen yet) is given only with consent: otherwise give 1-2 general non-spoiler hints and ask. A general hint names the kind of danger or what to prepare for, not the specific counter, item or solution (Medusa: "you'll want a way to deal with her gaze" is a general hint; naming reflection or a blindfold is the spoiler). Once the user consents for a topic, deliver the concrete spoiler without asking again or watering it down. Basic mechanics, controls, well-known survival advice, describing what the player can see, and plain facts about a monster/item the user explicitly asks about (its level, attacks, resistances, what it does) are NOT spoilers - also not when they were looked up in the source code.
- Accuracy: specific details (numbers, effects, odds, dates) only from tool results or certain knowledge; say "not sure" instead of guessing. No added flavor facts not in tool results. If the user's premise contradicts its memory it should check rather than explain it away.
- Voice: short (simple questions 1-3 sentences; strategy: the single most useful tip then offer more; lists at most 3 items aloud, except that after the user explicitly asked for a list / the full spoiler, about 150 words or stepping through it is fine), no markdown, URLs, file paths, code or raw tool output. A playful aside is fine; rambling is not.
- Preambles are REQUIRED by design: before a slow knowledge lookup (wiki, web search, source, changelog; not nethack_lookup or game tools, which are instant and need none) the assistant must first say a very short preamble ("Let me check the wiki.", "One sec.", "Checking the 5.0 changelog.") because lookups take seconds. Such a brief preamble is not tool jargon, narration or rambling: never penalize it in any dimension. Only several stacked preambles in one answer are a minor issue (speakability 4). Naming the source ("according to the wiki", "in the 5.0 source") is also fine. The transcript lists a turn's tool calls before the assistant's text, but the preamble was spoken before the lookup ran: do not penalize that ordering.

Deep-thinking expert (only in some runs): the assistant may hand a hard question to a slow reasoning model with consult_expert (it returns at once; the expert works in the background with the same game and knowledge tools and its result is delivered later in the same turn, shown as EXPERT RESULT, after which the assistant speaks it). A short "let me think that through, I'll get back to you" line before the delivered answer is the intended behavior, not a problem; the assistant's final spoken answer is what matters. Claims that match the EXPERT RESULT count as grounded (the expert verified them in the source), but if the expert result is wrong, the spoken answer is wrong.

Tools: game tools (get_status, look, get_screen, get_inventory, list_levels, get_level_map, get_messages, get_discoveries) show what the player sees. Knowledge tools: fetch_wiki_page (NetHack wiki, often describes 3.6; may append matching 5.0 changelog entries), search_nethack_source / read_nethack_source (the 5.0 source and changelog), nethack_lookup (monster/object/role data and effect tables extracted from the 5.0 source: authoritative), web_search. A claim that matches a tool result shown in the transcript is grounded.

Score each dimension 1-5 (5 = flawless, 4 = minor issue a user would not mind, 3 = noticeable problem, 2 = wrong or misleading in part, 1 = wrong / harmful):
- correctness: factual claims about the game state and NetHack are right, and the question is actually answered. The CASE GROUND TRUTH below was verified against the 5.0 source: it overrides your own memory (which is mostly NetHack 3.6). For other NetHack knowledge use your expertise, being aware that 5.0 changed some details vs 3.6 - do not penalize correct 5.0 facts you are unsure about unless contradicted. If the assistant correctly says something is unknowable or not visible, that is correct.
- groundedness: every claim about the current game is supported by tool results or the live-state snapshot the assistant was given (shown before the conversation; facts in it need no tool call); nothing invented (no unseen monsters/items, no identities of unidentified items, no made-up numbers); knowledge claims are either from tool results or common stable knowledge; uncertainty is flagged. False premises in the question are corrected rather than accepted.
- spoiler: follows the spoiler policy above (5 if no spoiler issue arises). Penalize unprompted spoilers AND refusing/watering down after consent AND unnecessary spoiler warnings on non-spoiler basics (mild: 4). Merely naming that a spoiler-level method exists (e.g. "there are ways like price identification, want me to explain?") while offering/asking is allowed; explaining how it works without consent is the violation.
- speakability: natural spoken answer of appropriate length; no coordinates, markdown, lists read like documents, URLs, or tool jargon ("the tool says", "according to get_status" is mildly bad); no rambling; directions phrased for a player (e.g. "two squares to your left").
- pass: true only if the reply would fully satisfy a demanding expert player for this case: correct, grounded, policy-compliant and concise (in practice: correctness >= 4, groundedness >= 4, spoiler >= 4, speakability >= 3, and the case-specific guidance is met).
- issues: short list of concrete problems (empty if none).
- rationale: 1-3 sentences.
The CASE-SPECIFIC GUIDANCE refines these rules and wins where they differ. Grade against what the case truth and guidance require: details they call optional or "a plus", or do not mention, are not requirements, so omitting them is not a failure (at most a minor issue).
Grade the whole conversation (all assistant turns); the final turn matters most in multi-turn cases but earlier mistakes count.`;

const SCHEMA = {
  type: 'object',
  properties: {
    rationale: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
    correctness: { type: 'integer', minimum: 1, maximum: 5 },
    groundedness: { type: 'integer', minimum: 1, maximum: 5 },
    spoiler: { type: 'integer', minimum: 1, maximum: 5 },
    speakability: { type: 'integer', minimum: 1, maximum: 5 },
    pass: { type: 'boolean' },
  },
  required: ['rationale', 'issues', 'correctness', 'groundedness', 'spoiler', 'speakability', 'pass'],
  additionalProperties: false,
} as const;

/** per tool result in the transcript: enough for the longest tool outputs (wiki pages, Sokoban solutions: ~8000 chars) */
export const TOOL_RESULT_CAP = 9000;

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(${s.length - n} more chars)` : s);

/** What the production game tools report for the fixture (the judge's view of the truth). */
export function fixtureTruth(fx: Fixture | null): string {
  if (!fx) return '(live game: rely on the tool results in the transcript)';
  const t = new GameTools({ running: fx.running, state: () => fx.state, screen: () => ({ lines: fx.screen.lines }) });
  const run = (name: string, args: Record<string, unknown> = {}) => {
    try {
      return t.run(name, args);
    } catch (e) {
      return `(error: ${(e as Error).message})`;
    }
  };
  return [
    `Fixture: ${fx.description}`,
    ...fx.notes.map((n) => `Note: ${n}`),
    `--- status\n${cap(run('get_status'), 1800)}`,
    `--- adjacent\n${run('look', { target: 'adjacent' })}`,
    `--- nearby\n${cap(run('look', { target: 'nearby', radius: 10 }), 1800)}`,
    `--- inventory\n${cap(run('get_inventory'), 1500)}`,
    `--- levels\n${cap(run('list_levels'), 1800)}`,
    `--- discoveries\n${cap(run('get_discoveries'), 1000)}`,
    `--- messages\n${run('get_messages', { n: 8 })}`,
  ].join('\n');
}

export function transcriptText(turns: TurnRecord[], snapshot?: string): string {
  const head = snapshot ? `[live-state snapshot given to the assistant as a system message]\n${snapshot}\n\n` : '[no live-state snapshot was given]\n\n';
  return head + turns
    .map((t, i) => {
      const lines = [`[turn ${i + 1}] USER${t.heard !== undefined ? ` (spoken; transcribed as: "${t.heard}")` : ''}: ${t.input}`];
      for (const x of t.tools) lines.push(`  TOOL ${x.name}(${JSON.stringify(x.args)}) -> ${x.ok ? '' : 'FAILED '}${cap(x.result, TOOL_RESULT_CAP)}`);
      for (const e of t.expert ?? []) {
        const checked = e.tools.map((x) => `${x.name}(${JSON.stringify(x.args)})`).join(', ') || 'no tools';
        lines.push(
          e.ok
            ? `  EXPERT RESULT ${e.id} after ${Math.round(e.ms / 1000)} s (it checked: ${checked}): ${e.answer} | key facts: ${e.keyFacts.join('; ')} | confidence ${e.confidence}` +
                `${e.unknowns.length ? ` | unknowns: ${e.unknowns.join('; ')}` : ''}${e.spoilerDetails ? ` | held-back spoiler details: ${e.spoilerDetails}` : ''}`
            : `  EXPERT ${e.id} ${e.status === 'cancelled' ? 'CANCELLED' : `FAILED (${e.error ?? 'unknown'})`}`,
        );
      }
      lines.push(`ASSISTANT: ${t.messages.join('\n  ') || '(no answer)'}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

export interface JudgeResult {
  scores: JudgeScores;
  usage: { input: number; cached: number; output: number; model: string };
}

export async function judge(opts: {
  c: EvalCase;
  fx: Fixture | null;
  turns: TurnRecord[];
  snapshot?: string;
  model: string;
  effort?: string;
  apiKey: string;
}): Promise<JudgeResult> {
  const { c } = opts;
  const user = [
    `CASE ${c.id} [${c.tags.join(', ')}]`,
    c.truth ? `CASE GROUND TRUTH: ${c.truth}` : '',
    c.rubric ? `CASE-SPECIFIC GUIDANCE: ${c.rubric}` : '',
    `GAME STATE (what the production tools report; the assistant could see all of this through its tools):\n${fixtureTruth(opts.fx)}`,
    `CONVERSATION:\n${transcriptText(opts.turns, opts.snapshot)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const body = {
    model: opts.model,
    input: [
      { role: 'system', content: RUBRIC },
      { role: 'user', content: user },
    ],
    text: { format: { type: 'json_schema', name: 'grade', schema: SCHEMA, strict: true } },
    reasoning: { effort: opts.effort ?? 'low' },
  };
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    }).catch((e: Error) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }) as unknown as Response);
    const j = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      lastErr = j?.error?.message ?? `HTTP ${res.status}`;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const text: string =
      j.output_text ?? (j.output ?? []).flatMap((o: any) => o.content ?? []).filter((x: any) => x.type === 'output_text').map((x: any) => x.text).join('');
    const scores = JSON.parse(text) as JudgeScores;
    return {
      scores,
      usage: { input: j.usage?.input_tokens ?? 0, cached: j.usage?.input_tokens_details?.cached_tokens ?? 0, output: j.usage?.output_tokens ?? 0, model: opts.model },
    };
  }
  throw new Error(`judge failed: ${lastErr}`);
}
