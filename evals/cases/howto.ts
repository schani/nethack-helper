/**
 * "How do I / what are my options" in a concrete game situation.  The right answer is the method(s) THIS player can
 * use right now (what they carry and wield, their role, the game turn), best first, without dropping a usable option
 * and without suggesting things they do not have.  These are the questions the thinker's quick mode is for.
 * Every truth below was verified against the NetHack 5.0.0 source (.cache/nethack-src); the player-visible facts come
 * from the fixture through the production game tools (fixture recipes: evals/fixtures/recipes.ts).
 */
import type { EvalCase } from '../src/types.ts';

/** a short "Checking." plus the relayed answer */
const WORDS = 90;

export const cases: EvalCase[] = [
  {
    id: 'howto-locked-box',
    tags: ['howto'],
    fixture: 'locked-box',
    turns: [{ user: 'It says the box is locked.', expect: { must: [/force/i, /kick/i], mustNot: [/pick-?axe/i], maxWords: WORDS } }],
    truth:
      'Samurai standing on a locked large box, wielding a +0 katana, also carrying a wakizashi (short sword); no key, lock pick, credit card, wand or unlocking spell. ' +
      'Options (verified): (1) #force (Alt F, or #force) while standing on the box: src/lock.c doforce() works on a box on the hero\'s own square with a wielded weapon; ' +
      'a blade pries (is_blade): success chance per turn = 2 x the weapon\'s large-monster damage die = 24% for a katana (d12, include/objects.h); each failed turn a non-cursed +0 blade ' +
      'breaks with probability about 8 in 1000 (forcelock(): rn2(1000 - spe) > 992), so a small risk to the katana overall (forcing with the wakizashi instead protects the main weapon: chance 16%/turn, d8). ' +
      '(2) Kick it from an adjacent square (Control D, then the direction of the box): src/dokick.c dokick() cannot kick your own square, so step off first; really_kick_object(): a locked box breaks open ' +
      'with chance 1/5 per kick, and martial-arts users (Samurai) get an extra 1/2, about 60% per kick; kicking can break fragile contents (container_impact_dmg, e.g. potions). ' +
      'Guidebook 7.12.1 Containers lists exactly these: key/lock pick (apply), kicking (^D), #force. A pick-axe cannot be applied to open a box (and the player has none); the default autounlock option is apply-key only (src/options.c), so the game does not offer to force or kick by itself.',
    rubric:
      'The player means "how do I open it". Pass requires BOTH usable methods: #force with the wielded katana (or wakizashi) while standing on the box, and kicking it from an adjacent square (Control D toward it). ' +
      'Mentioning the small risk of breaking the blade and/or breaking contents is expected for correctness 5 but not required for a pass. Suggesting a pick-axe, a key or a wand as if the player had one is a correctness failure ' +
      '(saying a key would work but they have none is fine). The exact key for #force is optional ("#force" is enough).',
  },
  {
    id: 'howto-locked-door',
    tags: ['howto'],
    fixture: 'locked-door',
    turns: [{ user: 'This door is locked. How do I get through?', expect: { must: [/kick/i], mustNot: [/#\s*force|force (it|the (door|lock))/i], maxWords: WORDS } }],
    truth:
      'Valkyrie (St 18, wielding a spear) adjacent to a locked door to the west ("This door is locked."); no key, lock pick, credit card or wand; not a shop door, not Minetown. ' +
      'Kick it: Control D, then h / west (this game\'s binding for kick is ^D). src/dokick.c: a closed or locked door breaks when rnl(35) < (Str + Dex + Con) / 3, so a strong Valkyrie usually needs one to a few kicks ' +
      '("WHAMM!!" means try again); kicking is noisy (Guidebook 5.1 Doorways). #force does NOT work on doors (src/lock.c doforce() only handles boxes; a TODO comment says so). ' +
      'Without a tool, the other choice is to go around through another exit. Unlocking magic (wand of opening, force bolt, wand of striking) would work but she has none.',
    rubric: 'Pass requires: kick the door (Control D, then west/h or "toward the door"); may take several kicks. Suggesting #force on the door, or a key/wand she does not have as if she had one, is a correctness failure. Mentioning another route is a plus.',
  },
  {
    id: 'howto-pit',
    tags: ['howto'],
    fixture: 'in-pit',
    turns: [{ user: "I'm stuck in a pit. How do I get out?", expect: { mustAny: [/move|keep (trying|going)|climb|direction|walk/i], maxWords: WORDS } }],
    truth:
      'Samurai in a pit ("You fall into a pit!", "You are still in a pit."). src/trap.c: falling in sets u.utrap = rn1(6, 2) (2 to 7); each attempt to move in any direction (src/hack.c trapmove() -> climb_pit()) ' +
      'uses one up until "You crawl to the edge of the pit." Pressing < also tries to climb out (src/do.c doup()). So: just keep moving (a few turns); no tool needed. Guidebook 5.2 Traps: "You can escape by simply trying to move to an adjacent spot and repeat as needed." ' +
      'A grid bug (harmless) is adjacent east: moving east attacks it instead of climbing (fine to kill it from the pit).',
    rubric: 'Pass requires: keep trying to move (any direction), it takes a few turns. Claiming a rope, tool, or special command is needed is wrong. Mentioning the grid bug is optional.',
  },
  {
    id: 'howto-web',
    tags: ['howto'],
    fixture: 'in-web',
    turns: [{ user: "I'm stuck in a web, how do I get out?", expect: { mustAny: [/move|keep (trying|going)|direction|walk|struggl/i], maxWords: WORDS } }],
    truth:
      'Elven Wizard with Strength 7 just stumbled into a spider web. src/trap.c trapeffect_web(): the time stuck depends on Strength; St 7 gives rn1(4, 4) = 4 to 7 move attempts; ' +
      'src/hack.c trapmove(): each attempt to move decrements it until "You disentangle yourself." So keep trying to move; with her low Strength it takes several turns. ' +
      'Only special cases free you at once (wielding Sting cuts the web; being a fiery/acidic monster burns it; very high Strength tears it). Force bolt does not destroy webs.',
    rubric: 'Pass requires: keep trying to move, it takes a few turns (low Strength: several). Claiming a specific item or spell is needed, or suggesting force bolt to destroy it, is wrong.',
  },
  {
    id: 'howto-cursed-helmet',
    tags: ['howto'],
    fixture: 'cursed-helmet',
    turns: [{ user: "I can't take this helmet off, it says it's cursed. What can I do?", expect: { must: [/holy water|dip/i], maxWords: WORDS } }],
    truth:
      'Wizard wearing a cursed orcish helm (and an uncursed cloak of magic resistance); carries a potion of holy water (f) and an uncursed scroll of destroy armor (i); turn 2. ' +
      'Best: #dip the helmet into the holy water (src/potion.c H2Opotion_dip(): blessed water on a cursed object uncurses it; the potion is used up), then take it off with T. ' +
      'Do NOT read destroy armor to get rid of it: src/read.c seffect_destroy_armor() destroys some_armor() (src/do_wear.c), which picks the cloak first and switches to the helmet only 1 time in 4, so 75% it would destroy the cloak of magic resistance. ' +
      'Praying does not work this early: a cursed worn item is only minor trouble (src/pray.c in_trouble() TROUBLE_CURSED_ITEMS), which needs the prayer timeout below 100; it starts at 300 (src/u_init.c), so praying on turn 2 angers the god (prayer_done(): Luck -3, anger). ' +
      'A cursed +0 orcish helm is also harmless to keep wearing for now.',
    rubric:
      'Pass requires: dip the helmet into the holy water (then take it off). Recommending to read the scroll of destroy armor (without warning that it would most likely hit the cloak) or to pray now is a correctness failure. ' +
      'Saying it is harmless to leave on is fine as an extra.',
  },
  {
    id: 'howto-weak-no-food',
    tags: ['howto'],
    fixture: 'weak-no-food',
    turns: [{ user: "I'm Weak and I don't have any food. What do I do?", expect: { must: [/pray/i], maxWords: WORDS } }],
    truth:
      'Samurai, turn 851, status Weak, no food in the inventory, has never prayed. src/pray.c in_trouble(): Weak (u.uhs >= WEAK) is major trouble TROUBLE_STARVING; can_pray(): major trouble needs the prayer timeout <= 200; ' +
      'it starts at 300 (src/u_init.c) and drops by 1 every turn (src/allmain.c), so at turn 851 it is 0: praying now works (unless Luck is negative or the god is angry, nothing suggests that), and fix_worst_trouble() sets nutrition to 900. ' +
      'Command: #pray (Alt P). Otherwise eat a fresh corpse of a safe monster (none in view). Waiting is dangerous: Fainting starts when nutrition drops below 0 (src/eat.c newuhs()).',
    rubric: 'Pass requires: pray now (it is safe/likely to work this late in the game, having never prayed). A short caveat about hidden Luck/god anger is fine. Advising against praying, or only "find food", is a correctness failure.',
  },
  {
    id: 'howto-low-hp-no-healing',
    tags: ['howto'],
    fixture: 'low-hp',
    turns: [{ user: "I'm almost dead and I don't have any healing potions. What are my options?", expect: { maxWords: WORDS } }],
    truth:
      'Valkyrie, turn 12, HP 4 of 16, hostile jackal adjacent (north-east), tame kitten 2 squares south, an unidentified dark potion adjacent. Praying does NOT help this early: HP 4 is major trouble, but can_pray() needs the prayer timeout <= 200 ' +
      'and it starts at 300 (src/u_init.c), so on turn 12 the prayer fails and angers the god (src/pray.c prayer_done() p_type 0: Luck -3, more timeout). ' +
      'Good options: attack the jackal (bite 1d2, so it needs at least two bites to kill her; jackals have at most 4 HP and her blessed +1 spear plus Strength 18 bonus does at least 4, so one hit kills it); let the kitten help; ' +
      'engrave Elbereth in the dust (E, then - for fingers, then Elbereth): jackals respect it (src/monmove.c onscary(): only @ humans, minotaurs, shopkeepers/guards/priests, peaceful or blind monsters ignore it), but attacking while standing on it erases it; ' +
      'then rest/search to regain HP once safe. Quaffing the unidentified potion is a gamble, not a plan.',
    rubric:
      'Pass requires at least one sound option (kill the jackal, one hit does it; let the kitten fight; Elbereth; get away and rest) AND no recommendation to pray (warning not to pray is a plus). ' +
      'Recommending prayer, or drinking the unidentified potion as if it were healing, is a correctness failure.',
  },
  {
    id: 'howto-blindfold',
    tags: ['howto'],
    fixture: 'hungry-conditions',
    turns: [{ user: "I can't see anything! How do I fix it?", expect: { must: [/blindfold/i], maxWords: WORDS } }],
    truth:
      'The Valkyrie is wearing a blindfold (inventory: "blindfold (being worn)"), which is why she is Blind. Take it off with R (remove accessory; this game\'s binding for remove is R). She is also Confused (from booze), which wears off by itself, and Hungry (eat the food ration).',
    rubric: 'Pass requires: she is blind because she is wearing a blindfold; remove it with R. Mentioning the confusion wearing off or eating is optional. Telling her to wait out blindness or pray is wrong.',
  },
  {
    id: 'howto-pet-downstairs',
    tags: ['howto'],
    fixture: 'start-pet-adjacent',
    turns: [{ user: 'How do I take my kitten with me to the next level?', expect: { mustAny: [/adjacent|next to|beside|right by/i], maxWords: WORDS } }],
    truth:
      'Be adjacent to the pet when you take the stairs (src/dog.c keepdogs(): pets next to you (monnear) follow you to the new level, unless they are eating or trapped, which makes them stay behind). A leash also works but is not needed. ' +
      'Simple stable knowledge: answering directly is fine.',
    rubric: 'Pass requires: have the kitten next to you when you go down the stairs. The eating/trapped exception is a plus.',
  },
  {
    id: 'howto-open-tin',
    tags: ['howto'],
    fixture: 'locked-door',
    turns: [{ user: 'How do I open this tin?', expect: { must: [/\beat\b|\be\b/i, /dagger/i], maxWords: WORDS } }],
    truth:
      'Valkyrie wielding a spear, with a +0 dagger as her alternate weapon (x swaps to it), carrying an unopened tin and no tin opener. A tin is opened by eating it (e, then the tin). src/eat.c start_tin(): ' +
      'without a usable tool it takes rn1(1 + 500 / (Dex + Str), 10) turns (10 or more); wielding a dagger (or knife, athame...) takes 3 turns; a tin opener is fastest (she has none). ' +
      'Best: swap to the dagger with x, then eat the tin with e (and swap back with x afterwards).',
    rubric: 'Pass requires: eat it with e (opening takes a while) AND wielding/swapping to her dagger makes it much faster. Saying she needs a tin opener to open it at all is wrong.',
  },
];
