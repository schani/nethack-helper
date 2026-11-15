// Parsers for the NetHack 5.0 source tables used by nethack_lookup (run by scripts/gen-nethack-data.ts, which
// writes nethack-5.0.json next to this file). Pure functions over source text; the C preprocessing of
// monsters.h / objects.h (their entries are macro calls) is done by the generator with `cpp`, using the
// marker macros from monsterCppInput() / objectCppInput().

export interface Attack { type: string; damage: string; dice: string }

export interface Monster {
  name: string;
  /** gendered names from NAMS(male, female, neutral) */
  names?: string[];
  enum: string;
  sym: string;
  symClass: string;
  level: number;
  speed: number;
  ac: number;
  mr: number;
  align: number;
  freq: number;
  gen: string[];
  attacks: Attack[];
  weight: number;
  nutrition: number;
  sound: string;
  size: string;
  resists: string[];
  conveys: string[];
  flags: string[];
  difficulty: number;
}

export interface GameObject {
  name: string | null;
  enum: string;
  class: string;
  desc: string | null;
  known: boolean;
  magic: boolean;
  unique: boolean;
  nowish: boolean;
  twoHanded: boolean;
  material: string;
  prop: string | null;
  prob: number;
  delay: number;
  weight: number;
  cost: number;
  sdam: number;
  ldam: number;
  oc1: number;
  oc2: number;
  nutrition: number;
  sub: string;
  dir: string;
}

// ------------------------------------------------------------------ generic C helpers

export function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
}

