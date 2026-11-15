/** Runs eval cases (fixture or live game, text or audio mode) and grades them. */
import path from 'node:path';
import { NodeRealtimeSession, type TurnRecord } from '../../server/src/assistant/realtime-node.ts';
import { playRecipe, snapshotFixture } from '../fixtures/capture.ts';
import { RECIPES } from '../fixtures/recipes.ts';
import { TRANSCRIBE_PER_MIN, TTS_PER_MIN, realtimeCost, responsesCost } from './cost.ts';
import { loadFixture, type Fixture } from './fixtures.ts';
import { gradeTurn } from './graders.ts';
import { CachedKnowledge, fixtureBackend, httpBackend, resolvedVariant, sessionFor, type KnowledgeMode } from './harness.ts';
import { judge } from './judge.ts';
import { questionAudio } from './tts.ts';
import type { CaseRun, EvalCase, Variant } from './types.ts';

export interface RunOptions {
  variant: Variant;
  mode: 'text' | 'audio';
  judgeModel: string | null;
  judgeEffort: string;
  knowledge: KnowledgeMode;
  outDir: string;
  livePort: number;
  apiKey: string;
}

let knowledgeService: CachedKnowledge | null = null;
export const knowledgeFor = (mode: KnowledgeMode) => (knowledgeService ??= new CachedKnowledge(mode));

/** Run one repetition of one case. Never throws (failures are recorded in the result). */
export async function runCase(c: EvalCase, rep: number, o: RunOptions): Promise<CaseRun> {
  const t0 = Date.now();
  const model = resolvedVariant(o.variant).model;
  const run: CaseRun = { case: c.id, tags: c.tags, rep, mode: o.mode, turns: [], pass: false, checksPass: false, cost: { realtime: 0, judge: 0, tts: 0 }, ms: 0 };
  let session: NodeRealtimeSession | null = null;
  let live: Awaited<ReturnType<typeof playRecipe>> | null = null;
  let fx: Fixture | null = null;
  try {
    const sessionCfg = await sessionFor(o.variant);
    let backend;
    let initialContext;
    if (c.live) {
      const recipe = RECIPES.find((r) => r.id === c.live);
      if (!recipe) throw new Error(`unknown live recipe ${c.live}`);
      live = await playRecipe(recipe, o.livePort);
      fx = await snapshotFixture(recipe, live.base, live.play);
      backend = httpBackend(live.base, o.variant);
      initialContext = o.variant.snapshot === 'none' ? null : await backend.context();
    } else {
      fx = loadFixture(c.fixture ?? 'start-pet-adjacent');
      const b = fixtureBackend(fx, c, o.variant, knowledgeFor(o.knowledge), path.join(o.outDir, 'logs'));
      backend = b.backend;
      initialContext = b.initialContext;
    }
    run.snapshot = initialContext?.text ?? null;
    session = await NodeRealtimeSession.open({ apiKey: o.apiKey, session: sessionCfg, backend, initialContext, mode: o.mode });
    for (const turn of c.turns) {
      let rec: TurnRecord;
      if (o.mode === 'audio') {
        const a = await questionAudio(turn.user, o.apiKey);
        if (!a.cached) run.cost.tts += (a.seconds / 60) * TTS_PER_MIN;
        run.cost.realtime += (a.seconds / 60) * TRANSCRIBE_PER_MIN;
        rec = await session.speak(a.pcm, turn.user);
      } else {
        rec = await session.ask(turn.user);
      }
      run.cost.realtime += realtimeCost(model, rec.usage);
      run.turns.push({ ...rec, checks: gradeTurn(rec, turn.expect) });
      if (rec.errors.some((e) => /transport lost|timed out/.test(e))) break;
    }
    run.checksPass = run.turns.length === c.turns.length && run.turns.every((t) => t.checks.every((x) => x.pass));
    if (o.judgeModel) {
      try {
        const j = await judge({ c, fx, turns: run.turns, snapshot: run.snapshot ?? undefined, model: o.judgeModel, effort: o.judgeEffort, apiKey: o.apiKey });
        run.judge = j.scores;
        run.judgeUsage = j.usage;
        run.cost.judge = responsesCost(o.judgeModel, j.usage);
      } catch (e) {
        run.error = (e as Error).message;
      }
    }
    run.pass = run.checksPass && (!o.judgeModel || !!run.judge?.pass);
  } catch (e) {
    run.error = (e as Error).stack ?? String(e);
  } finally {
    session?.close();
    await live?.close();
    run.ms = Date.now() - t0;
  }
  return run;
}

/** Run jobs with a concurrency limit; live jobs run one at a time (one game port). */
export async function runAll(jobs: { c: EvalCase; rep: number }[], o: RunOptions, concurrency: number, onDone: (r: CaseRun, i: number, n: number) => void): Promise<CaseRun[]> {
  const results: CaseRun[] = [];
  const fixtureJobs = jobs.filter((j) => !j.c.live);
  const liveJobs = jobs.filter((j) => j.c.live);
  let done = 0;
  const n = jobs.length;
  let next = 0;
  const worker = async () => {
    while (next < fixtureJobs.length) {
      const j = fixtureJobs[next++];
      let r = await runCase(j.c, j.rep, o);
      // one retry for infrastructure failures (network, rate limits), not for model failures
      if (r.error && !r.turns.length) r = await runCase(j.c, j.rep, o);
      results.push(r);
      onDone(r, ++done, n);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  for (const j of liveJobs) {
    const r = await runCase(j.c, j.rep, o);
    results.push(r);
    onDone(r, ++done, n);
  }
  return results;
}
