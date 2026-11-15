/**
 * Assistant eval suite.
 *
 *   npm run eval -- [--variant baseline] [--tags look,state] [--cases id,id] [--n 3] [--concurrency 4]
 *                   [--mode text|audio] [--judge gpt-5.5|gpt-5.4-mini|none] [--judge-effort low]
 *                   [--knowledge cache|live|offline] [--id run-id] [--dry-run] [--no-live] [--live-only] [--set core]
 *   npm run eval -- --list                          cases and tag counts
 *   npm run eval:compare -- <run-id-a> <run-id-b>   side-by-side report (also written to .cache/evals/compare-a-vs-b.md)
 *   npm run eval -- rejudge <run-id> [--judge gpt-5.4-mini] [--limit n]   re-grade a run with another judge, report agreement
 *
 * Results: .cache/evals/<run-id>/{results.json,summary.json,report.md}.  Audio mode without --cases/--tags runs
 * the cases marked `audio: true` (TTS question audio, real VAD/transcription, first-audio latency).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CORE, loadCases } from '../cases/index.ts';
import { VARIANTS } from '../variants.ts';
import { CACHE_DIR, ROOT, resolvedVariant } from './harness.ts';
import { compareMarkdown, markdown, summarize, type Summary } from './report.ts';
import { responsesCost } from './cost.ts';
import { gradeTurn } from './graders.ts';
import { loadFixture } from './fixtures.ts';
import { GameTools } from '../../server/src/assistant/game/tools.ts';
import { judge } from './judge.ts';
import { knowledgeFor, runAll, type RunOptions } from './runner.ts';
import type { CaseRun, EvalCase, JudgeScores } from './types.ts';

const argv = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const val = argv[i + 1];
  argv.splice(i, 2);
  return val;
};
const flag = (name: string) => {
  const i = argv.indexOf(name);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};

if (argv[0] === 'compare') {
  // compare on the cases both runs have (re-summarized from the raw results)
  const [a, b] = argv.slice(1);
  const load = (id: string) => ({
    summary: JSON.parse(fs.readFileSync(path.join(CACHE_DIR, id, 'summary.json'), 'utf8')) as Summary,
    runs: JSON.parse(fs.readFileSync(path.join(CACHE_DIR, id, 'results.json'), 'utf8')) as CaseRun[],
  });
  const A = load(a);
  const B = load(b);
  const shared = new Set(A.runs.map((r) => r.case).filter((c) => B.runs.some((r) => r.case === c)));
  const resum = (x: ReturnType<typeof load>) => {
    const { overall: _o, tags: _t, cases: _c, tokens: _k, cost: _s, ...meta } = x.summary;
    return summarize(meta, x.runs.filter((r) => shared.has(r.case)));
  };
  const md = `(${shared.size} shared cases)\n\n${compareMarkdown(resum(A), resum(B))}`;
  const out = path.join(CACHE_DIR, `compare-${a}-vs-${b}.md`);
  fs.writeFileSync(out, md + '\n');
  console.log(md);
  console.log(`\n(written to ${path.relative(ROOT, out)})`);
  process.exit(0);
}

const cases = await loadCases();

if (argv[0] === 'rejudge') {
  // Re-grade a finished run's transcripts with another judge (judge validation / judge-model comparison).
  const runId = argv[1];
  const model = opt('--judge', 'gpt-5.4-mini')!;
  const effort = opt('--judge-effort', 'low')!;
  const limit = Number(opt('--limit', '1000'));
  const conc = Number(opt('--concurrency', '8'));
  const applyTo = opt('--apply'); // write a re-graded copy of the run under this id
  const allRuns = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, runId, 'results.json'), 'utf8')) as CaseRun[];
  const only = opt('--only')?.split(','); // case#rep,...
  const runs = allRuns.filter((r) => r.judge && (!only || only.includes(`${r.case}#${r.rep}`))).slice(0, limit);
  const apiKey = process.env.OPENAI_API_KEY!;
  const out: { case: string; rep: number; orig: JudgeScores; re: JudgeScores }[] = [];
  let cost = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (next < runs.length) {
        const r = runs[next++];
        const c = cases.find((x) => x.id === r.case)!;
        const fx = c.live ? null : loadFixture(c.fixture ?? 'start-pet-adjacent');
        // runs recorded before snapshots were stored: rebuild it from the fixture (same code as production)
        const snapshot = r.snapshot !== undefined ? (r.snapshot ?? undefined) : fx ? new GameTools({ running: fx.running, state: () => fx.state, screen: () => fx.screen }).snapshot().text : undefined;
        try {
          const j = await judge({ c, fx, turns: r.turns, snapshot, model, effort, apiKey });
          cost += responsesCost(model, j.usage);
          out.push({ case: r.case, rep: r.rep, orig: r.judge!, re: j.scores });
          if (applyTo) {
            r.snapshot = snapshot ?? null;
            r.judge = j.scores;
            r.judgeUsage = j.usage;
            r.cost.judge = responsesCost(model, j.usage);
            r.pass = r.checksPass && j.scores.pass;
          }
        } catch (e) {
          console.error(`${r.case}#${r.rep}: ${(e as Error).message}`);
        }
      }
    }),
  );
  const agree = out.filter((x) => x.orig.pass === x.re.pass).length;
  const both = (a: boolean, b: boolean) => out.filter((x) => x.orig.pass === a && x.re.pass === b).length;
  const po = agree / out.length;
  const p1 = out.filter((x) => x.orig.pass).length / out.length;
  const q1 = out.filter((x) => x.re.pass).length / out.length;
  const pe = p1 * q1 + (1 - p1) * (1 - q1);
  const dims = ['correctness', 'groundedness', 'spoiler', 'speakability'] as const;
  const mad = Object.fromEntries(dims.map((d) => [d, out.reduce((a, x) => a + Math.abs(x.orig[d] - x.re[d]), 0) / out.length]));
  const file = path.join(CACHE_DIR, runId, `rejudge-${model}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`rejudged ${out.length} runs of ${runId} with ${model} (${effort}): pass agreement ${(po * 100).toFixed(1)}%, Cohen's kappa ${((po - pe) / (1 - pe)).toFixed(2)}`);
  console.log(`orig pass / re pass: both pass ${both(true, true)}, both fail ${both(false, false)}, orig only ${both(true, false)}, re only ${both(false, true)}`);
  console.log(`mean |score difference|: ${dims.map((d) => `${d} ${mad[d].toFixed(2)}`).join(', ')}; cost $${cost.toFixed(3)}`);
  for (const x of out.filter((y) => y.orig.pass !== y.re.pass)) console.log(`  disagree ${x.case}#${x.rep}: orig ${x.orig.pass} (${x.orig.rationale.slice(0, 140)}) | re ${x.re.pass} (${x.re.rationale.slice(0, 140)})`);
  console.log(`(written to ${path.relative(ROOT, file)})`);
  if (applyTo) {
    const dir = path.join(CACHE_DIR, applyTo);
    fs.mkdirSync(dir, { recursive: true });
    const old = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, runId, 'summary.json'), 'utf8')) as Summary;
    const { overall: _o, tags: _t, cases: _c, tokens: _k, cost: _s, ...meta } = old;
    fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(allRuns, null, 1));
    const sum = summarize({ ...meta, id: applyTo, judgeModel: model }, allRuns);
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(sum, null, 1));
    fs.writeFileSync(path.join(dir, 'report.md'), markdown(sum) + '\n');
    console.log(`re-graded run written to ${path.relative(ROOT, dir)}/ (pass rate ${(sum.overall.pass * 100).toFixed(1)}%)`);
  }
  process.exit(0);
}

if (argv[0] === 'regrade') {
  // recompute deterministic checks of stored runs with the current case expectations (no API calls)
  for (const runId of argv.slice(1)) {
    const dir = path.join(CACHE_DIR, runId);
    const runs = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')) as CaseRun[];
    let changed = 0;
    for (const r of runs) {
      const c = cases.find((x) => x.id === r.case);
      if (!c) continue;
      r.turns.forEach((t, i) => (t.checks = gradeTurn(t, c.turns[i]?.expect)));
      const checksPass = r.turns.length === c.turns.length && r.turns.every((t) => t.checks.every((x) => x.pass));
      const pass = checksPass && (!r.judge || r.judge.pass) && !r.error;
      if (pass !== r.pass) changed++;
      r.checksPass = checksPass;
      r.pass = pass;
    }
    const old = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')) as Summary;
    const { overall: _o, tags: _t, cases: _c, tokens: _k, cost: _s, ...meta } = old;
    const sum = summarize(meta, runs);
    fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(runs, null, 1));
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(sum, null, 1));
    fs.writeFileSync(path.join(dir, 'report.md'), markdown(sum) + '\n');
    console.log(`${runId}: ${changed} verdicts changed, pass rate ${(sum.overall.pass * 100).toFixed(1)}%`);
  }
  process.exit(0);
}

if (flag('--list')) {
  const tags = new Map<string, number>();
  for (const c of cases) for (const t of c.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
  for (const c of cases) console.log(`${c.id.padEnd(34)} ${(c.live ? `live:${c.live}` : (c.fixture ?? '')).padEnd(24)} ${c.tags.join(',')}${c.audio ? ' [audio]' : ''}`);
  console.log(
    `\n${cases.length} cases (${cases.filter((c) => c.live).length} live, ${cases.filter((c) => c.audio).length} audio); tags: ${[...tags]
      .sort((a, b) => b[1] - a[1])
      .map(([t, k]) => `${t} ${k}`)
      .join(', ')}`,
  );
  process.exit(0);
}

const variantName = opt('--variant', 'baseline')!;
const variant = VARIANTS[variantName];
if (!variant) throw new Error(`unknown variant ${variantName}; known: ${Object.keys(VARIANTS).join(', ')}`);
const mode = opt('--mode', 'text') as 'text' | 'audio';
const n = Number(opt('--n', '3'));
const concurrency = Number(opt('--concurrency', '4'));
const judgeArg = opt('--judge', 'gpt-5.5')!;
const judgeEffort = opt('--judge-effort', 'low')!;
const knowledge = opt('--knowledge', 'cache') as 'cache' | 'live' | 'offline';
const tagSel = opt('--tags')?.split(',').filter(Boolean);
const setSel = opt('--set');
const caseSel = setSel === 'core' ? CORE : opt('--cases')?.split(',').filter(Boolean);
const runId = opt('--id');
const dry = flag('--dry-run');
const noLive = flag('--no-live');
const liveOnly = flag('--live-only');

if (caseSel) for (const id of caseSel) if (!cases.some((c) => c.id === id)) throw new Error(`unknown case ${id}`);
let selected: EvalCase[] = cases.filter(
  (c) => (!tagSel || c.tags.some((t) => tagSel.includes(t))) && (!caseSel || caseSel.includes(c.id)) && (!noLive || !c.live) && (!liveOnly || c.live),
);
if (mode === 'audio' && !tagSel && !caseSel) selected = selected.filter((c) => c.audio);
if (!selected.length) throw new Error('no cases selected');

// cost estimate from experience: ~5.5k prompt tokens per model response (mostly cached after the first), 1.5-2.5 responses per turn
const turns = selected.reduce((a, c) => a + c.turns.length, 0) * n;
const r = resolvedVariant(variant);
const perTurn = (/mini/.test(r.model) ? 0.004 : 0.025) * (mode === 'audio' ? 1.6 : 1);
const perJudge = judgeArg === 'none' ? 0 : judgeArg === 'gpt-5.5' ? 0.03 : 0.006;
const estimate = turns * perTurn + selected.length * n * perJudge;
console.log(
  `${selected.length} cases x N=${n} (${turns} turns), variant ${variant.name} (${r.model}, reasoning ${r.reasoning}), mode ${mode}, judge ${judgeArg}: estimated cost ~$${estimate.toFixed(2)}`,
);
if (dry) process.exit(0);
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const id = runId ?? `${stamp}-${variant.name}${mode === 'audio' ? '-audio' : ''}`;
const outDir = path.join(CACHE_DIR, id);
fs.mkdirSync(outDir, { recursive: true });
let commit = '?';
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()) commit += '+dirty';
} catch {
  /* not a git checkout */
}

