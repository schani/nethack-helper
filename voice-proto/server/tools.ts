import { spawn } from "node:child_process";
import { realpath, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { SRC_DIR, TIMEOUTS, WEB_SEARCH_MODEL, apiKey } from "./config.ts";

// ---------------------------------------------------------------------------
// Tool definitions sent to the Realtime session (session.tools).
// Shape: { type: "function", name, description, parameters: JSONSchema }
// ---------------------------------------------------------------------------

export const TOOL_DEFS = [
  {
    type: "function",
    name: "web_search",
    description:
      "Search the web for NetHack information and get a short synthesized answer with source URLs. " +
      "Good for general questions, community knowledge, strategy, and anything about NetHack 5.0.0 (released May 2026, " +
      "formerly the 3.7 development line) that may be newer than your training data. Biased toward nethackwiki.com. " +
      "Takes several seconds; prefer fetch_wiki_page when you already know the wiki page title.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query, e.g. 'NetHack 5.0 genetic engineer'." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "fetch_wiki_page",
    description:
      "Fetch a page from the NetHack wiki (nethackwiki.com) and return a short plain-text excerpt: infobox stats " +
      "(for monsters/items), the intro, and the most relevant sections. Fast (under a second). Use exact wiki-style " +
      "titles like 'Genetic engineer', 'Elbereth', 'Sokoban', 'Sokoban Level 1a', 'Excalibur'. If the title is not " +
      "found it returns close matches to retry with. Note: many wiki pages still describe 3.6 behavior; look for " +
      "version notes or verify against the 5.0 source.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Wiki page title." },
        section: {
          type: "string",
          description: "Optional section heading to return (e.g. 'Strategy', 'Solution', 'History').",
        },
        focus: {
          type: "string",
          description: "Optional keywords; the excerpt is narrowed to paragraphs mentioning them.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "search_nethack_source",
    description:
      "Ripgrep (regex, smart-case) over the official NetHack 5.0.0 source tree. Returns up to ~40 matching lines as " +
      "path:line: text. Key places: include/monsters.h and include/objects.h (monster/object definitions and stats), " +
      "src/*.c (game logic), dat/*.lua (special level layouts such as Sokoban soko*.lua, quest levels, Gehennom), " +
      "dat/*.txt (rumors, oracles, data), doc/fixes5-0-0.txt (THE changelog of what changed from 3.6 to 5.0 - search it " +
      "for 'what changed' questions), doc/Guidebook.txt (player manual). Use path_glob to narrow (space-separated globs, directories or files), e.g. 'doc/fixes5-0-0.txt', " +
      "'src/*.c', 'dat/soko*.lua', 'include/'. Results are spoilers.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex (ripgrep syntax). Falls back to literal match if invalid." },
        path_glob: {
          type: "string",
          description: "Optional space-separated globs or directory/file paths relative to the source root, e.g. 'src/*.c include/' or 'doc/fixes5-0-0.txt'.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_nethack_source",
    description:
      "Read a line range (max 120 lines) from a file in the NetHack 5.0.0 source tree, e.g. after search_nethack_source " +
      "found something. Paths are relative to the source root, e.g. 'src/mhitu.c', 'dat/soko1-1.lua', 'doc/fixes5-0-0.txt'.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the source root." },
        start_line: { type: "integer", description: "1-based first line." },
        end_line: { type: "integer", description: "1-based last line (inclusive). Defaults to start_line + 60." },
      },
      required: ["path", "start_line"],
      additionalProperties: false,
    },
  },
] as const;

export type ToolName = (typeof TOOL_DEFS)[number]["name"];
export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name) as ToolName[];

export class ToolError extends Error {}

function str(v: unknown, name: string, required = true): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError(`missing required argument '${name}'`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`argument '${name}' must be a string`);
  return v.trim();
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 20).trimEnd() + " …[truncated]";
}

function withTimeout(ms: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([t, outer]) : t;
}

// ---------------------------------------------------------------------------
// web_search: Responses API + hosted web_search tool
// ---------------------------------------------------------------------------

