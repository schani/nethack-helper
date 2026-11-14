// Knowledge services: NetHack wiki, web search, and the 5.0.0 source tree.
// Tool definitions and behaviour are ported from voice-proto/server/tools.ts.
import { ToolError } from "./util.ts";
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
    name: "fetch_wiki_page",
    description:
      "Fetch a NetHack wiki (nethackwiki.com) page: infobox stats (monsters/items), intro and sections, plus the list of " +
      "section headings. Fast (well under a second). BEST FIRST CALL for any named monster, item, artifact, role, " +
      "spell, dungeon level or game concept: use the wiki-style name, e.g. 'Genetic engineer', 'Displacer beast', " +
      "'Elbereth', 'Excalibur', 'Sokoban'. Misspelled or approximate titles are resolved automatically to the closest " +
      "page. Sokoban step-by-step solutions: title 'Sokoban Level 1a' or '1b' (first level you enter), then 2a/2b, " +
      "3a/3b, 4a/4b (top); these return a numbered, voice-ready push list. Many wiki pages still describe 3.6; the page " +
      "often has 3.7/5.0 notes, otherwise confirm version-specific details in the source.",
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
      "Ripgrep (regex, smart-case) over the official NetHack 5.0.0 source tree. Use it to confirm version-specific " +
      "details and for 'what changed in 5.0' questions. Returns up to ~40 matching lines as " +
      "path:line: text. Key places: include/monsters.h and include/objects.h (monster/object definitions and stats), " +
      "src/*.c (game logic), dat/*.lua (special level layouts such as Sokoban soko*.lua, quest levels, Gehennom), " +
      "dat/*.txt (rumors, oracles, data), doc/fixes5-0-0.txt (THE changelog of what changed from 3.6 to 5.0 - search it " +
      "for 'what changed' questions), doc/Guidebook.txt (player manual). Use path_glob to narrow (space-separated globs, directories or files), e.g. 'doc/fixes5-0-0.txt', " +
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
      case "fetch_wiki_page":
        return fetchWikiPage(args, o.timeouts.fetch_wiki_page, signal);
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
