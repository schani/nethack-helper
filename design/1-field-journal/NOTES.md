# Field Journal

## Concept (≤150 words)

The client is one page of an adventurer's surveying notebook. The map is printed on graph paper, one square per cell, with a column and row ruler. The page uses three hands: the **game prints** (serif: status, journal, prompts), **you write in pencil** (your questions, names you give items with "called"), and **your companion writes in blue-black ink** (Caveat). The companion's notes go in the ruled right-hand margin. When it talks about a place, it circles the tile on the map, draws an ink route and numbers it ①②, and the matching footnote numbers appear in its note. Messages are dated journal entries (T3), the inventory is a packing list, and visited levels are thumb-index tabs you can flip back through. The voice state is a pen recorder: the pen is capped when idle, traces in graphite while listening, blots while thinking, and writes ink while speaking.

## Key usability decisions

- **The game always has the keys.** UI shortcuts use only F-keys that browsers don't reserve: F2 hold to talk, F3 mic on/off, F4 write a note (Esc returns), F6/⇧F6 flip level pages, F7 sources, F8 unfold a spoiler, F9 hush. A small "keys → game" stamp always shows where keystrokes go.
- **Prompts get a fixed-height rail above the map** (NetHack's top line). The rail shows the latest message. When a prompt is waiting, a slip with keycaps replaces it, and the default answer is ringed. The rail's height never changes, so the map never jumps.
- **Menus are index cards placed on the side away from the hero.** The companion can annotate the card itself, for example by circling the letter it recommends. It never preselects a menu item for you.
- **Hovering a tile** pins a specimen tag that shows the cell's description and its offset from the hero ("f · 1 south").
- **Colour remapping for paper:** all 16 NetHack colours reach at least 4:1 contrast on the page. Floors and corridors are deliberately lighter, so the room structure reads as graphite and objects and monsters stand out in coloured ink. The hero gets a highlighter swipe.
- **Spoilers are folded notes.** They stay closed until you say "unfold" or press F8. Every source the companion consulted (wiki, source code, level memory) appears as a citation under its note.
- **Flipping back never traps you.** Any game key returns to the current page.
- **"On this page" index:** the companion keeps a short list of landmarks on the current level, written as legend glyphs with relative directions.

## What's distinctive

The companion has a physical hand. Its words, map circles, and routes are drawn in the same ink, so "where is it?" is answered on the map itself. Unmapped stretches of a route are drawn as pencil dots, which shows that the companion knows the limits of what you've seen. The look is warm and analog, but the layout stays functional: a fixed grid, fixed rails, and keyboard first throughout.

## Mockup notes

- States: `1` Play · `2` Companion speaking (route + circle) · `3` Menu (#call) · `4` y/n prompt · `5` --More-- · `6` Level pages (atlas). Use the buttons at the top right or the digit keys. Digits switch states only in the mockup; in the real client they go to the game. Add `#…&clean` to the URL to hide the switcher.
- Data comes from `evals/fixtures`. States 1–2 use `shop.json` (map, status, messages), with the packing list taken from `unid-items.json` (same Valkyrie). States 3–5 use `menu-open.json`, `fountain-quaff-prompt.json`, and `more-prompt.json`. State 6 uses `deep-dlvl4.json` (all 5 remembered levels). The fountain route comes from a path search over the real shop map, about 20 steps.
- Hover any map tile to see its real `desc` from the fixture.
