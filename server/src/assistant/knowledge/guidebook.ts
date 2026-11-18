// The NetHack 5.0 Guidebook (doc/Guidebook.txt in the source tree) as a searchable tool for the thinker:
// a section by name or number, a command's entry (#force, ^D, kick), or the best-matching paragraphs for keywords.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ToolError, clip, str } from "./util.ts";

export const GUIDEBOOK_TOOL_DEF = {
  type: "function",
  name: "read_guidebook",
  description:
    "The official NetHack 5.0 Guidebook (player manual): commands and their default keys, what the screen shows, and how rooms, " +
    "doors, traps, shops, monsters, pets, objects, containers, curses, armor, food, prayer conduct, options and key bindings work. " +
    "Instant. topic: a section name or number ('Containers', 'Doorways', 'Traps', '7.12.1'), a command ('#force', 'kick', '^D', " +
    "'#pray', 'apply'), or keywords ('locked chest', 'remove cursed armor'); 'contents' lists all sections. Default keys there " +
    "can differ from this game's bindings: use get_keybindings for the actual key.",
  parameters: {
    type: "object",
    properties: {
      topic: { type: "string", description: "Section name or number, command, or keywords." },
    },
    required: ["topic"],
    additionalProperties: false,
  },
} as const;

interface Section {
  num: string;
  title: string;
  /** body text without the heading line */
  text: string;
}
interface Entry {
  /** the key or #command as printed, e.g. "^D", "#force", "a" */
  head: string;
  text: string;
  section: string;
}
interface Para {
  section: string;
  text: string;
}
interface Book {
  sections: Section[];
  entries: Entry[];
  paras: Para[];
}

const cache = new Map<string, Promise<Book>>();

const PAGE_FURNITURE = [/^\s+NetHack 5\.0\.0\s+\w+ \d+, \d{4}\s*$/, /^\s+NetHack Guidebook\s+\d+\s*$/];

