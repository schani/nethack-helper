// Hand-written effect tables for dungeon features, each line checked against the NetHack 5.0.0 source
// (file:function cited per table). Odds are per use. The `gist` is non-spoiler; the full tables are spoiler-level
// (full lists of random effects and their odds) and come back marked as such.
import type { LookupEntry } from './index.ts';

const fountain: LookupEntry = {
  kind: 'feature',
  name: 'fountain',
  aliases: ['quaff from fountain', 'drink from fountain', 'quaffing from a fountain', 'dip into fountain', 'dipping in a fountain', 'fountain quaffing', 'fountain dipping', 'magic fountain'],
  heading: 'fountain ({) effects',
  source: 'src/fountain.c',
  lines: [
    'Gist: you can quaff from it or #dip items into it; most results are harmless, a few summon monsters (water moccasins, a water nymph, a water demon), and very rarely you get a wish. Each use may dry it up.',
  ],
  spoiler: [
    'QUAFF (src/fountain.c drinkfountain(), roll 1-30): 1-9 "The cool draught refreshes you" (a little nutrition); 10-18 "This tepid water is tasteless" (nothing); then 1 in 30 each:',
    '19 self-knowledge (enlightenment); 20 foul water: you vomit and get hungrier; 21 contaminated water: lose 3-6 Strength and 1-10 HP (only 1-4 HP if poison resistant);',
    '22 water moccasins appear; 23 a water demon appears: on shallow levels it may grant a wish first ((20 minus dungeon level) percent), otherwise it is hostile and very dangerous early; 24 "This water\'s no good!": each item that is not already cursed has a 1 in 5 chance to become cursed, plus hunger;',
    '25 permanent see invisible; 26 monster detection; 27 you find a gem (once per fountain, afterwards a water nymph instead); 28 a water nymph appears (steals); 29 bad breath: monsters flee; 30 water gushes out into pools around you.',
    'Magic fountains (1 in 7 on ordinary levels): with Luck 0 or more, rolls 10-30 instead restore lost attributes and raise one (all of them at natural Luck 4+), "Wow! This makes you feel great!", and the fountain stops being magic.',
    'Afterwards it dries up with a 1 in 3 chance (src/fountain.c dryup(); in Minetown the first time only gives a warning, and drying one angers the watch); not after the magic effects or the cool draught from a magic fountain.',
    'DIP (src/fountain.c dipfountain()): a long sword at experience level 5+ has a 1 in 30 chance (1 in 6 for Knights) to become Excalibur if you are lawful; non-lawful: the sword is cursed and may lose enchantment. Either way the fountain disappears.',
    'Other dips: the item gets wet first (if that did something, 50% nothing else happens); then roll 1-30: 16 curses the item; 17-20 uncurses a cursed item ("The water glows for a moment"); 21 water demon; 22 water nymph; 23 water moccasins; 24 a gem (once, else as 25); 25 water gushes forth; 26-27 strange feelings; 28 you lose some gold; 29 coins appear (once); otherwise nothing. Then the same 1 in 3 chance to dry up.',
  ],
};

const sink: LookupEntry = {
  kind: 'feature',
  name: 'sink',
  aliases: ['kitchen sink', 'quaff from sink', 'drink from sink', 'kick sink', 'kicking a sink', 'ring in sink', 'drop ring in sink'],
  heading: 'sink ({, white in 5.0) effects',
  source: 'src/fountain.c, src/dokick.c, src/do.c',
  lines: [
    'Gist: in 5.0 a sink is shown as a white { (like a fountain). Quaffing from it has random effects (mostly water of some temperature), kicking it can produce a few one-time surprises, and dropping a ring into it gives a hint about the ring but usually loses it.',
  ],
  spoiler: [
    'QUAFF (src/fountain.c drinksink(), roll 1-20): very cold / very warm water; scalding water (1-6 damage unless fire resistant); a sewer rat; a random potion\'s effect (you see its color); a ring (once); the pipes break and it turns into a fountain; a water elemental; "tastes awful" (+1 experience point); sewage (vomit, hunger); toxic waste (you polymorph unless unchanging); clanking pipes; snatches of song; a stench (small gas cloud); otherwise a sip of cold, warm or hot water.',
    'KICK (src/dokick.c): 4 in 5 "Klunk! The pipes vibrate noisily"; otherwise, each with a 1 in 3 chance and once per sink: a black pudding oozes out, an amorous demon ("the dish washer") appears; else 1 in 3 muddy waste backs up (with a ring the first time); else you hurt yourself.',
    'RING DROPPED IN (src/do.c dosinkring(), identification method): most ring types give a distinctive message (e.g. searching and slow digestion come back, levitation makes the sink quiver upward); the ring is usually lost down the drain.',
  ],
};

