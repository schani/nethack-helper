# Eval failure root-cause analysis (run v2)

Source: `.cache/evals/v2/results.json` (85 cases × 3 reps, gpt-realtime-2.1, reasoning low, prompt at 9a15b53). Facts verified against the NetHack 5.0 source (`.cache/nethack-src`).

Root-cause classes:
- **A**: information not available from any tool.
- **B**: an existing tool had it, but wasn't called or was called with bad args.
- **C**: returned, but buried, truncated or misleading.
- **D**: the information was there and clear; the model got it wrong.
- **E**: the test, judge or check is wrong.

## Per case

| case (passes/3) | class | evidence |
|---|---|---|
| concise-best-armor 0 | D (A) | Game off. Generic advice that never names DSM, cloak of MR or speed boots. No curated strategy reference. |
| concise-early-wizard 0 | D (B) | 73–100 words vs. an 85 cap; a lecture. Mentions escape items without checking inventory. |
| hall-false-killed 0 | B, A | Only called get_messages. get_status has "(6 experience points)"; the snapshot only has "XL 1". |
| hidden-price-id-consent 0 | C, B, D, E | Wiki price tables stripped. Cha 8 not in the snapshot, and get_status not called. Ground truth wrong (§2). |
| robust-wiki-down 0 | A, E, D | Displacer beast is new in 5.0, so there's no memory of it. The judge penalized a correct "multiple attacks". The search `"Displacer beast"` misses (smart-case). |
| spoiler-fountain-optin 0 | C, D, E | Fountain effects table stripped. Up to 7 source-reading rounds. Prompt word caps force vagueness. Truth lists effects that don't exist in 5.0. |
| spoiler-medusa 0 | D | Its "general hint" names the counter. The prompt never defines a general hint. |
| spoiler-quest 0 | D, C | Names Lord Surtur and the Orb of Fate from the fetched wiki. The prompt's spoiler list omits nemesis and artifact names. |
| spoiler-sokoban-consent 0 | D, E | Prompt says to ask about orientation although the tools show it. The judge sees only 1400 characters of the tool result and calls the correct steps "invented". |
| state-char-creation 0 | A, D | Only "[ynaq]" is shown, with no meanings, and it guesses "a = quit" (role.c: a = random, no confirmation). The yn event is overwritten by a key event in state.ts. |
| state-menu-open 0 | E | Explains `i` and `o` correctly; the judge wanted `o` first. |
| state-not-running-general 0 | E | The judge passes it; the regex is too narrow. A correct Gehennom exception was judged a spoiler. |
| state-yn-should-i 0 | E | The judge passes it; "must call a tool" ignores the snapshot. |
| v5-valkyrie-spear 0 | B, C, D | Invents "starting gear varies". Case-sensitive search excluding doc/ misses fixes5-0-0.txt:971. |
| hall-castle-tune 1 | D, E | Offered the exact tune once; the judge was strict about a brief Mastermind mention. |
| hall-dragon-here 1 | D, A | "No dragon on this level" from a 7–10 square look. No unexplored/out-of-view indicator. |
| look-fight-order 1 | D, A | Wrong move mechanics. Look carries no threat data. |
| robust-rambling-question 1 | E | The judge passes it; "must call get_status" though AC is in the snapshot. |
| spoiler-consent-persists 1 | D | 186–191 words vs. a 140 cap. Engrave-test described wrong, from memory. |
| v5-genetic-engineer 1 | E | "Teleports away after polymorph" is correct (fixes5-0-0.txt:1750); the truth lacks it. |
| discoveries-called 2 | E | Judge noise. |
| hall-fake-monster 2 | E, C | Correctly found no such monster. Source-derived stats judged a spoiler. 4 sequential rounds. |
| hidden-dark-potion-adjacent 2 | D | Suggests items the hero doesn't have; ignores the adjacent jackal. |
| hidden-pet-location-unseen 2 | D, C | Doesn't link "Blind" to the missing kitten. Look gives no blindness warning. |
| know-floating-eye 2 | D | 65 words; invents "closing your eyes". |
| know-lichen 2 | D | "Doesn't rot fast" (it never rots). |
| live-fountain 2 | D | Lists outcomes before consent, including "healing", which isn't one. |
| look-altar-alignment 2 | D/E | Never says "lawful". |
| look-f-next-to-me 2 | D | Unasked "item testing" aside. |
| look-fountain-this 2 | E | Judge wanted the location and dipping. |
| other-main-stairs-lvl2 2 | D | Wrong travel advice for another level; prompt invites it. |
| other-mines-entrance 2 | B | Offered the map instead of calling get_level_map. |
| state-low-hp-trouble 2 | D | Invents a corridor; "let the kitten tank" when it's 2 squares away. |

