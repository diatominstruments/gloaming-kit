/**
 * Interpretations — how a drawing becomes structure.
 *
 * A glyph is an abstract input, not a picture to reproduce: copying its cells
 * onto the screen just shows the viewer their own grid back. So the
 * visualizations that build from it first *read* it into a handful of
 * elements, and build from those instead. An element is an oriented, possibly
 * stretched blob:
 *
 *   { x, y,       centre, in the figure's frame: about [-1, 1], y up
 *     angle,      direction of its long axis, radians
 *     sx, sy,     half-extents along that axis and across it, as fractions
 *                 of the figure's half-width — also the scale of a copy of
 *                 the whole figure placed there
 *     weight,     0–1: how much of it was drawn at full strength
 *     hue }       0–1: where it sits along the reading, for colour
 *
 * The reading is independent of what the visualization then does with the
 * elements — the fractal makes each one a copy of the whole figure, the
 * mosaic nests petals in them — so any reading pairs with any of them.
 *
 *   contour   the drawing is blurred into a smooth shape and elements are
 *             strung evenly along its outline, each turned to follow it. A
 *             blocky drawing becomes flowing curves; a ring becomes a loop,
 *             a line a long hairpin.
 *   clusters  filled cells merge into blobs — touching cells together,
 *             large regions split into a few — and each blob becomes one
 *             element at its centre of mass, sized by its mass and stretched
 *             along its own grain. Few, uneven, organic pieces.
 *   rosette   the grid is wrapped round a circle: columns go round, rows run
 *             from the rim (top) to the hub (bottom), and every unbroken run
 *             down a column becomes one petal pointing outward. Any drawing
 *             becomes a radial flower.
 *
 * Every reading also normalizes: positions are fitted to the figure, and
 * sizes scaled so the elements' areas add up to COVERAGE of it, with no
 * element larger than MAX_SCALE — so a copy of the figure placed in each one
 * is a contraction, as an iterated function system needs.
 */

export const INTERPRETATIONS = Object.freeze(['contour', 'clusters', 'rosette']);

/** The `interpret` option, with a per-visualization default. */
export const interpretOption = (value) => Object.freeze({
  kind: 'enum', values: INTERPRETATIONS, default: value,
});

const COVERAGE = 0.8;    // Σ sx·sy: the elements' total area, relative to the figure's
const MAX_SCALE = 0.55;  // no element's half-extent may exceed this
const REACH = 0.72;      // farthest element centre from the figure's centre

/** Filled cells as points in the figure's frame, aspect kept, y up. */
function cellPoints(glyph) {
  const { width, height, levels } = glyph;
  const cell = 2 / Math.max(width, height);
  return glyph.filled().map(({ x, y, level, weight }) => ({
    gx: x, gy: y,
    x: (x + 0.5 - width / 2) * cell,
    y: -(y + 0.5 - height / 2) * cell,
    weight,
    black: level === levels,
  }));
}

/*
 * contour ---------------------------------------------------------------
 */

const G = 56;          // samples per side of the blurred field
const LO = -1.35;      // field extent, in the figure's frame
const HI = 1.35;
const THRESHOLD = 0.42;

// Marching-squares segments per corner case: pairs of edges (0 bottom,
// 1 right, 2 top, 3 left). The saddles (5, 10) are resolved below.
const CASES = [
  [], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], null, [[0, 2]], [[3, 2]],
  [[2, 3]], [[2, 0]], null, [[2, 1]], [[1, 3]], [[1, 0]], [[0, 3]], [],
];