export function parseGuidebook(raw: string): Book {
  const lines = raw.split("\n").filter((l) => !PAGE_FURNITURE.some((re) => re.test(l)));
  const sections: Section[] = [];
  let cur: { num: string; title: string; body: string[] } | null = null;
  const flush = () => {
    if (cur) sections.push({ num: cur.num, title: cur.title, text: tidy(cur.body.join("\n")) });
  };
  for (const l of lines) {
    const m = /^ {5}(\d+(?:\.\d+)*)\.\s{1,3}(\S.*)$/.exec(l);
    // section headings are short; numbered list items inside the text are longer sentences
    if (m && m[2].length < 70 && !/[.,;]$/.test(m[2])) {
      flush();
      cur = { num: m[1], title: m[2].trim(), body: [] };
    } else if (cur) cur.body.push(l);
  }
  flush();
  // command entries: "     ^D   Kick something..." or "     #force" followed by lines indented 10
  const entries: Entry[] = [];
  for (const s of sections.filter((x) => /^(4|9\.10)$/.test(x.num) || /^Commands/.test(x.title))) {
    let e: { head: string; body: string[] } | null = null;
    const done = () => {
      if (e) entries.push({ head: e.head, text: tidy(e.body.join("\n")), section: `${s.num} ${s.title}` });
      e = null;
    };
    for (const l of s.text.split("\n")) {
      const m = /^(#\w+|\S{1,4})(?:\s{2,}(\S.*))?$/.exec(l);
      if (m && !/^\s/.test(l) && (m[1].startsWith("#") || m[2])) {
        done();
        e = { head: m[1], body: [l] };
      } else if (e && (/^ {5}\S/.test(l) || l.trim() === "")) e.body.push(l);
      else done();
    }
    done();
  }
  const paras: Para[] = [];
  for (const s of sections) {
    for (const p of s.text.split(/\n\s*\n/)) {
      const t = p.replace(/\s+/g, " ").trim();
      if (t.length > 40) paras.push({ section: `${s.num} ${s.title}`, text: t });
    }
  }
  return { sections, entries, paras };
}

/** dedent the 5-space page margin and drop runs of blank lines */
function tidy(s: string): string {
  return s
    .split("\n")
    .map((l) => l.replace(/^ {5}/, "").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function book(srcDir: string): Promise<Book> {
  let b = cache.get(srcDir);
  if (!b) {
    b = readFile(path.join(srcDir, "doc/Guidebook.txt"), "utf8").then(parseGuidebook);
    cache.set(srcDir, b);
    b.catch(() => cache.delete(srcDir));
  }
  return b;
}

const STOP = new Set("a an the of to in on and or for with how do i you your my is it can what when this that".split(" "));
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9#^ ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));

/** simple English stemming so "locked" matches "lock", "chests" matches "chest" */
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "") || w;

const KEY_ALIASES: Record<string, string> = { kick: "^D", "ctrl d": "^D", "control d": "^D", pray: "#pray", force: "#force", loot: "#loot" };

const MAX = 6000;

export async function readGuidebook(srcDir: string, args: Record<string, unknown>): Promise<string> {
  const topic = str(args.topic, "topic")!;
  let b: Book;
  try {
    b = await book(srcDir);
  } catch {
    throw new ToolError("the Guidebook is not installed on the server");
  }
  const q = topic.trim().toLowerCase();
  if (q === "contents" || q === "toc" || q === "index") return `Guidebook sections:\n${b.sections.map((s) => `${s.num} ${s.title}`).join("\n")}`;

  // 1. a section by number or (nearly) exact title
  const byNum = b.sections.find((s) => s.num === q.replace(/\.$/, ""));
  const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)|[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  const byTitle = byNum ?? b.sections.find((s) => norm(s.title) === norm(q)) ?? b.sections.find((s) => norm(q).length > 3 && norm(s.title).startsWith(norm(q)));
  if (byTitle) {
    const subs = b.sections.filter((s) => s.num.startsWith(`${byTitle.num}.`)).map((s) => `${s.num} ${s.title}`);
    return clip(`Guidebook ${byTitle.num} ${byTitle.title}\n\n${byTitle.text}${subs.length ? `\n\nSubsections: ${subs.join("; ")}` : ""}`, MAX);
  }

  // 2. a command entry (#force, ^D, kick)
  const cmd = KEY_ALIASES[q] ?? (q.startsWith("#") || /^\^.$/.test(q) ? topic.trim() : `#${q}`);
  const entry = b.entries.filter((e) => e.head.toLowerCase() === cmd.toLowerCase());
  const out: string[] = [];
  if (entry.length) out.push(...entry.map((e) => `Command ${e.head} (Guidebook ${e.section}):\n${e.text}`));

  // 3. keyword search over paragraphs (always added, so a command also gets the text that explains its use)
  const terms = [...new Set(words(topic).map(stem))];
  if (terms.length) {
    const scored = b.paras
      .filter((p) => !entry.some((e) => p.text.startsWith(e.head)))
      .map((p) => {
        const ws = words(p.text).map(stem);
        const hits = terms.filter((t) => ws.includes(t)).length;
        const freq = terms.reduce((a, t) => a + ws.filter((w) => w === t).length, 0);
        return { p, score: hits * 10 + Math.min(freq, 10) - (/^9\./.test(p.section) ? 5 : 0) };
      })
      .filter((x) => x.score >= Math.min(terms.length, 2) * 10 || (terms.length === 1 && x.score >= 10))
      .sort((a, b) => b.score - a.score)
      .slice(0, entry.length ? 3 : 5);
    for (const { p } of scored) out.push(`[${p.section}] ${p.text}`);
  }
  if (!out.length) return `Nothing in the Guidebook matches "${topic}". Try a section name ('contents' lists them) or fewer keywords.`;
  return clip(out.join("\n\n"), MAX);
}