const o: RunOptions = {
  variant,
  mode,
  judgeModel: judgeArg === 'none' ? null : judgeArg,
  judgeEffort,
  knowledge,
  outDir,
  livePort: Number(process.env.EVAL_LIVE_PORT ?? 8797),
  apiKey,
};
const jobs = selected.flatMap((c) => Array.from({ length: n }, (_, rep) => ({ c, rep })));
const t0 = Date.now();
let spent = 0;
const results = await runAll(jobs, o, concurrency, (res, i, total) => {
  spent += res.cost.realtime + res.cost.judge + res.cost.tts;
  const lat = res.turns.map((t) => (mode === 'audio' ? t.latency.first_audio : t.latency.first_text) ?? '-').join('/');
  const j = res.judge ? ` judge ${res.judge.correctness}${res.judge.groundedness}${res.judge.spoiler}${res.judge.speakability}` : '';
  console.log(`[${i}/${total}] ${res.pass ? 'PASS' : 'FAIL'} ${res.case}#${res.rep}${j} ${lat}ms $${spent.toFixed(3)}${res.error ? ` ERROR ${res.error.split('\n')[0].slice(0, 120)}` : ''}`);
  fs.appendFileSync(path.join(outDir, 'results.jsonl'), JSON.stringify(res) + '\n');
});
results.sort((a, b) => a.case.localeCompare(b.case) || a.rep - b.rep);
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 1));
const summary = summarize(
  { id, date: new Date().toISOString(), commit, variant: { ...variant, ...r }, mode, n, judgeModel: o.judgeModel, wallMs: Date.now() - t0 },
  results,
);
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
const md = markdown(summary);
fs.writeFileSync(path.join(outDir, 'report.md'), md + '\n');
console.log(`\n${md.split('\n## Failing')[0]}`);
const k = knowledgeFor(knowledge);
console.log(`knowledge cache: ${k.hits} hits, ${k.misses} misses`);
console.log(`results: ${path.relative(ROOT, outDir)}/ (report.md, summary.json, results.json); ${Math.round((Date.now() - t0) / 1000)} s`);
process.exit(0);