const WEB_SEARCH_INSTRUCTIONS = `You are a research helper for a NetHack voice assistant.
NetHack 5.0.0 was released in May 2026; it is the former 3.7 development line and differs from 3.6 in many ways.
Search the web (prefer nethackwiki.com, then the official nethack.org / GitHub NetHack repo, then reputable community sources).
Return a concise factual answer of at most 120 words, plain text, no markdown tables, no headings.
If sources describe 3.6 (or older) behavior and 5.0 may differ, say so explicitly. If you could not find a reliable answer, say so.
Do not include URLs in the body; they are attached separately.`;

export async function webSearch(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const query = str(args.query, "query")!;
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: withTimeout(TIMEOUTS.web_search, signal),
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: WEB_SEARCH_MODEL,
      instructions: WEB_SEARCH_INSTRUCTIONS,
      input: `NetHack question: ${query}`,
      tools: [{ type: "web_search", search_context_size: "low" }],
      reasoning: { effort: "none" },
      max_output_tokens: 1200,
      store: false,
    }),
  });
  const json: any = await res.json();
  if (!res.ok) throw new ToolError(`web search failed (${res.status}): ${json?.error?.message ?? "unknown error"}`);
  let text = "";
  const urls: string[] = [];
  for (const item of json.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type !== "output_text") continue;
      text += part.text;
      for (const a of part.annotations ?? []) {
        if (a.type === "url_citation" && a.url) {
          const u = a.url.replace(/[?&]utm_source=openai$/, "");
          if (!urls.includes(u)) urls.push(u);
        }
      }
    }
  }
  // Strip inline markdown citation links "([site](url))" — sources are listed separately.
  text = text.replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, "").replace(/\*\*/g, "").trim();
  if (!text) text = "No answer found.";
  return clip(text, 1500) + (urls.length ? `\nSources: ${urls.slice(0, 5).join(" , ")}` : "");
}

// ---------------------------------------------------------------------------
// fetch_wiki_page: nethackwiki.com MediaWiki API (TextExtracts + wikitext infobox)
// ---------------------------------------------------------------------------

const WIKI_API = "https://nethackwiki.com/api.php";
const WIKI_UA = "nethack-voice-proto/0.1 (voice assistant prototype)";
const WIKI_MAX = 3500;

