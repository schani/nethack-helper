/**
 * Fixture recipes for evals/fixtures/capture.ts.  Same seed + same keys =
 * same game, so re-running a recipe reproduces its fixture (debug-mode
 * recipes use wizard commands: ^V level teleport, ^F map, ^T teleport,
 * ^W wish incl. terrain, ^G create monster).
 */
import type { Play, Recipe } from './capture.ts';

/** seed 33 elven Wizard: kill the goblin east of the hero with force bolt */
const killGoblin = (p: Play) => p.cmd('Zal');

/** teleport next to the first cell matching `re` (dx, dy from it) */
async function near(p: Play, re: RegExp, dx: number, dy: number, pick = 0) {
  const c = (await p.find(re))[pick];
  if (!c) throw new Error(`nothing matching ${re}`);
  await p.teleport(c.x + dx, c.y + dy);
}

const OBJ = /^[)[!?/="(*%+$]$/;

/** the object in the densest pile area of the level (a shop's wares), preferring `prefer` symbols */
async function shopItem(p: Play, prefer = '!?') {
  const { cells } = await p.g.cells();
  const objs = cells.filter((c) => OBJ.test(c.ch));
  const at = new Set(objs.map((c) => `${c.x},${c.y}`));
  const score = (c: { x: number; y: number; ch: string }) => {
    let n = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (at.has(`${c.x + dx},${c.y + dy}`)) n++;
    return n * 10 + (prefer.includes(c.ch) ? 5 : 0);
  };
  const best = objs.sort((a, b) => score(b) - score(a))[0];
  if (!best || score(best) < 50) throw new Error('no shop-like pile area on this level');
  return best;
}

/** a lit room floor square with `n` free floor squares to its east (and none of them next to objects) */
async function openFloor(p: Play, n = 4, nearest = false) {
  const { cells, hero } = await p.g.cells();
  const at = new Map(cells.map((c) => [`${c.x},${c.y}`, c]));
  const floor = (x: number, y: number) => /^(floor of a room|dark part of a room)$/.test(at.get(`${x},${y}`)?.desc ?? '');
  const cands = cells.filter((c) => {
    for (let i = 0; i <= n; i++) for (const dy of [-1, 0, 1]) if (!floor(c.x + i, c.y + dy)) return false;
    return true;
  });
  cands.sort((a, b) => Math.abs(a.x - hero.x) + Math.abs(a.y - hero.y) - (Math.abs(b.x - hero.x) + Math.abs(b.y - hero.y)));
  if (!cands.length) throw new Error('no open floor');
  return cands[nearest ? 0 : Math.floor(cands.length / 2)];
}

/** level-teleport down until the overview mentions a shop; map the level and detect objects */
async function findShopLevel(p: Play) {
  for (let lvl = 2; lvl <= 12; lvl++) {
    await p.levelport(lvl);
    const ov = (await p.st()).overview ?? [];
    const here = ov.findIndex((l) => /You are here/.test(l));
    if (here >= 0 && /store|shop|deli|emporium|bookstore|liquor|jewel|boutique|lighting/i.test(ov[here + 1] ?? '')) {
      await p.mapLevel();
      const pot = await p.wishGet('blessed potion of object detection');
      await p.raw('q', 500);
      await p.raw(pot, 900);
      await p.g.toCommand();
      return lvl;
    }
  }
  throw new Error('no shop found on levels 2-12');
}

/** teleport to (x, y) or the nearest square in that row not occupied by a monster */
async function freeTeleport(p: Play, x: number, y: number) {
  const { cells } = await p.g.cells();
  const busy = new Set(cells.filter((c) => /^[A-Za-z@]$/.test(c.ch)).map((c) => `${c.x},${c.y}`));
  for (const dx of [0, 1, -1, 2, -2]) for (const dy of [0, -1, 1]) if (!busy.has(`${x + dx},${y + dy}`)) return p.teleport(x + dx, y + dy);
  throw new Error('no free square');
}

/** take the main-dungeon down stairs of the current level (map it first; avoid the Mines branch stairs) */
async function descend(p: Play) {
  await p.mapLevel();
  const stairs = await p.find(/^staircase down$/);
  if (!stairs.length) throw new Error('no down staircase');
  for (const s of stairs) {
    await p.teleport(s.x, s.y);
    await p.cmd('>');
    const st = await p.st();
    if (st.levels[st.currentLevel!]?.info?.dungeon === 'The Dungeons of Doom') return;
    await p.cmd('<'); // that was the branch: back up, try the other one
  }
  throw new Error('no main-dungeon down staircase');
}

export const RECIPES: Recipe[] = [
  {
    id: 'start-pet-adjacent',
    description: 'Turn 1, elven Wizard on the up stairs of Dlvl 1; kitten adjacent north, fountain, goblin, scroll and potion in the room',
    seed: 33,
    steps: async () => {},
    notes: [
      "Hero: Agnes, chaotic female elven Wizard, XL 1, HP 11/11, Pw 9/9, AC 9, not hungry, turn 1, Dlvl 1, standing on the up staircase (branch staircase up).",
      "The tame kitten (f) is adjacent, directly north. A fountain is 2 squares north. A goblin (o, hostile) is 3 squares east. A scroll labeled ASHPD SODALG is 2 east and 1 south; a potion 5 east and 1 south; a closed door 6 east.",
      "Inventory is fully identified (Wizard starting kit): quarterstaff, cloak of magic resistance, wand of locking, rings of sustain ability and increase damage, potions of holy water/booze/oil, scrolls of destroy armor/magic mapping/identify, spellbooks of force bolt/confuse monster, magic marker, bell.",
    ],
  },
  {
    id: 'fountain-adjacent',
    description: 'Dlvl 1 after killing the goblin; a fountain is diagonally adjacent (up-left), kitten adjacent north',
    seed: 33,
    steps: async (p) => {
      await killGoblin(p);
      await p.cmd('u');
    },
    notes: [
      'The fountain is adjacent, 1 square northwest (up-left). The kitten is adjacent north.',
      'The up staircase (branch staircase up) is adjacent southwest. A goblin corpse lies 2 east and 1 south.',
      'HP 11/11; Pw 4/9 after casting force bolt; the goblin was killed (You kill the goblin!).',
    ],
  },
  {
    id: 'fountain-quaff-prompt',
    description: 'Standing on the fountain; the game asks "Drink from the fountain? [yn] (n)"',
    seed: 33,
    steps: async (p) => {
      await killGoblin(p);
      await p.cmd('u');
      await p.cmd('y');
      await p.raw('q', 700);
    },
    keepPrompt: true,
    notes: [
      'The hero stands on the fountain. Pending yes/no question: "Drink from the fountain? [yn] (n)" (default no).',
      'Answering n would then ask which potion to drink from the inventory instead.',
    ],
  },
  {
    id: 'more-prompt',
    description: 'Prayed far too early; the game shows --More-- after "You begin praying to Anhur. You finish your prayer."',
    seed: 33,
    steps: async (p) => {
      await killGoblin(p);
      await p.cmd('u');
      await p.raw('#pray\r', 600);
      await p.raw('y', 900);
    },
    keepPrompt: true,
    notes: [
      'The game waits at --More-- after "You begin praying to Anhur. You finish your prayer."',
      'The message log already shows the next line: "The voice of Anhur rings out:" (the god is about to speak; praying on turn ~5 is far too soon, prayer timeout).',
      'The player should press Enter to continue.',
    ],
  },
  {
    id: 'menu-open',
    description: 'The #call menu "What do you want to name?" is open after picking up an unidentified scroll',
    seed: 33,
    steps: async (p) => {
      await killGoblin(p);
      const s = (await p.find(/scroll/))[0];
      await p.g.walkTo(s.x, s.y);
      await p.g.pickUp(/scroll/);
      await p.g.toCommand();
      await p.raw('#call\r', 800);
    },
    keepPrompt: true,
    notes: [
      'A menu titled "What do you want to name?" is open with: m - a monster, i - a particular object in inventory, o - the type of an object in inventory, f - the type of an object upon the floor, d - the type of an object on discoveries list, a - record an annotation for the current level.',
      'The hero just picked up p - a scroll labeled ASHPD SODALG (unidentified).',
    ],
  },
  {
    id: 'unid-items',
    description: 'Valkyrie carrying several unidentified potions, scrolls, a ring, a wand and an amulet; one potion type is called "maybe healing"',
    seed: 7,
    role: 'Valkyrie',
    wizard: true,
    steps: async (p) => {
      await p.beginSetup();
      for (const w of ['potion', 'potion', 'scroll', 'scroll', 'ring', 'wand', 'amulet']) await p.wish(w);
      // call the type of the first wished potion
      const inv = (await p.st()).inventory.filter((i) => i.class_sym === '!');
      await p.raw('#call\r', 600);
      await p.raw('o', 500);
      await p.raw(inv[0].letter, 500);
      await p.raw('maybe healing\r', 600);
      await p.g.toCommand();
      await p.endSetup();
      await p.walk('ll');
    },
    notes: [
      "The wished potions, scrolls, ring (engagement), wand (forked) and amulet (concave) are unidentified (only appearances known). The murky potion type has been called \"maybe healing\" by the player (still unidentified).",
      "In 5.0 Valkyries start with a spear (not a long sword), a dagger and a small shield; these are identified. A hostile fox is adjacent south-east and just bit the hero (HP 13/16).",
    ],
  },
  {
    id: 'mines-arrival',
    description: 'Gnomish Mines level 1 (Dlvl 3) right after arriving from Dlvl 2 via the branch staircase (dark, nothing in view yet)',
    seed: 7,
    role: 'Valkyrie',
    wizard: true,
    steps: async (p) => {
      await p.beginSetup();
      await descend(p); // Dlvl 1 -> 2
      await p.mapLevel();
      const s = (await p.find(/^branch staircase down$|staircase down/)).find((c) => /branch/.test(c.desc)) ?? (await p.find(/staircase down/))[0];
      await p.teleport(s.x, s.y);
      await p.cmd('>');
      await p.endSetup();
      await p.walk('s');
    },
    notes: ['Hero arrived in the Gnomish Mines (mines level 1, Dlvl 3) from Dlvl 2 via the branch staircase and stands on the up staircase. Dlvl 1 and 2 were magic-mapped. Nothing notable is in view.'],
  },
  {
    id: 'multi-monster',
    description: 'Dlvl 1 room with several hostile monsters at different distances (newt, jackals, gnome lord) and the pet',
    seed: 7,
    role: 'Valkyrie',
    wizard: true,
    steps: async (p) => {
      await p.beginSetup();
      const f = await openFloor(p, 6, true);
      await p.teleport(f.x, f.y);
      await p.create('newt');
      await freeTeleport(p, f.x + 3, f.y);
      await p.create('gnome lord');
      await freeTeleport(p, f.x + 6, f.y);
      await p.create('jackal');
      await p.create('jackal');
      await p.endSetup();
      await p.cmd('s');
    },
    notes: [
      "Hostile jackals are adjacent west and east, a gnome lord 2 left and 1 down, a fox 4 west, a newt 5 west, the tame kitten 6 west. HP 16/16.",
    ],
  },
  {
    id: 'shop',
    description: 'Inside a shop (found by level-teleporting down), standing on an item for sale',
    seed: 7,
    role: 'Valkyrie',
    wizard: true,
    steps: async (p) => {
      await p.beginSetup();
      await findShopLevel(p);
      const item = await shopItem(p);
      await p.teleport(item.x, item.y);
      await p.endSetup();
      await p.cmd(':');
    },
    notes: [
      'The hero is inside a shop (shopkeeper: peaceful @) standing on an item for sale; the recent messages give its price.',
      'Unidentified wares cannot be identified from their appearance; price identification is a spoiler-level technique.',
    ],
  },
  {
    id: 'altar-sink',
    description: 'Dlvl 3 room: a lawful altar adjacent west, a sink two squares west, fountains in the room',
    seed: 7,
    role: 'Valkyrie',
    wizard: true,
    steps: async (p) => {
      await p.beginSetup();
      await p.levelport(3);
      await p.mapLevel();
      const f = await openFloor(p);
      await p.teleport(f.x, f.y);
      await p.wish('sink');
      await p.walk('l');
      await p.wish('lawful altar');
      await p.endSetup();
      await p.walk('l');
    },
    notes: [
      'A lawful altar is adjacent, 1 square west. A sink is 2 squares west. The hero (neutral Valkyrie) is not lawful, so the altar is cross-aligned.',

    ],
  },
  {
    id: 'trap-room',
    description: 'A level (found by level-teleporting down) with a known trap about two squares from the hero',
    seed: 7,
    role: 'Valkyrie',
    wizard: true,
    steps: async (p) => {
      await p.beginSetup();
      for (let lvl = 2; lvl <= 10; lvl++) {
        await p.levelport(lvl);
        await p.mapLevel();
        const traps = (await p.find(/trap|pit|hole|web/)).filter((c) => c.ch === '^');
        if (!traps.length) continue;
        const t = traps[0];
        await freeTeleport(p, t.x + 2, t.y);
        await p.endSetup();
        await p.cmd('s');
        return;
      }
      throw new Error('no level with a known trap');
    },
    notes: [
      "A known rust trap (^) is 2 squares west of the hero; a grid bug (x) is adjacent north; walls to the south. Other levels were visited on the way down (Dlvl 2 now).",
    ],
  },
  {
    id: 'deep-dlvl4',
    description: 'Dlvl 4 after descending from Dlvl 1 through 2 and 3 (each level magic-mapped, with a brief detour into Mines level 1); scroll shop on 4, general store on 3, Mines branch on 2',
    seed: 7,
    role: 'Valkyrie',
    wizard: true,
    steps: async (p) => {
      await p.beginSetup();
      await descend(p); // 1 -> 2
      await descend(p); // 2 -> 3
      await descend(p); // 3 -> 4
      await p.mapLevel();
      await p.endSetup();
      await p.walk('s');
    },
    notes: [
      "Levels remembered: Dlvl 1, 2, 3 and 4 (current, standing on its up staircase), plus Gnomish Mines level 1 (Dlvl 3, only its arrival stairs seen). Dlvl 2 has two down staircases: the branch staircase down to the Gnomish Mines (top middle, about 20 right and 8 up from its up staircase) and the main one (right side, about 60 right and 3 down from its up staircase). Dlvl 3 has a general store, Dlvl 4 a scroll shop (dungeon overview; their rooms are not identified on the maps).",
      "Level 1 down staircase: top-right part, about 55 right and 7 up from its up staircase. Current level: down staircase 47 left and 12 down from the hero.",
    ],
  },
  {
    id: 'low-hp',
    description: 'Valkyrie badly hurt (HP below a third) with hostile monsters adjacent',
    seed: 7,
    role: 'Valkyrie',
    wizard: true,
    steps: async (p) => {
      await p.beginSetup();
      await p.levelport(2);
      for (const m of ['hill orc', 'jackal', 'jackal']) await p.create(m);
      await p.endSetup();
      for (let i = 0; i < 80; i++) {
        const st = await p.st();
        const hp = Number(st.status?.fields.hp ?? 99);
        const max = Number(st.status?.fields.hp_max ?? 1);
        if (hp / max < 0.3) break;
        await p.cmd('ms');
      }
    },
    notes: [
      "Turn 12, HP 4 of 16 with a hostile jackal adjacent (north-east); the hill orc was killed by the kitten. HP 4 counts as major trouble, but the prayer timeout starts at 300 and must be below 200, so praying on turn 12 would not help. Retreat, fight the weak jackal carefully, or flee upstairs.",
    ],
  },
  {
    id: 'hungry-conditions',
    description: 'Hungry, confused (from booze) and blind (blindfold on)',
    seed: 7,
    role: 'Valkyrie',
    wizard: true,
    steps: async (p) => {
      await p.beginSetup();
      const fold = await p.wishGet('uncursed blindfold');
      const booze = await p.wishGet('uncursed potion of booze');
      for (let i = 0; i < 120; i++) {
        const st = await p.st();
        if (/hungry|weak/i.test(st.status?.fields.hunger ?? '')) break;
        await p.cmd('20s');
      }
      // booze adds a little nutrition: get a bit hungrier first so the hero stays Hungry
      await p.cmd('20s');
      await p.endSetup();
      await p.raw('q', 500);
      await p.raw(booze, 800);
      await p.g.toCommand();
      await p.raw('P', 500);
      await p.raw(fold, 800);
      await p.g.toCommand();
    },
    notes: ['Status shows Hungry; conditions include Conf (booze) and Blind (wearing a blindfold). While blind the map shows only remembered things.'],
  },
  {
    id: 'sokoban-arrival',
    description: 'Just arrived on the first Sokoban level (on its down staircase); boulders and pits/holes visible',
    seed: 7,
    role: 'Valkyrie',
    wizard: true,
    steps: async (p) => {
      await p.beginSetup();
      await p.raw('\x16', 500);
      await p.raw('?\r', 800);
      await p.raw('>', 500);
      await p.raw('E', 1200);
      await p.g.toCommand();
      const s = (await p.find(/staircase down/))[0];
      await p.teleport(s.x, s.y);
      await p.endSetup();
      await p.cmd(':');
    },
    notes: [
      "First Sokoban level (entered from below); the hero stands on the down staircase; the up staircase is 2 squares north. Boulders lie to the west and east, pits to the north-east, a line of pits/holes further north. The level may be mirrored in 5.0.",
    ],
  },
  {
    id: 'minetown',
    description: 'Minetown: temple, shops, watchmen and peaceful gnomes around',
    seed: 7,
    role: 'Valkyrie',
    wizard: true,
    steps: async (p) => {
      await p.beginSetup();
      await p.raw('\x16', 500);
      await p.raw('?\r', 800);
      await p.raw('>', 500);
      await p.raw('w', 1200);
      await p.g.toCommand();
      await p.endSetup();
      await p.walk('s');
    },
    notes: ['Hero is in Minetown (Gnomish Mines). Look for the temple altar, the priest, shopkeepers and watchmen (peaceful).'],
  },
  {
    id: 'not-running',
    description: 'The game is not running (server up, no NetHack process)',
    seed: 33,
    noGame: true,
    steps: async () => {},
    notes: ['No game is running. Game tools report that the game is not running; general NetHack questions can still be answered.'],
  },
  {
    id: 'char-creation',
    description: 'The game just started and asks "Shall I pick character\'s race, role, gender and alignment for you? [ynaq]"',
    seed: 33,
    role: 'none',
    rawStart: true,
    steps: async () => {},
    keepPrompt: true,
    notes: ['Character creation: no map, no status yet. The game asks whether it should pick race, role, gender and alignment.'],
  },
];
