// Knowledge services: NetHack wiki, web search, and the 5.0.0 source tree.
// Tool definitions and behaviour are ported from voice-proto/server/tools.ts.
import { ToolError, str } from "./util.ts";
import { nethackLookup } from "./lookup/index.ts";
import { webSearch } from "./web-search.ts";
import { fetchWikiPage } from "./wiki.ts";
import { readNethackSource, searchNethackSource, sourceAvailable } from "./source.ts";

export const KNOWLEDGE_TOOL_DEFS = [
  {
    type: "function",
    name: "web_search",
    description:
      "Search the live web and get a short synthesized answer with source URLs (takes 3-8 seconds). USE IT for: news and " +
      "anything time-sensitive (patch releases after 5.0.0, tournaments such as TNNT or Junethack, public servers, " +
      "events, devteam announcements), community opinions and advice (Reddit, rec.games.roguelike.nethack, forums), " +
      "variants, ports and interfaces, and as the fallback when fetch_wiki_page finds no page or the wiki/source do not " +
      "answer the question. For game mechanics of a known monster/item/topic, fetch_wiki_page and the source are faster " +
      "and more reliable.",
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
    name: "nethack_lookup",
    description:
      "Instant offline facts extracted from the NetHack 5.0 source (no preamble needed): monster stats (level, speed, AC, " +
      "magic resistance, attacks with damage, resistances, what the corpse gives, traits), objects (damage, AC, weight, material, " +
      "what it grants, whether its appearance is randomized), artifacts, a role's exact starting inventory and intrinsics by level, " +
      "race differences, the effect tables of fountains (quaff/dip), sinks, thrones and altars, and price identification (shop " +
      "price formulas and the base price groups). USE IT FIRST for any named " +
      "monster, item, artifact, role or race, and for 5.0 numbers; use fetch_wiki_page afterwards only for strategy or explanations. " +
      "A name that is not in the game comes back as \"not in NetHack 5.0\" with the closest real names. Lines after SPOILER-LEVEL " +
      "are spoilers: use them only if the player asked for spoilers or agreed.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name as the player would say it, e.g. 'genetic engineer', 'speed boots', 'Valkyrie', 'Excalibur', 'fountain', 'fizzy potion'." },
        kind: {
          type: "string",
          enum: ["monster", "object", "artifact", "appearance", "role", "race", "feature", "mechanic"],
          description: "Optional: restrict to one kind (e.g. 'role' for 'wizard' the role rather than the monster).",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "fetch_wiki_page",
    description:
      "Fetch a NetHack wiki (nethackwiki.com) page: infobox, intro and sections with tables as 'a | b | c' rows (effect and " +
      "price tables), the list of section headings, and the 5.0 changelog entries that mention the page's subject. Fast " +
      "(well under a second). Use it for strategy, explanations and game concepts (dungeon levels, Elbereth, Sokoban, price " +
      "identification, prayer...) and for monsters/items when nethack_lookup's data is not enough; use the wiki-style name, " +
      "e.g. 'Genetic engineer', 'Elbereth', 'Sokoban'. Misspelled or approximate titles are resolved automatically to the " +
      "closest page. Sokoban step-by-step solutions: title 'Sokoban Level 1a' or '1b' (first level you enter), then 2a/2b, " +
      "3a/3b, 4a/4b (top); these return a numbered, voice-ready push list. Many wiki pages still describe 3.6: where the " +
      "appended 5.0 changelog entries or nethack_lookup disagree with the page, they win.",
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
        flip: {
          type: "string",
          enum: ["none", "left-right", "up-down", "both"],
          description: "Sokoban level pages only: mirror the solution's directions to match a mirrored 5.0 level.",
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
      "Ripgrep (regex, case-insensitive unless case_sensitive is set) over the official NetHack 5.0.0 source tree. Use it to confirm version-specific " +
      "details and for 'what changed in 5.0' questions. Returns up to ~40 matching lines as " +
      "path:line: text. Key places: include/monsters.h and include/objects.h (monster/object definitions and stats), " +
      "src/*.c (game logic), dat/*.lua (special level layouts such as Sokoban soko*.lua, quest levels, Gehennom), " +
      "dat/*.txt (rumors, oracles, data), doc/fixes5-0-0.txt (THE changelog of what changed from 3.6 to 5.0 - search it " +
      "for 'what changed' questions; hits there come back as whole changelog entries), doc/Guidebook.txt (player manual). Use path_glob to narrow (space-separated globs, directories or files), e.g. 'doc/fixes5-0-0.txt', " +
      "'src/*.c', 'dat/soko*.lua', 'include/'. Results are spoilers. Note: '$NHDT-Date' stamps and file dates are " +
      "commit times, NOT release dates.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex (ripgrep syntax). Falls back to literal match if invalid." },
        path_glob: {
          type: "string",
          description: "Optional space-separated globs or directory/file paths relative to the source root, e.g. 'src/*.c include/' or 'doc/fixes5-0-0.txt'.",
        },
        case_sensitive: { type: "boolean", description: "Match case exactly (default false: case-insensitive)." },
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


export type KnowledgeToolName = (typeof KNOWLEDGE_TOOL_DEFS)[number]["name"];
export const KNOWLEDGE_TOOL_NAMES: readonly string[] = KNOWLEDGE_TOOL_DEFS.map((t) => t.name);

export interface KnowledgeOptions {
  /** clean NetHack 5.0.0 checkout used by the source tools */
  srcDir: string;
  apiKey: () => string;
  webSearchModel: string;
  timeouts: { web_search: number; fetch_wiki_page: number; search_nethack_source: number };
}

/** Wiki / web / source lookups.  Stateless apart from its configuration. */
export class KnowledgeService {
  private opts: KnowledgeOptions;

  constructor(opts: KnowledgeOptions) {
    this.opts = opts;
  }

  has(name: string): boolean {
    return KNOWLEDGE_TOOL_NAMES.includes(name);
  }

  sourceAvailable(): Promise<boolean> {
    return sourceAvailable(this.opts.srcDir);
  }

  async run(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const o = this.opts;
    switch (name) {
      case "web_search":
        return webSearch(args, { apiKey: o.apiKey, model: o.webSearchModel, timeoutMs: o.timeouts.web_search }, signal);
      case "nethack_lookup":
        return nethackLookup({ name: str(args.name, "name")!, kind: str(args.kind, "kind", false) }, { srcDir: (await this.sourceAvailable()) ? o.srcDir : undefined });
      case "fetch_wiki_page":
        return fetchWikiPage(args, o.timeouts.fetch_wiki_page, signal, { srcDir: (await this.sourceAvailable()) ? o.srcDir : undefined });
      case "search_nethack_source":
        if (!(await this.sourceAvailable())) throw new ToolError("the NetHack source is not installed on the server (run scripts/setup-nethack-src.sh)");
        return searchNethackSource(o.srcDir, args, o.timeouts.search_nethack_source, signal);
      case "read_nethack_source":
        if (!(await this.sourceAvailable())) throw new ToolError("the NetHack source is not installed on the server (run scripts/setup-nethack-src.sh)");
        return readNethackSource(o.srcDir, args);
      default:
        throw new ToolError(`unknown tool '${name}'`);
    }
  }
}
