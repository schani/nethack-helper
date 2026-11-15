/**
 * nethack_lookup (generator parsers, checked-in data, fuzzy lookups), the 5.0 changelog helpers and the wiki
 * HTML renderer. The data-freshness and source-backed tests need the clean 5.0.0 checkout (.cache/nethack-src)
 * and a C preprocessor.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  calls, cInt, cString, humanCondition, parseDamageBonuses, parseInitSwitch, parseMonsters, parseObjects, parseTrobjArrays, splitArgs,
} from '../../src/assistant/knowledge/lookup/parse.ts';
import { findMatches, nethackLookup, normalize } from '../../src/assistant/knowledge/lookup/index.ts';
import { buildLookupData, serializeLookupData } from '../../src/assistant/knowledge/lookup/build.ts';
import { changelogFor, entryAt, parseChangelog, subjectPattern } from '../../src/assistant/knowledge/changelog.ts';
import { expandChangelogHits } from '../../src/assistant/knowledge/source.ts';
import { wikiHtmlToText } from '../../src/assistant/knowledge/wiki-html.ts';
import { loadConfig } from '../../src/config.ts';

const SRC = loadConfig({}).assistant.nethackSrcDir;
const hasSrc = fs.existsSync(path.join(SRC, 'src'));
const hasCpp = (() => {
  try {
    execFileSync('cpp', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('C source helpers', () => {
  it('splitArgs respects nesting and strings', () => {
    expect(splitArgs('NAM("a, b"), LVL(1, 2), (G_GENO | 3), {0,1}')).toEqual(['NAM("a, b")', 'LVL(1, 2)', '(G_GENO | 3)', '{0,1}']);
  });
  it('calls finds balanced macro calls', () => {
    expect(calls('x ATTK(AT_BITE, AD_PHYS, 1, 4), ATTK(AT_CLAW, AD_POLY, (1), 4)', 'ATTK')).toEqual(['AT_BITE, AD_PHYS, 1, 4', 'AT_CLAW, AD_POLY, (1), 4']);
  });
  it('cString joins literals; cInt evaluates small expressions', () => {
    expect(cString('"generic " "weapon"')).toBe('generic weapon');
    expect(cString('0')).toBeNull();
    expect(cInt('10 - 3')).toBe(7);
    expect(cInt('WT_HUMAN', { WT_HUMAN: 1450 })).toBe(1450);
    expect(cInt('UNKNOWN')).toBeNaN();
  });
});

describe('table parsers', () => {
  it('parseMonsters reads a MONREC entry', () => {
    const cpp = `MONREC(NAMS("gnome lord", "gnome lady", "gnome leader"), S_GNOME, LVL(3, 8, 10, 4, 0), (G_GENO | 2),
      A(ATTK(AT_WEAP, AD_PHYS, 1, 8), NO_ATTK), SIZ(WT_X, 120, MS_ORC, MZ_SMALL), MR_POISON, 0,
      M1_HUMANOID | M1_OMNIVORE, M2_GNOME | M2_LORD, M3_INFRAVISION, 4, CLR_BLUE, GNOME_LEADER)`;
    const [m] = parseMonsters(cpp, { S_GNOME: { ch: 'G', desc: 'gnome' } }, { WT_X: 700 });
    expect(m).toMatchObject({ name: 'gnome lord', names: ['gnome lord', 'gnome lady', 'gnome leader'], sym: 'G', level: 3, speed: 8, ac: 10, mr: 4, freq: 2, weight: 700, difficulty: 4 });
    expect(m.attacks).toEqual([{ type: 'weapon', damage: '', dice: '1d8' }]);
    expect(m.resists).toEqual(['poison']);
    expect(m.flags).toContain('lord of its kind');
  });
  it('parseObjects reads OBJREC fields in objclass order', () => {
    const cpp = 'OBJREC("elven cloak", "faded pall", 0, 0, 1, 0, 1, 1, 0, 0, 0, 0, 0, ARM_CLOAK, CLOTH, STEALTH, ARMOR_CLASS, 8, 0, 10, 60, 0, 0, 10 - 9, 1, 10, CLR_BLACK, ELVEN_CLOAK)';
    const [o] = parseObjects(cpp);
    expect(o).toMatchObject({ name: 'elven cloak', desc: 'faded pall', class: 'armor', cost: 60, weight: 10, oc1: 1, oc2: 1, prop: 'STEALTH', sub: 'ARM_CLOAK', material: 'cloth', magic: true });
  });
  it('parseTrobjArrays and parseInitSwitch read u_init.c', () => {
    const src = `static const struct trobj Valk[] = {
    { SPEAR, 1, WEAPON_CLASS, 1, 1, UNDEF_BLESS },
    { UNDEF_TYP, UNDEF_SPE, POTION_CLASS, 3, 3, 0 }, /* comment */
    { 0, 0, 0, 0, 0, 0 }
};
staticfn void
u_init_role(void)
{
    switch (Role_switch) {
    case PM_ARCHEOLOGIST:
        ini_inv(Arc);
        if (!rn2(10))
            ini_inv(Tinopener);
        else if (!rn2(4))
            ini_inv(Lamp);
        break;
    case PM_BARBARIAN:
        if (rn2(100) >= 50) {
            ini_inv(Bar0);
        } else {
            ini_inv(Bar1);
        }
        break;
    case PM_HEALER:
        u.umoney0 = rn1(1000, 1001);
        ini_inv(Healer);
        break;
    default:
        break;
    }
}
`;
    expect(parseTrobjArrays(src).Valk).toEqual([
      { otyp: 'SPEAR', spe: '1', cls: 'WEAPON_CLASS', qmin: 1, qmax: 1, bless: 'UNDEF_BLESS' },
      { otyp: 'UNDEF_TYP', spe: 'UNDEF_SPE', cls: 'POTION_CLASS', qmin: 3, qmax: 3, bless: '0' },
    ]);
    const sw = parseInitSwitch(src, 'u_init_role');
    expect(sw.PM_ARCHEOLOGIST.inv).toEqual([
      { list: 'Arc', cond: null },
      { list: 'Tinopener', cond: '1 in 10 chance' },
      { list: 'Lamp', cond: 'otherwise 1 in 4 chance' },
    ]);
    expect(sw.PM_BARBARIAN.inv).toEqual([
      { list: 'Bar0', cond: '50% chance' },
      { list: 'Bar1', cond: 'otherwise' },
    ]);
    expect(sw.PM_HEALER.notes).toEqual(['gold: 1001-2000']);
    expect(humanCondition('Role_if(PM_CLERIC) || Role_if(PM_WIZARD)')).toBe('if cleric or wizard');
  });
  it('parseDamageBonuses reads dmgval()', () => {
    const src = `dmgval(struct obj *otmp, struct monst *mon)
{
    if (bigmonst(ptr)) {
        switch (otyp) {
        case BROADSWORD:
            tmp++;
            break;
        case TWO_HANDED_SWORD:
            tmp += d(2, 6);
            break;
        }
    } else {
        switch (otyp) {
        case MACE:
            tmp++;
            break;
        case BROADSWORD:
            tmp += rnd(4);
            break;
        }
    }
    return tmp;
}
`;
    expect(parseDamageBonuses(src)).toEqual({ large: { BROADSWORD: '+1', TWO_HANDED_SWORD: '+2d6' }, small: { MACE: '+1', BROADSWORD: '+1d4' } });
  });
});

describe('5.0 changelog helpers', () => {
  const text = 'NHDT-Branch: x\n\nGeneral Fixes and Modified Features\n-----------------------------------\nfirst entry about\n\tgenetic engineers wrapping\nsecond entry\n\nGeneral New Features\n--------------------\nnew monsters:  genetic engineer (Q)\n';
  it('parseChangelog joins continuation lines and tracks sections', () => {
    const e = parseChangelog(text);
    expect(e.map((x) => x.text)).toEqual(['first entry about genetic engineers wrapping', 'second entry', 'new monsters:  genetic engineer (Q)']);
    expect(e[0]).toMatchObject({ line: 5, end: 6, section: 'General Fixes and Modified Features' });
    expect(e[2].section).toBe('General New Features');
    expect(entryAt(e, 6)?.line).toBe(5);
    expect(entryAt(e, 9)).toBeUndefined();
  });
  it('subjectPattern matches whole words and plurals, any case', () => {
    const re = subjectPattern('Genetic engineer')!;
    expect(re.test('give genetic engineers teleport')).toBe(true);
    expect(re.test('GENETIC ENGINEER')).toBe(true);
    expect(re.test('genetics engineering')).toBe(false);
    expect(subjectPattern('Fountain')!.test('fountains')).toBe(true);
    expect(subjectPattern('ab')).toBeNull();
  });
});

describe('wiki HTML -> compact text', () => {
  it('renders tables as pipe rows (row spans filled), lists, headings; drops chrome', () => {
    const html = `<div class="mw-parser-output"><div class="thumb tright"><table class="prettytable"><tr><td>infobox</td></tr></table></div>
