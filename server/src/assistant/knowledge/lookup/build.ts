// Builds the nethack_lookup data (LookupData) from a clean NetHack 5.0.0 source tree: monsters (include/monsters.h),
// objects (include/objects.h; appearance shuffling as in src/o_init.c, extra weapon damage from src/weapon.c),
// artifacts (include/artilist.h), starting inventory (src/u_init.c) and intrinsics by level (src/attrib.c).
// Needs a C preprocessor (`cpp`). Run via scripts/gen-nethack-data.ts, which writes nethack-5.0.json.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  artifactCppInput, intConstants, monsterCppInput, objectCppInput, parseArtifacts, parseDamageBonuses, parseInitSwitch, parseIntrinsics, parseInvSubs,
  parseMonsterSymbols, parseMonsters, parseObjects, parseRollFrom, parseTrobjArrays, parseTrobjChoices, shuffledGroups,
  type GameObject, type InvItem, type Monster,
} from './parse.ts';
import { normalize, type LookupData, type LookupEntry } from './index.ts';
import { parseChangelog } from '../changelog.ts';

export function buildLookupData(srcDir: string): LookupData {
  const read = (rel: string) => fs.readFileSync(path.join(srcDir, rel), 'utf8');
  const cpp = (input: string) => execFileSync('cpp', ['-P', '-undef', '-nostdinc', '-w'], { input, encoding: 'utf8', maxBuffer: 64 << 20 });

  const consts = { ...intConstants(read('include/weight.h')), ...intConstants(read('include/align.h')), ...intConstants(read('include/objclass.h')) };
  const monsters = parseMonsters(cpp(monsterCppInput(read('include/monsters.h'))), parseMonsterSymbols(read('include/defsym.h')), consts);
  const objs = parseObjects(cpp(objectCppInput(read('include/objects.h'))), consts);
  const groups = shuffledGroups(objs);
  const dmgBonus = parseDamageBonuses(read('src/weapon.c'));
  const uInit = read('src/u_init.c');
  const trobjs = parseTrobjArrays(uInit);
  const choices = parseTrobjChoices(uInit);
  const roleInit = parseInitSwitch(uInit, 'u_init_role');
  const raceInit = parseInitSwitch(uInit, 'u_init_race');
  const invSubs = parseInvSubs(uInit);
  const instruments = parseRollFrom(uInit);
  const intrinsics = parseIntrinsics(read('src/attrib.c'));
  const artifacts = parseArtifacts(cpp(artifactCppInput(read('include/artilist.h'))));
  if (monsters.length < 380 || objs.length < 400) throw new Error(`suspiciously few entries: ${monsters.length} monsters, ${objs.length} objects`);

  const lc = (s: string) => s.toLowerCase();
  const words = (e: string) => e.toLowerCase().replace(/_/g, ' ');
  const list = (xs: string[]) => xs.join(', ');

  // ------------------------------------------------------------------ objects
  const CLASS_PREFIX: Record<string, string> = { potion: 'potion of ', scroll: 'scroll of ', wand: 'wand of ', ring: 'ring of ', spellbook: 'spellbook of ' };
  const APPEARANCE_NOUN: Record<string, string> = { potion: 'potion', scroll: 'scroll', wand: 'wand', ring: 'ring', spellbook: 'spellbook', amulet: 'amulet', helmet: 'helmet', gloves: 'gloves', cloak: 'cloak', boots: 'boots' };
  const displayName = (o: GameObject) => {
    if (!o.name) return null;
    if (o.unique || o.class === 'amulet' || /^(?:Book of the Dead|novel)$/.test(o.name)) return o.name;
    return (CLASS_PREFIX[o.class] ?? '') + o.name;
  };
  const byEnum = new Map(objs.map((o) => [o.enum, o]));
  const nameOf = (e: string) => {
    const o = byEnum.get(e);
    return o ? (displayName(o) ?? e) : words(e);
  };
  const PROP: Record<string, string> = {
    FAST: 'speed', FLYING: 'flying', ANTIMAGIC: 'magic resistance', REFLECTING: 'reflection', TELEPAT: 'telepathy', SEE_INVIS: 'see invisible',
    INVIS: 'invisibility', DISPLACED: 'displacement', STEALTH: 'stealth', FUMBLING: 'fumbling', LEVITATION: 'levitation', WWALKING: 'water walking',
    JUMPING: 'jumping', PROTECTION: 'protection', LIFESAVED: 'life saving', STRANGLED: 'strangulation', SLEEPY: 'falling asleep', UNCHANGING: 'unchanging',
    MAGICAL_BREATHING: 'magical breathing', POISON_RES: 'poison resistance', FIRE_RES: 'fire resistance', COLD_RES: 'cold resistance',
    SHOCK_RES: 'shock resistance', SLEEP_RES: 'sleep resistance', DISINT_RES: 'disintegration resistance', ACID_RES: 'acid resistance',
    STONE_RES: 'petrification resistance', DRAIN_RES: 'drain resistance', SICK_RES: 'sickness resistance', FREE_ACTION: 'free action',
    REGENERATION: 'regeneration', SEARCHING: 'automatic searching', HUNGER: 'hunger', AGGRAVATE_MONSTER: 'aggravate monster', CONFLICT: 'conflict',
    WARNING: 'warning', TELEPORT: 'teleportitis', TELEPORT_CONTROL: 'teleport control', POLYMORPH: 'polymorphitis', POLYMORPH_CONTROL: 'polymorph control',
    ADORNED: 'adornment', SLOW_DIGESTION: 'slow digestion', HALF_SPDAM: 'half spell damage', HALF_PHDAM: 'half physical damage',
    CLAIRVOYANT: 'clairvoyance', ENERGY_REGENERATION: 'energy regeneration', INFRAVISION: 'infravision', BLINDED: 'blindness', CONFUSION: 'confusion', HALLUC: 'hallucination',
  };
  const SLOT: Record<string, string> = { ARM_SUIT: 'body armor', ARM_SHIELD: 'shield', ARM_HELM: 'helmet', ARM_GLOVES: 'gloves', ARM_BOOTS: 'boots', ARM_CLOAK: 'cloak', ARM_SHIRT: 'shirt' };
  const STRIKE: Record<string, string> = { P: 'piercing', S: 'slashing', B: 'blunt', PIERCE: 'piercing', SLASH: 'slashing', WHACK: 'blunt' };
  const skillName = (sub: string) => {
    const m = /^(-)?P_(\w+)$/.exec(sub.trim());
    if (!m || m[2] === 'NONE') return null;
    const w = words(m[2]).replace(/ spell$/, ' spells');
    return m[1] ? `ammunition (fired with a ${w})` : `${w} skill`;
  };

  // appearance lists of the randomized groups (all descriptions in the shuffled range, incl. extra scroll labels)
  const appearances: Record<string, string[]> = {};
  for (const o of objs) {
    const g = groups.get(o.enum);
    if (g && o.desc) (appearances[g] ??= []).push(o.desc);
  }

  const objectEntries: LookupEntry[] = [];
  for (const o of objs.slice(1)) {
    const name = displayName(o);
    if (!name || name.startsWith('generic ')) continue;
    const group = groups.get(o.enum);
    const lines: string[] = [];
    const spoiler: string[] = [];
    const cls = o.class;
    if (group) lines.push(`Appearance: random each game (one of the ${appearances[group].length} ${APPEARANCE_NOUN[group]} appearances); its appearance cannot tell you what it is.`);
    else if (o.desc) lines.push(`Appearance: always "${o.desc}"${cls === 'gem' ? ' (other gems and glass can look the same)' : ' (not randomized)'}.`);
    if (cls === 'weapon' || (cls === 'tool' && (o.sdam || o.ldam))) {
      const lb = dmgBonus.large[o.enum];
      const sb = dmgBonus.small[o.enum];
      if (o.sdam || o.ldam) lines.push(`Damage: d${o.sdam}${sb ? sb : ''} vs small/medium, d${o.ldam}${lb ? lb : ''} vs large monsters${o.oc1 ? `; to-hit ${o.oc1 > 0 ? '+' : ''}${o.oc1}` : ''}.`);
      const sk = skillName(o.sub);
      lines.push([sk ? `Uses the ${sk}` : '', o.twoHanded ? 'two-handed' : '', STRIKE[o.dir.split('|')[0].trim()] ?? ''].filter(Boolean).join('; ') + '.');
    }
    if (cls === 'armor') {
      lines.push(`Armor: ${SLOT[o.sub] ?? words(o.sub)}, improves AC by ${o.oc1}, magic cancellation ${o.oc2}${o.delay ? `, takes ${o.delay} turns to put on` : ''}.`);
    }
    if (o.prop && ['armor', 'ring', 'amulet', 'tool', 'weapon'].includes(cls)) lines.push(`Gives: ${PROP[o.prop] ?? words(o.prop)} (when worn${cls === 'weapon' ? ' or wielded' : ''}).`);
    if (cls === 'food') lines.push(`Nutrition ${o.nutrition}, takes ${o.delay} turn${o.delay === 1 ? '' : 's'} to eat.`);
    if (cls === 'spellbook' && o.oc2) lines.push(`Spell level ${o.oc2}${skillName(o.sub) ? ` (${skillName(o.sub)!.replace(/ skill$/, '')} school)` : ''}${o.dir && o.dir !== '0' ? `, ${words(o.dir).replace('nodir', 'non-directional').replace('immediate', 'directional').replace('ray', 'ray (bounces)')}` : ''}.`);
    if (cls === 'wand') lines.push(`Wand type: ${o.dir === 'NODIR' ? 'non-directional' : o.dir === 'IMMEDIATE' ? 'directional (beam)' : o.dir === 'RAY' ? 'ray (bounces off walls)' : words(o.dir)}.`);
    lines.push(`Weight ${o.weight}, material ${o.material}${o.magic ? ', magical' : ''}${o.unique ? ', unique' : ''}${o.nowish ? ', cannot be wished for' : ''}.`);
    const priceLine = `Base price ${o.cost} zorkmids.`;
    const probLine = o.prob ? `Generation probability ${o.prob} per 1000 of its class.` : 'Never randomly generated.';
    if (group) {
      spoiler.push(`${priceLine} (price identification)`, `${probLine} (how common it is)`);
    } else {
      lines.push(priceLine, probLine);
    }
    const aliases = [o.name!, ...(cls === 'spellbook' ? [`${o.name} spellbook`, `book of ${o.name}`] : []), ...(CLASS_PREFIX[cls] ? [`${o.name} ${cls}`] : [])].filter((x) => lc(x) !== lc(name));
    objectEntries.push({ kind: 'object', name, aliases, heading: `${name} (${cls}${cls === 'armor' ? `, ${SLOT[o.sub] ?? ''}` : ''})`, source: 'include/objects.h', lines, spoiler });
  }

  // appearance entries: "fizzy potion", "forked wand", ...
  const appearanceEntries: LookupEntry[] = [];
  for (const [group, descs] of Object.entries(appearances)) {
    const noun = APPEARANCE_NOUN[group];
    for (const d of descs) {
      const nm = /^(?:pair of |set of )/.test(d) || group === 'scroll' ? `${noun} labeled ${d}` : `${d} ${noun}`;
      appearanceEntries.push({
        kind: 'appearance',
        name: group === 'scroll' ? `scroll labeled ${d}` : nm,
        aliases: [d, `${d} ${noun}`],
        heading: `"${d}" (${noun} appearance)`,
        source: 'include/objects.h, src/o_init.c',
        lines: [
          `"${d}" is one of the ${descs.length} ${noun} appearances that are shuffled randomly in every game, so it can be any of the randomized ${noun} types; nobody can tell which from the appearance alone (it has to be identified).`,
        ],
        spoiler: [],
      });
    }
  }
  // fixed appearances of objects in shuffled classes (e.g. clear potion = water)
  for (const o of objs) {
    const g = o.desc && !groups.get(o.enum) && ['potion', 'scroll', 'spellbook', 'amulet'].includes(o.class) ? o.class : null;
    if (!g || !o.name) continue;
    const nm = g === 'scroll' ? `scroll labeled ${o.desc}` : `${o.desc} ${g}`;
    appearanceEntries.push({
      kind: 'appearance',
      name: nm,
      aliases: [`${o.desc} ${g}`],
      heading: `"${o.desc}" (${g} appearance)`,
      source: 'include/objects.h, src/o_init.c',
      lines: [`"${o.desc}" is a fixed appearance (not shuffled): it is always the ${displayName(o)}.`],
      spoiler: [],
    });
  }

  // class overviews: "amulet", "wands", ... (all types; appearances are random, never mapped)
  for (const [cls, group] of [['amulet', 'amulet'], ['ring', 'ring'], ['wand', 'wand'], ['potion', 'potion'], ['scroll', 'scroll'], ['spellbook', 'spellbook']] as const) {
    const names = objs.filter((o) => o.class === cls && o.name && !o.name.startsWith('generic ')).map((o) => displayName(o)!);
    objectEntries.push({
      kind: 'object',
      name: cls,
      aliases: [`${cls} types`, `all ${cls}s`, `list of ${cls}s`],
      heading: `${cls}s (object class)`,
      source: 'include/objects.h, src/o_init.c',
      lines: [
        `All ${names.length} ${cls} types: ${names.join(', ')}.`,
        `Appearances are shuffled every game (${appearances[group]?.length ?? 0} possible: ${(appearances[group] ?? []).join(', ')}), so an unidentified one's appearance never tells which type it is.`,
      ],
      spoiler: [],
    });
  }

  // ------------------------------------------------------------------ price identification (src/shk.c + base prices)
  const PRICE_GROUPS: [string, string][] = [
    ['potion', 'Potions'], ['scroll', 'Scrolls'], ['ring', 'Rings'], ['wand', 'Wands'], ['amulet', 'Amulets'], ['spellbook', 'Spellbooks'],
    ['helmet', 'Helmets with random appearances'], ['gloves', 'Gloves'], ['cloak', 'Cloaks with random appearances'], ['boots', 'Boots with random appearances'],
  ];
  const priceGroups = PRICE_GROUPS.map(([g, label]) => {
    const members = objs.filter((o) => o.name && !o.name.startsWith('generic ') && (groups.get(o.enum) === g || (['potion', 'scroll', 'spellbook'].includes(g) && o.class === g && o.desc && !o.unique && o.name !== 'novel')));
    const byCost = new Map<number, string[]>();
    for (const o of members) byCost.set(o.cost, [...(byCost.get(o.cost) ?? []), o.name === 'water' ? 'water (uncursed water counts as 0)' : o.name!]);
    return `${label}: ${[...byCost].sort((x, y) => x[0] - y[0]).map(([c, ns]) => `${c}: ${ns.join(', ')}`).join('; ')}.`;
  });
  // asking prices per Charisma band, with src/shk.c get_cost()'s integer rounding, for every base price above
  const bases = [...new Set(PRICE_GROUPS.flatMap(([g]) => objs.filter((o) => o.name && groups.get(o.enum) === g).map((o) => o.cost)))].sort((x, y) => x - y);
  const ask = (base: number, mul: number, div: number) => {
    let t = (base || 5) * mul;
    if (div > 1) t = Math.floor((Math.floor((t * 10) / div) + 5) / 10);
    return Math.max(1, t);
  };
  const CHA: [string, number, number][] = [['5 or less', 2, 1], ['6-7', 3, 2], ['8-10', 4, 3], ['11-15', 1, 1], ['16-17', 3, 4], ['18', 2, 3], ['19+', 1, 2]];
  const askTable = CHA.map(([band, m, d]) => `Cha ${band}: ${bases.map((b) => `base ${b} costs ${ask(b, m, d)} (${ask(b, m * 4, d * 3)} surcharged)`).join(', ')}`).join('. ');
  const priceEntry: LookupEntry = {
    kind: 'mechanic',
    name: 'price identification',
    aliases: ['price id', 'price-id', 'price identify', 'price trick', 'shop prices', 'shop price', 'selling price', 'buying price', 'base price'],
    heading: 'price identification (shop prices)',
    source: 'src/shk.c, include/objects.h',
    lines: ['Gist: shop prices follow from an item\'s base price, so they narrow down what an unidentified item can be (to a group of same-priced types, rarely a single one). How to do it is spoiler-level.'],
    spoiler: [
      'BUYING (src/shk.c get_cost()): the base price; times 4/3 if this unidentified object is one of the 1 in 4 (by its object id) that carry a surcharge; times 4/3 when wearing a dunce cap, as a Tourist below experience level 15, or with a visible Hawaiian shirt; then by Charisma: 5 or less x2, 6-7 x3/2, 8-10 x4/3, 11-15 x1, 16-17 x3/4, 18 x2/3, 19+ x1/2 (rounded). An angry shopkeeper adds 1/3.',
      `Asking prices by Charisma (no dunce cap / Tourist shirt), normal price first and the price with the 1 in 4 surcharge in parentheses, rounded like the game: ${askTable}. Find the asking price in the row for the hero's Charisma: a match on the normal price means that base without surcharge, a match in parentheses means that base with the surcharge.`,
      'SELLING (src/shk.c set_cost()): the shopkeeper offers half the base price (a third with a dunce cap, as a low-level Tourist or with a visible shirt); for unidentified items, one shopkeeper in four only offers 3/4 of that.',
      `Base prices of the items with random appearances (include/objects.h): ${priceGroups.join(' ')}`,
    ],
  };

  // ------------------------------------------------------------------ monsters
  const ALIGN = (a: number) => (!Number.isFinite(a) || a === -128 ? 'unaligned (Moloch)' : a > 0 ? `lawful (${a})` : a < 0 ? `chaotic (${a})` : 'neutral (0)');
  const QUEST_SOUND = /^(?:leader|nemesis|guardian)$/;
  const monsterEntries: LookupEntry[] = monsters.map((m: Monster) => {
    const lines: string[] = [];
    if (m.names) lines.push(`Names: ${m.names[0]} (male), ${m.names[1]} (female), ${m.names[2]} (gender-neutral form).`);
    lines.push(`Level ${m.level}, speed ${m.speed}, AC ${m.ac}, magic resistance ${m.mr}, alignment ${ALIGN(m.align)}, difficulty ${m.difficulty}.`);
    lines.push(`Attacks: ${m.attacks.length ? m.attacks.map((a) => [a.type, a.dice === '0d0' ? '' : a.dice, a.damage].filter(Boolean).join(' ')).join(', ') : 'none'}.`);
    const corpse = m.gen.includes('leaves no corpse') ? 'leaves no corpse' : m.conveys.length ? `eating the corpse can give: ${list(m.conveys.map((r) => `${r} resistance`))}` : '';
    lines.push(`Resists: ${m.resists.length ? list(m.resists) : 'nothing'}${corpse ? `; ${corpse}` : ''}.`);
    const traits = m.flags.filter((f) => !/^(?:carnivore|herbivore|omnivore|infravisible|proper name)$/.test(f));
    if (traits.length) lines.push(`Traits: ${list(traits)}.`);
    const gen = m.gen.filter((g) => g !== 'leaves no corpse');
    lines.push(`Generation: ${m.gen.includes('not randomly generated') || !m.freq ? 'not randomly generated' : `frequency ${m.freq} (1 rare to 5 very common)`}${gen.filter((g) => g !== 'not randomly generated').length ? `, ${list(gen.filter((g) => g !== 'not randomly generated'))}` : ''}.`);
    lines.push(`Size ${m.size}, weight ${m.weight}, nutrition ${m.nutrition}.`);
    const spoilerTag = QUEST_SOUND.test(m.sound) ? `quest ${m.sound}` : m.gen.includes('unique') ? 'unique special-level or endgame monster' : '';
    return {
      kind: 'monster',
      name: m.name,
      aliases: (m.names ?? []).filter((n) => n !== m.name),
      heading: `${m.name} (${m.sym}, ${m.symClass})`,
      source: 'include/monsters.h',
      lines: spoilerTag ? [] : lines,
      spoiler: spoilerTag ? [`(${spoilerTag}) ${lines.join(' ')}`] : [],
    };
  });

  // ------------------------------------------------------------------ roles and races
  const ROLE_PREFIX: Record<string, string> = {
    arc: 'PM_ARCHEOLOGIST', bar: 'PM_BARBARIAN', cav: 'PM_CAVE_DWELLER', hea: 'PM_HEALER', kni: 'PM_KNIGHT', mon: 'PM_MONK', pri: 'PM_CLERIC',
    ran: 'PM_RANGER', rog: 'PM_ROGUE', sam: 'PM_SAMURAI', tou: 'PM_TOURIST', val: 'PM_VALKYRIE', wiz: 'PM_WIZARD',
    dwa: 'PM_DWARF', elf: 'PM_ELF', gno: 'PM_GNOME', orc: 'PM_ORC', hum: 'PM_HUMAN',
  };
  const ROLE_NAME: Record<string, { name: string; aliases: string[] }> = {
    PM_CAVE_DWELLER: { name: 'Caveman', aliases: ['cavewoman', 'cave dweller', 'caveperson'] },
    PM_CLERIC: { name: 'Priest', aliases: ['priestess', 'cleric'] },
  };
  const roleName = (pm: string) => ROLE_NAME[pm]?.name ?? words(pm.replace(/^PM_/, '')).replace(/^\w/, (c) => c.toUpperCase());
  const INTRINSIC: Record<string, string> = {
    Fast: 'speed', Searching: 'automatic searching', Stealth: 'stealth', Infravision: 'infravision', See_invisible: 'see invisible', Warning: 'warning',
    Teleport_control: 'teleport control', Poison_resistance: 'poison resistance', Cold_resistance: 'cold resistance', Fire_resistance: 'fire resistance',
    Shock_resistance: 'shock resistance', Sleep_resistance: 'sleep resistance', Sick_resistance: 'sickness resistance', Regeneration: 'regeneration',
  };
  const intrinsicLine = (prefix: string) => {
    const xs = intrinsics[prefix] ?? [];
    return xs.length ? `Intrinsics by experience level (src/attrib.c): ${xs.map((x) => `XL ${x.level} ${INTRINSIC[x.prop] ?? words(x.prop)}`).join(', ')}.` : 'No intrinsics from experience levels (src/attrib.c).';
  };
  const CLASS_WORD: Record<string, string> = { WEAPON_CLASS: 'weapon', ARMOR_CLASS: 'armor', RING_CLASS: 'ring', AMULET_CLASS: 'amulet', TOOL_CLASS: 'tool', FOOD_CLASS: 'food item', POTION_CLASS: 'potion', SCROLL_CLASS: 'scroll', SPBOOK_CLASS: 'spellbook', WAND_CLASS: 'wand', GEM_CLASS: 'gem' };
  const itemText = (it: InvItem) => {
    const q = it.qmin === it.qmax ? it.qmin : `${it.qmin}-${it.qmax}`;
    if (it.otyp === 'UNDEF_TYP') return `${q} random ${CLASS_WORD[it.cls] ?? lc(it.cls)}${Number(q) === 1 ? '' : 's'}`;
    const o = byEnum.get(it.otyp);
    const spe = it.spe !== 'UNDEF_SPE' && ['WEAPON_CLASS', 'ARMOR_CLASS'].includes(it.cls) ? `${Number(it.spe) >= 0 ? '+' : ''}${Number(it.spe)} ` : '';
    const bless = it.bless === '1' ? 'blessed ' : '';
    const n = o ? displayName(o)! : words(it.otyp);
    const plural = q === 1 ? n : / of /.test(n) ? n.replace(/^(\S+)/, (w) => (/s$/.test(w) ? w : `${w}s`)) : /s$/.test(n) ? n : `${n}s`;
    return `${q === 1 ? '' : `${q} `}${bless}${spe}${plural}`;
  };
  const listText = (name: string): string => {
    if (name.endsWith('[]')) return `one of: ${(choices[name.slice(0, -2)] ?? []).map(listText).join(' / ')}`;
    return (trobjs[name] ?? []).map(itemText).join(', ');
  };
  const roleEntries: LookupEntry[] = Object.entries(roleInit).map(([pm, r]) => {
    const prefix = Object.keys(ROLE_PREFIX).find((k) => ROLE_PREFIX[k] === pm)!;
    const base = r.inv.filter((x) => !x.cond).map((x) => listText(x.list)).join(', ');
    const extras = r.inv.filter((x) => x.cond).map((x) => `${x.cond}: ${listText(x.list)}`);
    const lines = [
      `Starting inventory (src/u_init.c): ${base}.`,
      ...(extras.length ? [`Extra items: ${extras.join('; ')}.`] : []),
      ...(r.notes.length ? [`Also: ${r.notes.join('; ')}.`] : []),
      'Race substitutions apply (e.g. elves get elven versions of daggers, spears and bows; orcs orcish ones; dwarves dwarvish spears and helmets).',
      intrinsicLine(prefix),
    ];
    const name = roleName(pm);
    return { kind: 'role', name, aliases: ROLE_NAME[pm]?.aliases ?? [], heading: `${name} (role)`, source: 'src/u_init.c, src/attrib.c', lines, spoiler: [] };
  });
  const raceEntries: LookupEntry[] = ['PM_HUMAN', 'PM_ELF', 'PM_DWARF', 'PM_GNOME', 'PM_ORC'].map((pm) => {
    const prefix = Object.keys(ROLE_PREFIX).find((k) => ROLE_PREFIX[k] === pm)!;
    const subs = invSubs.filter((s) => s.race === pm).map((s) => `${nameOf(s.to)} instead of ${nameOf(s.from)}`);
    const extras = (raceInit[pm]?.inv ?? []).map((x) => `${x.cond ? `${x.cond}: ` : ''}${x.list === 'Instrument' ? `one random instrument (${instruments.map(nameOf).join(', ')})` : listText(x.list)}`);
    const lines = [
      ...(subs.length ? [`Starting inventory substitutions (src/u_init.c): ${subs.join('; ')}.`] : []),
      ...(extras.length ? [`Extra starting items: ${extras.join('; ')}.`] : []),
      intrinsicLine(prefix),
    ];
    const name = words(pm.replace(/^PM_/, ''));
    return { kind: 'race', name, aliases: [], heading: `${name} (race)`, source: 'src/u_init.c, src/attrib.c', lines, spoiler: [] };
  });

  // ------------------------------------------------------------------ artifacts
  const AD_WORD: Record<string, string> = { AD_PHYS: '', AD_DRLI: 'level drain', AD_COLD: 'cold', AD_FIRE: 'fire', AD_ELEC: 'shock', AD_STUN: 'stun', AD_DRST: 'poison', AD_MAGM: 'magic missiles' };
  const SPFX: Record<string, string> = {
    SPFX_NOGEN: 'never randomly generated', SPFX_INTEL: 'intelligent (self-willed; may blast you if you are not its alignment)', SPFX_SEEK: 'helps searching',
    SPFX_SEARCH: 'automatic searching', SPFX_WARN: 'warning', SPFX_DRLI: 'drains levels', SPFX_BEHEAD: 'can behead', SPFX_HALRES: 'hallucination resistance',
    SPFX_ESP: 'telepathy', SPFX_STLTH: 'stealth', SPFX_REGEN: 'regeneration', SPFX_EREGEN: 'energy regeneration', SPFX_HSPDAM: 'half spell damage',
    SPFX_HPHDAM: 'half physical damage', SPFX_TCTRL: 'teleport control', SPFX_LUCK: 'acts as a luckstone', SPFX_XRAY: 'X-ray vision', SPFX_REFLECT: 'reflection',
    SPFX_PROTECT: 'protection',
  };
  const SKIP_SPFX = /^SPFX_(?:RESTR|ATTK|DEFN|SPEAK|DMONS|DCLAS|DFLAG1|DFLAG2|DALIGN|DBONUS|NONE)$/;
  const ALIGN_WORD: Record<string, string> = { A_LAWFUL: 'lawful', A_NEUTRAL: 'neutral', A_CHAOTIC: 'chaotic', A_NONE: 'unaligned' };
  const targetText = (a: (typeof artifacts)[number]) => {
    const t = a.target;
    if (a.spfx.includes('SPFX_DFLAG2') || a.spfx.includes('SPFX_DFLAG1')) return `against ${words(t.replace(/^M\d_/, ''))}s`;
    if (a.spfx.includes('SPFX_DCLAS')) return `against ${words(t.replace(/^S_/, ''))}s`;
    if (a.spfx.includes('SPFX_DMONS')) return `against ${words(t.replace(/^PM_/, ''))}`;
    if (a.spfx.includes('SPFX_DALIGN')) return 'against cross-aligned monsters';
    return 'against all targets';
  };
  const artifactEntries: LookupEntry[] = artifacts.map((a) => {
    const lines: string[] = [];
    const role = a.role !== 'NON_PM' ? roleName(a.role) : '';
    const race = a.race !== 'NON_PM' ? words(a.race.replace(/^PM_/, '')) : '';
    lines.push(`Artifact ${nameOf(a.base)}; alignment ${ALIGN_WORD[a.align] ?? words(a.align)}${role ? `; ${role} artifact` : ''}${race ? `; ${race} artifact` : ''}.`);
    if (a.attack.ad && (a.attack.n || a.attack.d)) {
      const dmg = a.attack.d ? `+1d${a.attack.d} damage` : 'double damage';
      lines.push(`Attack bonus ${targetText(a)}: +1d${a.attack.n} to hit, ${dmg}${AD_WORD[a.attack.ad] ? ` (${AD_WORD[a.attack.ad]})` : ''}.`);
    }
    const res = (ad: string) => (ad === 'AD_MAGM' ? 'magic' : AD_WORD[ad] || words(ad.replace(/^AD_/, '')));
    if (a.defense.ad) lines.push(`When wielded: ${res(a.defense.ad)} resistance.`);
    if (a.carried.ad) lines.push(`When carried: ${res(a.carried.ad)} resistance.`);
    const w = a.spfx.filter((f) => !SKIP_SPFX.test(f)).map((f) => SPFX[f] ?? words(f.replace(/^SPFX_/, '')));
    const c = a.cspfx.filter((f) => !SKIP_SPFX.test(f)).map((f) => SPFX[f] ?? words(f.replace(/^SPFX_/, '')));
    if (w.length) lines.push(`Properties: ${list(w)}.`);
    if (c.length) lines.push(`When carried: ${list(c)}.`);
    const INVOKE: Record<string, string> = { LEV_TELE: 'level teleport', CREATE_PORTAL: 'a portal out of the dungeon branch', ENLIGHTENING: 'enlightenment', CREATE_AMMO: 'creating arrows', CHARGE_OBJ: 'charging an object', OBJ_DETECTION: 'object detection', BLINDING_RAY: 'a blinding ray', FLING_POISON: 'flinging poison' };
    if (a.invoke && a.invoke !== '0') lines.push(`Can be #invoked for: ${INVOKE[a.invoke] ?? words(a.invoke)}.`);
    lines.push(`Base value ${a.cost} zorkmids.`);
    const quest = /^The /.test(a.name);
    return {
      kind: 'artifact',
      name: a.name,
      aliases: quest ? [a.name.replace(/^The /, '')] : [],
      heading: `${a.name} (${quest ? 'quest artifact' : 'artifact'})`,
      source: 'include/artilist.h',
      lines: quest ? [] : lines,
      spoiler: quest ? [`(quest artifact) ${lines.join(' ')}`] : [],
    };
  });

  // "new objects: amulets of flying and guarding, ..." / "new monsters: ..." in the changelog's General New Features
  const newNames = new Set<string>();
  for (const e of parseChangelog(read('doc/fixes5-0-0.txt'))) {
    const m = /^new (?:objects|monsters|shields?|wands?|rings?|amulets?|tools?|armor|weapons?|potions?|scrolls?|spells?|spellbooks?):\s*(.*)$/i.exec(e.text);
    if (!m || !/New Features/.test(e.section)) continue;
    let prefix = '';
    for (let t of m[1].replace(/\([^)]*\)/g, '').split(/,\s*|\s+and\s+/)) {
      t = t.trim().replace(/^(?:set|pair) of /, '');
      if (!t) continue;
      const of = /^(.*? of )/.exec(t);
      if (of) prefix = of[1];
      else if (prefix && !objs.some((o) => o.name === t) && !monsters.some((x) => x.name === t)) t = prefix + t;
      newNames.add(normalize(t));
    }
  }
  for (const e of [...monsterEntries, ...objectEntries]) {
    if (newNames.has(normalize(e.name))) e.lines.unshift('New in NetHack 5.0 (doc/fixes5-0-0.txt).');
  }
  for (const e of objectEntries) {
    if (!e.heading.endsWith('(object class)')) continue;
    const fresh = objectEntries.filter((x) => x.lines[0]?.startsWith('New in NetHack 5.0') && x.heading.startsWith(`${x.name} (${e.name}`)).map((x) => x.name);
    if (fresh.length) e.lines.push(`New in 5.0 (doc/fixes5-0-0.txt): ${fresh.join(', ')}.`);
  }

  return {
    source: 'NetHack 5.0.0 source (generated by scripts/gen-nethack-data.ts)',
    entries: [...monsterEntries, ...objectEntries, ...artifactEntries, ...appearanceEntries, ...roleEntries, ...raceEntries, priceEntry],
  };
}

/** one entry per line, so diffs of the checked-in file stay readable */
export function serializeLookupData(data: LookupData): string {
  return `{"source":${JSON.stringify(data.source)},"entries":[\n${data.entries.map((e) => JSON.stringify(e)).join(',\n')}\n]}\n`;
}
