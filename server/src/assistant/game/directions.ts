/**
 * Spoken, hero-relative directions.  NetHack map coordinates: x grows to the
 * east (right on screen), y grows to the south (down on screen).  The
 * assistant must never speak raw coordinates, so every position it sees is
 * phrased relative to the hero (or, on other levels, as a map region).
 */

export interface Offset {
  dx: number;
  dy: number;
}

/** squares the hero has to walk (king moves) */
export const steps = (o: Offset) => Math.max(Math.abs(o.dx), Math.abs(o.dy));

const squares = (n: number) => (n === 1 ? '1 square' : `${n} squares`);

/**
 * "adjacent, 1 square north (up)", "3 squares west (left)",
 * "2 squares northeast (diagonally up-right)", "3 east and 1 north (3 right, 1 up)".
 */
export function describeOffset(o: Offset): string {
  const { dx, dy } = o;
  if (dx === 0 && dy === 0) return 'on your square';
  const ns = dy < 0 ? 'north' : 'south';
  const ew = dx > 0 ? 'east' : 'west';
  const ud = dy < 0 ? 'up' : 'down';
  const lr = dx > 0 ? 'right' : 'left';
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  let s: string;
  if (dx === 0) s = `${squares(ay)} ${ns} (${ud})`;
  else if (dy === 0) s = `${squares(ax)} ${ew} (${lr})`;
  else if (ax === ay) s = `${squares(ax)} ${ns}${ew} (diagonally ${ud}-${lr})`;
  else s = `${ax} ${ew} and ${ay} ${ns} (${ax} ${lr}, ${ay} ${ud})`;
  return steps(o) === 1 ? `adjacent, ${s}` : s;
}

/** Compass name of a unit step, e.g. "north" or "southwest". */
export function compass(o: Offset): string {
  const ns = o.dy < 0 ? 'north' : o.dy > 0 ? 'south' : '';
  const ew = o.dx > 0 ? 'east' : o.dx < 0 ? 'west' : '';
  return ns + ew || 'here';
}

/** screen-relative name of a unit step, e.g. "up" or "down-left" */
export function screenDir(o: Offset): string {
  const ud = o.dy < 0 ? 'up' : o.dy > 0 ? 'down' : '';
  const lr = o.dx > 0 ? 'right' : o.dx < 0 ? 'left' : '';
  return [ud, lr].filter(Boolean).join('-') || 'here';
}

/** the eight neighbours, clockwise from north */
export const NEIGHBOURS: readonly Offset[] = [
  { dx: 0, dy: -1 }, { dx: 1, dy: -1 }, { dx: 1, dy: 0 }, { dx: 1, dy: 1 },
  { dx: 0, dy: 1 }, { dx: -1, dy: 1 }, { dx: -1, dy: 0 }, { dx: -1, dy: -1 },
];

const UNIT: Record<string, Offset> = {
  north: { dx: 0, dy: -1 }, n: { dx: 0, dy: -1 }, up: { dx: 0, dy: -1 }, above: { dx: 0, dy: -1 }, upper: { dx: 0, dy: -1 },
  south: { dx: 0, dy: 1 }, s: { dx: 0, dy: 1 }, down: { dx: 0, dy: 1 }, below: { dx: 0, dy: 1 }, lower: { dx: 0, dy: 1 },
  east: { dx: 1, dy: 0 }, e: { dx: 1, dy: 0 }, right: { dx: 1, dy: 0 },
  west: { dx: -1, dy: 0 }, w: { dx: -1, dy: 0 }, left: { dx: -1, dy: 0 },
  northeast: { dx: 1, dy: -1 }, ne: { dx: 1, dy: -1 },
  northwest: { dx: -1, dy: -1 }, nw: { dx: -1, dy: -1 },
  southeast: { dx: 1, dy: 1 }, se: { dx: 1, dy: 1 },
  southwest: { dx: -1, dy: 1 }, sw: { dx: -1, dy: 1 },
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, once: 1, twice: 2,
};

const FILLER = new Set([
  'square', 'squares', 'step', 'steps', 'tile', 'tiles', 'space', 'spaces', 'cell', 'cells', 'of', 'me', 'to', 'the',
  'from', 'away', 'and', 'my', 'is', 'what', 'whats', "what's", 'there', 'thing', 'look', 'at', 'directly', 'just',
  'straight', 'side', 'on', 'towards', 'toward', 'hand', 'diagonally', 'go', 'next', 'square(s)', 'by', 'in', 'far',
  'further', 'whats', 'that', 'this', 'one', 'right-hand', 'left-hand', 'of-me',
]);

/**
 * Parse a spoken direction like "north", "2 west", "two squares to the
 * up-left", "southeast 3", "upper right".  Returns the unit vector and the
 * distance (undefined if none was given), or null if this isn't a direction.
 */
export function parseDirection(text: string): { unit: Offset; distance?: number } | null {
  const t = text
    .toLowerCase()
    .replace(/north[\s-]+east/g, 'northeast')
    .replace(/north[\s-]+west/g, 'northwest')
    .replace(/south[\s-]+east/g, 'southeast')
    .replace(/south[\s-]+west/g, 'southwest')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .trim();
  if (!t) return null;
  let dx = 0;
  let dy = 0;
  let distance: number | undefined;
  let sawDir = false;
  for (const tok of t.split(/\s+/)) {
    if (/^\d+$/.test(tok)) {
      distance = Number(tok);
      continue;
    }
    if (tok in UNIT) {
      // "one" is both a number and filler; directions win only for real direction words
      const u = UNIT[tok];
      if (u.dx) dx = u.dx;
      if (u.dy) dy = u.dy;
      sawDir = true;
      continue;
    }
    if (tok in NUMBER_WORDS) {
      distance = NUMBER_WORDS[tok];
      continue;
    }
    if (FILLER.has(tok)) continue;
    return null; // some other word: not a pure direction
  }
  if (!sawDir || (dx === 0 && dy === 0)) return null;
  if (distance !== undefined && (distance < 1 || distance > 80)) distance = undefined;
  return { unit: { dx, dy }, distance };
}

/**
 * Coarse region of the 80x21 map for levels the hero is not on, e.g.
 * "the north-west part of the map", "the middle of the map".
 */
export function mapRegion(x: number, y: number): string {
  const v = y < 7 ? 'north' : y > 13 ? 'south' : '';
  const h = x < 27 ? 'west' : x > 53 ? 'east' : '';
  if (!v && !h) return 'the middle of the map';
  if (!v) return `the ${h} side of the map`;
  if (!h) return `the ${v} part of the map`;
  return `the ${v}-${h} part of the map`;
}