function contour(glyph) {
  const cells = cellPoints(glyph);
  const step = (HI - LO) / (G - 1);
  const cell = 2 / Math.max(glyph.width, glyph.height);
  const sigma = cell * 0.75;
  const all = new Float32Array(G * G);
  const full = new Float32Array(G * G);
  const reach = Math.ceil((sigma * 3) / step);
  for (const p of cells) {
    const ci = Math.round((p.x - LO) / step);
    const cj = Math.round((p.y - LO) / step);
    const strength = 0.5 + 0.5 * p.weight;
    for (let j = Math.max(0, cj - reach); j <= Math.min(G - 1, cj + reach); j++) {
      for (let i = Math.max(0, ci - reach); i <= Math.min(G - 1, ci + reach); i++) {
        const dx = LO + i * step - p.x;
        const dy = LO + j * step - p.y;
        const v = strength * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
        all[j * G + i] += v;
        if (p.black) full[j * G + i] += v;
      }
    }
  }

  // Edge points, keyed by edge so neighbouring squares share them exactly:
  // horizontal edges from (i, j) to (i+1, j), then vertical ones to (i, j+1).
  const points = new Map();
  const at = (i, j) => all[j * G + i];
  const edgePoint = (key) => {
    let p = points.get(key);
    if (p) return p;
    const vertical = key >= G * G;
    const k = vertical ? key - G * G : key;
    const i = k % G;
    const j = Math.floor(k / G);
    const a = at(i, j);
    const b = vertical ? at(i, j + 1) : at(i + 1, j);
    const t = (THRESHOLD - a) / (b - a);
    p = vertical
      ? [LO + i * step, LO + (j + t) * step]
      : [LO + (i + t) * step, LO + j * step];
    points.set(key, p);
    return p;
  };
  const edgeKey = (i, j, e) => (
    e === 0 ? j * G + i
      : e === 2 ? (j + 1) * G + i
        : e === 3 ? G * G + j * G + i
          : G * G + j * G + i + 1
  );

  // Segments, linked end to end by the edges they share.
  const links = new Map();   // edge key -> [segment index, …]
  const segments = [];
  const link = (key, s) => {
    const list = links.get(key);
    if (list) list.push(s);
    else links.set(key, [s]);
  };
  for (let j = 0; j < G - 1; j++) {
    for (let i = 0; i < G - 1; i++) {
      const c = (at(i, j) > THRESHOLD ? 1 : 0) | (at(i + 1, j) > THRESHOLD ? 2 : 0)
        | (at(i + 1, j + 1) > THRESHOLD ? 4 : 0) | (at(i, j + 1) > THRESHOLD ? 8 : 0);
      let pairs = CASES[c];
      if (!pairs) {
        const mid = (at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1)) / 4 > THRESHOLD;
        pairs = c === 5
          ? (mid ? [[3, 2], [1, 0]] : [[3, 0], [1, 2]])
          : (mid ? [[2, 1], [0, 3]] : [[2, 3], [0, 1]]);
      }
      for (const [e0, e1] of pairs) {
        const a = edgeKey(i, j, e0);
        const b = edgeKey(i, j, e1);
        const s = segments.push([a, b]) - 1;
        link(a, s);
        link(b, s);
      }
    }
  }

  // Walk the segments into loops (or open chains, where the field runs off
  // the sampled area), as lists of points.
  const used = new Uint8Array(segments.length);
  const loops = [];
  for (let s0 = 0; s0 < segments.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const keys = [...segments[s0]];
    for (const forward of [true, false]) {
      for (;;) {
        const end = forward ? keys[keys.length - 1] : keys[0];
        const next = (links.get(end) ?? []).find((s) => !used[s]);
        if (next === undefined) break;
        used[next] = 1;
        const [a, b] = segments[next];
        const other = a === end ? b : a;
        if (forward) keys.push(other);
        else keys.unshift(other);
      }
    }
    const pts = keys.map(edgePoint);
    let length = 0;
    for (let k = 1; k < pts.length; k++) length += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    if (length > 0.12) loops.push({ pts, length });
  }
  if (!loops.length) return clusters(glyph);

  // String elements evenly along all of it: longer outlines get more.
  const total = loops.reduce((sum, l) => sum + l.length, 0);
  const count = Math.max(6, Math.min(16, Math.round(total / 0.4)));
  const sample = (x, y) => {
    const i = Math.max(0, Math.min(G - 1, Math.round((x - LO) / step)));
    const j = Math.max(0, Math.min(G - 1, Math.round((y - LO) / step)));
    return full[j * G + i] / Math.max(1e-6, all[j * G + i]);
  };
  const elements = [];
  let travelled = 0;
  for (const { pts, length } of loops) {
    const n = Math.max(2, Math.round((count * length) / total));
    const spacing = length / n;
    let k = 1;
    let along = 0;   // arclength at the start of segment k
    for (let e = 0; e < n; e++) {
      const target = (e + 0.5) * spacing;
      for (;;) {
        const seg = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        if (along + seg >= target || k === pts.length - 1) {
          const t = seg > 0 ? Math.min(1, (target - along) / seg) : 0;
          const [x0, y0] = pts[k - 1];
          const [x1, y1] = pts[k];
          const x = x0 + (x1 - x0) * t;
          const y = y0 + (y1 - y0) * t;
          elements.push({
            x, y,
            angle: Math.atan2(y1 - y0, x1 - x0),
            sx: spacing * 0.6,
            sy: spacing * 0.38,
            weight: sample(x, y),
            hue: (travelled + target) / total,
          });
          break;
        }
        along += seg;
        k++;
      }
    }
    travelled += length;
  }
  return elements;
}

