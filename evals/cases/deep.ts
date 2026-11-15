/**
 * Deep questions: multi-step reasoning over the 5.0 source, arithmetic, rare mechanics interactions.  The
 * deep-thinking expert (consult_expert) is meant for these; the production assistant without it must answer
 * alone.  Every truth below was verified against the NetHack 5.0.0 source (.cache/nethack-src), with the
 * player-visible facts taken from the fixture through the production game tools.
 */
import type { EvalCase } from '../src/types.ts';

/** two to three spoken messages (preamble + delivered answer) */
const DEEP_WORDS = 150;

export const cases: EvalCase[] = [
  {
    id: 'deep-price-lamp',
    tags: ['deep'],
    fixture: 'shop',
    turns: [
      {
        user: "Spoilers are fine: that lamp next to me costs 67 zorkmids. Work it out from the price, is it an oil lamp or a magic lamp?",
        expect: { mustAny: [/magic lamp/i], maxWords: DEEP_WORDS },
      },
    ],
    truth:
      'Price identification with the visible facts (look: "a lamp (for sale, 67 zorkmids)", adjacent southwest; get_status: Charisma 8; no dunce cap, not a Tourist, no visible shirt). src/shk.c get_cost(): Charisma 8-10 multiplies by 4/3 (rounded: ((base*4*10/3)+5)/10); unidentified items get another 4/3 surcharge when o_id % 4 == 0 (1 in 4, hidden). include/objects.h: oil lamp base 10, magic lamp base 50, both with the appearance "lamp". Oil lamp: 13 (or 18 with the surcharge). Magic lamp: 67 (or 89). So 67 means a MAGIC LAMP, unambiguously. Deducing it from the price is fine here: the user explicitly asked for the price method and agreed to spoilers.',
    rubric:
      'Pass if it concludes it is (almost certainly / must be) a magic lamp, ideally with the reason (base 50 with the Charisma 8 markup; an oil lamp would be about 13 or 18). Saying "probably an oil lamp", refusing to deduce, or not reaching a conclusion is a correctness failure. A short preamble before the answer is fine.',
  },
  {
    id: 'deep-price-boots',
    tags: ['deep'],
    fixture: 'shop',
    turns: [
      {
        user: 'Spoilers are fine. Those riding boots are 40 zorkmids. Use the price to figure out what they could be. Should I buy them and put them on?',
        expect: { must: [/fumbl/i, /levitat/i], maxWords: DEEP_WORDS },
      },
    ],
    truth:
      '"riding boots" is a randomized appearance among the seven magic boots (src/o_init.c shuffles speed..levitation boots). Bases (include/objects.h): speed, water walking, jumping 50; elven, kicking 8; fumble, levitation 30. With Charisma 8 (x4/3, src/shk.c get_cost) the possible asking prices are 67/89 (base 50), 40/53 (base 30), 11/14 (base 8). 40 = base 30 without the random 1-in-4 surcharge, so the boots are FUMBLE BOOTS or LEVITATION BOOTS. Both are bad to put on untested: src/mkobj.c generates fumble and levitation boots cursed with negative enchantment 9 times in 10 (stuck on your feet; cursed levitation boots are a serious problem). Advice: do not buy them to wear (or at least never put them on unless known uncursed and you want levitation).',
    rubric:
      'Must name both candidates (fumble boots and levitation boots) and advise against putting them on (or only after making sure they are not cursed). Claiming speed/jumping/elven boots are possible at 40 is wrong.',
  },
  {
    id: 'deep-boots-no-consent',
    tags: ['deep'],
    fixture: 'shop',
    turns: [
      {
        user: 'Should I buy those riding boots for 40?',
        expect: { mustNot: [/fumbl/i, /levitat/i, /speed boots|jumping boots|elven boots|kicking boots|water walking/i], maxWords: 90 },
      },
    ],
    truth:
      'The riding boots are unidentified (the appearance is randomized among the magic boots). Their price narrows them down (40 at Charisma 8 means fumble or levitation boots), but price identification is a spoiler-level method and the user has not agreed to spoilers.',
    rubric:
      'Without consent the assistant must not reveal what the price implies (no boot types named). Ideal: says it cannot tell what they are from the look, mentions that there is a way to narrow it down from the price (a spoiler) and asks, possibly with a general caution about trying on unknown armor in a shop or that they could be cursed. Consulting the expert is not needed before consent.',
  },
  {
    id: 'deep-fountain-wish-odds',
    tags: ['deep'],
    fixture: 'fountain-adjacent',
    turns: [
      {
        user: "Give me the exact odds, spoilers are fine: if I quaff from this fountain right now, what's my chance of getting a wish?",
        expect: {
          mustAny: [/0\.6|0\.63|six tenths|1 in 1[56]\d|one in (a hundred and )?(fifty|sixty)|1 in 160|one in 160|less than (one|1) ?(percent|%)|under (one|1) ?(percent|%)|about (one|1) ?(percent|%)/i],
          maxWords: DEEP_WORDS,
        },
      },
    ],
    truth:
      'src/fountain.c drinkfountain(): fate = rnd(30); fate 23 summons a water demon (dowaterdemon), which grants a wish if rnd(100) > 80 + level_difficulty(); level_difficulty() on Dlvl 1 is the depth, 1 (src/dungeon.c), so 19 in 100. Per quaff: 1/30 x 19/100 = 19/3000, about 0.63 percent, roughly 1 in 158. The other 81 percent of the time the water demon (level 8, three attacks) is hostile, which is very likely fatal for an XL 1 character. (If the fountain happens to be a hidden "magic" fountain, 1 in 7 fountains, and Luck is not negative, fate >= 10 gives restore/gain ability instead and no demon can appear; this is invisible to the player.) The wish chance grows worse deeper (it is best on Dlvl 1).',
    rubric:
      'Pass if the number is right (about 0.6 percent / roughly 1 in 150-160, or 1/30 times 19 percent) and it warns that the demon is usually hostile and deadly. Stating 1/30 alone, or "about 3 percent", or 3.6-era numbers, is wrong. The magic-fountain caveat is a plus, not required.',
  },
  {
    id: 'deep-pray-weak-low-hp',
    tags: ['deep'],
    fixture: 'hungry-conditions',
    turns: [
      {
        user:
          "Hypothetical, give me the real mechanics: say I keep going until I'm Weak from hunger, and my HP drops to 3 out of 16 around turn 1500, and I still haven't prayed once this game. If I pray then, will it fix both the hunger and my HP?",
        expect: { mustAny: [/hunger|weak|stomach|food|nutrition/i], maxWords: DEEP_WORDS },
      },
    ],
    truth:
      'src/pray.c: Weak (u.uhs >= WEAK) is major trouble TROUBLE_STARVING (9) and HP 3 of 16 is major trouble TROUBLE_HIT (7) (critically_low_hp: HP <= 5, or HP <= max/5 at XL 1-5). can_pray(): major trouble needs prayer timeout <= 200; it starts at 300 (src/u_init.c) and drops by 1 per turn (src/allmain.c), so at turn ~1500 with no earlier prayer it is 0: the prayer works provided Luck is not negative, the god is not angry and the alignment record is not negative (hidden values; normally fine if nothing bad was done). pleased(): the worst trouble is always fixed first, and Weak ranks above low HP, so the hunger is surely fixed (nutrition reset to 900). Whether the HP is also restored depends on hidden values: off an altar action = 1 + rn2(Luck + 2), capped at 3; action 1 fixes only the worst trouble, 2 or more fixes all major troubles. With Luck 0 that is a 50/50 chance that only the hunger is fixed and the HP stays at 3; better Luck raises the odds. With a low alignment record (below 4; a Valkyrie starts at 0, it grows by killing hostile monsters) only the worst trouble is fixed (or, at record 0, possibly nothing). So: hunger yes; HP only maybe, so pray while hunger is not the only fix needed... practical advice: eat first or deal with hunger before it gets to Weak so the prayer goes to the HP, or be ready to heal otherwise.',
    rubric:
      'Key points: prayer should work (timeout long expired if never prayed, assuming Luck/alignment/god anger are fine, which are unknown to the player); it fixes the hunger for sure because being Weak counts as worse than low HP; restoring the HP as well is NOT guaranteed (about a coin flip with average Luck). Saying "yes, both are always fixed" is a correctness failure (score <= 3). Acknowledging that Luck/alignment are hidden is required for groundedness 5 (at least implicitly, e.g. "as long as you haven\'t angered your god").',
  },
  {
    id: 'deep-jackal-survive',
    tags: ['deep'],
    fixture: 'low-hp',
    turns: [
      {
        user: 'I only have 4 HP and that jackal is right next to me. Do the math: can it kill me before I kill it?',
        expect: { mustAny: [/two bites|2 bites|at least two|at most 2|1 to 2|one or two|up to 2|max(imum)? (of )?2|2 damage|two damage|two (hit )?points/i], maxWords: DEEP_WORDS },
      },
    ],
    truth:
      'Jackal (include/monsters.h): level 0, speed 12, AC 7, one bite 1d2. Level-0 monsters get 1d4 HP, at least 2 (src/makemon.c newmonhp), so a jackal has at most 4 HP. The hero (speed 12, same as the jackal, so one bite per turn) has HP 4: it takes at least two bites (2 + 2) to kill her, so she cannot die this turn; worst case she dies after two turns if both bites hit for 2 and she misses twice. Her blessed +1 spear does d6+1 against small monsters plus +2 for Strength 18 (src/weapon.c dbon), at least 4 damage, so any hit kills the jackal outright. The tame kitten is 2 squares south and can help. Advice: attack it now (each swing that hits kills it); only flee if more monsters show up.',
    rubric:
      'Must get the core arithmetic right: jackal bite 1-2 damage, so it needs at least two bites to kill her from 4 HP; one hit from her spear kills it (jackals have at most 4 HP, her minimum damage is 4) — the second point is a plus. Recommending to attack (or let the kitten help) is right; recommending prayer is wrong (turn 12, prayer timeout too high).',
  },
  {
    id: 'deep-carry-capacity',
    tags: ['deep'],
    fixture: 'unid-items',
    turns: [
      {
        user: 'How much more weight can I pick up before I become Burdened? Add it up for me.',
        expect: { mustAny: [/\b78\d\b|seven hundred (and )?eighty/i], maxWords: DEEP_WORDS },
      },
    ],
    truth:
      'src/hack.c weight_cap(): 25 x (Str + Con) + 50 = 25 x (18 + 18) + 50 = 950 (below the 1000 cap). Inventory weights (include/objects.h): spear 30, dagger 10, small shield 30, food ration 20, two potions 20 each (40), two scrolls 5 each (10), ring 3, wand 7, amulet 20 = 170 (unidentified items weigh the same as every item of their class). Burdened as soon as the total exceeds the capacity (calc_capacity: wt - wc > 0), so she can add 780 more weight units before becoming Burdened. Example: a long sword weighs 40, a boulder 6000.',
    rubric: 'The answer must be about 780 (capacity 950 minus 170 carried). Close but wrong numbers (e.g. capacity 1000 -> 830, or a mis-added inventory) are correctness failures.',
  },
  {
    id: 'deep-hunger-turns',
    tags: ['deep'],
    fixture: 'hungry-conditions',
    turns: [
      {
        user: "I'm Hungry right now. How many turns do I have before I get Weak if I don't eat?",
        expect: { mustAny: [/\b100\b|hundred/i], maxWords: DEEP_WORDS },
      },
    ],
    truth:
      'src/eat.c newuhs(): Hungry means nutrition 51-150, Weak at 50 or below. A Valkyrie burns 1 nutrition per turn (src/eat.c gethungry: no rings, amulet or regeneration in her inventory; the blindfold costs nothing), plus 1 per melee attack (overexertion). The exact nutrition is hidden, so it is anywhere from 1 to 100 turns: at most about 100 turns, possibly much sooner. She has a food ration: eat now (confusion and blindness do not change this).',
    rubric: 'Must say it is at most about 100 turns and that the exact number is unknown (could be soon); recommending eating (she has a food ration) is a plus. A precise single number of turns stated as fact is a groundedness failure.',
  },
  {
    id: 'deep-spear-or-dagger',
    tags: ['deep'],
    fixture: 'unid-items',
    turns: [
      {
        user: 'That fox next to me: should I fight it with my spear, or switch to my dagger? Which one is actually better here?',
        expect: { mustAny: [/spear/i], mustNot: [/switch to (the|your) dagger/i], maxWords: DEEP_WORDS },
      },
    ],
    truth:
      'Spear (wielded, blessed +1): d6 vs small / d8 vs large, +1 enchantment; dagger (+0): d4 / d3, +2 to-hit (include/objects.h). Both start at Basic skill for a Valkyrie (starting-inventory weapons) and both can reach Expert (src/u_init.c Skill_V). A fox is small, so the spear does d6+1 (average 4.5) vs the dagger d4 (2.5), both plus +2 for Strength 18. Switching weapons (x) also costs a turn while the fox bites. Keep the spear. Daggers shine later as thrown weapons (several at once, multishot), not as this melee weapon.',
    rubric: 'Must recommend keeping the spear for this fight with the damage reason; mentioning the dagger\'s throwing value is a plus.',
  },
];
