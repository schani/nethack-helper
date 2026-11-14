// Turns the step-by-step Sokoban solutions on nethackwiki "Sokoban Level Nx" pages into a voice-friendly step list.
//
// The wiki writes solutions as ASCII maps where boulders are lettered, next to move strings like "B ddld dddl llll*"
// ("push boulder B down 2, left 1, down 4, left 4, into a hole"). Letters mean nothing to a player looking at their
// screen, and an LLM can't reliably turn ASCII art into spoken directions, so we simulate the pushes and describe each
// boulder by where it is relative to the player (assuming they followed the earlier steps) and to the arrival stairs.
// Mirrored 5.0 levels are handled by negating offsets / swapping directions (flip = left-right / up-down / both).

export type Flip = "none" | "left-right" | "up-down" | "both";

export function parseFlip(v: string | undefined): Flip {
  const s = (v ?? "").toLowerCase().replace(/[\s_]+/g, "-");
  if (!s || s === "none" || s === "no") return "none";
  if (s === "both" || s.includes("both") || (/(lr|left|horiz)/.test(s) && /(ud|up|vert)/.test(s))) return "both";
  if (/^(lr|left-right|horizontal|h|x)$/.test(s) || s.includes("left") || s.includes("horiz")) return "left-right";
  if (/^(ud|up-down|vertical|v|y)$/.test(s) || s.includes("up") || s.includes("vert")) return "up-down";
  return "none";
}

/** Matches wiki titles like "Sokoban Level 1a". */
export const SOKOBAN_LEVEL_TITLE = /^sokoban level [1-4][ab]$/i;

interface Pos { x: number; y: number }
interface Step { stage: number; letter: string; from?: Pos; player?: Pos; arrival?: Pos; runs: [string, number][]; fell: boolean }
interface Stage { text: string }

const DIRS: Record<string, Pos> = { u: { x: 0, y: -1 }, d: { x: 0, y: 1 }, l: { x: -1, y: 0 }, r: { x: 1, y: 0 } };
const WORD: Record<string, string> = { u: "up", d: "down", l: "left", r: "right" };

function decode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#124;/g, "|").replace(/&amp;/g, "&");
}

