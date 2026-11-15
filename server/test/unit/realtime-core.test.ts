/**
 * The transport-agnostic Realtime conversation core shared by the browser (WebRTC) and the
 * Node eval driver (WebSocket): tool-call pairing, barge-in handling, live-context snapshots.
 */
import { describe, expect, it } from 'vitest';
import { RealtimeConversation, type ConnState, type RealtimeView } from '../../../shared/assistant/realtime-core.ts';

const view: RealtimeView = { state() {}, error() {}, system() {}, user() {}, assistant() {}, tool() {}, listening() {}, mic() {} };
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(context = { text: '[Live game state] HP 11/11', turn: 1 }) {
  const sent: Record<string, any>[] = [];
  const toolCalls: string[] = [];
  let clock = 0;
  const host = { open: true, state: 'connected' as ConnState, send: (e: Record<string, any>) => sent.push(e), transportLost() {} };
  const backend = {
    tool: async (name: string) => (toolCalls.push(name), { ok: true, result: `${name} result` }),
    context: async () => context,
    log() {},
  };
  const conv = new RealtimeConversation(view, backend, host, { now: () => (clock += 1000), contextWaitMs: 5 });
  return { conv, sent, toolCalls, host, setContext: (c: typeof context) => (context = c) };
}

const fnCall = (id: string, name = 'look') => ({ type: 'function_call', id: `item_${id}`, call_id: id, name, arguments: '{"target":"f"}' });

describe('RealtimeConversation', () => {
  it('adds the initial snapshot and replaces it (deleting the old item) when the game changed', async () => {
    const t = setup();
    t.conv.attach({ context: { text: 'snapshot 1', turn: 1 }, isReconnect: false });
    t.setContext({ text: 'snapshot 2', turn: 2 });
    await t.conv.sendText('hi');
    const creates = t.sent.filter((e) => e.type === 'conversation.item.create' && e.item.role === 'system');
    expect(creates.map((e) => e.item.content[0].text)).toEqual(['snapshot 1', 'snapshot 2']);
    expect(t.sent.find((e) => e.type === 'conversation.item.delete')?.item_id).toBe(creates[0].item.id);
    expect(t.sent.at(-1)).toEqual({ type: 'response.create' });
  });

  it('runs tool calls of a completed response and pairs each with one output before asking for the answer', async () => {
    const t = setup();
    t.conv.attach({ context: null, isReconnect: false });
    await t.conv.sendText('what is the f?');
    t.sent.length = 0;
    t.conv.onEvent({ type: 'response.created', response: { id: 'r1' } });
    t.conv.onEvent({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [fnCall('c1'), fnCall('c2', 'get_status')] } });
    await tick();
    await tick();
    expect(t.toolCalls).toEqual(['look', 'get_status']);
    expect(t.sent.map((e) => e.type)).toEqual(['conversation.item.create', 'conversation.item.create', 'response.create']);
    expect(t.sent[0].item).toMatchObject({ type: 'function_call_output', call_id: 'c1', output: 'look result' });
    expect(t.conv.debug.unpaired()).toEqual([]);
  });

  it('pairs calls of an interrupted response with an INTERRUPTED note and lets the new turn drive the answer', async () => {
    const t = setup();
    t.conv.attach({ context: null, isReconnect: false });
    t.conv.onEvent({ type: 'response.created', response: { id: 'r1' } });
    t.conv.onEvent({ type: 'response.done', response: { id: 'r1', status: 'cancelled', output: [{ ...fnCall('c9'), status: 'incomplete' }] } });
    await tick();
    const out = t.sent.find((e) => e.item?.type === 'function_call_output');
    expect(out?.item.output).toMatch(/^INTERRUPTED/);
    expect(out?.previous_item_id).toBe('item_c9');
    expect(t.sent.some((e) => e.type === 'response.create')).toBe(false);
    expect(t.conv.debug.dropped()).toEqual(['look:c9']);
  });

  it('marks first-text latency on the first assistant message of a turn', async () => {
    const t = setup();
    t.conv.attach({ context: null, isReconnect: false });
    await t.conv.sendText('hp?');
    t.conv.onEvent({ type: 'response.output_text.delta', item_id: 'a1', delta: 'You have ' });
    t.conv.onEvent({ type: 'response.output_text.done', item_id: 'a1', text: 'You have 11 HP.' });
    const last = t.conv.debug.transcript.at(-1)!;
    expect(last).toMatchObject({ role: 'assistant', text: 'You have 11 HP.' });
    expect(last.ms?.first_text).toBeGreaterThan(0);
    expect(t.conv.history.at(-1)).toEqual({ role: 'assistant', text: 'You have 11 HP.' });
  });

  it('text typed while not connected is shown at once, asks the host to connect, and is sent as one turn on attach', async () => {
    const users: string[] = [];
    let connects = 0;
    const sent: Record<string, any>[] = [];
    const host = { open: false, state: 'idle' as ConnState, send: (e: Record<string, any>) => sent.push(e), transportLost() {}, ensureConnected: () => connects++ };
    const v: RealtimeView = { ...view, user: (_k, text) => users.push(text) };
    const conv = new RealtimeConversation(v, { tool: async () => ({ ok: true, result: '' }), context: async () => ({ text: 'ctx', turn: 1 }), log() {} }, host, { contextWaitMs: 5 });
    await conv.sendText('hello');
    await conv.sendText('are you there?');
    expect(users).toEqual(['hello', 'are you there?']);
    expect(connects).toBe(2);
    expect(sent).toEqual([]);
    host.open = true;
    conv.attach({ context: { text: 'ctx', turn: 1 }, isReconnect: false });
    await tick();
    await tick();
    const texts = sent.filter((e) => e.item?.role === 'user').map((e) => e.item.content[0].text);
    expect(texts).toEqual(['hello', 'are you there?']);
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(1);
    expect(conv.history.map((h) => h.text)).toEqual(['hello', 'are you there?']);
  });

  it('without a lazily connecting host, text while not connected is ignored', async () => {
    const t = setup();
    t.host.state = 'idle';
    await t.conv.sendText('hello');
    expect(t.sent).toEqual([]);
  });

  it('closing the mic mid-utterance commits the audio and asks for the answer; otherwise does nothing', () => {
    const t = setup();
    t.conv.attach({ context: null, isReconnect: false });
    t.sent.length = 0;
    t.conv.micClosed();
    expect(t.sent).toEqual([]);
    t.conv.onEvent({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
    t.sent.length = 0;
    t.conv.micClosed();
    expect(t.sent.map((e) => e.type)).toEqual(['input_audio_buffer.commit', 'response.create']);
  });
});
