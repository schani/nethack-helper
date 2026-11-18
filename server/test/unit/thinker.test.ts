/**
 * The thinker service (server/src/assistant/expert.ts) against a fake Responses API: instructions on every request
 * (previous_response_id does not carry them over), quick vs deep settings and tools, the player's situation in the
 * input, the round cap, and the answer cache.
 */
import { describe, expect, it } from 'vitest';
import { ExpertService } from '../../src/assistant/expert.ts';

type Json = Record<string, any>;

const answer = (over: Json = {}) =>
  JSON.stringify({ options: [], answer: 'Kick it.', key_facts: [], confidence: 'high', spoiler: false, spoiler_details: '', unknowns: [], cacheable: false, ...over });

function fakeApi(script: Json[][]) {
  const bodies: Json[] = [];
  let i = 0;
  const fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const output = script[Math.min(i++, script.length - 1)];
    return new Response(JSON.stringify({ id: `r${i}`, output, usage: { input_tokens: 1000, output_tokens: 50, input_token_details: {}, output_tokens_details: {} } }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, bodies };
}

const call = (name: string, args: Json = {}) => ({ type: 'function_call', call_id: `c-${name}`, name, arguments: JSON.stringify(args) });
const msg = (text: string) => ({ type: 'message', content: [{ type: 'output_text', text }] });

function service(fetch: typeof globalThis.fetch, over: Json = {}) {
  const ran: string[] = [];
  const svc = new ExpertService({
    apiKey: () => 'sk-test',
    tools: [
      { name: 'read_guidebook', description: 'g', parameters: {} },
      { name: 'web_search', description: 'w', parameters: {} },
    ],
    quickExclude: ['web_search'],
    runTool: async (name) => (ran.push(name), { ok: true, result: `${name} result`, ms: 1 }),
    snapshot: () => ({ text: '[Live game state] turn 5', turn: 5 }),
    situation: () => '## Inventory\na - a +0 katana (weapon in hand)',
    promptsDir: new URL('../../prompts', import.meta.url).pathname,
    log: { write: () => {} } as never,
    fetch,
    ...over,
  });
  return { svc, ran };
}

const req = (question: string, depth?: 'quick' | 'deep') => ({ question, depth, excerpt: [], consultationId: 'x1' });

describe('thinker service', () => {
  it('sends the instructions with every request, also after a tool round', async () => {
    const api = fakeApi([[call('read_guidebook', { topic: 'Containers' })], [msg(answer())]]);
    const { svc, ran } = service(api.fetch);
    const r = await svc.consult(req('It says the box is locked'));
    expect(r.ok).toBe(true);
    expect(ran).toEqual(['read_guidebook']);
    expect(api.bodies).toHaveLength(2);
    for (const b of api.bodies) expect(b.instructions).toMatch(/You are the thinker/);
    expect(api.bodies[1].previous_response_id).toBe('r1');
  });

  it('quick mode: low effort, no web search, the situation and mode in the input', async () => {
    const api = fakeApi([[msg(answer())]]);
    const { svc } = service(api.fetch);
    const r = await svc.consult(req('How do I open it?'));
    const b = api.bodies[0];
    expect(r.depth).toBe('quick');
    expect(b.reasoning.effort).toBe(svc.quick.effort);
    expect(b.tools.map((t: Json) => t.name)).toEqual(['read_guidebook']);
    expect(b.input[0].content).toMatch(/^MODE: quick/);
    expect(b.input[0].content).toMatch(/PLAYER'S SITUATION[\s\S]*katana/);
  });

  it('deep mode keeps every tool and the deep effort', async () => {
    const api = fakeApi([[msg(answer())]]);
    const { svc } = service(api.fetch, { effort: 'medium' });
    await svc.consult(req('Work out the odds', 'deep'));
    expect(api.bodies[0].reasoning.effort).toBe('medium');
    expect(api.bodies[0].tools.map((t: Json) => t.name)).toEqual(['read_guidebook', 'web_search']);
  });

  it('after the round cap pending tool calls are skipped and it must answer', async () => {
    const api = fakeApi([[call('read_guidebook')], [call('read_guidebook')], [msg(answer())]]);
    const { svc, ran } = service(api.fetch, { quick: { maxRounds: 2 } });
    const r = await svc.consult(req('q'));
    expect(ran).toHaveLength(1);
    expect(api.bodies[2].tool_choice).toBe('none');
    expect(api.bodies[2].input[0].output).toMatch(/^SKIPPED/);
    expect(r.rounds).toBe(2);
  });

  it('caches answers marked cacheable (not spoilers), keyed by the normalized question', async () => {
    const api = fakeApi([[msg(answer({ cacheable: true, answer: 'Be next to it when you take the stairs.' }))]]);
    const { svc } = service(api.fetch);
    await svc.consult(req('How do I take my pet downstairs?'));
    const again = await svc.consult(req('how do I take my pet downstairs'));
    expect(api.bodies).toHaveLength(1);
    expect(again).toMatchObject({ ok: true, cached: true, cost: 0, answer: 'Be next to it when you take the stairs.' });
    // another depth is another question
    await svc.consult(req('how do I take my pet downstairs', 'deep'));
    expect(api.bodies).toHaveLength(2);
  });

  it('does not cache situation-specific or spoiler answers', async () => {
    const api = fakeApi([[msg(answer({ cacheable: true, spoiler: true }))], [msg(answer({ cacheable: false }))]]);
    const { svc } = service(api.fetch);
    await svc.consult(req('a'));
    await svc.consult(req('a'));
    await svc.consult(req('a'));
    expect(api.bodies).toHaveLength(3);
  });
});
