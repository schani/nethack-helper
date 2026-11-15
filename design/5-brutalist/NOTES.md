# Proposal 5 — Neo-brutalist Arcade

## Concept (≤150 words)
A loud frame around a calm map. Status sits on top as chunky stat blocks with thick black borders, hard offset shadows and flat saturated fills, so HP, Pw, AC, XL, Dlvl and gold read at a glance. Conditions and Hunger are slapped on as tilted stickers. The 80×21 map lives in a quiet, undecorated warm-white panel. Glyphs are set in JetBrains Mono ExtraBold, and NetHack's 16 colours are remapped so that each one holds up on light paper. Inventory is a drawer of class-tinted tiles. The assistant is DELPHI, a small geometric character with moods: idle, listening, thinking, talking, a pink "SPOILER?" face and a red "HEADS-UP!" face. It talks in comic speech bubbles and leaves torn-paper receipt chips (WIKI / SRC / LOOK / STATE / MAP) for every lookup. Game prompts turn into hazard-striped bars with big buttons that are labelled with the real keys.

## Key usability decisions
- **Keys always go to the game.** All UI shortcuts use F-keys: F1 help, F2 hold-to-talk, F3 open mic, F4 type, F7 drawer, F8/F9 spoiler yes/no, F10 hush. A pill in the map's bottom bar always shows where keystrokes go (`KEYS → GAME` / `KEYS → DELPHI · Esc returns`). After you send a typed question, focus goes back to the game and a toast says so (state 4).
- **The map never moves or gets covered by prompts.** y/n and --More-- take over the fixed-height message strip above the map. The y/n buttons are 42px, show the key on a keycap, and mark the default with a `DEFAULT ↵` tag. While the prompt is open, the hero pulses so the question is tied to the action. Menus and text windows dock on the right side of the map, the same place NetHack puts them.
- **The assistant points at the map.** Pin markers in its replies (A, B) match rings on the map, so "three up, one left" can be checked by eye. It can also mark its suggested choice in an open game menu (`DELPHI ★`). It never selects the option for you.
- **Spoilers need consent.** You get a pink gate bubble with F8/F9 buttons, or you can answer by voice. A standing "SPOILERS: ASK FIRST" tag sits in the header. The answer to a spoiler arrives as a printed receipt that shows its working (price-ID: 333 ÷ 4/3 = 250 → acid/oil).
- **Hover any tile** to get a tooltip with the glyph, its description, and its offset from the hero (e.g. "2 down, 1 left of you"). The look bar also always shows what is under you.
- **Map colours** (0–15 swatch in F1): every glyph colour has 3.3:1 or better contrast on #FFFDF8; most are 4–18:1. "White" (15) is shown as black ink. Dark-room floor is deliberately faint. The hero gets a yellow block, pets a pink underline and peacefuls a blue underline.
- **Low HP is a UI-generated sticker in a different style** (black on yellow) from NetHack's own conditions, so the two aren't confused. The HP block turns red and shakes, and DELPHI interrupts unasked (marked `UNASKED`).
- Responsive: the map cell size is computed to fit the available space (80 columns always fit). At 1280px the Gold block hides (gold is still on the strip and in the drawer); at 1920px or wider the blocks grow.

## What's distinctive
The assistant has a personality: a face with moods, comic bubbles, and receipts you can audit. The chrome is loud while the map panel stays plain. Every prompt is a physical-looking button that is also the real key.

## States in index.html (demo bar at bottom, or Alt+1–8; `?state=…&clean` hides the bar)
1 play (shop, Dlvl 3) · 2 assistant + spoiler gate (click F8 TELL ME → receipt) · 3 y/n "Drink from the fountain?" + listening · 4 #call menu + Delphi suggestion · 5 low HP · 6 --More-- + thinking · 7 conditions (Hungry/Blind/Conf) · 8 Discoveries text window + Levels drawer.

Screenshots: shot-1 … shot-9 at 1440×900 (1 play, 2 spoiler gate, 3 spoiler answered, 4 y/n, 5 menu, 6 low HP, 7 --More--, 8 conditions, 9 text window). shot-10 is low HP at 1280×800 and shot-11 is play at 1920×1080. All data comes from `evals/fixtures/{shop,fountain-quaff-prompt,menu-open,low-hp,more-prompt,hungry-conditions}.json`.
