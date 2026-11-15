// FROZEN tool descriptions of the v2 knowledge tools (server/src/assistant/knowledge/index.ts at 9a15b53), used only by
// eval variants with knowledge: 'v2' (ablations). Do not edit.
export const V2_TOOL_DESCRIPTIONS: Record<string, string> = {
  fetch_wiki_page:
    "Fetch a NetHack wiki (nethackwiki.com) page: infobox stats (monsters/items), intro and sections, plus the list of " +
      "section headings. Fast (well under a second). BEST FIRST CALL for any named monster, item, artifact, role, " +
      "spell, dungeon level or game concept: use the wiki-style name, e.g. 'Genetic engineer', 'Displacer beast', " +
      "'Elbereth', 'Excalibur', 'Sokoban'. Misspelled or approximate titles are resolved automatically to the closest " +
      "page. Sokoban step-by-step solutions: title 'Sokoban Level 1a' or '1b' (first level you enter), then 2a/2b, " +
      "3a/3b, 4a/4b (top); these return a numbered, voice-ready push list. Many wiki pages still describe 3.6; the page " +
      "often has 3.7/5.0 notes, otherwise confirm version-specific details in the source.",
  search_nethack_source:
    "Ripgrep (regex, smart-case) over the official NetHack 5.0.0 source tree. Use it to confirm version-specific " +
      "details and for 'what changed in 5.0' questions. Returns up to ~40 matching lines as " +
      "path:line: text. Key places: include/monsters.h and include/objects.h (monster/object definitions and stats), " +
      "src/*.c (game logic), dat/*.lua (special level layouts such as Sokoban soko*.lua, quest levels, Gehennom), " +
      "dat/*.txt (rumors, oracles, data), doc/fixes5-0-0.txt (THE changelog of what changed from 3.6 to 5.0 - search it " +
      "for 'what changed' questions), doc/Guidebook.txt (player manual). Use path_glob to narrow (space-separated globs, directories or files), e.g. 'doc/fixes5-0-0.txt', " +
      "'src/*.c', 'dat/soko*.lua', 'include/'. Results are spoilers. Note: '$NHDT-Date' stamps and file dates are " +
      "commit times, NOT release dates.",
};
