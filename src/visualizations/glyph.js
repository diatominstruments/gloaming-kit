/**
 * Glyphs — visualizations that build their structure from a small drawing.
 *
 * A glyph is a coarse grid of cells, each empty or filled at one of a few
 * strengths. A client offers the viewer a canvas to click cells on (the demo's
 * timeline editor does), and passes the result as an ordinary option:
 *
 *   { id: 'glyph-fractal', options: { glyph: [
 *     '2..1..2',
 *     '.2.1.2.',
 *     '..222..',
 *     '1122211',
 *     '..222..',
 *     '.2.1.2.',
 *     '2..1..2',
 *   ] } }
 *
 * One string per row, one character per cell: a digit is that strength,
 * `.` or a space is empty, and any other character (`#`, `x`…) is full
 * strength, so plain ASCII art works too. Rows may also be arrays of numbers,
 * for a client that keeps the grid as a matrix. Values past `levels` clamp.
 * Either way it is plain JSON, so it travels in timeline config like any
 * other option.
 *
 * A visualization declares the option with glyphOption(), which describe()
 * reports as `kind: 'grid'` with the canvas size and number of strengths an
 * editor should offer. The size is a suggestion: a drawing of any size up to
 * MAX_SIZE is accepted, and each visualization fits whatever it is given.
 * An empty or unreadable drawing falls back to the visualization's default,
 * so there is always something on screen.
 */

/** Strengths above empty an editor offers by default: grey and black. */
export const GLYPH_LEVELS = 2;

/** Largest grid accepted on either axis; anything beyond is cropped. */
export const MAX_SIZE = 32;

/**
 * A `glyph` option spec: an editor canvas of `width` × `height` cells, each
 * 0–`levels`, starting from `value` (rows, in the format above).
 */
export function glyphOption({ width, height, levels = GLYPH_LEVELS, value }) {
  return Object.freeze({
    kind: 'grid', width, height, levels, default: Object.freeze([...value]),
  });
}

const cellValue = (c, levels) => {
  if (typeof c === 'number') return Number.isFinite(c) ? Math.max(0, Math.min(levels, Math.round(c))) : 0;
  if (c === '.' || c === ' ' || c === '0' || c === undefined) return 0;
  const n = c.charCodeAt(0) - 48;
  return n >= 0 && n <= 9 ? Math.min(levels, n) : levels;
};

/**
 * A parsed drawing. `cells` is row-major, top row first, one byte per cell
 * holding its strength 0–`levels`.
 */
export class Glyph {
  constructor(width, height, levels, cells) {
    this.width = width;
    this.height = height;
    this.levels = levels;
    this.cells = cells;
  }

  /** Parse rows (strings or number arrays), or null if `value` isn't a grid. */
  static parse(value, levels = GLYPH_LEVELS) {
    if (!Array.isArray(value) || !value.length) return null;
    const rows = value.slice(0, MAX_SIZE).map((row) => (typeof row === 'string' ? [...row] : row));
    if (!rows.every(Array.isArray)) return null;
    const width = Math.min(MAX_SIZE, Math.max(...rows.map((r) => r.length)));
    const height = rows.length;
    if (!width) return null;
    const cells = new Uint8Array(width * height);
    rows.forEach((row, y) => {
      for (let x = 0; x < width; x++) cells[y * width + x] = cellValue(row[x], levels);
    });
    return new Glyph(width, height, levels, cells);
  }

  /** Strength at (x, y); 0 outside the grid. */
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.cells[y * this.width + x];
  }

  /** Strength at (x, y) as 0–1. */
  weight(x, y) {
    return this.get(x, y) / this.levels;
  }

  /** Number of filled cells. */
  get count() {
    let n = 0;
    for (const c of this.cells) if (c) n++;
    return n;
  }

  /** Every filled cell as { x, y, level, weight }, row by row. */
  filled() {
    const out = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const level = this.cells[y * this.width + x];
        if (level) out.push({ x, y, level, weight: level / this.levels });
      }
    }
    return out;
  }

  /** Back to the string-rows format. */
  toRows() {
    const rows = [];
    for (let y = 0; y < this.height; y++) {
      let row = '';
      for (let x = 0; x < this.width; x++) {
        const c = this.cells[y * this.width + x];
        row += c ? String(c) : '.';
      }
      rows.push(row);
    }
    return rows;
  }
}

/**
 * The drawing a visualization should build from: its `name` option if that
 * holds at least one filled cell, otherwise the option's declared default.
 * Warns once per instance when a value was given but couldn't be read.
 */
export function readGlyph(viz, name = 'glyph') {
  const spec = viz.constructor.options[name];
  const value = viz.options[name];
  if (value !== undefined) {
    const glyph = Glyph.parse(value, spec.levels);
    if (glyph && glyph.count) return glyph;
    if (!glyph) {
      console.warn(`GloamingKit: '${viz.constructor.id}' ${name} should be an array of rows; using its default`);
    }
  }
  return Glyph.parse(spec.default, spec.levels);
}

/*
 * Default drawings, one per visualization, each chosen to show off what that
 * one does with a drawing. Kept here so they are easy to compare and reuse.
 */

// Radially symmetric, sparse enough that the copies stay distinct and
// recursion shows two or three levels down.
export const FLOWER = [
  '2..1..2',
  '.2.1.2.',
  '..222..',
  '1122211',
  '..222..',
  '.2.1.2.',
  '2..1..2',
];

// A ring with a broken inner ring and a core. Symmetric drawings evolve
// symmetrically under the automaton rules, which is most of their charm.
export const MANDALA = [
  '................',
  '.....222222.....',
  '...2222222222...',
  '..222......222..',
  '..22...11...22..',
  '.22..........22.',
  '.22..........22.',
  '.22.1..22..1.22.',
  '.22.1..22..1.22.',
  '.22..........22.',
  '.22..........22.',
  '..22...11...22..',
  '..222......222..',
  '...2222222222...',
  '.....222222.....',
  '................',
];

// Chevrons over a row of diamonds: reads as a carved frieze on a tunnel wall.
export const CHEVRONS = [
  '2..............2',
  '.2............2.',
  '..2..........2..',
  '...2...11...2...',
  '....2..11..2....',
  '.....2....2.....',
  '......2..2......',
  '.......22.......',
  '................',
  '...1........1...',
  '..111......111..',
  '...1........1...',
];

// Recognisable from any height, which matters for a city seen in flight.
export const INVADER = [
  '............',
  '............',
  '...2.....2..',
  '....2...2...',
  '...2222222..',
  '..22.222.22.',
  '.22222222222',
  '.2.2222222.2',
  '.2.1.....1.2',
  '....11.11...',
  '............',
  '............',
];

// An eye: a solid pupil inside an open ring, so the flow has an obstacle to
// part around and a channel to pour through.
export const EYE = [
  '............',
  '....1111....',
  '..111..111..',
  '..1......1..',
  '.11..22..11.',
  '.1..2222..1.',
  '.1..2222..1.',
  '.11..22..11.',
  '..1......1..',
  '..111..111..',
  '....1111....',
  '............',
];

// One long stroke, winding in: growth that follows the drawing has a path
// to travel, from the outer end to a fainter tip at the centre.
export const SPIRAL = [
  '22222222222.',
  '..........2.',
  '.22222222.2.',
  '.2......2.2.',
  '.2.2222.2.2.',
  '.2.2..2.2.2.',
  '.2.2.11.2.2.',
  '.2.2....2.2.',
  '.2.222222.2.',
  '.2........2.',
  '.2222222222.',
  '............',
];
