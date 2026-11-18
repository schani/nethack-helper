/** Aggregates case runs into summary metrics, writes results JSON + markdown, and compares runs. */
import { wordCount } from './graders.ts';
import type { CaseRun } from './types.ts';

export interface Stat {
  n: number;
  median: number | null;
  p90: number | null;
  mean: number | null;
}

export function stat(xs: (number | undefined | null)[]): Stat {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: null, p90: null, mean: null };
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { n: v.length, median: q(0.5), p90: q(0.9), mean: v.reduce((a, b) => a + b, 0) / v.length };
}

/** Wilson score interval for k successes out of n */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const judgeScore = (r: CaseRun) => (r.judge ? (r.judge.correctness + r.judge.groundedness + r.judge.spoiler + r.judge.speakability) / 4 : undefined);

export interface Group {
  runs: number;
  cases: number;
  pass: number;
  passCI: [number, number];
  /** pass rate of each repetition (spread across reps) */
  repPass: number[];
  checks: number;
  judge: { score: number | null; correctness: number | null; groundedness: number | null; spoiler: number | null; speakability: number | null; pass: number | null };
  firstText: Stat;
  firstAudio: Stat;
  /** time to the final answer: when the turn's last message started (a delivered thinker result), else the first */
  final: Stat;
  total: Stat;
  /** spoken words per turn: the final answer (last message) and everything said (preambles included) */
  words: Stat;
  wordsAll: Stat;
  rounds: number | null;
  toolsPerTurn: number | null;
  errors: number;
  flaky: number;
  /** fraction of turns that consulted the expert; expert run time and cost per consultation */
  expertRate: number;
  expertMs: Stat;
  expertCost: number | null;
  expertFailed: number;
  /** thinker run time by depth; consultations answered from its cache */
  quickMs?: Stat;
  deepMs?: Stat;
  quickCalls?: number;
  deepCalls?: number;
  cachedCalls?: number;
}

export function group(runs: CaseRun[]): Group {
  const k = runs.filter((r) => r.pass).length;
  const reps = [...new Set(runs.map((r) => r.rep))].sort((a, b) => a - b);
  const turns = runs.flatMap((r) => r.turns);
  const judged = runs.filter((r) => r.judge);
  const consults = turns.flatMap((t) => t.expert ?? []);
  const byCase = new Map<string, CaseRun[]>();
  for (const r of runs) byCase.set(r.case, [...(byCase.get(r.case) ?? []), r]);
  return {
    runs: runs.length,
    cases: byCase.size,
    pass: runs.length ? k / runs.length : 0,
    passCI: wilson(k, runs.length),
    repPass: reps.map((rep) => {
      const rs = runs.filter((r) => r.rep === rep);
      return rs.filter((r) => r.pass).length / rs.length;
    }),
    checks: runs.length ? runs.filter((r) => r.checksPass).length / runs.length : 0,
    judge: {
      score: mean(judged.map((r) => judgeScore(r)!)),
      correctness: mean(judged.map((r) => r.judge!.correctness)),
      groundedness: mean(judged.map((r) => r.judge!.groundedness)),
      spoiler: mean(judged.map((r) => r.judge!.spoiler)),
      speakability: mean(judged.map((r) => r.judge!.speakability)),
      pass: judged.length ? judged.filter((r) => r.judge!.pass).length / judged.length : null,
    },
    // latency of the first turn only would hide multi-turn effects; use every turn
    firstText: stat(turns.map((t) => t.latency.first_text)),
    firstAudio: stat(turns.map((t) => t.latency.first_audio)),
    final: stat(turns.map((t) => finalMs(t))),
    total: stat(turns.map((t) => t.latency.total)),
    words: stat(turns.map((t) => wordCount(t.messages?.at(-1) ?? t.answer))),
    wordsAll: stat(turns.map((t) => wordCount(t.answer))),
    rounds: mean(turns.map((t) => t.rounds)),
    toolsPerTurn: mean(turns.map((t) => t.tools.length)),
    errors: runs.filter((r) => r.error).length,
    flaky: [...byCase.values()].filter((rs) => rs.some((r) => r.pass) && rs.some((r) => !r.pass)).length,
    expertRate: turns.length ? turns.filter((t) => t.expert?.length).length / turns.length : 0,
    expertMs: stat(turns.flatMap((t) => (t.expert ?? []).filter((e) => e.status !== 'cancelled').map((e) => e.ms))),
    expertCost: mean(turns.flatMap((t) => (t.expert ?? []).map((e) => e.cost))),
    expertFailed: turns.flatMap((t) => (t.expert ?? []).filter((e) => !e.ok)).length,
    quickMs: stat(consults.filter((e) => e.depth === 'quick' && e.status !== 'cancelled').map((e) => e.ms)),
    deepMs: stat(consults.filter((e) => e.depth !== 'quick' && e.status !== 'cancelled').map((e) => e.ms)),
    quickCalls: consults.filter((e) => e.depth === 'quick').length,
    deepCalls: consults.filter((e) => e.depth !== 'quick').length,
    cachedCalls: consults.filter((e) => e.cached).length,
  };
}

