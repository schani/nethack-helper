# 2 · Mission Control

## Concept (≤150 words)
The NetHack client as an instrument panel. Everything a power user checks between keystrokes is already on screen. Systems on the left: HP gauge with a turn-stamped trend line, hunger and load scales, and a 15-lamp annunciator for conditions. The map sits in the centre as the primary display, with coordinate rulers, a hero crosshair, and disposition tints (hostile, tame, peaceful). Below it are a turn-stamped message log and a Contacts table that gives range and bearing for every monster and waypoint. Comms and cargo are on the right: the assistant is a radio channel with mic and voice level meters, a live caption, and a compact transcript whose tool lookups appear as chips you can open. Under it, inventory is a ledger with an equipment grid. The style is Swiss: one ink colour, a strict grid, monospace data, and colour used only to mean something.

## Key usability decisions
- **Keys always belong to the game.** UI controls use only F-keys (F2 hold to talk, F3 mic, F4 type, F5 inventory or discoveries, F6 level memory, F7 lookups, F8 allow spoiler, Esc back to the game). A `KEYS → GAME / MENU / PROMPT / --MORE-- / COMMS` pill in the header always shows where the next keystroke goes.
- **Three alert levels in fixed places.** *Nominal* shows no colour. *Caution* (amber) turns on the header CAUTION lamp with its reasons, the matching annunciator lamps, and a top accent on the Condition panel. *Warning* (red) does all of that, plus a red frame around the map, a WARNING strip with the cause (HP, adjacent hostile, prayer too early), a red HP block, and an automatic spoken alert. Status colours always come with a text label.
- **Prompts appear where NetHack puts them.** y/n prompts take over the top line (inverted, with the default key marked and an optional "COMMS ADVISES" hint). `--More--` shows a blinking ↵ key and a queue count. Menus and text windows open as overlays over a dimmed map, keeping the hero visible.
- **The assistant shows its work.** Every answer lists the tools it used (`nethack_lookup potion of acid → objects.h`), and you can open a chip to see the source text. A spoiler gate is recorded in the transcript.
- **Directions are relative and numeric.** Contacts and the cursor inspector use the same "47W 12S · r47" form the assistant speaks.
- **Map palette:** NetHack's 16 colours remapped for light paper. All are ≥3.9:1 contrast, and bright colours also render bold. "White" becomes the strongest ink, and dark-room floor is drawn as faint memory.

## What's distinctive
It is a radar-style Contacts table plus an annunciator panel. The client calculates range, bearing, and threat itself, so it answers "what's near me and how bad is it" before you ask the assistant.

## Files
`index.html` is self-contained, with real fixture data inlined. The `_src/` folder holds the template, `build.py` (which inlines `evals/fixtures/*.json`), and `shoot.sh`. Mockup states are switched with keys 1–8 or the footer buttons; the number keys are for this mockup only and would be NetHack count prefixes in the real client. The nominal state adds five plausible log lines (magic-mapping messages) because that fixture's log holds only the welcome line.
