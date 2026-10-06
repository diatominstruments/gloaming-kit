/**
 * Glyphs — visualizations that take a small drawing as input and build
 * textures, tessellations and growth from it.
 *
 * A glyph is a coarse grid of cells, each empty or filled at one of a few
 * strengths. A client offers the viewer a canvas to click cells on (the demo's
 * timeline editor does), and passes the result as an ordinary option:
 *
 *   { id: 'glyph-crystal', options: { glyph: [
 *     '....2....',
 *     '....2....',
 *     '.1..2..1.',
 *     '..1.2.1..',
 *     '222222222',
 *     '..1.2.1..',
 *     '.1..2..1.',
 *     '....2....',
 *     '....2....',
 *   ] } }
 *
 * One string per row, one character per cell: a digit is that strength,
 * `.` or a space is empty, and any other character (`#`, `x`…) is full
 * strength, so plain ASCII art works too. Rows may also be arrays of numbers,
 * for a client that keeps the grid as a matrix. Values past `levels` clamp.
 * Either way it is plain JSON, so it travels in timeline config like any
 * other option.
 *
 * The drawing is never put on screen. Each visualization reads it as
 * something else — a potential field, a crystal's habit, a branching rule, a
 * map of chemistry, a spectrum of waves — and what you see is what that
 * structure does with it, repeated across the whole canvas. The readings are
 * at the bottom of this file, shared so any visualization can use them.
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
 * Readings — ways of turning a drawing into something continuous, shared by
 * the visualizations. None of them keeps the grid.
 */

/**
 * The drawing as a smooth, endlessly tiled scalar field: `field(u, v)` is
 * 0–1 for any real (u, v), where one unit is one copy of the drawing. Each
 * filled cell is a round Gaussian blot `blur` cells wide, so the field has
 * no trace of the cells' squareness; the tiling mirrors the drawing at every
 * border, so copies join without seams. Sampled under a rotation and a
 * drift, no copy lines up with any other on screen.
 *
 * The field is tabulated once at `res` samples per cell and read back
 * bilinearly. `field.gradMax` is the steepest slope in it, per tile unit,
 * for scaling anything that follows its gradient.
 */
export function glyphField(glyph, { blur = 0.55, res = 16 } = {}) {
  const { width: w, height: h } = glyph;
  const W = w * res;
  const H = h * res;
  const su = blur / w;
  const sv = blur / h;
  const cut = 4;
  const table = new Float32Array(W * H);
  const cells = glyph.filled();
  let peak = 0;
  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H;
    for (let i = 0; i < W; i++) {
      const u = (i + 0.5) / W;
      let sum = 0;
      for (const { x, y, weight } of cells) {
        const uc = (x + 0.5) / w;
        const vc = (y + 0.5) / h;
        // The cell and its mirror images across the tile's four borders.
        for (const um of [uc, -uc, 2 - uc]) {
          const du = (u - um) / su;
          if (du > cut || du < -cut) continue;
          for (const vm of [vc, -vc, 2 - vc]) {
            const dv = (v - vm) / sv;
            if (dv > cut || dv < -cut) continue;
            sum += weight * Math.exp(-0.5 * (du * du + dv * dv));
          }
        }
      }
      table[j * W + i] = sum;
      if (sum > peak) peak = sum;
    }
  }
  if (peak > 0) for (let i = 0; i < table.length; i++) table[i] = Math.min(1, table[i] / peak);

  const fold = (t) => { t %= 2; if (t < 0) t += 2; return t > 1 ? 2 - t : t; };
  const field = (u, v) => {
    const fx = fold(u) * W - 0.5;
    const fy = fold(v) * H - 0.5;
    let x0 = Math.floor(fx);
    let y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const x1 = Math.min(W - 1, x0 + 1);
    const y1 = Math.min(H - 1, y0 + 1);
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    const a = table[y0 * W + x0] + (table[y0 * W + x1] - table[y0 * W + x0]) * tx;
    const b = table[y1 * W + x0] + (table[y1 * W + x1] - table[y1 * W + x0]) * tx;
    return a + (b - a) * ty;
  };
  let gradMax = 0;
  for (let j = 1; j < H - 1; j++) {
    for (let i = 1; i < W - 1; i++) {
      const gx = (table[j * W + i + 1] - table[j * W + i - 1]) * W / 2;
      const gy = (table[(j + 1) * W + i] - table[(j - 1) * W + i]) * H / 2;
      gradMax = Math.max(gradMax, gx * gx + gy * gy);
    }
  }
  field.gradMax = Math.max(1e-6, Math.sqrt(gradMax));
  return field;
}