/** time to the final answer of a turn (runs recorded before final_text existed: the first message) */
export function finalMs(t: CaseRun['turns'][number]): number | undefined {
  return t.latency.final_text ?? (t.messages.length <= 1 ? t.latency.first_text : undefined);
}

export interface Summary {
  id: string;
  date: string;
  commit: string;
  variant: Record<string, unknown>;
  mode: string;
  n: number;
  judgeModel: string | null;
  overall: Group;
  tags: Record<string, Group>;
  cases: Record<string, { tags: string[]; pass: number; judge: number | null; failures: string[]; issues: string[]; answers: string[] }>;
  tokens: { input: number; cached: number; output: number; audioIn: number; audioOut: number };
  cost: { realtime: number; judge: number; tts: number; expert?: number; total: number; perCaseRun: number };
  wallMs: number;
}

export function summarize(meta: Omit<Summary, 'overall' | 'tags' | 'cases' | 'tokens' | 'cost'>, runs: CaseRun[]): Summary {
  const tags: Record<string, Group> = {};
  for (const t of [...new Set(runs.flatMap((r) => r.tags))].sort()) tags[t] = group(runs.filter((r) => r.tags.includes(t)));
  const cases: Summary['cases'] = {};
  for (const id of [...new Set(runs.map((r) => r.case))]) {
    const rs = runs.filter((r) => r.case === id);
    const failures = new Set<string>();
    for (const r of rs) {
      if (r.error) failures.add(`error: ${r.error.split('\n')[0].slice(0, 160)}`);
      for (const [i, t] of r.turns.entries()) for (const c of t.checks) if (!c.pass) failures.add(`t${i + 1} ${c.name}${c.detail ? ` (${c.detail.slice(0, 120)})` : ''}`);
      if (r.judge && !r.judge.pass) failures.add(`judge: ${r.judge.rationale.slice(0, 200)}`);
    }
    cases[id] = {
      tags: rs[0].tags,
      pass: rs.filter((r) => r.pass).length / rs.length,
      judge: mean(rs.filter((r) => r.judge).map((r) => judgeScore(r)!)),
      failures: [...failures].slice(0, 8),
      issues: [...new Set(rs.flatMap((r) => r.judge?.issues ?? []))].slice(0, 6),
      answers: rs.map((r) => r.turns.map((t) => t.answer).join(' || ').slice(0, 400)),
    };
  }
  const turns = runs.flatMap((r) => r.turns);
  const sum = (f: (u: any) => number) => turns.reduce((a, t) => a + f(t.usage), 0);
  const cost = {
    realtime: runs.reduce((a, r) => a + r.cost.realtime, 0),
    judge: runs.reduce((a, r) => a + r.cost.judge, 0),
    tts: runs.reduce((a, r) => a + r.cost.tts, 0),
    expert: runs.reduce((a, r) => a + (r.cost.expert ?? 0), 0),
    total: 0,
    perCaseRun: 0,
  };
  cost.total = cost.realtime + cost.judge + cost.tts + cost.expert;
  cost.perCaseRun = runs.length ? cost.total / runs.length : 0;
  return {
    ...meta,
    overall: group(runs),
    tags,
    cases,
    tokens: { input: sum((u) => u.input_tokens), cached: sum((u) => u.cached_text + u.cached_audio), output: sum((u) => u.output_tokens), audioIn: sum((u) => u.input_audio), audioOut: sum((u) => u.output_audio) },
    cost,
  };
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? '-' : `${Math.round(x * 100)}%`);
const num = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? '-' : x.toFixed(d));
const ms = (s: Stat) => (s.median === null ? '-' : `${s.median} / ${s.p90}`);
const words = (s: Stat | undefined) => (!s || s.median === null ? '-' : `${num(s.mean, 1)} / ${s.median} / ${s.p90}`);