const throne: LookupEntry = {
  kind: 'feature',
  name: 'throne',
  aliases: ['sit on throne', 'sitting on a throne', 'throne room', 'kick throne'],
  heading: 'throne (\\) sitting effects',
  source: 'src/sit.c',
  lines: [
    'Gist: #sit on a throne for a random effect: good ones (a wish, genocide, identify, healing) and bad ones (electric shock, a summoned court, curses, losing gold); then it may vanish.',
  ],
  spoiler: [
    'SIT (src/sit.c throne_sit_effect()): 1 in 3 chance of an effect, each 1 in 13: lose 3-6 points of a random attribute and 1-10 HP; gain 1 point of a random attribute; electric shock (1-30 damage, 1-6 if shock resistant); full healing (max HP +4 if nearly full; cures blindness, sickness, wounded legs); lose your gold; a wish (if Luck + 0..4 is not negative, else Luck +1); summons 1-10 throne-room court monsters; genocide one species; a curse (blindness and Luck loss if your Luck is positive, else items cursed); magic mapping if Luck is negative or you already see invisible (confusion on unmappable levels), else permanent see invisible; teleport (aggravate monster instead if Luck is negative); identify some of your inventory; 16-22 turns of confusion.',
    'Otherwise "You feel somehow out of place" (or "very comfortable" for rulers). After any sit the throne vanishes with a 1 in 3 chance.',
    'Vlad\'s Tower throne (5.0, src/sit.c special_throne_effect()): when an effect triggers, 4 in 13 give a wish and the throne disintegrates (the only way it goes away); others: permanent level drain, greasy hands and inventory, an intrinsic stolen, being sent deep into Gehennom (to the vibrating square level) unless you carry the Amulet, three summoned demons, a confused remove curse, polymorph, an acid bath (1-80 damage), random attribute changes.',
  ],
};

const altar: LookupEntry = {
  kind: 'feature',
  name: 'altar',
  aliases: ['sacrifice', 'offer', '#offer', 'sacrificing', 'drop on altar', 'altar identification', 'cross-aligned altar', 'convert altar'],
  heading: 'altar (_) uses',
  source: 'src/do.c, src/pray.c',
  lines: [
    'Gist: dropping items on any altar shows whether they are blessed (amber flash), cursed (black flash) or uncursed (no flash) (src/do.c doaltarobj(); not while blind). Look at the altar to see its alignment. Praying on a cross-aligned altar angers your god.',
  ],
  spoiler: [
    'SACRIFICE (#offer, src/pray.c dosacrifice() / offer_corpse()): only fresh corpses count (killed within the last 50 turns; acid blobs always), worth the monster\'s difficulty + 1. On your own altar: first it reduces your god\'s anger, then the prayer timeout ("hopeful feeling" / "reconciliation"); with nothing to fix, at experience level 3+ and Luck 0+, a 1 in (6 + 2 x gifts so far x artifacts in the game) chance of an artifact gift ("Use my gift wisely!"); otherwise Luck rises ("four-leaf clover"), but 5.0 never raises Luck above the corpse\'s value.',
    'Cross-aligned altar (src/pray.c offer_different_alignment_altar()): "You sense a conflict"; with a (level + 2) in (level + 8) chance it converts to your alignment (Luck +1, a temple priest there gets angry), otherwise Luck -1. If your own god is angry with you, you instead convert to the altar\'s god (once per game; Luck -3). Same-race sacrifice: lawful and neutral heroes are punished (Luck -5, god anger) and the altar turns chaotic; chaotic heroes may summon a demon. Sacrificing your former pet: alignment penalty and you aggravate monsters. Unicorns: one of the altar\'s alignment is an insult; a cross-aligned unicorn on your altar is a big bonus.',
  ],
};

export const EFFECT_ENTRIES: LookupEntry[] = [fountain, sink, throne, altar];
