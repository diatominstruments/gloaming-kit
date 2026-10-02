/**
 * Volumes — a drawing read as a picture of a 3D structure.
 *
 * A glyph is flat, but a 3D visualization can treat it as a view of
 * something solid and build that instead. A volume is a set of nodes — one
 * per cell of the structure — and the links between neighbouring ones, so a
 * visualization can draw it as blocks, balls, diamonds, or pipes along the
 * links.
 *
 *   hull   the structure that looks like the drawing from the front, from
 *          the side and from above: a cell is solid where all three views
 *          are drawn. A cross becomes a 3D cross; a square ring becomes the
 *          first step of the Menger sponge. A drawing too lopsided to agree
 *          with itself from three sides (less than half its cells' worth of
 *          solid) is turned on a lathe instead.
 *   lathe  the drawing spun about its vertical axis, as a profile is on a
 *          lathe — each side of the centre column folded onto the other —
 *          and sampled on SPOKES ribs, so a dot off the axis becomes a ring.
 *          Vases, lanterns, tori.
 *   flat   the drawing as it is, one cell deep.
 *
 * Nodes sit in the figure's frame, [-1, 1] on the drawing's longer side,
 * y up. Each has a position in its own rib's plane (x, y, z) and the turn
 * of that plane about y, so its place in space is that position turned by
 * `turn` — x' = x·cos + z·sin, z' = −x·sin + z·cos. Only the lathe turns
 * them; the grid volumes have every turn 0.
 */

export const VOLUMES = Object.freeze(['hull', 'lathe', 'flat']);

/** The `volume` option, with a per-visualization default. */
export const volumeOption = (value) => Object.freeze({
  kind: 'enum', values: VOLUMES, default: value,
});

const SPOKES = 8;

/**
 * `glyph` as a volume: { mode, size, cell, nodes, links }. `mode` is the
 * volume actually built (a hull may fall back to a lathe), `size` the grid's
 * cells per side, `cell` one cell's width in the frame, and `links` pairs of
 * node indices.
 */
export function buildVolume(glyph, mode = 'hull') {
  if (!VOLUMES.includes(mode)) {
    console.warn(`GloamingKit: glyph volume '${mode}'; expected ${VOLUMES.join('|')}`);
    mode = 'hull';
  }
  const size = Math.max(glyph.width, glyph.height);
  const ox = Math.floor((size - glyph.width) / 2);
  const oy = Math.floor((size - glyph.height) / 2);
  // The drawing centred in a square of `size`.
  const at = (u, v) => glyph.get(u - ox, v - oy);
  const cell = 2 / size;
  const pos = (i) => (i + 0.5 - size / 2) * cell;

  if (mode === 'lathe') return lathe(glyph, size, at, cell, pos);

  const cells = [];
  for (let z = 0; z < (mode === 'flat' ? 1 : size); z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const level = mode === 'flat' ? at(x, y) : Math.min(at(x, y), at(z, y), at(x, z));
        if (level) cells.push({ gx: x, gy: y, gz: z, level });
      }
    }
  }
  if (mode === 'hull' && cells.length < Math.max(2, glyph.count / 2)) {
    return lathe(glyph, size, at, cell, pos);
  }
  const nodes = cells.map(({ gx, gy, gz, level }) => node(
    pos(gx), -pos(gy), mode === 'flat' ? 0 : pos(gz), 0, level, glyph.levels,
  ));
  return { mode, size, cell, nodes, links: gridLinks(cells) };
}

function node(x, y, z, turn, level, levels) {
  return { x, y, z, turn, level, weight: level / levels, black: level === levels };
}

/**
 * Links between grid cells: across faces, and across edges or corners only
 * where nothing else in the box they span is solid — so a diagonal stroke
 * stays joined but a solid patch doesn't turn into a lattice of crosses.
 */
function gridLinks(cells) {
  const key = (x, y, z) => `${x},${y},${z}`;
  const index = new Map(cells.map((c, i) => [key(c.gx, c.gy, c.gz), i]));
  const links = [];
  cells.forEach((c, i) => {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          // Each pair once: only neighbours that come later in (z, y, x) order.
          if (dz < 0 || (dz === 0 && (dy < 0 || (dy === 0 && dx <= 0)))) continue;
          const j = index.get(key(c.gx + dx, c.gy + dy, c.gz + dz));
          if (j === undefined) continue;
          let clear = true;
          for (let ez = 0; ez <= Math.abs(dz) && clear; ez++) {
            for (let ey = 0; ey <= Math.abs(dy) && clear; ey++) {
              for (let ex = 0; ex <= Math.abs(dx) && clear; ex++) {
                const corner = ex + ey + ez;
                if (corner === 0 || corner === Math.abs(dx) + Math.abs(dy) + Math.abs(dz)) continue;
                if (index.has(key(c.gx + ex * Math.sign(dx), c.gy + ey * Math.sign(dy), c.gz + ez * Math.sign(dz)))) {
                  clear = false;
                }
              }
            }
          }
          if (clear) links.push([i, j]);
        }
      }
    }
  });
  return links;
}

