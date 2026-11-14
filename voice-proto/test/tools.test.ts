// Unit + integration tests for the tool layer and HTTP endpoints. Real network calls (wiki, OpenAI) are made.
// Run: npm test   (server tests expect the server on http://localhost:8788 unless VOICE_PROTO_URL is set)
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseInfobox, splitSections, runTool, TOOL_DEFS, srcAvailable } from "../server/tools.ts";
import { buildSessionConfig } from "../server/session.ts";

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
  test("missing title returns close matches", async () => {
    const r = await runTool("fetch_wiki_page", { title: "Sokoban Level 1" });
    assert.match(r, /Sokoban Level 1a/);
  });
  test("section selection", async () => {
    const r = await runTool("fetch_wiki_page", { title: "Sokoban Level 1a", section: "Strategy" });
    assert.match(r, /== Strategy ==/);
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
