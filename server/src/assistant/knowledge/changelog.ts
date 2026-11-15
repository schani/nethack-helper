// The NetHack 5.0 changelog (doc/fixes5-0-0.txt in the 5.0.0 source tree) as whole entries.
// An entry starts in column 0; its wrapped continuation lines start with whitespace.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const CHANGELOG_PATH = "doc/fixes5-0-0.txt";

export interface ChangelogEntry {
  /** 1-based line of the entry's first line */
  line: number;
  /** last line of the entry */
  end: number;
  /** section heading, e.g. "General New Features" */
  section: string;
  /** the entry with continuation lines joined */
  text: string;
}

/** Split a fixes*.txt changelog into entries (continuation lines joined, section headings tracked). */
export function parseChangelog(text: string): ChangelogEntry[] {
  const lines = text.split("\n");
  const out: ChangelogEntry[] = [];
  let section = "";
  let cur: ChangelogEntry | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // a heading is a line followed by a ----- underline
    if (/^-{5,}\s*$/.test(lines[i + 1] ?? "") && l.trim() && !/^\s/.test(l)) {
      section = l.trim();
      cur = null;
      i++;
      continue;
    }
    if (!l.trim() || /^-{5,}\s*$/.test(l) || /^\$NHDT|^NHDT-/.test(l)) {
      cur = null;
      continue;
    }
    if (/^\s/.test(l) && cur) {
      cur.text += " " + l.trim();
      cur.end = i + 1;
      continue;
    }
    cur = { line: i + 1, end: i + 1, section, text: l.trim() };
    out.push(cur);
  }
  return out;
}

const cache = new Map<string, Promise<ChangelogEntry[]>>();

export function loadChangelog(srcDir: string, rel = CHANGELOG_PATH): Promise<ChangelogEntry[]> {
  const file = join(srcDir, rel);
  let p = cache.get(file);
  if (!p) {
    p = readFile(file, "utf8").then(parseChangelog, () => []);
    cache.set(file, p);
  }
  return p;
}

/** The whole entry containing a line (for expanding search hits), or undefined. */
export function entryAt(entries: ChangelogEntry[], line: number): ChangelogEntry | undefined {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = entries[mid];
    if (line < e.line) hi = mid - 1;
    else if (line > e.end) lo = mid + 1;
    else return e;
  }
  return undefined;
}

/** Regex for a subject such as "Fountain" or "genetic engineer": whole words, optional plural, any case. */
export function subjectPattern(subject: string): RegExp | null {
  const words = subject
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .split(/[^a-z0-9']+/)
    .filter(Boolean);
  if (!words.length || words.join(" ").length < 3) return null;
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = words.map((w, i) => (i === words.length - 1 ? `${esc(w.replace(/(?:es|s)$/, ""))}(?:s|es)?` : esc(w)));
  return new RegExp(`\\b${parts.join("[\\s-]+")}\\b`, "i");
}

// player-relevant sections first; the 5.0.0-x sections are changes made during 3.7 development (still new vs 3.6)
const SECTION_RANK: [RegExp, number][] = [
  [/^General New Features/i, 0],
  [/^General Fixes and Modified Features/i, 1],
  [/^Fixes to .*General Problems/i, 2],
];
const rank = (s: string) => SECTION_RANK.find(([re]) => re.test(s))?.[1] ?? 9;

/**
 * Changelog entries mentioning a subject, as compact text for appending to a wiki result ("" if none).
 * Platform/interface and code-cleanup sections are skipped.
 */
export async function changelogFor(srcDir: string, subject: string, opts: { max?: number; maxChars?: number; tooMany?: number } = {}): Promise<string> {
  const re = subjectPattern(subject);
  if (!re) return "";
  const entries = (await loadChangelog(srcDir)).filter((e) => rank(e.section) < 9 && re.test(e.text));
  if (!entries.length) return "";
  if (entries.length > (opts.tooMany ?? 60))
    return `NetHack 5.0 changelog: ${entries.length} entries mention "${subject}" (too many to list; search_nethack_source in doc/fixes5-0-0.txt with a more specific pattern).`;
  const max = opts.max ?? 12;
  const maxChars = opts.maxChars ?? 1800;
  const picked = [...entries].sort((a, b) => rank(a.section) - rank(b.section) || a.line - b.line);
  const lines: string[] = [];
  let used = 0;
  for (const e of picked) {
    if (lines.length >= max) break;
    const l = `- ${e.text}${rank(e.section) === 0 ? " [new feature]" : ""}`;
    if (used + l.length > maxChars && lines.length) break;
    lines.push(l);
    used += l.length;
  }
  const more = entries.length - lines.length;
  return (
    `NetHack 5.0 changelog (changes since 3.6, newer than the wiki where they differ; a "fix" entry describes a bug that no longer happens) - ${entries.length} entr${entries.length === 1 ? "y" : "ies"} mentioning "${subject}"` +
    `${more > 0 ? `, ${lines.length} shown (search_nethack_source in doc/fixes5-0-0.txt for the rest)` : ""}:\n${lines.join("\n")}`
  );
}
