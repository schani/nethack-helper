/**
 * Background "deep-thinking expert" consultations for the voice assistant.
 *
 * The realtime model calls consult_expert(question); the call is answered at once ("the expert is working on
 * it") so the conversation goes on, while a slow, strong reasoning model works on the question on the server
 * (POST /api/assistant/expert, see server/src/assistant/expert.ts).  When a result arrives it is queued here
 * and delivered only when the voice channel is idle: no response in progress, no assistant audio playing,
 * the user not speaking, no tool call in flight, and a short quiet gap since the last activity.  Delivery
 * (done by RealtimeConversation) adds a system message with the result and requests a response, following the
 * Realtime API's documented pattern for mid-conversation context updates (conversation.item.create with a
 * system message, then response.create).
 *
 * Handles several concurrent consultations (results that are ready at the same moment are delivered
 * together), cancellation (cancel_expert tool, the panel's cancel button, session end), duplicates, failures
 * and timeouts (delivered as a short "couldn't finish" note), and stale results (the game moved on: the
 * delivery says so).  Transport-agnostic, no DOM / Node APIs: unit-tested in server/test/unit.
 */

export const EXPERT_TOOL = 'consult_expert';
export const CANCEL_EXPERT_TOOL = 'cancel_expert';
/** tools the conversation core answers itself (never sent to the server's tool endpoint) */
export const CLIENT_TOOLS: readonly string[] = [EXPERT_TOOL, CANCEL_EXPERT_TOOL];

export interface ExpertRequest {
  question: string;
  /** the last few exchanges, so the expert knows what the user asked and whether they agreed to spoilers */
  excerpt: { role: 'user' | 'assistant'; text: string }[];
  consultationId: string;
  sessionId?: string;
}

export interface ExpertResult {
  ok: boolean;
  /** spoken-ready answer (already follows the spoiler policy for what the excerpt shows) */
  answer: string;
  keyFacts: string[];
  confidence: 'high' | 'medium' | 'low';
  /** the answer or spoilerDetails contain spoiler-level information */
  spoiler: boolean;
  /** spoiler-level details held back because the user has not agreed to spoilers yet */
  spoilerDetails?: string;
  /** hidden or unknowable values the answer depends on */
  unknowns: string[];
  error?: string;
  ms: number;
  rounds: number;
  tools: { name: string; args: Record<string, unknown>; ok: boolean; ms: number }[];
  usage?: { input: number; cached: number; output: number; reasoning: number };
  cost?: number;
  model?: string;
  /** game turn / snapshot the expert started from (staleness check) */
  snapshot?: { turn: number; text: string };
}

export type ConsultationStatus = 'running' | 'ready' | 'delivering' | 'delivered' | 'cancelled';

export interface Consultation {
  id: string;
  question: string;
  status: ConsultationStatus;
  startedAt: number;
  finishedAt?: number;
  deliveredAt?: number;
  /** game turn when the question was asked (from the last snapshot the conversation saw) */
  startTurn?: number;
  startContext?: string;
  result?: ExpertResult;
  /** the delivery response was cut off (user barged in); the result stays in the conversation */
  interrupted?: boolean;
  cancelReason?: string;
  /** turn counter of the conversation when it was asked (eval bookkeeping) */
  userTurn: number;
  ac: AbortController;
}

export interface ConsultationDeps {
  /** runs the expert; may reject (network) or resolve with ok:false */
  expert?: (req: ExpertRequest, signal: AbortSignal) => Promise<ExpertResult>;
  now: () => number;
  /** null while the channel is busy, else the time it became idle */
  idleSince: () => number | null;
  /** add the results to the conversation and request a response (sets up its own completion tracking) */
  deliver: (batch: Consultation[]) => void;
  /** a consultation changed (UI) */
  changed: (c: Consultation) => void;
  maxConcurrent?: number;
  /** quiet gap after the last activity before a result is spoken (ms) */
  quietMs?: number;
}