/** Split a C argument list at top-level commas (parentheses, braces and string literals respected). */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let str: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (str) {
      cur += c;
      if (c === "\\") cur += s[++i] ?? "";
      else if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'") str = c;
    else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** All `NAME( ... )` calls in s with their raw argument text (balanced parentheses). */
export function calls(s: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    let depth = 1;
    let i = m.index + m[0].length;
    let str: string | null = null;
    for (; i < s.length && depth; i++) {
      const c = s[i];
      if (str) {
        if (c === "\\") i++;
        else if (c === str) str = null;
      } else if (c === '"' || c === "'") str = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    out.push(s.slice(m.index + m[0].length, i - 1));
    re.lastIndex = i;
  }
  return out;
}

/** Concatenate adjacent C string literals ("generic " "weapon" -> generic weapon); null for 0 / NULL. */
export function cString(s: string): string | null {
  const parts = [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
  return parts.length ? parts.join("") : null;
}

/** Evaluate a small integer C expression (numbers, + - * / ( ) and known names); NaN if unknown. */
export function cInt(s: string, names: Record<string, number> = {}): number {
  const expr = s
    .replace(/\((?:schar|uchar|int|long|short|char|unsigned)\)/g, "")
    .replace(/\b([A-Za-z_]\w*)\b/g, (n) => (n in names ? `(${names[n]})` : "NaN"))
    .replace(/(\d+)[uUlL]+\b/g, "$1");
  if (!/^[\d\s+\-*/()NaN.]*$/.test(expr)) return NaN;
  try {
    return Math.trunc(Number(Function(`"use strict"; return (${expr});`)()));
  } catch {
    return NaN;
  }
}

/** `NAME = 123,` enum members and `#define NAME 123` constants. */
export function intConstants(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of stripComments(text).matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(-?\d+)\s*,?/gm)) out[m[1]] = Number(m[2]);
  for (const m of stripComments(text).matchAll(/^#\s*define\s+([A-Z][A-Z0-9_]*)\s+\(?(-?(?:0x[0-9a-fA-F]+|\d+))[uUlL]*\)?\s*$/gm)) out[m[1]] = Number(m[2]);
  return out;
}

const words = (enumName: string, prefix: RegExp) => enumName.replace(prefix, "").toLowerCase().replace(/_/g, " ");

// ------------------------------------------------------------------ monsters

/** monsters.h -> cpp input: MON(...) entries become MONREC(...) markers; inner macros (NAM, LVL, A, ATTK, SIZ) stay. */
export function monsterCppInput(monstersH: string): string {
  const body = monstersH
    .replace(/#if defined\(MONS_ENUM\)\s*\n[\s\S]*?#endif\s*\n/, "") // the per-includer MON definitions
    .replace(/#if defined\(MONS_ENUM\) \|\| defined\(DUMP_ENUMS\)[\s\S]*?#endif/, "");
  return `#define MAIL_STRUCTURES 1\n#define MON(nam, sym, lvl, gen, atk, siz, mr1, mr2, flg1, flg2, flg3, d, col, bn) MONREC(nam, sym, lvl, gen, atk, siz, mr1, mr2, flg1, flg2, flg3, d, col, bn)\n${body}`;
}

/** MONSYM(idx, ch, basename, S_SYM, "description") from defsym.h */
export function parseMonsterSymbols(defsymH: string): Record<string, { ch: string; desc: string }> {
  const out: Record<string, { ch: string; desc: string }> = {};
  for (const m of defsymH.matchAll(/^\s*MONSYM\(\s*\d+,\s*'((?:\\.|[^'])+)',\s*\w+,\s*(S_\w+),\s*"([^"]*)"\)/gm)) out[m[2]] = { ch: m[1].replace(/^\\/, ""), desc: m[3] };
  return out;
}

const ATTACK: Record<string, string> = {
  AT_NONE: "passive", AT_CLAW: "claw", AT_BITE: "bite", AT_KICK: "kick", AT_BUTT: "butt", AT_TUCH: "touch", AT_STNG: "sting",
  AT_HUGS: "crushing hug", AT_SPIT: "spit", AT_ENGL: "engulf", AT_BREA: "breath", AT_EXPL: "explode", AT_BOOM: "explodes when killed",
  AT_GAZE: "gaze", AT_TENT: "tentacles", AT_WEAP: "weapon", AT_MAGC: "spellcasting",
};
const DAMAGE: Record<string, string> = {
  AD_PHYS: "", AD_MAGM: "magic missile", AD_FIRE: "fire", AD_COLD: "cold", AD_SLEE: "sleep", AD_DISN: "disintegration",
  AD_ELEC: "shock", AD_DRST: "poison (strength)", AD_ACID: "acid", AD_BLND: "blinding", AD_STUN: "stun", AD_SLOW: "slow",
  AD_PLYS: "paralysis", AD_DRLI: "level drain", AD_DREN: "drains energy", AD_LEGS: "leg wounding", AD_STON: "petrification",
  AD_STCK: "sticky", AD_SGLD: "steals gold", AD_SITM: "steals an item", AD_SEDU: "seduces and steals", AD_TLPT: "teleports you",
  AD_RUST: "rust", AD_CONF: "confusion", AD_DGST: "digestion", AD_HEAL: "heals you", AD_WRAP: "wrap / drowning",
  AD_WERE: "lycanthropy", AD_DRDX: "poison (dexterity)", AD_DRCO: "poison (constitution)", AD_DRIN: "eats brains (intelligence)",
  AD_DISE: "disease", AD_DCAY: "rot (organic items)", AD_SSEX: "seduction", AD_HALU: "hallucination", AD_DETH: "touch of death",
  AD_PEST: "pestilence", AD_FAMN: "famine", AD_SLIM: "sliming", AD_ENCH: "disenchant", AD_CORR: "corrosion", AD_POLY: "polymorph",
  AD_CLRC: "clerical spells", AD_SPEL: "mage spells", AD_RBRE: "random breath", AD_SAMU: "steals the Amulet", AD_CURS: "curses / steals intrinsics",
};
const RESIST: Record<string, string> = {
  MR_FIRE: "fire", MR_COLD: "cold", MR_SLEEP: "sleep", MR_DISINT: "disintegration", MR_ELEC: "shock", MR_POISON: "poison",
  MR_ACID: "acid", MR_STONE: "petrification",
};
const FLAG: Record<string, string> = {
  M1_FLY: "flies", M1_SWIM: "swims", M1_AMORPHOUS: "amorphous (flows under doors)", M1_WALLWALK: "phases through walls",
  M1_CLING: "clings to the ceiling", M1_TUNNEL: "tunnels", M1_NEEDPICK: "needs a pick to tunnel", M1_CONCEAL: "hides under objects",
  M1_HIDE: "hides (mimics or on the ceiling)", M1_AMPHIBIOUS: "amphibious", M1_BREATHLESS: "breathless", M1_NOTAKE: "cannot pick up objects",
  M1_NOEYES: "no eyes", M1_NOHANDS: "no hands", M1_NOLIMBS: "no limbs", M1_NOHEAD: "no head", M1_MINDLESS: "mindless",
  M1_HUMANOID: "humanoid", M1_ANIMAL: "animal", M1_SLITHY: "serpentine", M1_UNSOLID: "unsolid", M1_THICK_HIDE: "thick hide",
  M1_OVIPAROUS: "lays eggs", M1_REGEN: "regenerates", M1_SEE_INVIS: "sees invisible", M1_TPORT: "teleports at random",
  M1_TPORT_CNTRL: "teleport control", M1_ACID: "acidic to eat", M1_POIS: "poisonous to eat", M1_CARNIVORE: "carnivore",
  M1_HERBIVORE: "herbivore", M1_OMNIVORE: "omnivore", M1_METALLIVORE: "eats metal",
  M2_NOPOLY: "you cannot polymorph into it", M2_UNDEAD: "undead", M2_WERE: "lycanthrope", M2_HUMAN: "human", M2_ELF: "elf",
  M2_DWARF: "dwarf", M2_GNOME: "gnome", M2_ORC: "orc", M2_DEMON: "demon", M2_MERC: "guard or soldier", M2_LORD: "lord of its kind",
  M2_PRINCE: "ruler of its kind", M2_MINION: "minion of a deity", M2_GIANT: "giant", M2_SHAPESHIFTER: "shapeshifter",
  M2_MALE: "always male", M2_FEMALE: "always female", M2_NEUTER: "genderless", M2_PNAME: "proper name", M2_HOSTILE: "always hostile",
  M2_PEACEFUL: "always peaceful", M2_DOMESTIC: "tameable by feeding", M2_WANDER: "wanders", M2_STALK: "follows you between levels",
  M2_NASTY: "extra nasty", M2_STRONG: "strong", M2_ROCKTHROW: "throws boulders", M2_GREEDY: "likes gold", M2_JEWELS: "likes gems",
  M2_COLLECT: "picks up weapons and food", M2_MAGIC: "picks up magic items",
  M3_WANTSAMUL: "wants the Amulet", M3_WANTSBELL: "wants the Bell", M3_WANTSBOOK: "wants the Book", M3_WANTSCAND: "wants the Candelabrum",
  M3_WANTSARTI: "wants the quest artifact", M3_WANTSALL: "wants the major artifacts", M3_WAITFORU: "waits until it sees you",
  M3_CLOSE: "lets you approach", M3_INFRAVISION: "infravision", M3_INFRAVISIBLE: "infravisible", M3_DISPLACES: "shoves monsters out of its way",
};
const GEN: Record<string, string> = {
  G_UNIQ: "unique", G_NOHELL: "not generated in Gehennom", G_HELL: "only generated in Gehennom", G_NOGEN: "not randomly generated",
  G_SGROUP: "appears in small groups", G_LGROUP: "appears in large groups", G_GENO: "genocidable", G_NOCORPSE: "leaves no corpse",
};
const SIZE: Record<string, string> = { MZ_TINY: "tiny", MZ_SMALL: "small", MZ_MEDIUM: "medium", MZ_HUMAN: "medium (human-sized)", MZ_LARGE: "large", MZ_HUGE: "huge", MZ_GIGANTIC: "gigantic" };

const bits = (expr: string, map: Record<string, string>) =>
  expr
    .split("|")
    .map((x) => x.trim().replace(/^\(|\)$/g, ""))
    .filter((x) => x && x !== "0")
    .map((x) => map[x] ?? words(x, /^[A-Z]+\d?_/));

/** Parse the cpp output of monsterCppInput(). `consts`: weights (WT_*) and other enum values. */
export function parseMonsters(cppOut: string, syms: Record<string, { ch: string; desc: string }>, consts: Record<string, number> = {}): Monster[] {
  const out: Monster[] = [];
  for (const raw of calls(cppOut, "MONREC")) {
    const a = splitArgs(raw);
    if (a.length !== 14) throw new Error(`monster entry with ${a.length} fields: ${raw.slice(0, 80)}`);
    const [nam, sym, lvl, gen, atk, siz, mr1, mr2, f1, f2, f3, d, , bn] = a;
    let names: string[] = [];
    if (/^NAM\s*\(/.test(nam)) names = [cString(nam)!];
    else if (/^NAMS\s*\(/.test(nam)) names = splitArgs(calls(nam, "NAMS")[0]).map((x) => cString(x)!);
    else throw new Error(`monster name: ${nam}`);
    const [level, speed, ac, mr, align] = splitArgs(calls(lvl, "LVL")[0]).map((x) => cInt(x, consts));
    const genParts = gen.replace(/^\(|\)$/g, "").split("|").map((x) => x.trim());
    const freq = genParts.map((x) => cInt(x)).find((n) => Number.isFinite(n)) ?? 0;
    const attacks: Attack[] = [];
    for (const at of calls(atk, "ATTK")) {
      const [t, dmg, n, s] = splitArgs(at);
      attacks.push({ type: ATTACK[t] ?? words(t, /^AT_/), damage: DAMAGE[dmg] ?? words(dmg, /^AD_/), dice: `${cInt(n)}d${cInt(s)}` });
    }
    const [wt, nut, snd, sz] = splitArgs(calls(siz, "SIZ")[0]);
    const s = syms[sym.trim()];
    out.push({
      name: names[0], // the classic (male) form: "gnome lord", not "gnome leader"
      ...(names.length > 1 ? { names } : {}),
      enum: bn.trim(),
      sym: s?.ch ?? "?",
      symClass: s?.desc ?? sym,
      level, speed, ac, mr, align,
      freq,
      gen: genParts.filter((x) => GEN[x]).map((x) => GEN[x]),
      attacks,
      weight: cInt(wt, consts),
      nutrition: cInt(nut, consts),
      sound: words(snd.trim(), /^MS_/),
      size: SIZE[sz.trim()] ?? words(sz.trim(), /^MZ_/),
      resists: bits(mr1, RESIST),
      conveys: bits(mr2, RESIST),
      flags: [...bits(f1, FLAG), ...bits(f2, FLAG), ...bits(f3, FLAG)],
      difficulty: cInt(d, consts),
    });
  }
  return out;
}

// ------------------------------------------------------------------ objects

/** objects.h -> cpp input: OBJECT(...) entries become OBJREC(...) markers with BITS() expanded to its fields. */
export function objectCppInput(objectsH: string): string {
  const body = objectsH.replace(/#if defined\(OBJECTS_DESCR_INIT\)[\s\S]*?#endif\s*\/\*\s*OBJECTS_DESCR_INIT[^\n]*\n/, "");
  if (body === objectsH) throw new Error("objects.h: per-includer OBJECT definitions not found");
  return [
    "#define MAIL_STRUCTURES 1",
    "#define NoDes 0",
    "#define OBJ(name,desc) name, desc",
    "#define BITS(nmkn,mrg,uskn,ctnr,mgc,chrg,uniq,nwsh,big,tuf,dir,sub,mtrl) nmkn, mrg, uskn, ctnr, mgc, chrg, uniq, nwsh, big, tuf, dir, sub, mtrl",
    "#define OBJECT(obj,bits,prp,sym,prob,dly,wt,cost,sdam,ldam,oc1,oc2,nut,color,sn) OBJREC(obj, bits, prp, sym, prob, dly, wt, cost, sdam, ldam, oc1, oc2, nut, color, sn)",
    "#define MARKER(tag,sn)",
    body,
  ].join("\n");
}

const CLASS: Record<string, string> = {
  ILLOBJ_CLASS: "strange", WEAPON_CLASS: "weapon", ARMOR_CLASS: "armor", RING_CLASS: "ring", AMULET_CLASS: "amulet", TOOL_CLASS: "tool",
  FOOD_CLASS: "food", POTION_CLASS: "potion", SCROLL_CLASS: "scroll", SPBOOK_CLASS: "spellbook", WAND_CLASS: "wand", COIN_CLASS: "coin",
  GEM_CLASS: "gem", ROCK_CLASS: "rock", BALL_CLASS: "iron ball", CHAIN_CLASS: "iron chain", VENOM_CLASS: "venom",
};

/** Parse the cpp output of objectCppInput(). Field meanings follow objclass.h (oc1/oc2: weapon hit bonus, armor AC/MC, ...). */
export function parseObjects(cppOut: string, consts: Record<string, number> = {}): GameObject[] {
  const out: GameObject[] = [];
  for (const raw of calls(cppOut, "OBJREC")) {
    const a = splitArgs(raw);
    // OBJ(name, desc) -> 2 fields, BITS(...) -> 13 fields, then the 13 remaining OBJECT() fields
    if (a.length !== 28) throw new Error(`object entry with ${a.length} fields: ${raw.slice(0, 120)}`);
    const [name, desc, nmkn, , , , mgc, , uniq, nwsh, big, , dir, sub, mtrl, prp, sym, prob, dly, wt, cost, sdam, ldam, oc1, oc2, nut, , sn] = a;
    const num = (x: string) => {
      const v = cInt(x, consts);
      return Number.isFinite(v) ? v : 0;
    };
    out.push({
      name: cString(name),
      enum: sn.trim(),
      class: CLASS[sym.trim()] ?? sym.trim(),
      desc: cString(desc),
      known: num(nmkn) === 1,
      magic: num(mgc) === 1,
      unique: num(uniq) === 1,
      nowish: num(nwsh) === 1,
      twoHanded: num(big) === 1,
      material: mtrl.trim().toLowerCase().replace(/_/g, " "),
      prop: prp.trim() === "0" ? null : prp.trim(),
      prob: num(prob),
      delay: num(dly),
      weight: num(wt),
      cost: num(cost),
      sdam: num(sdam),
      ldam: num(ldam),
      oc1: num(oc1),
      oc2: num(oc2),
      nutrition: num(nut),
      sub: sub.trim(),
      dir: dir.trim(),
    });
  }
  return out;
}

/**
 * Which objects get their appearance shuffled per game (src/o_init.c shuffle_all() / obj_shuffle_range()): whole
 * classes (amulets, potions before water, rings, scrolls/spellbooks up to the first non-magic or unique one, wands)
 * plus the helmet, glove, cloak and boot ranges; objects known from the start are left out (shuffle()).
 * Returns enum name -> group id.
 */
export function shuffledGroups(objs: GameObject[]): Map<string, string> {
  const out = new Map<string, string>();
  const idx = (e: string) => {
    const i = objs.findIndex((o) => o.enum === e);
    if (i < 0) throw new Error(`object ${e} not found`);
    return i;
  };
  const add = (lo: number, hi: number, group: string) => {
    for (let i = lo; i <= hi; i++) if (!objs[i].known) out.set(objs[i].enum, group);
  };
  const classRange = (cls: string) => {
    const lo = objs.findIndex((o, i) => o.class === cls && i > 20); // skip the generic class objects
    let hi = lo;
    while (objs[hi + 1]?.class === cls) hi++;
    return [lo, hi] as const;
  };
  for (const cls of ["ring", "wand"]) {
    const [lo, hi] = classRange(cls);
    add(lo, hi, cls);
  }
  {
    const [lo] = classRange("potion");
    add(lo, idx("POT_WATER") - 1, "potion");
  }
  for (const cls of ["amulet", "scroll", "spellbook"]) {
    const [lo, hi] = classRange(cls);
    let end = lo;
    while (end <= hi && !objs[end].unique && objs[end].magic) end++;
    add(lo, end - 1, cls);
  }
  add(idx("HELMET"), idx("HELM_OF_TELEPATHY"), "helmet");
  add(idx("LEATHER_GLOVES"), idx("GAUNTLETS_OF_DEXTERITY"), "gloves");
  add(idx("CLOAK_OF_PROTECTION"), idx("CLOAK_OF_DISPLACEMENT"), "cloak");
  add(idx("SPEED_BOOTS"), idx("LEVITATION_BOOTS"), "boots");
  return out;
}

// ------------------------------------------------------------------ starting inventory (src/u_init.c) and intrinsics (src/attrib.c)

export interface InvItem { otyp: string; spe: string; cls: string; qmin: number; qmax: number; bless: string }
export interface ConditionalInv { list: string; cond: string | null }

/** `static const struct trobj Name[] = { {...}, ... };` arrays */
export function parseTrobjArrays(uInitC: string): Record<string, InvItem[]> {
  const src = stripComments(uInitC);
  const out: Record<string, InvItem[]> = {};
  for (const m of src.matchAll(/static\s+const\s+struct\s+trobj\s+(\w+)\[\]\s*=\s*\{([\s\S]*?)\};/g)) {
    const items: InvItem[] = [];
    for (const e of m[2].matchAll(/\{\s*([^{}]*?)\s*\}/g)) {
      const f = splitArgs(e[1]);
      if (f.length !== 6 || f[0] === "0") continue;
      items.push({ otyp: f[0], spe: f[1], cls: f[2], qmin: Number(f[3]), qmax: Number(f[4]), bless: f[5] });
    }
    out[m[1]] = items;
  }
  return out;
}

/** Human-readable form of the small conditions used in u_init.c (rn2 chances, role checks). */
export function humanCondition(c: string): string {
  const s = c.trim();
  let m: RegExpExecArray | null;
  if ((m = /^!rn2\((\d+)\)$/.exec(s))) return `1 in ${m[1]} chance`;
  if ((m = /^rn2\((\d+)\)\s*>=\s*(\d+)$/.exec(s))) return `${Math.round((100 * (Number(m[1]) - Number(m[2]))) / Number(m[1]))}% chance`;
  const role = (r: string) => r.replace(/^PM_/, "").toLowerCase().replace(/_/g, " ");
  if ((m = /^!Role_if\(PM_(\w+)\)$/.exec(s))) return `if not a ${role(m[1])}`;
  const roles = [...s.matchAll(/Role_if\(PM_(\w+)\)/g)].map((x) => role(x[1]));
  if (roles.length && /^[\sRole_if()PM_A-Z|]+$/.test(s)) return `if ${roles.join(" or ")}`;
  return `if ${s}`;
}

/**
 * The `case PM_X:` blocks of a switch in a u_init.c function: per case, the ini_inv() lists in order with their
 * conditions ("1 in 6 chance", "otherwise 1 in 4 chance", ...), and other notable lines (gold, intrinsics).
 */
export function parseInitSwitch(uInitC: string, fn: string): Record<string, { inv: ConditionalInv[]; notes: string[] }> {
  const start = uInitC.search(new RegExp(`^${fn}\\(`, "m"));
  if (start < 0) throw new Error(`${fn}() not found`);
  const end = uInitC.indexOf("\n}\n", start);
  const body = stripComments(uInitC.slice(start, end));
  const out: Record<string, { inv: ConditionalInv[]; notes: string[] }> = {};
  let cur: { inv: ConditionalInv[]; notes: string[] } | null = null;
  let pending: string | null = null; // condition of the next single statement
  const blocks: (string | null)[] = []; // conditions of open { } blocks
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    let m: RegExpExecArray | null;
    if ((m = /^case (PM_\w+):/.exec(line))) {
      cur = out[m[1]] = { inv: [], notes: [] };
      pending = null;
      blocks.length = 0;
      continue;
    }
    if (!cur) continue;
    if (/^default:/.test(line)) {
      cur = null;
      continue;
    }
    const blockCond = () => blocks.filter(Boolean).join(", ") || null;
    if ((m = /^\}?\s*else if \((.*)\)\s*(\{?)$/.exec(line))) {
      const c = `otherwise ${humanCondition(m[1])}`;
      if (line.startsWith("}")) blocks.pop();
      if (m[2]) blocks.push(c);
      else pending = c;
      continue;
    }
    if ((m = /^if \((.*)\)\s*(\{?)$/.exec(line))) {
      const c = humanCondition(m[1]);
      if (m[2]) blocks.push(c);
      else pending = c;
      continue;
    }
    if (/^\}?\s*else\s*(\{?)$/.test(line)) {
      if (line.startsWith("}")) blocks.pop();
      if (line.endsWith("{")) blocks.push("otherwise");
      else pending = "otherwise";
      continue;
    }
    if (line === "}" || line === "};") {
      blocks.pop();
      continue;
    }
    const cond = pending ?? blockCond();
    if ((m = /ini_inv\((\w+)(\[[^\]]*\])?\)/.exec(line))) {
      cur.inv.push({ list: m[2] ? `${m[1]}[]` : m[1], cond });
      pending = null;
    } else if ((m = /u\.umoney0\s*=\s*(.*);/.exec(line))) {
      const v = m[1].trim();
      const r = /^rn1\((\d+),\s*(\d+)\)$/.exec(v);
      const d = /^rnd\((\d+)\)$/.exec(v);
      cur.notes.push(r ? `gold: ${r[2]}-${Number(r[1]) + Number(r[2]) - 1}` : d ? `gold: 1-${d[1]}` : v === "0" ? "no gold" : `gold: ${v}`);
      pending = null;
    } else if ((m = /^H(\w+)\s*\|=\s*FROMOUTSIDE/.exec(line))) {
      cur.notes.push(`intrinsic ${m[1].replace(/_/g, " ").toLowerCase()}${cond ? ` (${cond})` : ""}`);
      pending = null;
    } else if (/;\s*$/.test(line)) {
      pending = null;
    }
  }
  return out;
}

/** `static const struct trobj *M_spell[] = { A, B, C };` style alternatives inside u_init.c */
export function parseTrobjChoices(uInitC: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of stripComments(uInitC).matchAll(/static\s+const\s+struct\s+trobj\s*\*\s*(\w+)\[\]\s*=\s*\{([^}]*)\}/g)) {
    out[m[1]] = m[2].split(",").map((x) => x.trim()).filter(Boolean);
  }
  return out;
}

/** Race-based starting inventory substitutions (inv_subs[]). */
export function parseInvSubs(uInitC: string): { race: string; from: string; to: string }[] {
  const m = /inv_subs\[\]\s*=\s*\{([\s\S]*?)\};/.exec(stripComments(uInitC));
  if (!m) return [];
  return [...m[1].matchAll(/\{\s*(PM_\w+),\s*(\w+),\s*(\w+)\s*\}/g)].map((x) => ({ race: x[1], from: x[2], to: x[3] }));
}

/** Instruments etc. chosen with ROLL_FROM(list) inside a case block: `static const int trotyp[] = { ... };` */
export function parseRollFrom(uInitC: string): string[] {
  const m = /static const int trotyp\[\]\s*=\s*\{([^}]*)\}/.exec(stripComments(uInitC));
  return m ? m[1].split(",").map((x) => x.trim()).filter(Boolean) : [];
}

/** attrib.c: `xxx_abil[] = { { level, &(HProp), "gain msg", "lose msg" }, ... }` -> prefix -> [level, property] */
export function parseIntrinsics(attribC: string): Record<string, { level: number; prop: string }[]> {
  const out: Record<string, { level: number; prop: string }[]> = {};
  for (const m of stripComments(attribC).matchAll(/(\w{3})_abil\[\]\s*=\s*\{([\s\S]*?)\}\s*\}/g)) {
    out[m[1]] = [...m[2].matchAll(/\{\s*(\d+),\s*&\(?H(\w+)\)?\s*,/g)].map((x) => ({ level: Number(x[1]), prop: x[2] }));
  }
  return out;
}

/** weapon.c dmgval(): extra damage per weapon against large ("large") and small/medium ("small") targets. */
export function parseDamageBonuses(weaponC: string): { large: Record<string, string>; small: Record<string, string> } {
  const start = weaponC.search(/^dmgval\(/m);
  const body = stripComments(weaponC.slice(start, weaponC.indexOf("\n}\n", start)));
  const big = body.indexOf("if (bigmonst(ptr))");
  const els = body.indexOf("} else {", big);
  const endElse = body.indexOf("\n    }\n", els);
  const parse = (part: string) => {
    const out: Record<string, string> = {};
    let pending: string[] = [];
    for (const l of part.split("\n")) {
      let m: RegExpExecArray | null;
      if ((m = /case (\w+):/.exec(l))) pending.push(m[1]);
      else if (/tmp\+\+/.test(l)) pending.forEach((e) => (out[e] = "+1"));
      else if ((m = /tmp \+= rnd\((\d+)\)/.exec(l))) pending.forEach((e) => (out[e] = `+1d${m![1]}`));
      else if ((m = /tmp \+= d\((\d+),\s*(\d+)\)/.exec(l))) pending.forEach((e) => (out[e] = `+${m![1]}d${m![2]}`));
      if (/break;/.test(l)) pending = [];
    }
    return out;
  };
  return { large: parse(body.slice(big, els)), small: parse(body.slice(els, endElse > 0 ? endElse : undefined)) };
}

// ------------------------------------------------------------------ artifacts (include/artilist.h)

export interface ArtAttack { ad: string; n: number; d: number }
export interface Artifact {
  name: string;
  base: string;
  spfx: string[];
  cspfx: string[];
  target: string;
  attack: ArtAttack;
  defense: ArtAttack;
  carried: ArtAttack;
  invoke: string;
  align: string;
  role: string;
  race: string;
  cost: number;
  enum: string;
}

/** artilist.h -> cpp input: A(...) entries become ARTREC(...) markers, attack macros become ATK(ad, n, d). */
export function artifactCppInput(artilistH: string): string {
  const body = artilistH.replace(/#if defined\(MAKEDEFS_C\)[\s\S]*?static NEARDATA struct artifact artilist\[\] = \{\s*\n#endif[^\n]*\n/, "");
  if (body === artilistH) throw new Error("artilist.h: per-includer A() definitions not found");
  return [
    "#define A(nam, typ, s1, s2, mt, atk, dfn, cry, inv, al, cl, rac, gs, gv, cost, clr, bn) ARTREC(nam, typ, s1, s2, mt, atk, dfn, cry, inv, al, cl, rac, gs, gv, cost, clr, bn)",
    "#define NO_ATTK ATK(0,0,0)", "#define NO_DFNS ATK(0,0,0)", "#define NO_CARY ATK(0,0,0)", "#define DFNS(c) ATK(c,0,0)", "#define CARY(c) ATK(c,0,0)",
    ...["PHYS:AD_PHYS", "DRLI:AD_DRLI", "COLD:AD_COLD", "FIRE:AD_FIRE", "ELEC:AD_ELEC", "STUN:AD_STUN", "POIS:AD_DRST"].map((x) => {
      const [m, ad] = x.split(":");
      return `#define ${m}(a,b) ATK(${ad},a,b)`;
    }),
    body,
  ].join("\n");
}

export function parseArtifacts(cppOut: string): Artifact[] {
  const atk = (s: string): ArtAttack => {
    const [ad, n, d] = splitArgs(calls(s, "ATK")[0] ?? "0,0,0");
    return { ad: ad === "0" ? "" : ad, n: Number(n) || 0, d: Number(d) || 0 };
  };
  const flags = (s: string) => s.replace(/[()]/g, "").split("|").map((x) => x.trim()).filter((x) => x && x !== "0");
  const out: Artifact[] = [];
  for (const raw of calls(cppOut, "ARTREC")) {
    const a = splitArgs(raw);
    if (a.length !== 17) throw new Error(`artifact entry with ${a.length} fields: ${raw.slice(0, 80)}`);
    const name = cString(a[0]);
    if (!name) continue;
    out.push({
      name, base: a[1], spfx: flags(a[2]), cspfx: flags(a[3]), target: a[4].trim(), attack: atk(a[5]), defense: atk(a[6]), carried: atk(a[7]),
      invoke: a[8].trim(), align: a[9].trim(), role: a[10].trim(), race: a[11].trim(), cost: cInt(a[14]), enum: a[16].trim(),
    });
  }
  return out;
}