function cleanProse(s: string): string {
  return s
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, "$1")
    .replace(/'''?/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract the "Strategy" section of the page's wikitext. */
function strategySection(wikitext: string): string | null {
  const m = /^==\s*(Strategy|Solution)\s*==\s*$/im.exec(wikitext);
  if (!m) return null;
  const rest = wikitext.slice(m.index + m[0].length);
  const end = rest.search(/^==[^=].*==\s*$/m);
  return end >= 0 ? rest.slice(0, end) : rest;
}

interface MapInfo { boulders: Map<string, Pos>; player?: Pos; arrival?: Pos; up?: Pos; pits: Pos[] }

function readMap(lines: string[]): MapInfo {
  const info: MapInfo = { boulders: new Map(), pits: [] };
  lines.forEach((line, y) => {
    for (let x = 0; x < line.length; x++) {
      const c = line[x];
      if (/[A-Z]/.test(c)) info.boulders.set(c, { x, y });
      else if (c === "@") info.player = { x, y };
      else if (c === ">") info.arrival = { x, y };
      else if (c === "<") info.up = { x, y };
      else if (c === "^") info.pits.push({ x, y });
    }
  });
  return info;
}

const MOVE_RE = /'''([A-Za-z])'''\s*([udlr*][udlr*\s]*)/g;
const BOILERPLATE = /replaced by letters|ttyrec|youtube|following solution|faster solution|exercise to the reader|permanentlink/i;

export function parseSokobanSolution(wikitext: string): { stages: Stage[]; steps: Step[]; first?: MapInfo; after?: string } | null {
  const sec = strategySection(wikitext);
  if (!sec) return null;
  const stages: Stage[] = [];
  const steps: Step[] = [];
  const pendingMoves: { letter: string; moves: string }[] = [];
  let prose: string[] = []; // prose since the last replayed step = description of the next stage
  let first: MapInfo | undefined;
  let state = new Map<string, Pos>();
  let player: Pos | undefined;
  let arrival: Pos | undefined;
  let mapBuf: string[] = [];
  let inDiv = false;

  const clipText = (t: string, n: number) => (t.length > n ? t.slice(0, n - 10).trimEnd() + "…" : t);

  function flushMap() {
    if (!mapBuf.length) return;
    if (mapBuf.some((l) => l.includes("|"))) {
      const info = readMap(mapBuf);
      if (!first) {
        first = info;
        // On the starting map the hero stands on the arrival (down) stairs.
        if (!info.arrival && info.player) info.arrival = info.player;
      }
      state = new Map(info.boulders);
      if (info.player) player = info.player;
      arrival = info.arrival ?? arrival ?? first.arrival;
    }
    mapBuf = [];
  }

  /** End of a map block or a run of move lines: apply the collected moves to the current board. */
  function replay() {
    flushMap();
    if (!pendingMoves.length) return;
    if (prose.length) {
      stages.push({ text: clipText(prose.join(" "), 420) });
      prose = [];
    }
    for (const { letter, moves } of pendingMoves.splice(0)) {
      const from = state.get(letter);
      const pushes = moves.replace(/\*/g, "");
      const runs: [string, number][] = [];
      for (const ch of pushes) {
        const last = runs[runs.length - 1];
        if (last && last[0] === ch) last[1]++;
        else runs.push([ch, 1]);
      }
      const step: Step = { stage: stages.length - 1, letter, from, player, arrival, runs, fell: moves.includes("*") };
      steps.push(step);
      if (!from) continue;
      let p = { ...from };
      let prev = { ...from };
      for (const ch of pushes) {
        prev = p;
        p = { x: p.x + DIRS[ch].x, y: p.y + DIRS[ch].y };
      }
      player = prev; // the hero ends up where the boulder was before the last push
      if (step.fell) state.delete(letter);
      else state.set(letter, p);
    }
  }

  for (const raw of sec.split("\n")) {
    const line = decode(raw);
    if (/<div[^>]*ttymap/i.test(line)) { replay(); inDiv = true; continue; }
    if (/<\/div>/i.test(line)) { inDiv = false; continue; } // moves for a div map follow on separate lines
    const pre = inDiv || line.startsWith(" ");
    if (!pre) {
      replay();
      const t = cleanProse(line);
      if (t && !BOILERPLATE.test(t) && !/^(\{\||\||\[\[Category)/i.test(line.trim())) prose.push(t);
      continue;
    }
    const body = line.startsWith(" ") ? line.slice(1) : line;
    const q = body.indexOf("'''");
    const mapPart = (q >= 0 ? body.slice(0, q) : body).replace(/\s+$/, "");
    if (mapPart.trim()) mapBuf.push(mapPart);
    else if (!inDiv) flushMap();
    if (q >= 0) {
      for (const m of body.slice(q).matchAll(MOVE_RE)) pendingMoves.push({ letter: m[1].toUpperCase(), moves: m[2].replace(/\s+/g, "") });
    }
  }
  replay();
  const after = prose.length ? clipText(prose.join(" "), 360) : undefined;
  return { stages, steps, first, after };
}

function rel(dx: number, dy: number): string {
  if (!dx && !dy) return "at the same spot";
  const parts: string[] = [];
  if (dx) parts.push(`${Math.abs(dx)} ${dx > 0 ? "right" : "left"}`);
  if (dy) parts.push(`${Math.abs(dy)} ${dy > 0 ? "down" : "up"}`);
  return parts.join(", ");
}

function flipDir(d: string, flip: Flip): string {
  const h = flip === "left-right" || flip === "both";
  const v = flip === "up-down" || flip === "both";
  if (h && (d === "l" || d === "r")) return d === "l" ? "r" : "l";
  if (v && (d === "u" || d === "d")) return d === "u" ? "d" : "u";
  return d;
}

function delta(a: Pos, b: Pos, flip: Flip): [number, number] {
  let dx = a.x - b.x;
  let dy = a.y - b.y;
  if (flip === "left-right" || flip === "both") dx = -dx;
  if (flip === "up-down" || flip === "both") dy = -dy;
  return [dx, dy];
}

