/**
 * Deep-thinking expert consultations in the shared conversation core: consult_expert answers at once, results are
 * queued and spoken only when the voice channel is idle, concurrency, cancellation, failures and stale results.
 */
import { describe, expect, it } from 'vitest';
import { RealtimeConversation, type ConnState, type ExpertRequest, type ExpertResult, type RealtimeView } from '../../../shared/assistant/realtime-core.ts';
import { deliveryText, staleNote, type Consultation } from '../../../shared/assistant/consultations.ts';
import { parseAnswer } from '../../src/assistant/expert.ts';

const view: RealtimeView = { state() {}, error() {}, system() {}, user() {}, assistant() {}, tool() {}, listening() {}, mic() {} };
const tick = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const ok = (answer: string, extra: Partial<ExpertResult> = {}): ExpertResult => ({
  ok: true, answer, keyFacts: ['fact'], confidence: 'high', spoiler: false, unknowns: [], ms: 1000, rounds: 1, tools: [], ...extra,
});

function setup(opts: { quietMs?: number; context?: { text: string; turn: number } } = {}) {
  const sent: Record<string, any>[] = [];
  const pending = new Map<string, { req: ExpertRequest; signal: AbortSignal; resolve: (r: ExpertResult) => void; reject: (e: Error) => void }>();
  let context = opts.context ?? { text: '[Live game state] Dlvl:1, turn 10.', turn: 10 };
  const host = { open: true, state: 'connected' as ConnState, send: (e: Record<string, any>) => sent.push(e), transportLost() {} };
  const changes: string[] = [];
  const backend = {
    tool: async (name: string) => ({ ok: true, result: `${name} result` }),
    context: async () => context,
    log() {},
    expert: (req: ExpertRequest, signal: AbortSignal) =>
      new Promise<ExpertResult>((resolve, reject) => {
        pending.set(req.consultationId, { req, signal, resolve, reject });
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
  };
  const v: RealtimeView = { ...view, expert: (c) => changes.push(`${c.id}:${c.status}`) };
  const conv = new RealtimeConversation(v, backend, host, { contextWaitMs: 5, expertQuietMs: opts.quietMs ?? 0 });
  conv.attach({ context, isReconnect: false });
  return { conv, sent, pending, host, changes, setContext: (c: typeof context) => (context = c) };
}

let rid = 0;
/** the model answers a turn: optional spoken text, then function calls */
function respond(t: ReturnType<typeof setup>, calls: { id: string; name: string; args: Record<string, unknown> }[], spoken = '', status = 'completed') {
  const id = `r${++rid}`;
  t.conv.onEvent({ type: 'response.created', response: { id } });
  const output = [
    ...(spoken ? [{ type: 'message', id: `m${rid}`, content: [{ type: 'output_text', text: spoken }] }] : []),
    ...calls.map((c) => ({ type: 'function_call', id: `item_${c.id}`, call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) })),
  ];
  t.conv.onEvent({ type: 'response.done', response: { id, status, output } });
  return id;
}
const consult = (id: string, question: string) => ({ id, name: 'consult_expert', args: { question } });
const deliveries = (t: ReturnType<typeof setup>) => t.sent.filter((e) => e.type === 'conversation.item.create' && e.item.role === 'system' && /^\[Expert result/.test(e.item.content[0].text));
const creates = (t: ReturnType<typeof setup>) => t.sent.filter((e) => e.type === 'response.create');

describe('expert consultations', () => {
  it('consult_expert returns at once; after a spoken preamble no extra response is requested', async () => {
    const t = setup();
    respond(t, [consult('c1', 'price of the lamp at 67 with Cha 8?')], 'Let me think that through properly.');
    await tick();
    const out = t.sent.find((e) => e.item?.type === 'function_call_output');
    expect(out!.item.output).toMatch(/^STARTED consultation x1/);
    expect(creates(t)).toHaveLength(0);
    expect(t.pending.get('x1')!.req.question).toBe('price of the lamp at 67 with Cha 8?');
    expect(t.conv.experts.running).toHaveLength(1);
  });

  it('without a preamble the model is asked to respond (to say it will get back)', async () => {
    const t = setup();
    respond(t, [consult('c1', 'q')]);
    await tick();
    expect(creates(t)).toHaveLength(1);
  });

  it('delivers the result as a system message plus a tagged response.create when the channel is idle', async () => {
    const t = setup();
    respond(t, [consult('c1', 'lamp?')], 'One moment.');
    await tick();
    t.pending.get('x1')!.resolve(ok('It is a magic lamp.'));
    await tick();
    expect(deliveries(t)).toHaveLength(1);
    expect(deliveries(t)[0].item.content[0].text).toContain('Answer: It is a magic lamp.');
    expect(creates(t).at(-1)).toEqual({ type: 'response.create', response: { metadata: { expert: 'x1' } } });
    // the delivery response finishes: delivered
    t.conv.onEvent({ type: 'response.created', response: { id: 'rd', metadata: { expert: 'x1' } } });
    t.conv.onEvent({ type: 'response.done', response: { id: 'rd', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'About the lamp: magic.' }] }] } });
    expect(t.conv.experts.list[0].status).toBe('delivered');
    expect(t.conv.experts.settled).toBe(true);
    expect(t.changes).toEqual(['x1:running', 'x1:ready', 'x1:delivering', 'x1:delivered']);
  });

  it('waits while a response is in progress, audio is playing, or the user is speaking', async () => {
    const t = setup();
    respond(t, [consult('c1', 'q1')], 'Let me think.');
    await tick();
    // a new user turn by voice: speaking, then waiting for the VAD-created response
    t.conv.onEvent({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
    t.pending.get('x1')!.resolve(ok('A1'));
    await tick();
    expect(deliveries(t)).toHaveLength(0);
    t.conv.onEvent({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
    await tick();
    expect(deliveries(t)).toHaveLength(0); // the auto response has not started yet
    t.conv.onEvent({ type: 'response.created', response: { id: 'ra' } });
    t.conv.onEvent({ type: 'output_audio_buffer.started', response_id: 'ra' });
    t.conv.onEvent({ type: 'response.done', response: { id: 'ra', status: 'completed', output: [] } });
    await tick();
    expect(deliveries(t)).toHaveLength(0); // audio still playing
    t.conv.onEvent({ type: 'output_audio_buffer.stopped', response_id: 'ra' });
    await tick();
    expect(deliveries(t)).toHaveLength(1);
  });

  it('waits for a quiet gap after the last activity', async () => {
    const t = setup({ quietMs: 60 });
    respond(t, [consult('c1', 'q1')], 'Let me think.');
    await tick();
    t.pending.get('x1')!.resolve(ok('A1'));
    await tick();
    expect(deliveries(t)).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 90));
    await tick();
    expect(deliveries(t)).toHaveLength(1);
  });

  it('does not deliver while tool calls of a response are still running', async () => {
    const t = setup();
    respond(t, [consult('c1', 'q1')], 'Let me think.');
    await tick();
    // the model is mid tool-call (arguments streamed, response not done yet)
    t.conv.onEvent({ type: 'response.created', response: { id: 'rt' } });
    t.conv.onEvent({ type: 'response.output_item.added', response_id: 'rt', item: { type: 'function_call', call_id: 'c2', name: 'look' } });
    t.pending.get('x1')!.resolve(ok('A1'));
    await tick();
    expect(deliveries(t)).toHaveLength(0);
    t.conv.onEvent({ type: 'response.done', response: { id: 'rt', status: 'completed', output: [{ type: 'function_call', id: 'item_c2', call_id: 'c2', name: 'look', arguments: '{}' }] } });
    await tick();
    expect(deliveries(t)).toHaveLength(0); // the tool answer response was requested and is pending
    t.conv.onEvent({ type: 'response.created', response: { id: 'rt2' } });
    t.conv.onEvent({ type: 'response.done', response: { id: 'rt2', status: 'completed', output: [] } });
    await tick();
    expect(deliveries(t)).toHaveLength(1);
  });

  it('delivers results that are ready together in one message; later ones after the delivery is spoken', async () => {
    const t = setup();
    respond(t, [consult('c1', 'first'), consult('c2', 'second'), consult('c3', 'third')], 'Let me think about all of that.');
    await tick();
    expect(t.conv.experts.running.map((c) => c.id)).toEqual(['x1', 'x2', 'x3']);
    t.conv.onEvent({ type: 'response.created', response: { id: 'busy' } });
    t.pending.get('x2')!.resolve(ok('A2'));
    t.pending.get('x1')!.resolve(ok('A1'));
    await tick();
    t.conv.onEvent({ type: 'response.done', response: { id: 'busy', status: 'completed', output: [] } });
    await tick();
    expect(deliveries(t)).toHaveLength(1);
    const text = deliveries(t)[0].item.content[0].text;
    expect(text).toContain('Expert result x1');
    expect(text).toContain('Expert result x2');
    expect(creates(t).at(-1)!.response.metadata.expert).toBe('x1,x2');
    // x3 finishes while the delivery is being spoken
    t.conv.onEvent({ type: 'response.created', response: { id: 'rd', metadata: { expert: 'x1,x2' } } });
    t.pending.get('x3')!.resolve(ok('A3'));
    await tick();
    expect(deliveries(t)).toHaveLength(1);
    t.conv.onEvent({ type: 'response.done', response: { id: 'rd', status: 'completed', output: [] } });
    await tick();
    expect(deliveries(t)).toHaveLength(2);
    expect(deliveries(t)[1].item.content[0].text).toContain('Expert result x3');
  });

  it('a duplicate question while running is not started twice; the concurrency cap is enforced', async () => {
    const t = setup();
    respond(t, [consult('c1', 'Is it a magic lamp?'), consult('c2', 'is it a MAGIC lamp')], 'Hmm.');
    await tick();
    const outs = t.sent.filter((e) => e.item?.type === 'function_call_output').map((e) => e.item.output);
    expect(outs[1]).toMatch(/^ALREADY RUNNING/);
    respond(t, [consult('c3', 'b'), consult('c4', 'c'), consult('c5', 'd')], 'Hmm.');
    await tick();
    const last = t.sent.filter((e) => e.item?.type === 'function_call_output').at(-1);
    expect(last!.item.output).toMatch(/already running/);
    expect(t.conv.experts.running).toHaveLength(3);
  });

  it('cancel_expert aborts the request; a late result is never delivered', async () => {
    const t = setup();
    respond(t, [consult('c1', 'q1')], 'Let me think.');
    await tick();
    const p = t.pending.get('x1')!;
    respond(t, [{ id: 'c2', name: 'cancel_expert', args: {} }], 'Okay, never mind.');
    await tick();
    expect(p.signal.aborted).toBe(true);
    expect(t.sent.filter((e) => e.item?.type === 'function_call_output').at(-1)!.item.output).toMatch(/^CANCELLED x1/);
    p.resolve(ok('late'));
    await tick();
    expect(deliveries(t)).toHaveLength(0);
    expect(t.conv.experts.list[0].status).toBe('cancelled');
    expect(t.conv.experts.settled).toBe(true);
  });

  it('the panel cancel button tells the model quietly; ending the session cancels everything', async () => {
    const t = setup();
    respond(t, [consult('c1', 'q1'), consult('c2', 'q2')], 'Let me think.');
    await tick();
    t.conv.cancelConsultation('x1');
    const note = t.sent.at(-1);
    expect(note!.item.content[0].text).toMatch(/x1 .*cancelled by the user/);
    expect(t.sent.filter((e) => e.type === 'response.create')).toHaveLength(0);
    t.conv.endSession();
    expect(t.pending.get('x2')!.signal.aborted).toBe(true);
    expect(t.conv.experts.list.map((c) => c.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('failures and timeouts are delivered as a short "could not finish" note', async () => {
    const t = setup();
    respond(t, [consult('c1', 'q1')], 'Let me think.');
    await tick();
    t.pending.get('x1')!.resolve({ ...ok(''), ok: false, error: 'timed out after 90 s' });
    await tick();
    expect(deliveries(t)[0].item.content[0].text).toMatch(/could NOT finish \(timed out after 90 s\)/);
  });

  it('a network error from the backend becomes a failure result', async () => {
    const t = setup();
    respond(t, [consult('c1', 'q1')], 'Let me think.');
    await tick();
    t.pending.get('x1')!.reject(new Error('socket hang up'));
    await tick();
    expect(deliveries(t)[0].item.content[0].text).toMatch(/could NOT finish \(network error: socket hang up\)/);
  });

  it('flags stale results when the game moved on', async () => {
    const t = setup({ context: { text: '[Live game state] Dlvl:2 (The Dungeons of Doom), turn 100.', turn: 100 } });
    respond(t, [consult('c1', 'q1')], 'Let me think.');
    await tick();
    t.setContext({ text: '[Live game state] Dlvl:3 (The Dungeons of Doom), turn 180.', turn: 180 });
    t.pending.get('x1')!.resolve(ok('A1'));
    await tick();
    const text = deliveries(t)[0].item.content[0].text;
    expect(text).toMatch(/moved on since the question \(turn 100 -> 180, level 2 -> 3\)/);
  });

  it('a delivery cut off by the user is marked interrupted and not repeated', async () => {
    const t = setup();
    respond(t, [consult('c1', 'q1')], 'Let me think.');
    await tick();
    t.pending.get('x1')!.resolve(ok('A1'));
    await tick();
    t.conv.onEvent({ type: 'response.created', response: { id: 'rd', metadata: { expert: 'x1' } } });
    t.conv.onEvent({ type: 'input_audio_buffer.speech_started', item_id: 'u2' });
    t.conv.onEvent({ type: 'response.done', response: { id: 'rd', status: 'cancelled', output: [] } });
    await tick();
    expect(t.conv.experts.list[0]).toMatchObject({ status: 'delivered', interrupted: true });
    expect(deliveries(t)).toHaveLength(1);
  });

  it('a rejected delivery response.create is retried with its marker once the active response ends', async () => {
    const t = setup();
    respond(t, [consult('c1', 'q1')], 'Let me think.');
    await tick();
    t.pending.get('x1')!.resolve(ok('A1'));
    await tick();
    // a VAD response sneaked in first
    t.conv.onEvent({ type: 'response.created', response: { id: 'rv' } });
    t.conv.onEvent({ type: 'error', error: { code: 'conversation_already_has_active_response', message: 'active' } });
    t.conv.onEvent({ type: 'response.done', response: { id: 'rv', status: 'completed', output: [] } });
    await tick();
    expect(creates(t).at(-1)).toEqual({ type: 'response.create', response: { metadata: { expert: 'x1' } } });
    t.conv.onEvent({ type: 'response.created', response: { id: 'rd', metadata: { expert: 'x1' } } });
    t.conv.onEvent({ type: 'response.done', response: { id: 'rd', status: 'completed', output: [] } });
    expect(t.conv.experts.list[0].status).toBe('delivered');
  });

  it('a reconnect while delivering queues the result again for the new session', async () => {
    const t = setup();
    respond(t, [consult('c1', 'q1')], 'Let me think.');
    await tick();
    t.pending.get('x1')!.resolve(ok('A1'));
    await tick();
    expect(deliveries(t)).toHaveLength(1);
    t.conv.detach();
    expect(t.conv.experts.list[0].status).toBe('ready');
    t.conv.attach({ context: { text: '[Live game state] Dlvl:1, turn 11.', turn: 11 }, isReconnect: true });
    t.conv.onEvent({ type: 'session.updated' });
    await tick();
    expect(deliveries(t)).toHaveLength(2);
  });

  it('reports the expert as unavailable when the backend has none', async () => {
    const sent: Record<string, any>[] = [];
    const host = { open: true, state: 'connected' as ConnState, send: (e: Record<string, any>) => sent.push(e), transportLost() {} };
    const conv = new RealtimeConversation(view, { tool: async () => ({ ok: true, result: '' }), context: async () => ({ text: '', turn: 0 }), log() {} }, host);
    conv.attach({ context: null, isReconnect: false });
    conv.onEvent({ type: 'response.created', response: { id: 'r' } });
    conv.onEvent({ type: 'response.done', response: { id: 'r', status: 'completed', output: [{ type: 'function_call', id: 'i', call_id: 'c', name: 'consult_expert', arguments: '{"question":"q"}' }] } });
    await tick();
    expect(sent.find((e) => e.item?.type === 'function_call_output')!.item.output).toMatch(/^ERROR: the expert is not available/);
    expect(sent.at(-1)).toEqual({ type: 'response.create' });
  });
});

describe('expert delivery text and parsing', () => {
  const c = (over: Partial<Consultation> = {}): Consultation => ({
    id: 'x1', question: 'q', status: 'ready', startedAt: 0, userTurn: 1, ac: new AbortController(), result: ok('A'), ...over,
  });
  it('includes held-back spoiler details, unknowns and the speaking instructions', () => {
    const text = deliveryText([c({ result: ok('A', { spoilerDetails: 'base 50: magic lamp', unknowns: ['Luck'], confidence: 'medium' }) })], null, 12_000);
    expect(text).toContain('asked 12 s ago');
    expect(text).toContain('Spoiler-level details the expert kept out');
    expect(text).toContain('Depends on things nobody can see in the game: Luck.');
    expect(text).toMatch(/at most about 80 words/);
  });
  it('no stale note for small changes', () => {
    expect(staleNote(c({ startTurn: 10, startContext: 'Dlvl:1 turn 10' }), { text: 'Dlvl:1, turn 20', turn: 20 })).toBe('');
  });
  it('parses structured answers and tolerates plain text', () => {
    const r = parseAnswer(JSON.stringify({ answer: 'Yes.', key_facts: ['a'], confidence: 'high', spoiler: true, spoiler_details: '', unknowns: [] }));
    expect(r).toMatchObject({ ok: true, answer: 'Yes.', spoiler: true, confidence: 'high' });
    expect(r.spoilerDetails).toBeUndefined();
    expect(parseAnswer('plain words').answer).toBe('plain words');
    expect(parseAnswer('').ok).toBe(false);
  });
});