## Test bugs

1. **hidden-price-id-consent.** Cha 8 means ×4/3. A price of 333 means base 250 with no surcharge: acid or oil. The current "200 or 250" is wrong.
2. **spoiler-fountain-optin.** Truth must match 5.0 `drinkfountain()`:
   - cool draught, tepid water;
   - self-knowledge, foul water, contaminated water;
   - water moccasins, water demon (possible wish), water nymph;
   - curse items, see invisible, monster detection, gem;
   - bad breath, gushing pools;
   - magic fountains restore and gain ability;
   - then a 1/3 chance the fountain dries up.

   Remove hallucination and object detection.
3. **v5-genetic-engineer.** Add teleporting away after polymorphing someone.
4. **robust-wiki-down.** Accept "can't check, new in 5.0". Penalize D&D lore. Actual behavior (hack.c): 50% chance to swap places when you attack it, `F` prevents that; level 12, AC −3; eating the corpse gives temporary displacement.
5. **state-yn-should-i, robust-rambling-question.** Drop "must call tool" when the snapshot has the fact.
6. **state-not-running-general.** Widen the regex. The Gehennom/endgame exception is a fact, not a spoiler.
7. **state-menu-open.** Pass if `i` and `o` are both explained correctly.
8. **spoiler-sokoban-consent.** Fixture is 1b, flipped both ways. Put the first 3 steps in the truth and raise the judge's tool-result cap.
9. **hall-castle-tune, look-fountain-this, discoveries-called, hall-fake-monster.** Align the judge with its rubric.

## Systemic causes

1. **The wiki tool strips all tables.** It uses the wiki's plain-text extract, which drops them, so effect and price tables vanish.
2. **No fast path to 5.0 facts.**
   - The wiki is 3.6-centric.
   - Source search is smart-case, so capitalized names miss.
   - Wrapped changelog continuation lines are lost.
   - The model falls back on 3.6 memory.
3. **Feed/view gaps in player-visible meaning.**
   - No meanings for prompt choices.
   - yn events are overwritten by key events.
   - No XP points in the snapshot.
   - No explored-fraction indicator and no blindness warning.
4. **Prompt conflicts.**
   - Word caps vs. spoiler opt-in.
   - "General hint" is undefined.
   - "Source-derived = spoiler" vs. "check the source".
   - Sokoban says "ask" although the tools know the orientation.
   - The travel tip gets applied to other levels.
5. **Spoiler gating relies only on model restraint.** Tools return spoiler sections before consent.
6. **Eval flaws.**
   - The judge's 1400-character tool-result cap.
   - The judge penalizes required preambles.
   - Tool-required checks ignore the snapshot.
   - Some truths describe 3.6.
7. **Length overruns** on strategy and post-consent answers.

## Proposed changes (prioritized)

| # | change | source / legitimacy | fixes |
|---|---|---|---|
| P1 | Wiki: render tables and lists from the section's wikitext | wiki | fountain-optin, price-id, fountain gists |
| P2 | Append matching 5.0 changelog lines (incl. continuations) to wiki results; source search case-insensitive | 5.0 source | valkyrie-spear, genetic-engineer, wiki-down |
| P3 | Offline `nethack_lookup`: monsters.h, objects.h, u_init.c, source-verified effect tables; "not in 5.0, closest: …" | public game data | fake-monster, genetic-engineer, valkyrie-spear, fountain-optin, fight-order |
| P4 | View: XP points in snapshot; prompt-choice explainer; yn fix; blind/hallucinating warnings; explored-fraction | feed + source; no hidden stats (luck, alignment record, prayer timeout) | false-killed, char-creation, menu-open, yn, pet-unseen, dragon-here, altar |
| P5 | Sokoban auto-orientation from the visible layout | lit level | sokoban-consent |
| P6 | `price_identify(item)` after consent | standard technique | price-id-consent |
| P7 | Spoiler-tagged tool sections plus a harness consent ledger | harness | quest, medusa, live-fountain |
| P8 | Curated 5.0-verified strategy notes | hand-written | best-armor, early-wizard, lichen, floating-eye |
| P9 | Prompt fixes for the conflicts above | prompt | medusa, quest, stairs-lvl2, consent-persists, concise |
| P10 | Eval fixes: judge cap, preambles allowed, test bugs above | evals | ~11 false negatives |
