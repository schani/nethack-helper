# 3 · Zen

## Concept (≤150 words)
The dungeon is set like a page in a fine book: an 80×21 grid in IBM Plex Mono at 25px, centered on warm paper, with nothing else on screen by default. Above it sits the game's message line in a reading serif (Newsreader). Below it is a hairline status whisper with an ensō orb at its center. The orb is the assistant. It has no panel. It speaks in film-style captions that arrive word by word and fade out. When it names a tile, the rest of the map dims, an indigo ring draws around that tile, and a small label appears beside it. Inventory, transcript, messages, levels, discoveries and character details come up as calm F-key sheets and close instantly. Colour has meaning and is used sparingly. Ink means the game wants an answer. Vermilion means danger. Ochre means caution. Indigo is the assistant's voice.

## Key usability decisions
- **The keyboard belongs to the game.** The UI uses only F1–F4 and F6–F9. F5, F10, F11 and F12 are left to the browser.
- **Sheets are read-only peeks.** Game keys pass through and the sheet stays open: press `q` and the inventory stays visible while the game asks what to drink. Esc or the same F-key closes a sheet.
- **Focus moves in one case only.** F2 (write) is the only time keys stop reaching the game. When it happens the map veils, the input underline turns indigo, the corner indicator changes to "keys → assistant · Esc returns", and Esc returns.
- **Game prompts can't be mistaken for anything else.** A 3px ink bar runs across the top of the viewport, with a "■ The game asks / waits" label. Keycaps are solid ink and the default answer is filled. Menus are framed in hard ink; the assistant's soft sheets have no frame. The assistant can point at a menu row ("assistant suggests", in indigo) but never selects it.
- **The status line stays quiet until something matters.** When HP drops below ⅓, the HP number turns vermilion and gets larger, the hairline gauge above the status line shortens and turns red, and a faint vignette warms the edges of the screen. Hunger and conditions appear as words in ochre or indigo.
- **Directions are always relative to the hero.** The spotlight draws a dotted path from the hero to the target. The hero never dims.
- **Captions stay short and spoken.** Sources appear as small caps under a caption. Full lookups (wiki, source, overview) go in the transcript margin. Spoilers are gated ("spoiler · say 'go ahead'").
- **Map colours on paper.** All 16 NetHack colours are remapped to at least 3:1 contrast. NetHack's "black" is drawn as real ink, except dark-room floor, which is drawn as a faint remembered dot. Corridors and floors are lighter than walls, so objects and monsters stand out.
- **Hover any tile** to see its description in small caps.
- **Motion.** Captions fade in word by word (opacity, blur and a 4px rise). The spotlight dims over 700ms and its ring takes 1.1s to draw. Sheets open in 160–200ms and close faster. All motion respects `prefers-reduced-motion`.

## What's distinctive
The assistant has no window at all. It is a mark at the center of the status line and a voice. The map is spotlit the way a director lights a stage. The level memory sheet shows the dungeon as a spine of remembered thumbnails, with the Mines branch hanging off Dlvl 2.

## Files
`index.html` (self-contained; fixture data embedded; demo state pills at top right, hidden with `?shot`; `?s=<state>` deep-links; F3/F4/F6–F9, F1-hold and F2 work live). Screenshots: `shot-1-play` … `shot-10-write` at 1440×900.
Data comes from `evals/fixtures/` (shop, low-hp, unid-items, menu-open, fountain-quaff-prompt, more-prompt, deep-dlvl4).
