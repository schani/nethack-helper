// Wiki page HTML (MediaWiki parse API, templates already expanded) -> compact plain text for a voice model:
// paragraphs, "== Heading ==" lines (the format splitSections() reads), lists as "- item" lines, and tables as
// "a | b | c" pipe rows (row spans filled in). Page chrome (infobox/navigation boxes, references, edit links,
// language bars, "needs update" notices, encyclopedia quotes, collapsed old-version tables) is dropped.

interface El { tag: string; attrs: Record<string, string>; children: Node[] }
type Node = El | string;

const VOID = new Set(["br", "img", "hr", "meta", "link", "input", "wbr", "source", "col", "area"]);
const BLOCK = new Set(["p", "div", "ul", "ol", "dl", "table", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "center", "figure", "section"]);
/** class names whose element (and content) is dropped */
const DROP_CLASS = /\b(?:languages|thumb|todo|metadata|noprint|mw-references-wrap|references|reference|navbox|NavFrame|toc|mw-editsection|nhencyclopedia|mw-collapsed|mw-cite-backlink|printfooter|catlinks)\b/;
const DROP_TAG = new Set(["style", "script", "figure", "img", "noscript"]);

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", para: "¶", times: "×", minus: "-", ndash: "–", mdash: "—",
  hellip: "…", le: "≤", ge: "≥", frasl: "/", deg: "°", plusmn: "±", middot: "·", bull: "•", rarr: "→", larr: "←", laquo: "«", raquo: "»",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}

/** Tolerant HTML -> tree parser (MediaWiki output is well-formed; stray end tags are ignored). */
export function parseHtml(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [] };
  const stack: El[] = [root];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+|<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) top.children.push(m[5]);
    else if (m[1]) {
      const tag = m[1].toLowerCase();
      const i = stack.map((e) => e.tag).lastIndexOf(tag);
      if (i > 0) stack.length = i;
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const attrs: Record<string, string> = {};
      for (const a of (m[3] ?? "").matchAll(/([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
      const el: El = { tag, attrs, children: [] };
      top.children.push(el);
      if (!m[4] && !VOID.has(tag)) stack.push(el);
    }
  }
  return root;
}

const isEl = (n: Node): n is El => typeof n !== "string";
const cls = (e: El) => e.attrs.class ?? "";

function dropped(e: El): boolean {
  if (DROP_TAG.has(e.tag) || (e.tag === "sup" && /reference/.test(cls(e)))) return true;
  if (DROP_CLASS.test(cls(e))) return true;
  if (/display:\s*none/.test(e.attrs.style ?? "")) return true;
  return false;
}

/** inline text of a subtree (whitespace collapsed later) */
function inline(n: Node, out: string[]): void {
  if (!isEl(n)) {
    out.push(decodeEntities(n));
    return;
  }
  if (n.tag === "span" && /mwe-math-element/.test(cls(n))) {
    // math: the fallback image's alt text holds the TeX source
    const img = find(n, (x) => x.tag === "img");
    out.push((img?.attrs.alt ?? "").replace(/^\{\\displaystyle\s*/, "").replace(/\}$/, ""));
    return;
  }
  if (dropped(n)) return;
  if (n.tag === "br") return void out.push(" / ");
  if (n.tag === "li") out.push(" ");
  if (n.tag === "tr") out.push("; ");
  if (n.tag === "td" || n.tag === "th") out.push(" ");
  for (const c of n.children) inline(c, out);
  if (n.tag === "li" || n.tag === "p" || n.tag === "dd" || n.tag === "dt") out.push(" ");
}

function find(n: El, pred: (e: El) => boolean): El | null {
  for (const c of n.children) {
    if (!isEl(c)) continue;
    if (pred(c)) return c;
    const r = find(c, pred);
    if (r) return r;
  }
  return null;
}

const squash = (s: string) =>
  s
    .replace(/[   ]/g, " ")
    .replace(/⁄/g, "/")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?)])/g, "$1")
    .replace(/(\/\s*){2,}/g, "/ ")
    .replace(/^[\s/;]+|[\s/;]+$/g, "")
    .trim();

const inlineText = (n: Node) => {
  const out: string[] = [];
  inline(n, out);
  return squash(out.join(""));
};