<p>Intro with a <a href="/wiki/X">link</a><sup class="reference">[1]</sup> and <sup>9</sup>&#8260;<sub>30</sub>.</p>
<h2><span class="mw-headline">Quaffing</span></h2>
<table class="wikitable"><tbody><tr><th>Probability</th><th>Message</th><th>Effect</th></tr>
<tr><td rowspan="2">1/30</td><td>"The water is contaminated!"</td><td>Lose HP<br />(not resistant)</td></tr>
<tr><td>"Perhaps it is runoff"</td><td>Lose d4 HP</td></tr></tbody></table>
<table class="prettytable mw-collapsible mw-collapsed"><tr><td>old 3.4.3 prices</td></tr></table>
<ul><li>first</li><li>second<ul><li>nested</li></ul></li></ul>
<div class="upcoming"><p><i>The following information pertains to an upcoming version (3.7.0).</i></p>New in 3.7.</div>
<div class="mw-references-wrap"><ol class="references"><li>ref</li></ol></div></div>`;
    const t = wikiHtmlToText(html);
    expect(t).toContain('Intro with a link and 9/30.');
    expect(t).toContain('== Quaffing ==');
    expect(t).toContain('Probability | Message | Effect\n1/30 | "The water is contaminated!" | Lose HP / (not resistant)\n1/30 | "Perhaps it is runoff" | Lose d4 HP');
    expect(t).toContain('- first\n- second\n  - nested');
    expect(t).toContain('[3.7/5.0 note] New in 3.7.');
    expect(t).not.toMatch(/infobox|old 3\.4\.3|\[1\]|ref$/);
  });
});

describe('nethack_lookup (checked-in data)', () => {
  it('normalizes articles and plurals', () => {
    expect(normalize('The Jackals')).toBe('jackal');
    expect(normalize('potions of healing')).toBe('potion of healing');
    expect(normalize('elves')).toBe('elf');
  });
  it('monsters: 5.0 stats, gendered names, typos', () => {
    const ge = nethackLookup({ name: 'genetic engineer' });
    expect(ge).toMatch(/Level 12, speed 12, AC 3/);
    expect(ge).toMatch(/claw 1d4 polymorph/);
    expect(ge).toMatch(/teleports at random/);
    expect(nethackLookup({ name: 'displacer beast' })).toMatch(/AC -10[\s\S]*claw 4d4, claw 4d4, bite 2d10/);
    expect(nethackLookup({ name: 'gnome lady' })).toMatch(/gnome lord \(G, gnome\)[\s\S]*Level 3/);
    expect(nethackLookup({ name: 'genetic enginer' })).toMatch(/closest is "genetic engineer"[\s\S]*Level 12/);
  });
  it('unknown names: not in NetHack 5.0, with the closest real names', () => {
    const r = nethackLookup({ name: 'frost wyrmling' });
    expect(r).toMatch(/^"frost wyrmling" is not in NetHack 5\.0/);
    expect(r).toMatch(/Closest names: .*frost giant/);
  });
  it('objects: randomized appearances are never mapped; price and frequency are spoiler-level', () => {
    const r = nethackLookup({ name: 'potion of healing' });
    expect(r).toMatch(/Appearance: random each game/);
    expect(r).not.toMatch(/purple-red/);
    expect(r).toMatch(/SPOILER-LEVEL[\s\S]*Base price 20 zorkmids/);
    expect(nethackLookup({ name: 'fizzy potion' })).toMatch(/shuffled randomly in every game/);
    expect(nethackLookup({ name: 'clear potion' })).toMatch(/always the potion of water/);
    expect(nethackLookup({ name: 'elven cloak' })).toMatch(/always "faded pall"[\s\S]*improves AC by 1, magic cancellation 1[\s\S]*stealth/);
    expect(nethackLookup({ name: 'two-handed sword' })).toMatch(/d12 vs small\/medium, d6\+2d6 vs large/);
  });
  it('roles: 5.0 starting inventory and intrinsics; role preferred over the player-monster', () => {
    const v = nethackLookup({ name: 'Valkyrie' });
    expect(v.indexOf('(role)')).toBeLessThan(v.indexOf('monster data'));
    expect(v).toMatch(/Starting inventory \(src\/u_init\.c\): \+1 spear, \+0 dagger, \+3 small shield, food ration\./);
    expect(v).toMatch(/1 in 6 chance: oil lamp/);
    expect(v).toMatch(/XL 1 cold resistance, XL 3 stealth, XL 7 speed/);
    expect(nethackLookup({ name: 'monk' })).toMatch(/one of: blessed spellbook of healing \/ blessed spellbook of protection \/ blessed spellbook of confuse monster/);
    expect(nethackLookup({ name: 'elf', kind: 'race' })).toMatch(/elven dagger instead of dagger/);
  });
  it('artifacts; quest artifacts and quest monsters are spoiler-gated', () => {
    expect(nethackLookup({ name: 'Excalibur' })).toMatch(/Artifact long sword; alignment lawful/);
    const orb = nethackLookup({ name: 'Orb of Fate' });
    expect(orb).toMatch(/Everything about it is spoiler-level\.\)\nSPOILER-LEVEL[\s\S]*Valkyrie artifact/);
    expect(nethackLookup({ name: 'Lord Surtur' })).toMatch(/SPOILER-LEVEL[\s\S]*quest nemesis/);
  });
  it('feature effect tables: gist first, full table spoiler-level with source citations', () => {
    const f = nethackLookup({ name: 'fountain' });
    expect(f.indexOf('Gist:')).toBeLessThan(f.indexOf('SPOILER-LEVEL'));
    expect(f).toMatch(/drinkfountain\(\)/);
    expect(f).not.toMatch(/hallucinat/i);
    expect(nethackLookup({ name: 'sit on throne' })).toMatch(/throne_sit_effect/);
    expect(nethackLookup({ name: 'kick sink' })).toMatch(/dokick\.c/);
    expect(nethackLookup({ name: 'sacrifice' })).toMatch(/offer_corpse/);
  });
  it('price identification: formulas from shk.c and asking prices rounded like the game, all spoiler-level', () => {
    const r = nethackLookup({ name: 'price id' });
    expect(r).toMatch(/^NetHack 5\.0 game mechanic data[\s\S]*SPOILER-LEVEL[\s\S]*get_cost\(\)/);
    expect(r).toMatch(/Cha 8-10: [^.]*base 250 costs 333 \(444 surcharged\)/);
    expect(r).toMatch(/Potions: [^.]*250: acid, oil;/);
  });
  it('ranking: exact matches score 0', () => {
    expect(findMatches('lichen')[0]).toMatchObject({ score: 0, entry: { kind: 'monster', name: 'lichen' } });
  });
});

describe.skipIf(!hasSrc)('with the 5.0.0 source', () => {
  it.skipIf(!hasCpp)('the checked-in data is up to date (re-run scripts/gen-nethack-data.ts)', () => {
    const file = new URL('../../src/assistant/knowledge/lookup/nethack-5.0.json', import.meta.url);
    expect(serializeLookupData(buildLookupData(SRC))).toBe(fs.readFileSync(file, 'utf8'));
  });
  it('names that are game concepts but not in the tables are not called fake', () => {
    expect(nethackLookup({ name: 'Elbereth' }, { srcDir: SRC })).toMatch(/does appear in the NetHack 5\.0 source/);
    expect(nethackLookup({ name: 'frost wyrmling' }, { srcDir: SRC })).toMatch(/is not in NetHack 5\.0/);
  });
  it('changelogFor appends whole entries for a subject; search hits expand to whole entries', async () => {
    const r = await changelogFor(SRC, 'Genetic engineer');
    expect(r).toMatch(/'port away after polymorphing someone so that they don't just repeat that/);
    expect(await expandChangelogHits(SRC, ['doc/fixes5-0-0.txt:1751: \taway after polymorphing', 'src/x.c:1: y'])).toEqual([
      expect.stringMatching(/^doc\/fixes5-0-0\.txt:1750: give genetic engineers teleport capability .* 'port away after polymorphing/),
      'src/x.c:1: y',
    ]);
  });
});
