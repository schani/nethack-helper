// fetch_wiki_page: nethackwiki.com MediaWiki parse API (rendered page -> compact text with tables as pipe rows,
// wikitext infobox), plus the matching NetHack 5.0 changelog entries (the wiki mostly describes 3.6).
import { ToolError, clip, str, withTimeout } from './util.ts';
import { SOKOBAN_LEVEL_TITLE, formatSokobanSolution } from './sokoban.ts';
import { wikiHtmlToText } from './wiki-html.ts';
import { changelogFor } from './changelog.ts';

const WIKI_API = "https://nethackwiki.com/api.php";
const WIKI_UA = "nethack-web/0.3 (NetHack voice assistant)";
const WIKI_MAX = 5000;

export async function wikiGet(params: Record<string, string>, signal: AbortSignal): Promise<any> {
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

export interface Section { heading: string; level: number; text: string }

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

export function terms(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9']+/).filter((t) => t.length > 2);
}

export async function resolveTitle(title: string, signal: AbortSignal): Promise<{ title: string | null; suggestions: string[] }> {
  const os: any = await wikiGet({ action: "opensearch", search: title, limit: "8", namespace: "0" }, signal);
  let suggestions: string[] = os?.[1] ?? [];
  if (!suggestions.length) {
    // Full-text search, plus prefix searches on shortened titles in parallel to survive typos ("genetic enginer").
    const prefixes = [...new Set([title.slice(0, -2), title.slice(0, -4), title.split(/\s+/)[0]].filter((p) => p.trim().length >= 4 && p !== title))];
    const [sr, ...pre] = await Promise.all([
      wikiGet({ action: "query", list: "search", srsearch: title, srlimit: "8" }, signal),
      ...prefixes.map((p) => wikiGet({ action: "opensearch", search: p, limit: "8", namespace: "0" }, signal).catch(() => null)),
    ]);
    suggestions = (sr?.query?.search ?? []).map((r: any) => r.title);
    if (!suggestions.length) suggestions = pre.map((o: any) => o?.[1] ?? []).find((l: string[]) => l.length) ?? [];
  }
  const exact = suggestions.find((s) => s.toLowerCase() === title.toLowerCase());
  return { title: exact ?? null, suggestions };
}

export interface WikiOptions {
  /** NetHack 5.0 source tree: matching changelog entries are appended to the page (omitted when unset) */
  srcDir?: string;
}

interface LoadedPage { title: string; text: string; wikitext: string }

/** One parse API call: rendered HTML (templates expanded) -> compact text, plus the raw wikitext (infobox, Sokoban maps). */
async function loadPage(title: string, signal: AbortSignal): Promise<LoadedPage | null> {
  const j: any = await wikiGet(
    { action: "parse", page: title, prop: "text|wikitext", redirects: "1", disableeditsection: "1", disabletoc: "1", disablelimitreport: "1" },
    signal,
  );
  if (j?.error || !j?.parse) {
    if (j?.error && j.error.code !== "missingtitle" && j.error.code !== "invalidtitle") throw new ToolError(`wiki error: ${j.error.info ?? j.error.code}`);
    return null;
  }
  return { title: j.parse.title, text: wikiHtmlToText(j.parse.text ?? ""), wikitext: j.parse.wikitext ?? "" };
}

/** Sections left out of the default (whole page) view; they stay listed under "Sections:" and can be requested. */
const LOW_VALUE_SECTION = /^(?:glyphs?(?: and tiles)?|tiles?|history|etymology|origins?|trivia|see also|references|external links|notes and references|encyclop[a]?edia entry|(?:in )?(?:other )?variants?|in other games|gallery|.*\b(?:slash'?em|unnethack|dnethack|xnethack|evilhack|splicehack|fiqhack|nethack4|grunthack|sporkhack|hack'?em|variant)s?\b.*)$/i;

export async function fetchWikiPage(args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal, opts: WikiOptions = {}): Promise<string> {
  let title = str(args.title, "title")!.replace(/_/g, " ");
  const section = str(args.section, "section", false);
  const focus = str(args.focus, "focus", false);
  const flip = str(args.flip, "flip", false);
  const sig = withTimeout(timeoutMs, signal);

  let page = await loadPage(title, sig);
  let suggestions: string[] = [];
  let resolvedNote = "";
  if (!page || page.text.trim().length < 20) {
    // Resolve in the same call (saves the model a round trip): exact case-insensitive match, else the top search hit.
    const r = await resolveTitle(title, sig);
    suggestions = r.suggestions;
    const pick = r.title ?? suggestions[0] ?? null;
    if (!pick) return `No wiki page found for "${title}". Use web_search instead.`;
    if (!r.title) resolvedNote = `(No page titled "${title}"; showing the closest match "${pick}". If that is not what was meant, use one of the other matches or web_search.)`;
    const asked = title;
    page = await loadPage(pick, sig);
    if (!page || !page.text.trim()) return `Wiki page "${asked}" could not be loaded. Use web_search instead.`;
  }
  title = page.title;
  const url = `https://nethackwiki.com/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
  const sections = splitSections(page.text);
  const infobox = page.wikitext ? parseInfobox(page.wikitext) : "";
  const headings = sections.slice(1).map((s) => s.heading);
  const header = `Wiki: ${title} (${url})` + (resolvedNote ? `\n${resolvedNote}` : "") +
    (suggestions.length > 1 ? `\nOther matches: ${suggestions.filter((s) => s !== title).slice(0, 6).join("; ")}` : "");
  const toc = headings.length ? `\nSections: ${headings.join(" | ")}` : "";
  const intro = sections[0].text;

  // Sokoban level pages: return the solution as a voice-ready step list instead of ASCII maps.
  const wantsSolution = !section || /strateg|solution|solv|step|walkthrough/i.test(section);
  if (SOKOBAN_LEVEL_TITLE.test(title) && wantsSolution && page.wikitext) {
    const solution = formatSokobanSolution(page.wikitext, title, flip);
    if (solution) return clip([header, clip(intro.split(/\n{2,}/)[0], 400), solution].join("\n"), 8000);
  }

  let body = "";
  if (page.text.trim().length < 40) body = page.text.trim();
  if (/^sokoban$/i.test(title)) {
    body += "(Step-by-step solutions are on the level pages: fetch 'Sokoban Level 1a' or 'Sokoban Level 1b' for the first level, then 2a/2b, 3a/3b, 4a/4b.)\n";
  }
  const render = (s: Section) => (s.heading === "(intro)" ? s.text : `== ${s.heading} ==\n${s.text}`);

  if (section) {
    const want = section.toLowerCase();
    const aliases = [want, ...(/solution|solv|walkthrough/.test(want) ? ["strategy"] : []), ...(/strateg/.test(want) ? ["solution"] : [])];
    const exact = sections.findIndex((s) => aliases.includes(s.heading.toLowerCase()));
    const idx = exact >= 0 ? exact : sections.findIndex((s) => aliases.some((a) => s.heading.toLowerCase().includes(a)));
    if (idx >= 0) {
      // include subsections
      const lvl = sections[idx].level;
      const parts = [sections[idx]];
      for (let i = idx + 1; i < sections.length && sections[i].level > lvl; i++) parts.push(sections[i]);
      body += parts.map(render).join("\n\n");
    } else {
      body += `(No section matching "${section}".)\n${intro}`;
    }
  } else if (focus) {
    const ft = terms(focus).filter((t) => !["nethack", "the", "and", "what", "changed", "change", "changes"].includes(t));
    // blocks: paragraphs, whole tables and whole lists (separated by blank lines)
    const paras: { sec: string; text: string; score: number; i: number }[] = [];
    let i = 0;
    for (const s of sections.slice(1)) { // the intro is always included below
      for (const p of s.text.split(/\n{2,}/)) {
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
    body += clip(intro, 500) + "\n";
    for (const p of chosen) {
      if (p.sec !== lastSec && p.sec !== "(intro)") body += `== ${p.sec} ==\n`;
      lastSec = p.sec;
      body += p.text + "\n\n";
    }
    if (!chosen.length) body += `(No paragraphs mention "${focus}".)`;
  } else {
    // whole page: skip low-value sections (and their subsections)
    const kept: Section[] = [];
    let skipBelow = 0;
    for (const s of sections) {
      if (skipBelow && s.level > skipBelow) continue;
      skipBelow = 0;
      if (s.heading !== "(intro)" && LOW_VALUE_SECTION.test(s.heading)) {
        skipBelow = s.level;
        continue;
      }
      kept.push(s);
    }
    body += kept.map(render).join("\n\n");
  }

  const changes = opts.srcDir && !SOKOBAN_LEVEL_TITLE.test(title) ? await changelogFor(opts.srcDir, title).catch(() => "") : "";
  const out = [header, infobox, clip(body.trim().replace(/\n{3,}/g, "\n\n"), WIKI_MAX)].filter(Boolean).join("\n") + toc;
  return clip(out, WIKI_MAX + 1500) + (changes ? `\n\n${changes}` : "");
}