/** Voice-ready solution text for a Sokoban level page, or null if the page has no parsable solution. */
export function formatSokobanSolution(wikitext: string, title: string, flipArg?: string): string | null {
  const parsed = parseSokobanSolution(wikitext);
  if (!parsed || !parsed.steps.length) return null;
  const flip = parseFlip(flipArg);
  const { stages, steps, first, after } = parsed;
  const out: string[] = [];
  out.push(`SOKOBAN SOLUTION for ${title} (converted from the wiki for voice; ${steps.length} steps).` +
    (flip !== "none" ? ` Directions are already MIRRORED (${flip}) to match the player's level.` : ""));

  if (first?.arrival) {
    const describe = (f: Flip) => {
      const id: string[] = [];
      if (first.up) {
        const [dx, dy] = delta(first.up, first.arrival!, f);
        id.push(`up staircase ${rel(dx, dy)}${!dx || !dy ? (dy ? " (same column)" : " (same row)") : ""}`);
      }
      if (first.pits.length) {
        let dx = first.pits.reduce((n, p) => n + p.x, 0) / first.pits.length - first.arrival!.x;
        let dy = first.pits.reduce((n, p) => n + p.y, 0) / first.pits.length - first.arrival!.y;
        if (f === "left-right" || f === "both") dx = -dx;
        if (f === "up-down" || f === "both") dy = -dy;
        const side = [Math.abs(dy) >= 0.5 ? (dy > 0 ? "below" : "above") : "", Math.abs(dx) >= 0.5 ? (dx > 0 ? "to the right" : "to the left") : ""].filter(Boolean).join(" and ");
        id.push(`holes mostly ${side || "around you"}`);
      }
      return id.join(", ");
    };
    const all: Flip[] = ["none", "left-right", "up-down", "both"];
    out.push(
      `WHICH ORIENTATION: compare with what the player sees when arriving (positions relative to the arrival point): ` +
        all.map((f) => `flip="${f}": ${describe(f)}`).join("; ") + `. ` +
        (flip === "none"
          ? `The steps below are for flip="none" (the wiki's orientation). If the player's level matches another line, call fetch_wiki_page again with that flip value.`
          : `The steps below are ALREADY MIRRORED for flip="${flip}"; read them out as written.`) +
        (first.boulders.size ? ` The level starts with ${first.boulders.size} boulders.` : ""),
    );
  }
  out.push(
    `NETHACK 5.0 NOTE (checked against the 5.0 level files): the map and boulder positions are the same as on the wiki, but each line of holes has one rolling boulder trap where the boulders enter it and some holes moved by a square. ` +
      `A boulder pushed onto that trap rolls on by itself and drops into the next open hole (the trap is harmless to you in Sokoban). So the pushes below still work; if a boulder rolls away or drops in earlier than listed, go on to the next step; if it stops short of a hole, keep pushing it the same way.`,
  );
  out.push(`HOW TO READ: positions are counted in squares from where the player should be standing after the previous step ("you") and from the arrival stairs. Between pushes in different directions the player walks around to the other side of the boulder. Give the player one to three steps at a time, then offer to continue.`);

  let lastStage = -1;
  steps.forEach((s, i) => {
    if (s.stage !== lastStage && stages[s.stage]) {
      out.push(`STAGE: ${stages[s.stage].text}`);
      lastStage = s.stage;
    }
    const where: string[] = [];
    if (s.from && s.player) {
      const [dx, dy] = delta(s.from, s.player, flip);
      const adjacent: Record<string, string> = { "1,0": "directly to your right", "-1,0": "directly to your left", "0,-1": "directly above you", "0,1": "directly below you" };
      where.push(adjacent[`${dx},${dy}`] ?? `${rel(dx, dy)} from you`);
    }
    if (s.from && s.arrival) {
      const [dx, dy] = delta(s.from, s.arrival, flip);
      where.push(`${rel(dx, dy)} from the arrival stairs`);
    }
    const pushes = s.runs.map(([d, n]) => `${WORD[flipDir(d, flip)]} ${n}`).join(", then ");
    out.push(`${i + 1}. Boulder ${s.letter}${where.length ? ` (${where.join("; ")})` : ""}: push ${pushes}${s.fell ? ", into a hole" : ""}.`);
  });
  if (after) out.push(`AFTERWARDS: ${after}`);
  return out.join("\n");
}
