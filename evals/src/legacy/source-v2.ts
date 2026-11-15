// FROZEN copy of server/src/assistant/knowledge/source.ts at 9a15b53 (v2 tools: smart-case search, changelog hits as single lines),
// used only by eval variants with knowledge: 'v2' (ablations). Do not edit.
// search_nethack_source / read_nethack_source: ripgrep over a clean NetHack 5.0.0 checkout
// (.cache/nethack-src, see scripts/setup-nethack-src.sh -- not vendor/, which holds our patched build tree).
// Ported from voice-proto/server/tools.ts (keep behaviour in sync).
import { spawn } from "node:child_process";
import { realpath, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ToolError, clip, str, withTimeout } from "../../../server/src/assistant/knowledge/util.ts";

export function sourceAvailable(srcDir: string): Promise<boolean> {
  return stat(join(srcDir, "src")).then(() => true, () => false);
}

const MAX_MATCH_LINES = 40;
const MAX_SEARCH_CHARS = 4000;

function runRg(srcDir: string, argv: string[], signal: AbortSignal): Promise<{ code: number | null; lines: string[]; stderr: string; truncated: boolean }> {
  return new Promise((resolveP, reject) => {
    const child = spawn("rg", argv, { cwd: srcDir, signal });
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

async function safePath(srcDir: string, p: string): Promise<string> {
  const cleaned = p.replace(/^\.?\/+/, "").replace(/^nethack-src\//, "");
  if (isAbsolute(cleaned) || cleaned.split(/[\\/]/).includes("..")) throw new ToolError("path must be relative to the source root, without '..'");
  const root = await realpath(srcDir);
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

export async function searchNethackSource(srcDir: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const pattern = str(args.pattern, "pattern")!;
  const glob = str(args.path_glob, "path_glob", false);
  const sig = withTimeout(timeoutMs, signal);
  const base = ["--line-number", "--with-filename", "--no-heading", "--color", "never", "--smart-case", "--max-columns", "200", "--max-columns-preview", "--max-count", glob ? "30" : "8", "--sort", "path"];
  const target = ".";
  const globArgs: string[] = [];
  // path_glob may hold several space/comma separated entries; directories and plain files become globs too.
  // Be forgiving with path_glob: a wrong entry is skipped (and reported) instead of failing the whole call, and a
  // bare file name such as "fixes5-0-0.txt" matches that file anywhere in the tree. Saves a retry round trip.
  const skipped: string[] = [];
  for (let g of (glob ?? "").split(/[\s,]+/).filter(Boolean)) {
    g = g.replace(/^\.?\/+/, "").replace(/^nethack-src\//, "");
    if (g.split("/").includes("..")) throw new ToolError("path_glob must not contain '..'");
    if (!/[*?[{]/.test(g)) {
      let full: string;
      try {
        full = await safePath(srcDir, g); // validates existence and confinement
      } catch {
        if (!g.includes("/")) globArgs.push("--glob", `**/${g}`);
        else skipped.push(g);
        continue;
      }
      const rel = relative(await realpath(srcDir), full);
      g = (await stat(full)).isDirectory() ? `${rel}/**` : rel;
    }
    globArgs.push("--glob", g);
  }
  if (glob && !globArgs.length) throw new ToolError(`no such path(s): ${skipped.join(", ")}`);
  let literal = false;
  let r = await runRg(srcDir, [...base, ...globArgs, "--regexp", pattern, "--", target], sig);
  if (r.code === 2 && /regex parse error|error parsing/i.test(r.stderr)) {
    literal = true;
    r = await runRg(srcDir, [...base, "--fixed-strings", ...globArgs, "--regexp", pattern, "--", target], sig);
  }
  if (r.code === 2 && !r.lines.length) throw new ToolError(`search error: ${clip(r.stderr.trim(), 200)}`);
  if (!r.lines.length) return `No matches for /${pattern}/${glob ? ` in ${glob}` : ""}.${skipped.length ? ` (skipped nonexistent: ${skipped.join(", ")})` : ""}`;
  let out = r.lines.map((l) => l.replace(/^\.\//, "")).join("\n");
  out = clip(out, MAX_SEARCH_CHARS);
  const note = [
    literal ? "(pattern was invalid regex; searched literally)" : "",
    skipped.length ? `(skipped nonexistent path_glob entries: ${skipped.join(", ")})` : "",
    r.truncated ? `(showing first ${MAX_MATCH_LINES} matching lines; max ${glob ? 30 : 8} per file; narrow with path_glob or a more specific pattern)` : "",
  ].filter(Boolean).join(" ");
  return `NetHack 5.0.0 source matches (path:line: text):\n${out}${note ? "\n" + note : ""}`;
}

export async function readNethackSource(srcDir: string, args: Record<string, unknown>): Promise<string> {
  const path = str(args.path, "path")!;
  const start = Math.max(1, Math.floor(Number(args.start_line ?? 1)) || 1);
  let end = args.end_line === undefined || args.end_line === null ? start + 60 : Math.floor(Number(args.end_line));
  if (!Number.isFinite(end) || end < start) end = start + 60;
  end = Math.min(end, start + 119);
  const full = await safePath(srcDir, path);
  const st = await stat(full);
  if (!st.isFile()) throw new ToolError(`${path} is not a file`);
  if (st.size > 5_000_000) throw new ToolError("file too large");
  const lines = (await readFile(full, "utf8")).split("\n");
  if (start > lines.length) throw new ToolError(`${path} has only ${lines.length} lines`);
  const rel = relative(await realpath(srcDir), full);
  const slice = lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l.length > 220 ? l.slice(0, 220) + "…" : l}`);
  return clip(`${rel} lines ${start}-${Math.min(end, lines.length)} of ${lines.length}:\n${slice.join("\n")}`, 6000);
}

