// Unit + integration tests for the tool layer and HTTP endpoints. Real network calls (wiki, OpenAI) are made.
// Run: npm test   (server tests expect the server on http://localhost:8788 unless VOICE_PROTO_URL is set)
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseInfobox, splitSections, runTool, TOOL_DEFS, srcAvailable } from "../server/tools.ts";
import { buildSessionConfig } from "../server/session.ts";
import { formatSokobanSolution, parseFlip } from "../server/sokoban.ts";

const BASE = process.env.VOICE_PROTO_URL ?? "http://localhost:8788";
const hasSrc = await srcAvailable();

describe("pure helpers", () => {
  test("parseInfobox extracts and cleans monster template", () => {
    const wt = "{{monster\n |name=genetic engineer\n |attacks=[[Claw attack|Claw]] 1d4 [[polymorph]]\n |reference=[https://x y]\n}}\nText";
    const out = parseInfobox(wt);
    assert.match(out, /\[monster infobox\]/);
    assert.match(out, /attacks: Claw 1d4 polymorph/);
    assert.doesNotMatch(out, /reference/);
  });
  test("splitSections splits on wiki headings", () => {
    const secs = splitSections("Intro text\n== Strategy ==\nDo X\n=== Sub ===\nY\n== History ==\nZ");
    assert.deepEqual(secs.map((s) => s.heading), ["(intro)", "Strategy", "Sub", "History"]);
    assert.equal(secs[0].text, "Intro text");
  });
  test("tool definitions are valid realtime function tools", () => {
    for (const t of TOOL_DEFS) {
      assert.equal(t.type, "function");
      assert.ok(t.description.length > 40);
      assert.equal(t.parameters.type, "object");
    }
  });
  test("session config shape (GA realtime)", async () => {
    const cfg: any = await buildSessionConfig({ model: "gpt-realtime-2.1", voice: "marin", reasoning: "low" });
    assert.equal(cfg.type, "realtime");
    assert.equal(cfg.audio.input.turn_detection.type, "semantic_vad");
    assert.equal(cfg.audio.input.transcription.model, "gpt-transcribe");
    assert.equal(cfg.tools.length, 4);
    assert.match(cfg.instructions, /Spoiler/);
    assert.match(cfg.instructions, /released on May 2, 2026/);
    assert.equal(cfg.parallel_tool_calls, true);
    assert.doesNotMatch(cfg.instructions, /Extra Accuracy Rules/);
    const mini: any = await buildSessionConfig({ model: "gpt-realtime-2.1-mini", voice: "marin", reasoning: "low" });
    assert.match(mini.instructions, /Extra Accuracy Rules/);
  });
});