/*
 * clusters --------------------------------------------------------------
 */

const CHUNK = 5;   // cells per blob, roughly, when a region is split

function clusters(glyph) {
  const cells = cellPoints(glyph);
  const cell = 2 / Math.max(glyph.width, glyph.height);

  // Regions of touching cells (diagonals count).
  const index = new Map(cells.map((c, i) => [`${c.gx},${c.gy}`, i]));
  const region = new Int32Array(cells.length).fill(-1);
  const regions = [];
  cells.forEach((c, start) => {
    if (region[start] >= 0) return;
    const members = [];
    const stack = [start];
    region[start] = regions.length;
    while (stack.length) {
      const i = stack.pop();
      members.push(cells[i]);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const n = index.get(`${cells[i].gx + dx},${cells[i].gy + dy}`);
          if (n !== undefined && region[n] < 0) {
            region[n] = regions.length;
            stack.push(n);
          }
        }
      }
    }
    regions.push(members);
  });

  // How many blobs each region splits into: about one per CHUNK cells, and
  // at least three overall where the cells allow it, so there is a figure
  // to build rather than a single lump.
  const ks = regions.map((r) => Math.max(1, Math.round(r.length / CHUNK)));
  const largest = () => regions.reduce((best, r, i) => (r.length / ks[i] > regions[best].length / ks[best] ? i : best), 0);
  while (ks.reduce((a, b) => a + b, 0) < Math.min(3, cells.length)) ks[largest()]++;

  const elements = [];
  regions.forEach((members, r) => {
    for (const blob of kmeans(members, ks[r])) {
      let mass = 0, mx = 0, my = 0, black = 0;
      for (const c of blob) {
        const w = 0.5 + 0.5 * c.weight;
        mass += w;
        mx += c.x * w;
        my += c.y * w;
        black += c.black ? 1 : 0;
      }
      mx /= mass;
      my /= mass;
      // Grain: the principal axis of the blob's cells.
      let cxx = 0, cyy = 0, cxy = 0;
      for (const c of blob) {
        cxx += (c.x - mx) ** 2;
        cyy += (c.y - my) ** 2;
        cxy += (c.x - mx) * (c.y - my);
      }
      const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      const tr = (cxx + cyy) / 2;
      const det = Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy);
      const ratio = Math.sqrt((tr + det + cell * cell * 0.1) / (tr - det + cell * cell * 0.1));
      const stretch = Math.max(1, Math.min(2.6, ratio));
      const size = Math.sqrt(mass) * cell;
      elements.push({
        x: mx, y: my, angle,
        sx: size * Math.sqrt(stretch),
        sy: size / Math.sqrt(stretch),
        weight: black / blob.length,
        hue: (Math.atan2(my, mx) / (Math.PI * 2) + 1) % 1,
      });
    }
  });
  return elements;
}