async function wikiGet(params: Record<string, string>, signal: AbortSignal): Promise<any> {
  const url = `${WIKI_API}?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;
  const res = await fetch(url, { signal, headers: { "User-Agent": WIKI_UA } });
  if (!res.ok) throw new ToolError(`wiki request failed (${res.status})`);
  return res.json();
}

function cleanWikitext(s: string): string {
  let out = s;
  for (let i = 0; i < 3; i++) {
    out = out
      .replace(/\{\{(?:monsym|glyph|sym)\|([^{}|]*)[^{}]*\}\}/gi, "$1")
      .replace(/\{\{[^{}|]*\|([^{}|]*)\}\}/g, "$1")
      .replace(/\{\{([^{}|]*)\}\}/g, "$1");
  }
  return out
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, "$1")
    .replace(/'''?/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract the leading infobox template (e.g. {{monster ...}}) into "key: value" pairs. */
export function parseInfobox(wikitext: string): string {
  const start = wikitext.search(/\{\{\s*(monster|weapon|armor|armour|item|tool|ring|wand|amulet|potion|scroll|spellbook|food|gem|artifact|role|race|level|dungeon|trap|fountain|sink|altar|throne)\b/i);
  if (start < 0 || start > 400) return "";
  let depth = 0;
  let end = -1;
  for (let i = start; i < wikitext.length - 1; i++) {
    if (wikitext[i] === "{" && wikitext[i + 1] === "{") { depth++; i++; }
    else if (wikitext[i] === "}" && wikitext[i + 1] === "}") { depth--; i++; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) return "";
  const body = wikitext.slice(start + 2, end - 2);
  // split on top-level pipes
  const parts: string[] = [];
  let cur = "";
  let d = 0;
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === "{{" || two === "[[") { d++; cur += two; i++; continue; }
    if (two === "}}" || two === "]]") { d--; cur += two; i++; continue; }
    if (body[i] === "|" && d === 0) { parts.push(cur); cur = ""; continue; }
    cur += body[i];
  }
  parts.push(cur);
  const kind = parts.shift()!.trim();
  const skip = new Set(["reference", "attributes", "image", "tile"]);
  const kv = parts
    .map((p) => {
      const eq = p.indexOf("=");
      if (eq < 0) return null;
      const k = p.slice(0, eq).trim();
      const v = cleanWikitext(p.slice(eq + 1));
      return k && v && !skip.has(k.toLowerCase()) ? `${k}: ${v}` : null;
    })
    .filter(Boolean);
  return kv.length ? clip(`[${kind} infobox] ${kv.join("; ")}`, 900) : "";
}

interface Section { heading: string; level: number; text: string }

export function splitSections(extract: string): Section[] {
  const sections: Section[] = [{ heading: "(intro)", level: 1, text: "" }];
  for (const line of extract.split("\n")) {
    const m = /^(={2,6})\s*(.*?)\s*\1\s*$/.exec(line);
    if (m) sections.push({ heading: m[2], level: m[1].length, text: "" });
    else sections[sections.length - 1].text += line + "\n";
  }
  for (const s of sections) s.text = s.text.replace(/\n{3,}/g, "\n\n").trim();
  return sections;
}

function terms(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9']+/).filter((t) => t.length > 2);
}

async function resolveTitle(title: string, signal: AbortSignal): Promise<{ title: string | null; suggestions: string[] }> {
  const os: any = await wikiGet({ action: "opensearch", search: title, limit: "8", namespace: "0" }, signal);
  let suggestions: string[] = os?.[1] ?? [];
  if (!suggestions.length) {
    const sr: any = await wikiGet({ action: "query", list: "search", srsearch: title, srlimit: "8" }, signal);
    suggestions = (sr?.query?.search ?? []).map((r: any) => r.title);
  }
  const exact = suggestions.find((s) => s.toLowerCase() === title.toLowerCase());
  return { title: exact ?? null, suggestions };
}

export async function fetchWikiPage(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  let title = str(args.title, "title")!.replace(/_/g, " ");
  const section = str(args.section, "section", false);
  const focus = str(args.focus, "focus", false);
  const sig = withTimeout(TIMEOUTS.fetch_wiki_page, signal);

  const load = (t: string) =>
    Promise.all([
      wikiGet({ action: "query", prop: "extracts", explaintext: "1", exsectionformat: "wiki", redirects: "1", titles: t }, sig),
      wikiGet({ action: "parse", page: t, prop: "wikitext", section: "0", redirects: "1" }, sig).catch(() => null),
    ]);

  let [ex, wt] = await load(title);
  let page = ex?.query?.pages?.[0];
  let suggestions: string[] = [];
  if (!page || page.missing || !page.extract) {
    const r = await resolveTitle(title, sig);
    suggestions = r.suggestions;
    const pick = r.title ?? (suggestions.length === 1 ? suggestions[0] : null);
    if (!pick) {
      return suggestions.length
        ? `No wiki page titled "${title}". Close matches: ${suggestions.join("; ")}. Call fetch_wiki_page again with one of these.`
        : `No wiki page found for "${title}". Try web_search instead.`;
    }
    title = pick;
    [ex, wt] = await load(title);
    page = ex?.query?.pages?.[0];
    if (!page || page.missing || !page.extract) return `Wiki page "${title}" could not be loaded.`;
  }
  title = page.title;
  const url = `https://nethackwiki.com/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
  const sections = splitSections(page.extract);
  const infobox = wt?.parse?.wikitext ? parseInfobox(wt.parse.wikitext) : "";
  const headings = sections.slice(1).map((s) => s.heading);

  let body = "";
  if (/^#?REDIRECT/i.test(page.extract.trim()) || page.extract.trim().length < 40) {
    body = page.extract.trim();
  }
  const intro = sections[0].text;
  if (section) {
    const want = section.toLowerCase();
    const idx = sections.findIndex((s) => s.heading.toLowerCase() === want) >= 0
      ? sections.findIndex((s) => s.heading.toLowerCase() === want)
      : sections.findIndex((s) => s.heading.toLowerCase().includes(want));
    if (idx >= 0) {
      // include subsections
      const lvl = sections[idx].level;
      const parts = [sections[idx]];
      for (let i = idx + 1; i < sections.length && sections[i].level > lvl; i++) parts.push(sections[i]);
      body = parts.map((s) => `== ${s.heading} ==\n${s.text}`).join("\n");
    } else {
      body = `(No section matching "${section}".)\n${intro}`;
    }
  } else if (focus) {
    const ft = terms(focus);
    const paras: { sec: string; text: string; score: number; i: number }[] = [];
    let i = 0;
    for (const s of sections) {
      for (const p of s.text.split(/\n+/)) {
        if (!p.trim()) continue;
        const lower = (s.heading + " " + p).toLowerCase();
        const score = ft.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
        paras.push({ sec: s.heading, text: p.trim(), score, i: i++ });
      }
    }
    const picked = paras.filter((p) => p.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
    let budget = WIKI_MAX - 600;
    const chosen: typeof paras = [];
    for (const p of picked) {
      if (budget <= 0) break;
      chosen.push(p);
      budget -= p.text.length;
    }
    chosen.sort((a, b) => a.i - b.i);
    let lastSec = "";
    body = clip(intro, 500) + "\n";
    for (const p of chosen) {
      if (p.sec !== lastSec && p.sec !== "(intro)") body += `== ${p.sec} ==\n`;
      lastSec = p.sec;
      body += p.text + "\n";
    }
    if (!chosen.length) body += `(No paragraphs mention "${focus}".)`;
  } else {
    body = sections.map((s) => (s.heading === "(intro)" ? s.text : `== ${s.heading} ==\n${s.text}`)).join("\n");
  }

  const header = `Wiki: ${title} (${url})` + (suggestions.length > 1 ? `\nOther matches: ${suggestions.filter((s) => s !== title).slice(0, 6).join("; ")}` : "");
  const toc = headings.length ? `\nSections: ${headings.join(" | ")}` : "";
  const out = [header, infobox, clip(body.trim(), WIKI_MAX)].filter(Boolean).join("\n") + toc;
  return clip(out, WIKI_MAX + 1500);
}

// ---------------------------------------------------------------------------
// search_nethack_source / read_nethack_source: local NetHack 5.0.0 checkout
// ---------------------------------------------------------------------------

const MAX_MATCH_LINES = 40;
const MAX_SEARCH_CHARS = 4000;

function runRg(argv: string[], signal: AbortSignal): Promise<{ code: number | null; lines: string[]; stderr: string; truncated: boolean }> {
  return new Promise((resolveP, reject) => {
    const child = spawn("rg", argv, { cwd: SRC_DIR, signal });
    const lines: string[] = [];
    let buf = "";
    let stderr = "";
    let truncated = false;
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const parts = buf.split("\n");
      buf = parts.pop()!;
      for (const l of parts) {
        if (lines.length < MAX_MATCH_LINES) lines.push(l);
        else if (!truncated) { truncated = true; child.kill(); }
      }
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (e: any) => (e.name === "AbortError" ? reject(new ToolError("source search timed out")) : reject(e)));
    child.on("close", (code) => {
      if (buf && lines.length < MAX_MATCH_LINES) lines.push(buf);
      resolveP({ code, lines, stderr, truncated });
    });
  });
}