export function markdown(s: Summary): string {
  const o = s.overall;
  const L: string[] = [];
  L.push(`# Eval run ${s.id}`, '');
  L.push(`- variant: **${String(s.variant.name)}** (${String(s.variant.description ?? '')})`);
  L.push(`- config: ${JSON.stringify(Object.fromEntries(Object.entries(s.variant).filter(([k]) => !['name', 'description'].includes(k))))}`);
  L.push(`- mode ${s.mode}, N=${s.n}, ${o.cases} cases, ${o.runs} case runs, judge ${s.judgeModel ?? 'none'}, commit ${s.commit}, ${s.date}`);
  L.push('');
  L.push('| metric | value |', '|---|---|');
  L.push(`| pass rate | **${pct(o.pass)}** (95% CI ${pct(o.passCI[0])}-${pct(o.passCI[1])}; per rep ${o.repPass.map(pct).join(', ')}) |`);
  L.push(`| deterministic checks pass | ${pct(o.checks)} |`);
  L.push(`| judge pass | ${pct(o.judge.pass)} |`);
  L.push(`| judge score (1-5: correct / grounded / spoiler / speakable) | ${num(o.judge.score)} (${num(o.judge.correctness)} / ${num(o.judge.groundedness)} / ${num(o.judge.spoiler)} / ${num(o.judge.speakability)}) |`);
  L.push(`| flaky cases (mixed results across reps) | ${o.flaky} |`);
  L.push(`| first text ms (median / p90) | ${ms(o.firstText)} |`);
  L.push(`| first audio ms (median / p90) | ${ms(o.firstAudio)} |`);
  L.push(`| time to final answer ms (median / p90) | ${ms(o.final ?? stat([]))} |`);
  L.push(`| turn total ms (median / p90) | ${ms(o.total)} |`);
  L.push(`| thinker: call rate (turns) / run time ms median, p90 / cost per call / failed | ${pct(o.expertRate)} / ${ms(o.expertMs ?? stat([]))} / ${o.expertCost == null ? '-' : `$${o.expertCost.toFixed(4)}`} / ${o.expertFailed ?? 0} |`);
  L.push(`| thinker calls quick / deep / cached; run time ms quick, deep (median / p90) | ${o.quickCalls ?? 0} / ${o.deepCalls ?? 0} / ${o.cachedCalls ?? 0}; ${ms(o.quickMs ?? stat([]))}, ${ms(o.deepMs ?? stat([]))} |`);
  L.push(`| words per turn, final answer (mean / median / p90) | ${words(o.words)} |`);
  L.push(`| words per turn incl. preambles (mean / median / p90) | ${words(o.wordsAll)} |`);
  L.push(`| tool rounds / tools per turn | ${num(o.rounds)} / ${num(o.toolsPerTurn)} |`);
  L.push(`| tokens in (cached) / out | ${s.tokens.input} (${s.tokens.cached}) / ${s.tokens.output} |`);
  L.push(`| cost (realtime + judge + tts + expert) | $${s.cost.total.toFixed(3)} ($${s.cost.realtime.toFixed(3)} + $${s.cost.judge.toFixed(3)} + $${s.cost.tts.toFixed(3)} + $${(s.cost.expert ?? 0).toFixed(3)}); $${s.cost.perCaseRun.toFixed(4)} per case run |`);
  L.push(`| errors | ${o.errors} |`);
  L.push('');
  L.push('', '## Per tag', '', '| tag | cases | pass | judge | correctness | first text med | final answer med / p90 | words med | thinker rate |', '|---|---|---|---|---|---|---|---|---|');
  for (const [t, g] of Object.entries(s.tags))
    L.push(`| ${t} | ${g.cases} | ${pct(g.pass)} | ${num(g.judge.score)} | ${num(g.judge.correctness)} | ${g.firstText.median ?? '-'} | ${ms(g.final ?? stat([]))} | ${g.words.median ?? '-'} | ${pct(g.expertRate)} |`);
  L.push('', '## Failing / flaky cases', '');
  for (const [id, c] of Object.entries(s.cases).sort((a, b) => a[1].pass - b[1].pass)) {
    if (c.pass === 1) continue;
    L.push(`### ${id} — ${pct(c.pass)} pass, judge ${num(c.judge)} [${c.tags.join(', ')}]`);
    for (const f of c.failures) L.push(`- ${f}`);
    L.push(`- answer: ${c.answers[0]}`);
    L.push('');
  }
  return L.join('\n');
}

