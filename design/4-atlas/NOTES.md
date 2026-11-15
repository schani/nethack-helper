# 4 · Cartographer's Atlas

## Concept
You build an atlas as you play. A permanent left column shows the dungeon as a cross-section: each visited level is a line-drawn thumbnail of its remembered map. Stair lines join each level's down stairs to the next level's up stairs, and the Mines branch leaves from its real staircase. The live map sits in the centre as a map sheet, with a grid-square ruler (A–H × 1–3), a scale bar and a north arrow. Click a level (or press F6 and use the arrow keys) to open its remembered map read-only. A small inset keeps the live level on screen, and Esc brings it back. The assistant is the Cartographer: its directions become routes and callouts on the sheet and in the atlas, with sources listed like a printed map's notes. F7 opens the whole atlas as an exploded axonometric plate with a gazetteer.

## Key usability decisions
- **Keys always go to the game** unless a mode says otherwise. The pill at the top always shows where keys go (LIVE / PREVIEW / GAME MENU / GAME ASKS / TEXT WINDOW / PLATE).
- Assistant keys stay as built (F2 mic, hold F3 to talk, F4 type). The atlas adds F6 (browse) and F7 (plate). No letter, digit or Ctrl key is ever taken from NetHack.
- **A preview never traps you.** Esc returns to the live map. Any game key also returns and is passed to the game. The live inset is clickable.
- Remembered maps are clearly marked: red "Remembered · T:7 · read-only" badge, a faint hatch, a different title, and the live inset.
- Game prompts appear where NetHack puts them:
  - y/n questions take over the message strip, with keycaps and the default outlined.
  - Menus and text windows open over the map's right or centre and dim it without hiding it. Menus keep NetHack's letters, groups and `,` `-` `>` keys. Text windows end in a visible `--More--`.
  - A `--More--` after a message shows in the same message strip with an Enter/Space keycap. (This variant isn't one of the screenshots.)
- The hover inspector shows the same `desc` the assistant reads, plus the direction from the hero and the grid square.
- Spoilers are gated in the chat ("Spoiler check"). Projected (spoiler-derived) levels are drawn dashed and only appear after you consent.
- Colour: the 16 NetHack colours are remapped for paper. Every colour except the deliberately quiet floor and corridor glyphs is ≥ 4.0:1 on the room tint. Bright colours are also bold, so they can be told apart from their normal pairs. Room floors get a pale fill so rooms read as areas, and the glyphs stay a strict 80×21 grid.
- Cell size scales with the window (about 8.75 px at 1280, 9 px at 1440 and 13 px at 1920).

## What's distinctive
- The dungeon's **structure** is the main navigation element, not a menu: real thumbnails, real stair connections, and branch lines from the actual branch staircase.
- **Routes across levels**: the Cartographer's path goes up from Dlvl 4, across Dlvl 3, and onto Dlvl 2's Mines stairs. Squares you haven't explored are drawn dotted ("unsurveyed") instead of being guessed.
- **Exploded axonometric plate**: stacked level planes with stair shafts, a gazetteer with grid references, and projected outlines (e.g. Minetown) kept visually separate from what you surveyed.

## States in `index.html`
Use `?s=play|browse|menu|yn|text|plate` and add `&clean` to hide the mockup switcher. Alt+1…6, F6 and F7 also work.
1. Play: hover inspector and a spoiler check.
2. Atlas preview of Dlvl 2 while the Cartographer explains where the Mines stairs are, with the route and callouts.
3. Multi-drop menu.
4. y/n prompt (pray), with lookups from the wiki and source.
5. Ctrl-O text window with `--More--`.
6. Atlas plate.

All data comes from `evals/fixtures/deep-dlvl4.json`.