async function safePath(p: string): Promise<string> {
  const cleaned = p.replace(/^\.?\/+/, "").replace(/^nethack-src\//, "");
  if (isAbsolute(cleaned) || cleaned.split(/[\\/]/).includes("..")) throw new ToolError("path must be relative to the source root, without '..'");
  const root = await realpath(SRC_DIR);
  let full: string;
  try {
    full = await realpath(resolve(root, cleaned));
  } catch {
    throw new ToolError(`no such file: ${cleaned}`);
  }
  if (full !== root && !full.startsWith(root + sep)) throw new ToolError("path escapes the source root");
  if (relative(root, full).split(sep)[0] === ".git") throw new ToolError("path not allowed");
  return full;
}

export async function searchNethackSource(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const pattern = str(args.pattern, "pattern")!;
  const glob = str(args.path_glob, "path_glob", false);
  const sig = withTimeout(TIMEOUTS.search_nethack_source, signal);
  const base = ["--line-number", "--with-filename", "--no-heading", "--color", "never", "--smart-case", "--max-columns", "200", "--max-columns-preview", "--max-count", glob ? "30" : "8", "--sort", "path"];
  const target = ".";
  const globArgs: string[] = [];
  // path_glob may hold several space/comma separated entries; directories and plain files become globs too.
  for (let g of (glob ?? "").split(/[\s,]+/).filter(Boolean)) {
    g = g.replace(/^\.?\/+/, "").replace(/^nethack-src\//, "");
    if (g.split("/").includes("..")) throw new ToolError("path_glob must not contain '..'");
    if (!/[*?[{]/.test(g)) {
      const full = await safePath(g); // validates existence and confinement
      const rel = relative(await realpath(SRC_DIR), full);
      g = (await stat(full)).isDirectory() ? `${rel}/**` : rel;
    }
    globArgs.push("--glob", g);
  }
  let literal = false;
  let r = await runRg([...base, ...globArgs, "--regexp", pattern, "--", target], sig);
  if (r.code === 2 && /regex parse error|error parsing/i.test(r.stderr)) {
    literal = true;
    r = await runRg([...base, "--fixed-strings", ...globArgs, "--regexp", pattern, "--", target], sig);
  }
  if (r.code === 2 && !r.lines.length) throw new ToolError(`search error: ${clip(r.stderr.trim(), 200)}`);
  if (!r.lines.length) return `No matches for /${pattern}/${glob ? ` in ${glob}` : ""}.`;
  let out = r.lines.map((l) => l.replace(/^\.\//, "")).join("\n");
  out = clip(out, MAX_SEARCH_CHARS);
  const note = [
    literal ? "(pattern was invalid regex; searched literally)" : "",
    r.truncated ? `(showing first ${MAX_MATCH_LINES} matching lines; max ${glob ? 30 : 8} per file; narrow with path_glob or a more specific pattern)` : "",
  ].filter(Boolean).join(" ");
  return `NetHack 5.0.0 source matches (path:line: text):\n${out}${note ? "\n" + note : ""}`;
}

export async function readNethackSource(args: Record<string, unknown>): Promise<string> {
  const path = str(args.path, "path")!;
  const start = Math.max(1, Math.floor(Number(args.start_line ?? 1)) || 1);
  let end = args.end_line === undefined || args.end_line === null ? start + 60 : Math.floor(Number(args.end_line));
  if (!Number.isFinite(end) || end < start) end = start + 60;
  end = Math.min(end, start + 119);
  const full = await safePath(path);
  const st = await stat(full);
  if (!st.isFile()) throw new ToolError(`${path} is not a file`);
  if (st.size > 5_000_000) throw new ToolError("file too large");
  const lines = (await readFile(full, "utf8")).split("\n");
  if (start > lines.length) throw new ToolError(`${path} has only ${lines.length} lines`);
  const rel = relative(await realpath(SRC_DIR), full);
  const slice = lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l.length > 220 ? l.slice(0, 220) + "…" : l}`);
  return clip(`${rel} lines ${start}-${Math.min(end, lines.length)} of ${lines.length}:\n${slice.join("\n")}`, 6000);
}

// ---------------------------------------------------------------------------

export async function runTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  switch (name) {
    case "web_search": return webSearch(args, signal);
    case "fetch_wiki_page": return fetchWikiPage(args, signal);
    case "search_nethack_source": return searchNethackSource(args, signal);
    case "read_nethack_source": return readNethackSource(args);
    default: throw new ToolError(`unknown tool '${name}'`);
  }
}

export function srcAvailable(): Promise<boolean> {
  return stat(join(SRC_DIR, "src")).then(() => true, () => false);
}