/**
 * The drawing's silhouette as seen from its centre, as `n` speeds round the
 * compass: how far the filled cells reach in each direction, smoothed with a
 * kernel of sharpness `kappa` (higher is spikier) and scaled so the slowest
 * direction is 1 and the fastest at most `ratio`. A cross reads as four
 * spikes, a ring as a circle, a diagonal stroke as a long lozenge. Angle 0 is
 * to the right and angles run clockwise on screen.
 */
export function radialProfile(glyph, { n = 72, kappa = 14, ratio = 2.6 } = {}) {
  const cx = (glyph.width - 1) / 2;
  const cy = (glyph.height - 1) / 2;
  const reach = Math.max(1, Math.hypot(cx, cy));
  const out = new Float32Array(n).fill(0.05);
  for (const { x, y, weight } of glyph.filled()) {
    const dx = x - cx;
    const dy = y - cy;
    const r = Math.hypot(dx, dy) / reach;
    if (r < 1e-3) continue;
    const a = Math.atan2(dy, dx);
    for (let i = 0; i < n; i++) {
      const d = Math.cos((i / n) * Math.PI * 2 - a) - 1;
      out[i] += weight * r * r * Math.exp(kappa * d);
    }
  }
  let lo = Infinity;
  let hi = 0;
  for (const v of out) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const span = Math.min(ratio, hi / Math.max(lo, 1e-6));
  for (let i = 0; i < n; i++) out[i] = 1 + (span - 1) * ((out[i] - lo) / Math.max(hi - lo, 1e-6));
  return out;
}

/*
 * Default drawings, one per visualization, each chosen to show what that
 * reading does with a drawing. Kept here so they are easy to compare and
 * reuse.
 */

// Three strong whorls and a weak one, off-centre: as a potential this is
// hills and a hollow, and the current circles each of them.
export const WHORLS = [
  '.........',
  '..22.....',
  '.2222..1.',
  '..22..111',
  '.......1.',
  '....22...',
  '...2222..',
  '....22...',
  '.........',
];

// A four-armed star with faint diagonals: crystals grow as pointed stars
// with soft shoulders, and the tessellation they make is of stars.
export const STAR = [
  '....2....',
  '....2....',
  '.1..2..1.',
  '..1.2.1..',
  '222222222',
  '..1.2.1..',
  '.1..2..1.',
  '....2....',
  '....2....',
];

// A fern, read as rules row by row: a centre cell carries the trunk on,
// cells either side of it throw out laterals, and a row with no centre
// forks the trunk in two. The laterals then follow the same rules, so each
// one is a smaller fern.
export const FERN = [
  '....2....',
  '.2.....2.',
  '....2....',
  '..2...2..',
  '....1....',
  '.2..2..2.',
  '....2....',
  '...2.2...',
  '....2....',
];

// Blots and a stripe: as a map of chemistry, the blots become one kind of
// texture and the stripe another, with a third in between.
export const BLOTS = [
  '.........',
  '.22...1..',
  '.22..111.',
  '......1..',
  '.........',
  '..1......',
  '.111..22.',
  '..1...22.',
  '.........',
];

// Eight points round a ring at the angles of an octagon: as wave vectors
// they interfere into an eightfold quasicrystal, a pattern that never
// repeats exactly and is nowhere a grid.
export const OCTAGON = [
  '.........',
  '.........',
  '...2.2...',
  '..2...2..',
  '.........',
  '..2...2..',
  '...2.2...',
  '.........',
  '.........',
];