export function compareMarkdown(a: Summary, b: Summary): string {
  const L: string[] = [];
  const d = (x: number | null, y: number | null, scale = 100, unit = '%', digits = 0) =>
    x === null || y === null ? '-' : `${y - x >= 0 ? '+' : ''}${((y - x) * scale).toFixed(digits)}${unit}`;
  L.push(`# ${a.id} (${String(a.variant.name)}) vs ${b.id} (${String(b.variant.name)})`, '');
  L.push(`| metric | ${String(a.variant.name)} | ${String(b.variant.name)} | delta |`, '|---|---|---|---|');
  const row = (name: string, x: number | null, y: number | null, fmt: (v: number | null) => string, delta: string) => L.push(`| ${name} | ${fmt(x)} | ${fmt(y)} | ${delta} |`);
  row('pass rate', a.overall.pass, b.overall.pass, pct, d(a.overall.pass, b.overall.pass));
  row('checks pass', a.overall.checks, b.overall.checks, pct, d(a.overall.checks, b.overall.checks));
  row('judge score', a.overall.judge.score, b.overall.judge.score, (v) => num(v), d(a.overall.judge.score, b.overall.judge.score, 1, '', 2));
  for (const k of ['correctness', 'groundedness', 'spoiler', 'speakability'] as const)
    row(`  ${k}`, a.overall.judge[k], b.overall.judge[k], (v) => num(v), d(a.overall.judge[k], b.overall.judge[k], 1, '', 2));
  row('first text median ms', a.overall.firstText.median, b.overall.firstText.median, (v) => String(v ?? '-'), d(a.overall.firstText.median, b.overall.firstText.median, 1, ' ms'));
  row('first text p90 ms', a.overall.firstText.p90, b.overall.firstText.p90, (v) => String(v ?? '-'), d(a.overall.firstText.p90, b.overall.firstText.p90, 1, ' ms'));
  row('first audio median ms', a.overall.firstAudio.median, b.overall.firstAudio.median, (v) => String(v ?? '-'), d(a.overall.firstAudio.median, b.overall.firstAudio.median, 1, ' ms'));
  for (const q of ['median', 'p90'] as const) {
    const x = a.overall.final?.[q] ?? null;
    const y = b.overall.final?.[q] ?? null;
    row(`time to final answer ${q} ms`, x, y, (v) => String(v ?? '-'), d(x, y, 1, ' ms'));
  }
  row('turn total median ms', a.overall.total.median, b.overall.total.median, (v) => String(v ?? '-'), d(a.overall.total.median, b.overall.total.median, 1, ' ms'));
  row('turn total p90 ms', a.overall.total.p90, b.overall.total.p90, (v) => String(v ?? '-'), d(a.overall.total.p90, b.overall.total.p90, 1, ' ms'));
  for (const [k, label] of [['words', 'words, final answer'], ['wordsAll', 'words incl. preambles']] as const)
    for (const q of ['mean', 'median', 'p90'] as const)
      row(`${label} ${q}`, a.overall[k]?.[q] ?? null, b.overall[k]?.[q] ?? null, (v) => num(v, q === 'mean' ? 1 : 0), d(a.overall[k]?.[q] ?? null, b.overall[k]?.[q] ?? null, 1, '', 1));
  row('thinker call rate (turns)', a.overall.expertRate ?? 0, b.overall.expertRate ?? 0, pct, d(a.overall.expertRate ?? 0, b.overall.expertRate ?? 0));
  row('thinker run time median ms', a.overall.expertMs?.median ?? null, b.overall.expertMs?.median ?? null, (v) => String(v ?? '-'), d(a.overall.expertMs?.median ?? null, b.overall.expertMs?.median ?? null, 1, ' ms'));
  row('tool rounds', a.overall.rounds, b.overall.rounds, (v) => num(v), d(a.overall.rounds, b.overall.rounds, 1, '', 2));
  row('cost per case run $', a.cost.perCaseRun, b.cost.perCaseRun, (v) => num(v, 4), d(a.cost.perCaseRun, b.cost.perCaseRun, 1, '', 4));
  L.push(
    '',
    '## Per tag',
    '',
    `| tag | pass ${String(a.variant.name)} | pass ${String(b.variant.name)} | delta | correctness a / b | final answer med a / b | thinker rate a / b |`,
    '|---|---|---|---|---|---|---|',
  );
  for (const t of [...new Set([...Object.keys(a.tags), ...Object.keys(b.tags)])].sort()) {
    const x = a.tags[t];
    const y = b.tags[t];
    L.push(
      `| ${t} | ${x ? pct(x.pass) : '-'} | ${y ? pct(y.pass) : '-'} | ${x && y ? d(x.pass, y.pass) : '-'} | ${num(x?.judge.correctness)} / ${num(y?.judge.correctness)} | ` +
        `${x?.final?.median ?? '-'} / ${y?.final?.median ?? '-'} | ${x ? pct(x.expertRate) : '-'} / ${y ? pct(y.expertRate) : '-'} |`,
    );
  }
  const shared = Object.keys(a.cases).filter((id) => b.cases[id]);
  const regress = shared.filter((id) => b.cases[id].pass < a.cases[id].pass - 0.01).sort((x, y) => b.cases[x].pass - a.cases[x].pass - (b.cases[y].pass - a.cases[y].pass));
  const improve = shared.filter((id) => b.cases[id].pass > a.cases[id].pass + 0.01);
  L.push('', `## Regressions (${regress.length})`, '');
  for (const id of regress) L.push(`- ${id}: ${pct(a.cases[id].pass)} -> ${pct(b.cases[id].pass)}; ${b.cases[id].failures.slice(0, 2).join(' / ')}`);
  L.push('', `## Improvements (${improve.length})`, '');
  for (const id of improve) L.push(`- ${id}: ${pct(a.cases[id].pass)} -> ${pct(b.cases[id].pass)}`);
  return L.join('\n');
}