describe("sokoban solution formatter", () => {
  // Tiny synthetic page in the wiki's format: map with lettered boulders, moves to the right of the map.
  const B = "'''";
  const wt = [
    "Intro.", "", "==Strategy==", "All boulders are replaced by letters so they can be referred to.", "",
    "First, open the way:", "",
    ` ------- ${B}A${B} d`,
    ` |<.@..| ${B}B${B} rr`,
    " |^.AB.|",
    " |^....|",
    " -------", "",
    "Finish:", "",
    ` ------- ${B}B${B} lll*`, " |<.>..|", " |^....|", " |^..B.|", " -------", "",
    "==Next level==", "x",
  ].join("\n");
  test("parseFlip normalizes spoken variants", () => {
    assert.equal(parseFlip(undefined), "none");
    assert.equal(parseFlip("left-right"), "left-right");
    assert.equal(parseFlip("horizontal"), "left-right");
    assert.equal(parseFlip("up_down"), "up-down");
    assert.equal(parseFlip("both"), "both");
  });
  test("steps describe boulders relative to the player and arrival stairs", () => {
    const out = formatSokobanSolution(wt, "Sokoban Level 9z")!;
    assert.match(out, /1\. Boulder A \(directly below you; 1 down from the arrival stairs\): push down 1\./);
    // after pushing A down the hero stands where A was, so B is directly to the right
    assert.match(out, /2\. Boulder B \(directly to your right; 1 right, 1 down from the arrival stairs\): push right 2\./);
    // B moved 2 right and the next map resets positions: B is 1 left, 1 down of the hero shown on that map
    assert.match(out, /3\. Boulder B \(\d+ (left|right).*\): push left 3, into a hole\./);
    assert.match(out, /STAGE: Finish:\n3\. Boulder B .*push left 3, into a hole\./);
    assert.match(out, /flip="none": up staircase 2 left \(same row\)/);
    assert.match(out, /NETHACK 5\.0 NOTE/);
    assert.doesNotMatch(out, /replaced by letters/);
  });
  test("flip mirrors positions and directions", () => {
    const out = formatSokobanSolution(wt, "Sokoban Level 9z", "left-right")!;
    assert.match(out, /1\. Boulder A \(directly below you; 1 down from the arrival stairs\): push down 1\./);
    assert.match(out, /2\. Boulder B \(directly to your left;.*push left 2\./);
    assert.match(out, /ALREADY MIRRORED for flip="left-right"/);
  });
  test("returns null without a parsable solution", () => {
    assert.equal(formatSokobanSolution("no strategy here", "Sokoban Level 1a"), null);
  });
});

describe("source tools", { skip: !hasSrc && "NetHack source not cloned (run scripts/setup.sh)" }, () => {
  test("search finds genetic engineer in monsters.h and the 5.0 changelog", async () => {
    const r = await runTool("search_nethack_source", { pattern: "genetic engineer", path_glob: "include/ doc/fixes5-0-0.txt" });
    assert.match(r, /include\/monsters\.h:\d+:/);
    assert.match(r, /doc\/fixes5-0-0\.txt:\d+:/);
  });
  test("search caps output", async () => {
    const r = await runTool("search_nethack_source", { pattern: "the" });
    assert.ok(r.length <= 4300, `len ${r.length}`);
    assert.match(r, /showing first 40/);
  });
  test("invalid regex falls back to literal", async () => {
    const r = await runTool("search_nethack_source", { pattern: "enl_foo(", path_glob: "src/*.c" });
    assert.match(r, /searched literally/);
  });
  test("path_glob is forgiving: bad entries skipped, bare file names matched anywhere", async () => {
    const r = await runTool("search_nethack_source", { pattern: "genetic engineer", path_glob: "include/monsters.h fixes5-0-0.txt src/nonexistent" });
    assert.match(r, /include\/monsters\.h:\d+:/);
    assert.match(r, /doc\/fixes5-0-0\.txt:\d+:/);
    assert.match(r, /skipped nonexistent path_glob entries: src\/nonexistent/);
    await assert.rejects(runTool("search_nethack_source", { pattern: "x", path_glob: "src/nope" }), /no such path/);
  });
  test("read returns numbered lines and caps range", async () => {
    const r = await runTool("read_nethack_source", { path: "include/monsters.h", start_line: 1, end_line: 1000 });
    assert.match(r, /^include\/monsters\.h lines 1-120 of \d+/);
  });
  test("read rejects traversal", async () => {
    await assert.rejects(runTool("read_nethack_source", { path: "../../package.json", start_line: 1 }), /without '\.\.'/);
    await assert.rejects(runTool("read_nethack_source", { path: "src/../../../server/main.ts", start_line: 1 }), /without '\.\.'/);
    await assert.rejects(runTool("search_nethack_source", { pattern: "x", path_glob: "../*" }), /'\.\.'/);
    await assert.rejects(runTool("read_nethack_source", { path: ".git/config", start_line: 1 }), /not allowed|no such file/);
  });
});

describe("wiki tool (network)", () => {
  test("fetches page with infobox", async () => {
    const r = await runTool("fetch_wiki_page", { title: "Genetic engineer" });
    assert.match(r, /^Wiki: Genetic engineer/);
    assert.match(r, /monster infobox/);
    assert.ok(r.length < 5200);
  });
  test("approximate title resolves to the closest page in one call", async () => {
    const r = await runTool("fetch_wiki_page", { title: "genetic enginer" });
    assert.match(r, /^Wiki: Genetic engineer/);
    assert.match(r, /closest match/);
    assert.match(r, /monster infobox/);
  });
  test("section selection (with Solution -> Strategy alias)", async () => {
    const r = await runTool("fetch_wiki_page", { title: "Elbereth", section: "History" });
    assert.match(r, /== History ==/);
    const s = await runTool("fetch_wiki_page", { title: "Sokoban", section: "Solution" });
    assert.match(s, /== Strategy ==/);
    assert.match(s, /Sokoban Level 1a/);
  });
  test("Sokoban level page returns a voice-ready step list, optionally mirrored", async () => {
    const r = await runTool("fetch_wiki_page", { title: "Sokoban Level 1a", section: "Solution" });
    assert.match(r, /SOKOBAN SOLUTION for Sokoban Level 1a/);
    assert.match(r, /1\. Boulder A \(2 right, 1 down from you; .*\): push down 1\./);
    assert.match(r, /2\. Boulder B \(directly to your right; .*\): push right 4\./);
    assert.doesNotMatch(r, /\|\^\|/); // no ASCII map rows
    const m = await runTool("fetch_wiki_page", { title: "Sokoban Level 1a", flip: "left-right" });
    assert.match(m, /2\. Boulder B \(directly to your left; .*\): push left 4\./);
  });
});

describe("web_search (OpenAI Responses API)", { skip: !process.env.OPENAI_API_KEY && "no OPENAI_API_KEY" }, () => {
  test("returns concise answer with sources", { timeout: 40_000 }, async () => {
    const r = await runTool("web_search", { query: "NetHack 5.0.0 new monsters" });
    assert.ok(r.length > 50 && r.length < 2500, `len ${r.length}`);
    assert.match(r, /Sources: https?:\/\//);
  });
});

describe("HTTP endpoints", async () => {
  const up = await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false);
  const opts = { skip: !up && `server not running at ${BASE}` };
  test("POST /api/tools/:name runs a tool", opts, async () => {
    const res = await fetch(`${BASE}/api/tools/fetch_wiki_page`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: { title: "Elbereth", focus: "scare" } }) });
    const j = await res.json();
    assert.equal(res.status, 200);
    assert.equal(j.ok, true);
    assert.equal(typeof j.ms, "number");
  });
  test("unknown tool -> 404 with ok=false", opts, async () => {
    const res = await fetch(`${BASE}/api/tools/rm_rf`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).ok, false);
  });
  test("bad args -> ok=false with message", opts, async () => {
    const j = await (await fetch(`${BASE}/api/tools/read_nethack_source`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: {} }) })).json();
    assert.equal(j.ok, false);
    assert.match(j.result, /missing required argument 'path'/);
  });
  test("POST /api/session mints ephemeral secret (no API key leak)", { ...opts, timeout: 20_000 }, async () => {
    for (const model of ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"]) {
      const res = await fetch(`${BASE}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) });
      const j = await res.json();
      assert.equal(res.status, 200, JSON.stringify(j));
      assert.match(j.value, /^ek_/);
      assert.equal(j.model, model);
      assert.ok(!JSON.stringify(j).includes(process.env.OPENAI_API_KEY ?? "sk-never"));
    }
  });
});