/**
 * The lathe: a profile of radius × height, each radius taking the stronger
 * of the two columns that far either side of the centre, swept round on
 * SPOKES ribs. Links run along each rib as the 2D grid's do, and round each
 * ring between neighbouring ribs.
 */
function lathe(glyph, size, at, cell, pos) {
  const odd = size % 2 === 1;
  const radii = Math.ceil(size / 2);
  const profile = [];   // [ring][row] -> level
  for (let k = 0; k < radii; k++) {
    const left = odd ? (size - 1) / 2 - k : size / 2 - 1 - k;
    const right = odd ? (size - 1) / 2 + k : size / 2 + k;
    profile.push(Array.from({ length: size }, (_, y) => Math.max(at(left, y), at(right, y))));
  }
  // The centre column of an odd drawing is the axis itself: one node, not
  // a ring.
  const radius = (k) => (odd ? k : k + 0.5) * cell;
  const onAxis = (k) => odd && k === 0;
  const nodes = [];
  const ids = new Map();   // `${k},${y},${spoke}` -> node index
  for (let k = 0; k < radii; k++) {
    for (let y = 0; y < size; y++) {
      const level = profile[k][y];
      if (!level) continue;
      for (let s = 0; s < (onAxis(k) ? 1 : SPOKES); s++) {
        ids.set(`${k},${y},${s}`, nodes.length);
        nodes.push(node(radius(k), -pos(y), 0, (s / SPOKES) * Math.PI * 2, level, glyph.levels));
      }
    }
  }
  const id = (k, y, s) => ids.get(`${k},${y},${onAxis(k) ? 0 : s}`);
  const filled = (k, y) => k >= 0 && k < radii && y >= 0 && y < size && profile[k][y] > 0;
  const links = [];
  for (let k = 0; k < radii; k++) {
    for (let y = 0; y < size; y++) {
      if (!filled(k, y)) continue;
      for (let s = 0; s < (onAxis(k) ? 1 : SPOKES); s++) {
        // Round the ring.
        if (!onAxis(k)) links.push([id(k, y, s), id(k, y, (s + 1) % SPOKES)]);
      }
      // Along the ribs: outward and down, diagonals only where unbridged.
      // From the axis a link fans out to every rib.
      const along = [[1, 0], [0, 1], [1, 1], [-1, 1]];
      for (const [dk, dy] of along) {
        if (!filled(k + dk, y + dy)) continue;
        if (dk && dy && (filled(k + dk, y) || filled(k, y + dy))) continue;
        // A link touching the axis comes up once per rib; keep one of each.
        const seen = new Set();
        for (let s = 0; s < SPOKES; s++) {
          const a = id(k, y, s);
          const b = id(k + dk, y + dy, s);
          const pair = `${a},${b}`;
          if (a === b || seen.has(pair)) continue;
          seen.add(pair);
          links.push([a, b]);
        }
      }
    }
  }
  return { mode: 'lathe', size, cell, nodes, links };
}

/** Where `node` is in space, as [x, y, z]. */
export function placeNode({ x, y, z, turn }) {
  if (!turn) return [x, y, z];
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  return [x * c + z * s, y, -x * s + z * c];
}

const GREY = 0.7;   // a grey cell's copy, relative to a black one's

/**
 * The volume as elements (see glyph-interpret.js), for a fractal: one per
 * node, sized to one cell's share of the figure, so a copy of the whole
 * structure at every node is the structure made of copies of itself — the
 * 3D counterpart of the `cells` reading. Each carries its node's `z` and
 * `turn` (as `phi`). Recentred as that reading is: shifting every centre by
 * (1 − s)·t moves the whole figure by t. A lathe is already centred on its
 * axis, so only its height moves.
 */
export function volumeElements(volume) {
  const { nodes, size } = volume;
  if (!nodes.length) return [];
  const s = 1 / size;
  const scale = (n) => s * (n.black ? 1 : GREY);
  const spots = nodes.map(placeNode);
  let tx = 0, ty = 0, tz = 0, mass = 0;
  nodes.forEach((n, i) => {
    const w = scale(n) ** 3;
    tx += spots[i][0] * w;
    ty += spots[i][1] * w;
    tz += spots[i][2] * w;
    mass += w;
  });
  const keep = 1 - s;
  const turned = volume.mode === 'lathe';
  return nodes.map((n, i) => {
    const [wx, wy, wz] = spots[i];
    return {
      x: n.x - (turned ? 0 : keep * tx / mass),
      y: n.y - keep * ty / mass,
      z: n.z - (turned ? 0 : keep * tz / mass),
      phi: n.turn,
      angle: 0,
      sx: scale(n),
      sy: scale(n),
      weight: n.weight,
      // Round the vertical axis, drifting with height.
      hue: ((Math.atan2(wz, wx) / (Math.PI * 2) + 1 + wy * 0.15) % 1 + 1) % 1,
    };
  });
}