const norm = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export class Consultations {
  readonly list: Consultation[] = [];
  private deps: ConsultationDeps;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  delivering: Consultation[] | null = null;

  constructor(deps: ConsultationDeps) {
    this.deps = deps;
  }

  get enabled() {
    return !!this.deps.expert;
  }

  get running() {
    return this.list.filter((c) => c.status === 'running');
  }

  /** nothing running, queued or being delivered */
  get settled() {
    return this.list.every((c) => c.status === 'delivered' || c.status === 'cancelled');
  }

  /** Start a consultation; returns the existing one for a duplicate question that is still running. */
  start(
    question: string,
    meta: { excerpt: ExpertRequest['excerpt']; sessionId?: string; turn?: number; context?: string; userTurn: number },
  ): { c: Consultation; duplicate: boolean } | { error: string } {
    const expert = this.deps.expert;
    if (!expert) return { error: 'the expert is not available in this session' };
    if (!question.trim()) return { error: "missing 'question'" };
    const dup = this.list.find((c) => c.status === 'running' && norm(c.question) === norm(question));
    if (dup) return { c: dup, duplicate: true };
    const max = this.deps.maxConcurrent ?? 3;
    if (this.running.length >= max) return { error: `${max} consultations are already running; wait for one to finish or cancel one` };
    const c: Consultation = {
      id: `x${++this.seq}`,
      question: question.trim(),
      status: 'running',
      startedAt: this.deps.now(),
      startTurn: meta.turn,
      startContext: meta.context,
      userTurn: meta.userTurn,
      ac: new AbortController(),
    };
    this.list.push(c);
    this.deps.changed(c);
    const req: ExpertRequest = { question: c.question, excerpt: meta.excerpt, consultationId: c.id, sessionId: meta.sessionId };
    expert(req, c.ac.signal)
      .catch((e: Error): ExpertResult => failure(e?.name === 'AbortError' ? 'cancelled' : `network error: ${e?.message ?? e}`, this.deps.now() - c.startedAt))
      .then((r) => this.finished(c, r));
    return { c, duplicate: false };
  }

  private finished(c: Consultation, r: ExpertResult) {
    if (c.status !== 'running') return; // cancelled meanwhile: the late result is discarded
    c.result = r;
    c.finishedAt = this.deps.now();
    c.status = 'ready';
    this.deps.changed(c);
    this.pump();
  }

  /** Cancel one consultation (by id) or all running / queued ones. Returns the cancelled ones. */
  cancel(id: string | undefined, reason: string): Consultation[] {
    const hit = this.list.filter((c) => (c.status === 'running' || c.status === 'ready') && (!id || c.id === id));
    for (const c of hit) {
      c.status = 'cancelled';
      c.cancelReason = reason;
      c.ac.abort();
      this.deps.changed(c);
    }
    return hit;
  }

  /** Deliver ready results if the channel is idle (call after every event that may change idleness). */
  pump() {
    if (this.delivering) return;
    const ready = this.list.filter((c) => c.status === 'ready');
    if (!ready.length) return;
    const since = this.deps.idleSince();
    if (since === null) return; // the next channel event pumps again
    const wait = since + (this.deps.quietMs ?? 800) - this.deps.now();
    if (wait > 0) {
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.pump();
        }, wait);
      }
      return;
    }
    for (const c of ready) {
      c.status = 'delivering';
      this.deps.changed(c);
    }
    this.delivering = ready;
    this.deps.deliver(ready);
  }

  /** The delivery could not be sent after all (the user started talking): queue it again. */
  requeue() {
    const batch = this.delivering ?? [];
    this.delivering = null;
    for (const c of batch) if (c.status === 'delivering') (c.status = 'ready'), this.deps.changed(c);
  }

  /** The response speaking the batch is done (interrupted: cut off by the user). */
  delivered(interrupted: boolean) {
    const batch = this.delivering ?? [];
    this.delivering = null;
    for (const c of batch) {
      if (c.status !== 'delivering') continue;
      c.status = 'delivered';
      c.deliveredAt = this.deps.now();
      c.interrupted = interrupted;
      this.deps.changed(c);
    }
    this.pump();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export function failure(error: string, ms: number): ExpertResult {
  return { ok: false, answer: '', keyFacts: [], confidence: 'low', spoiler: false, unknowns: [], error, ms, rounds: 0, tools: [] };
}

/** game turn and dungeon level from a live-state snapshot text */
export function snapshotFacts(text: string | undefined): { turn?: number; dlvl?: string } {
  if (!text) return {};
  const turn = /\bturn (\d+)/.exec(text)?.[1];
  const dlvl = /Dlvl:\s*(\d+)/.exec(text)?.[1] ?? /\b(Home \d|Plane of \w+|Astral Plane|Sanctum)\b/.exec(text)?.[1];
  return { turn: turn ? Number(turn) : undefined, dlvl };
}

/** turns of game time after which a result is flagged as possibly out of date */
export const STALE_TURNS = 25;

/** Note for the model when the game moved on since the question (or '' if not). */
export function staleNote(c: Consultation, now: { text: string; turn: number } | null): string {
  if (!now?.text) return '';
  const before = snapshotFacts(c.result?.snapshot?.text ?? c.startContext);
  const startTurn = c.result?.snapshot?.turn ?? c.startTurn ?? before.turn;
  const after = snapshotFacts(now.text);
  const nowTurn = now.turn || after.turn;
  const parts: string[] = [];
  if (startTurn !== undefined && nowTurn !== undefined && nowTurn - startTurn >= STALE_TURNS) parts.push(`turn ${startTurn} -> ${nowTurn}`);
  if (before.dlvl && after.dlvl && before.dlvl !== after.dlvl) parts.push(`level ${before.dlvl} -> ${after.dlvl}`);
  if (!parts.length) return '';
  return `The game has moved on since the question (${parts.join(', ')}): say in a few words that this was worked out for the earlier situation, and point out anything that no longer applies given the current live state.`;
}

/** The system message that hands finished consultations to the realtime model. */
export function deliveryText(batch: Consultation[], now: { text: string; turn: number } | null, at: number): string {
  const blocks = batch.map((c) => {
    const r = c.result!;
    const ago = Math.round((at - c.startedAt) / 1000);
    const head = `[Expert result ${c.id}] The user's question (asked ${ago} s ago): "${c.question}"`;
    if (!r.ok) {
      return `${head}\nThe expert could NOT finish (${r.error ?? 'unknown error'}). Tell the user in one short sentence that the careful check didn't work out this time; give your own brief answer only if you are confident of it, otherwise suggest asking again.`;
    }
    const lines = [head, `Answer: ${r.answer}`];
    if (r.keyFacts.length) lines.push(`Key facts: ${r.keyFacts.join('; ')}`);
    lines.push(`Confidence: ${r.confidence}.${r.unknowns.length ? ` Depends on things nobody can see in the game: ${r.unknowns.join('; ')}.` : ''}`);
    if (r.spoilerDetails)
      lines.push(`Spoiler-level details the expert kept out of the answer (give them right away if the user already agreed to spoilers on this topic; otherwise offer them): ${r.spoilerDetails}`);
    const stale = staleNote(c, now);
    if (stale) lines.push(stale);
    return lines.join('\n');
  });
  const many = batch.length > 1;
  return (
    `${blocks.join('\n\n')}\n\n` +
    `Now tell the user ${many ? 'these results' : 'this result'}: start with a short lead-in naming the question (for example "About the lamp:"), ` +
    'then relay the Answer faithfully: it is already written for speech, so keep its conclusion and its key numbers and reasons; you may shorten it ' +
    '(at most about 80 words). Keep the spoiler policy (if spoiler details were kept out and the user has not agreed yet, end by asking whether they want them). ' +
    'Mention unknowns or low confidence briefly. Never read out these labels, ids, numbers of seconds, file paths or code. ' +
    'If the user has meanwhile asked something else that is more urgent, give the gist in one sentence and offer the rest.'
  );
}