/** table -> pipe rows; rowspans are carried down so every row is self-contained */
function renderTable(t: El): string {
  const rows: El[] = [];
  const collect = (e: El) => {
    for (const c of e.children) {
      if (!isEl(c) || dropped(c)) continue;
      if (c.tag === "tr") rows.push(c);
      else if (c.tag === "tbody" || c.tag === "thead" || c.tag === "tfoot") collect(c);
    }
  };
  collect(t);
  const caption = t.children.find((c): c is El => isEl(c) && c.tag === "caption");
  const lines: string[] = caption ? [`(table: ${inlineText(caption)})`] : [];
  const carry: { text: string; left: number }[] = []; // per column
  for (const tr of rows) {
    const cells: string[] = [];
    const tds = tr.children.filter((c): c is El => isEl(c) && (c.tag === "td" || c.tag === "th") && !dropped(c));
    let col = 0;
    const takeCarry = () => {
      while (carry[col]?.left > 0) {
        cells.push(carry[col].text);
        carry[col].left--;
        col++;
      }
    };
    for (const td of tds) {
      takeCarry();
      const text = inlineText(td);
      const span = Math.max(1, Math.min(50, Number(td.attrs.colspan) || 1));
      const rs = Math.max(1, Math.min(100, Number(td.attrs.rowspan) || 1));
      for (let k = 0; k < span; k++) {
        if (k === 0) cells.push(text);
        if (rs > 1) carry[col] = { text, left: rs - 1 };
        col++;
      }
    }
    takeCarry();
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    if (cells.some(Boolean)) lines.push(cells.join(" | "));
  }
  return lines.join("\n");
}

function renderList(e: El, depth: number, out: string[]): void {
  let i = 0;
  for (const c of e.children) {
    if (!isEl(c) || dropped(c)) continue;
    if (c.tag === "li" || c.tag === "dd" || c.tag === "dt") {
      const nested = c.children.filter((x): x is El => isEl(x) && (x.tag === "ul" || x.tag === "ol" || x.tag === "dl"));
      const own: El = { ...c, children: c.children.filter((x) => !nested.includes(x as El)) };
      const text = inlineText(own);
      const bullet = e.tag === "ol" ? `${++i}.` : c.tag === "dt" ? "" : "-";
      if (text) out.push(`${"  ".repeat(depth)}${bullet ? bullet + " " : ""}${text}${c.tag === "dt" ? ":" : ""}`);
      for (const n of nested) renderList(n, depth + 1, out);
    }
  }
}

/** Render block-level content; blocks are separated by blank lines. */
function blocks(n: El, out: string[]): void {
  let para: Node[] = [];
  const flush = () => {
    if (!para.length) return;
    const t = inlineText({ tag: "p", attrs: {}, children: para });
    if (t) out.push(t);
    para = [];
  };
  for (const c of n.children) {
    if (!isEl(c)) {
      para.push(c);
      continue;
    }
    if (dropped(c)) continue;
    const h = /^h([1-6])$/.exec(c.tag);
    if (h) {
      flush();
      const eq = "=".repeat(Math.max(2, Number(h[1])));
      out.push(`${eq} ${inlineText(c)} ${eq}`);
    } else if (c.tag === "table") {
      flush();
      const t = renderTable(c);
      if (t) out.push(t);
    } else if (c.tag === "ul" || c.tag === "ol" || c.tag === "dl") {
      flush();
      const lines: string[] = [];
      renderList(c, 0, lines);
      if (lines.length) out.push(lines.join("\n"));
    } else if (c.tag === "pre") {
      flush();
      const raw: string[] = [];
      const text = (x: Node): void => void (isEl(x) ? (x.tag === "br" ? raw.push("\n") : x.children.forEach(text)) : raw.push(decodeEntities(x)));
      text(c);
      const t = raw.join("").replace(/\s+$/gm, "").replace(/^\n+|\n+$/g, "");
      if (t) out.push(t);
    } else if (c.tag === "div" && /\bupcoming\b/.test(cls(c))) {
      // "The following information pertains to an upcoming version (3.7.0) ..." boxes: keep the content, tagged
      flush();
      const inner: string[] = [];
      blocks({ ...c, children: c.children.filter((x) => !(isEl(x) && x.tag === "p" && /pertains to an upcoming version/.test(inlineText(x)))) }, inner);
      if (inner.length) out.push(`[3.7/5.0 note] ${inner.join("\n\n")}`);
    } else if (BLOCK.has(c.tag)) {
      flush();
      blocks(c, out);
    } else {
      para.push(c);
    }
  }
  flush();
}

/** Page HTML -> compact text with "== Heading ==" section lines. */
export function wikiHtmlToText(html: string): string {
  const out: string[] = [];
  blocks(parseHtml(html), out);
  return out
    // notices and hatnotes (": ''For the monster in other variants, see ...''")
    .filter((b) => !/^This (?:page|article) may need to be updated|^- (?:For |This (?:article|page) is about|See also:?|Main article:)/.test(b))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