/** Split points into k groups by k-means, seeded deterministically. */
function kmeans(points, k) {
  if (k <= 1 || points.length <= k) return k <= 1 ? [points] : points.map((p) => [p]);
  // Seeds: farthest-point, starting from the point farthest from the mean.
  const mean = points.reduce((m, p) => [m[0] + p.x / points.length, m[1] + p.y / points.length], [0, 0]);
  const d2 = (p, c) => (p.x - c[0]) ** 2 + (p.y - c[1]) ** 2;
  let first = points[0];
  for (const p of points) if (d2(p, mean) > d2(first, mean)) first = p;
  const centres = [[first.x, first.y]];
  while (centres.length < k) {
    let best = points[0];
    let bestD = -1;
    for (const p of points) {
      const d = Math.min(...centres.map((c) => d2(p, c)));
      if (d > bestD) { bestD = d; best = p; }
    }
    centres.push([best.x, best.y]);
  }
  let groups = [];
  for (let iter = 0; iter < 8; iter++) {
    groups = centres.map(() => []);
    for (const p of points) {
      let bi = 0;
      for (let i = 1; i < k; i++) if (d2(p, centres[i]) < d2(p, centres[bi])) bi = i;
      groups[bi].push(p);
    }
    groups.forEach((g, i) => {
      if (!g.length) return;
      centres[i] = [g.reduce((s, p) => s + p.x, 0) / g.length, g.reduce((s, p) => s + p.y, 0) / g.length];
    });
  }
  return groups.filter((g) => g.length);
}

/*
 * rosette ---------------------------------------------------------------
 */

const HUB = 0.18;   // radius of the drawing's bottom row, as a fraction of the rim's

function rosette(glyph) {
  const { width, height, levels } = glyph;
  const radius = (y) => HUB + (1 - (y + 0.5) / height) * (1 - HUB);
  const elements = [];
  for (let x = 0; x < width; x++) {
    // Column x points this way; the first column straight up.
    const theta = Math.PI / 2 - ((x + 0.5) / width) * Math.PI * 2;
    let y = 0;
    while (y < height) {
      if (!glyph.get(x, y)) { y++; continue; }
      const y0 = y;
      let black = 0;
      while (y < height && glyph.get(x, y)) {
        if (glyph.get(x, y) === levels) black++;
        y++;
      }
      const y1 = y - 1;
      const r = (radius(y0) + radius(y1)) / 2;
      const length = ((y1 - y0 + 1) / height) * (1 - HUB);
      elements.push({
        x: Math.cos(theta) * r,
        y: Math.sin(theta) * r,
        angle: theta,
        sx: Math.max(length * 0.55, 0.04),
        sy: Math.max((Math.PI * r) / width * 0.55, 0.03),
        weight: black / (y1 - y0 + 1),
        hue: x / width,
      });
    }
  }
  return elements;
}

/*
 * ------------------------------------------------------------------------
 */

const READERS = { contour, clusters, rosette };

/**
 * Read `glyph` into elements by the named interpretation (see the top of the
 * file), normalized to the figure. An unknown name warns and reads as
 * `fallback`.
 */
export function interpret(glyph, name, fallback = 'contour') {
  if (!(name in READERS)) {
    console.warn(`GloamingKit: glyph interpretation '${name}'; expected ${INTERPRETATIONS.join('|')}`);
    name = fallback;
  }
  return normalize(READERS[name](glyph));
}

/** Fit centres within REACH and scale sizes to COVERAGE, capped at MAX_SCALE. */
function normalize(elements) {
  if (!elements.length) return elements;
  // Centre on the elements' own middle, so a drawing off to one side still
  // builds a figure about the origin.
  const cx = elements.reduce((s, e) => s + e.x, 0) / elements.length;
  const cy = elements.reduce((s, e) => s + e.y, 0) / elements.length;
  const far = Math.max(1e-6, ...elements.map((e) => Math.hypot(e.x - cx, e.y - cy)));
  const fit = elements.length > 1 ? REACH / far : 0;
  const area = elements.reduce((s, e) => s + e.sx * e.sy, 0);
  const grow = Math.sqrt(COVERAGE / Math.max(1e-6, area));
  return elements.map((e) => {
    const cap = Math.min(1, MAX_SCALE / (Math.max(e.sx, e.sy) * grow));
    return {
      ...e,
      x: (e.x - cx) * fit,
      y: (e.y - cy) * fit,
      sx: e.sx * grow * cap,
      sy: e.sy * grow * cap,
    };
  });
}
