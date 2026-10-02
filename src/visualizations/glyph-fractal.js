import { ThreeVisualization } from './three-base.js';
import { approach, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';
import {
  PALETTE_OPTION, PALETTE_GLSL, paletteUniforms, updatePalette, isPsychedelic,
  DISTANCE_OPTION, Swoop, paletteColor, instanceGlow,
} from './three-shared.js';
import { windowOf } from './glyph-window.js';
import { Glyph, glyphOption, readGlyph, FLOWER } from './glyph.js';
import { interpret, interpretOption } from './glyph-interpret.js';
import { Evolver, evolveOption } from './glyph-evolve.js';
import { buildVolume, placeNode, volumeElements, volumeOption } from './glyph-volume.js';

const TABLE = 4096;   // resolution of the map-picking table
const SHAPES = ['blocks', 'pipes', 'spheres', 'diamonds', 'box'];

/**
 * GlyphFractal — a fractal grown from the drawing, made of copies of itself
 * all the way down.
 *
 * The drawing is first read into a handful of elements (option `interpret`;
 * see glyph-interpret.js): strung along its smoothed outline, merged into
 * blobs, wrapped into a rosette, or taken cell by cell. Each element then becomes a map that
 * shrinks the whole figure into it — moved, turned and stretched to match —
 * and iterating the maps in random order (the chaos game) draws the one
 * figure made of copies of itself in that arrangement. Copies strung along a
 * curve curl into dragon-like filaments; a few stretched blobs grow fronds;
 * a rosette grows snowflakes; one per cell makes the drawing out of copies
 * of the drawing, the reading that keeps it recognisable. It is rebuilt every frame, so as the maps
 * move the whole figure moves with them at every scale.
 *
 * Option `evolve` keeps the structure itself alive rather than fixed (see
 * glyph-evolve.js): `drift` (default) lets every copy wander, turn and
 * stretch on its own slow path, with hits jolting a few into new shapes;
 * `grow` assembles the figure copy by copy along the reading, the oldest
 * withering as new ones sprout and every regrowth a mutation; `morph` flows
 * between the three readings in turn; `still` holds the reading. The
 * `mutate` input (mid by default) sets how fast.
 *
 * Option `form` sets how it stands up in 3D:
 *
 *   bloom   (default) a point cloud whose copies tilt out of the plane
 *           about the axis across their direction from the centre, like
 *           petals; mostly-black elements tilt one way and mostly-grey ones
 *           the other, so the figure opens into a layered flower, and every
 *           copy of a copy does the same
 *   solid   the elements revolved round the vertical axis into three
 *           planes, so the figure is a 3D crystal, nested two or three
 *           levels deep; every piece at the bottom is a lit model of the
 *           drawing itself, so the drawing shows at the finest scale
 *
 * Option `shape` sets what that model is made of (solid only):
 *
 *   blocks    (default) a block per cell, grey cells smaller
 *   pipes     tubes joining neighbouring cells — the drawing as plumbing
 *   spheres   a ball per cell, joined to its neighbours by thin rods
 *   diamonds  a faceted diamond per cell, joined the same way
 *   box       a single box per piece, with no drawing in it: the drawing
 *             shows only in how the boxes are arranged
 *
 * The model is 3D: option `volume` (solid only; see glyph-volume.js) reads
 * the drawing as a picture of a structure — `hull` (default), the shape that
 * looks like the drawing from the front, the side and above; `lathe`, the
 * drawing spun about its vertical axis; or `flat`, the drawing one cell
 * deep. With the `cells` reading the copies themselves sit at the
 * structure's cells, so the whole figure is the structure built from
 * copies of itself — a square ring grows the Menger sponge. The other
 * readings are flat, and are revolved into planes as above.
 *
 * Elements drawn mostly in grey make dimmer copies, so they read as fainter
 * parts of the figure at every scale.
 *
 * Reactions:
 *
 *   jolt   a hit swells every copy, so the figure blooms into overlapping
 *          light, kicks the fold, and drives the evolution (a mutation, a
 *          sprout, or a hurried morph)
 *   mutate how fast the structure evolves
 *   fold   how far the copies tilt
 *   spin   how fast the copies twist about their own centres
 *   glow   brightness
 *
 * Colour follows each point's address — which copy it is in, and which copy
 * of that — so every copy, and every copy within it, wears its own hue.
 */
export class GlyphFractal extends ThreeVisualization {
  static id = 'glyph-fractal';
  static label = 'Glyph Fractal';
  static description = 'The drawing made of copies of itself, all the way down, opening into 3D; hits bloom the copies into each other.';
  static category = CATEGORY.GLYPHS;

  static inputs = {
    jolt: { kind: 'event', default: TRIGGER.BASS },
    fold: { kind: 'level', default: {
      sum: [{ intensity: 'bass', gain: 0.5 }, { relative: 'bass', gain: 0.5 }],
      smooth: 0.2,
    } },
    spin: { kind: 'level', default: { intensity: 'mid', smooth: 0.6 } },
    // How fast the structure evolves (see the `evolve` option).
    mutate: { kind: 'level', default: { intensity: 'mid', smooth: 1 } },
    glow: { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
      smooth: 0.1,
    } },
  };

  static options = {
    glyph: glyphOption({ width: 7, height: 7, value: FLOWER }),
    interpret: interpretOption('contour'),
    evolve: evolveOption('drift'),
    form: { kind: 'enum', values: ['bloom', 'solid'], default: 'bloom' },
    shape: { kind: 'enum', values: SHAPES, default: 'blocks' },
    volume: volumeOption('hull'),
    palette: PALETTE_OPTION,
    distance: DISTANCE_OPTION,
  };
  // The 2D window, wearing this one's default drawing.
  static fallback = windowOf(this.options);

  static CUBES = 12000;       // most pieces the solid may nest into
  static TRIANGLES = 1.5e6;   // most triangles across all of them
  static REVOLVE = 3;         // solid: planes the elements are revolved into
  static PER_FRAME = 80000;   // bloom: chaos-game iterations per frame
  // Points kept: two frames. More history smears the finest copies as the
  // maps move, and fine copies are the point.
  static CLOUD = 160000;
  // Added copy size at full hit strength. Small: copies that overlap fill
  // each other in, and the bass is rarely fully at rest.
  static SWELL = 0.12;
  // Tilt, rad: [idle, added at full fold]. Small, because it compounds: a
  // copy of a copy tilts by its own lean on top of its parent's, so past
  // about half a radian the finer levels scramble into fog.
  static FOLD = [0.12, 0.45];
  static TWIST = 0.3;         // largest twist of a copy about its centre, rad
  static SPIN = [0.15, 0.8];  // twist phase rate: [idle, added at full spin]
  static VIEW = 3.4;          // camera distance at `med`, in figure radii
  static ORBIT = [0.04, 0.12];
  static KICK_DECAY = 2.6;

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    const { CLOUD } = GlyphFractal;
    this.psychedelic = isPsychedelic(this);
    this.glyph = readGlyph(this);

    const form = this.options.form ?? 'bloom';
    if (form !== 'bloom' && form !== 'solid') {
      console.warn(`GloamingKit: glyph-fractal form '${form}'; expected bloom|solid`);
    }
    this.solid = form === 'solid';
    const spec = GlyphFractal.options;
    const volume = this.options.volume ?? spec.volume.default;
    let reading = this.options.interpret ?? spec.interpret.default;
    if (this.solid) this.volume = buildVolume(this.glyph, volume);
    const read = this.solid ? (glyph, r) => this.lift(r) : interpret;
    // One element is one map, whose fractal is a single point: read the
    // default drawing instead.
    if (read(this.glyph, reading).length < 2) {
      this.glyph = Glyph.parse(spec.glyph.default);
      reading = spec.interpret.default;
      if (this.solid) this.volume = buildVolume(this.glyph, volume);
    }
    // Whether the first reading is revolved into planes (see lift()).
    this.revolved = this.solid && !this.inSpace(reading);
    this.evolver = new Evolver(this.glyph, reading, this.options.evolve ?? spec.evolve.default, read);
    this.maps = this.createMaps(this.evolver.count);
    this.scratch = [new Float64Array(9), new Float64Array(9), new Float64Array(9)];

    const n = this.maps.length;
    this.matrices = new Float32Array(n * 12);
    this.hues = new Float32Array(n);
    this.dims = new Float32Array(n);
    this.placeMaps();
    if (this.solid) this.buildCubes();
    else this.buildPoints();

    this.phase = Math.random() * 10;
    this.spinRate = GlyphFractal.SPIN[0];
    this.fold = GlyphFractal.FOLD[0];
    this.kick = 0;
    this.colorPhase = Math.random();
    this.swoop = new Swoop(this.options.distance, { near: 0.3, far: 2.2, period: 30 });
    this.lift = Math.random() * 10;
    this.camera.fov = 55;
    this.camera.near = 0.01;
    this.camera.far = 100;
    this.center = new THREE.Vector3();
    this.mean = new THREE.Vector3();   // the figure's centre this frame
  }

  /** Bloom: a chaos-game point cloud. */
  buildPoints() {
    const THREE = this.THREE;
    const { CLOUD } = GlyphFractal;
    this.table = new Uint16Array(TABLE);
    this.reweigh();

    this.cloud = new Float32Array(CLOUD * 3);
    this.tones = new Float32Array(CLOUD * 2);   // (hue, brightness) per point
    this.position = new THREE.BufferAttribute(this.cloud, 3).setUsage(THREE.DynamicDrawUsage);
    this.tone = new THREE.BufferAttribute(this.tones, 2).setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.position);
    geometry.setAttribute('tone', this.tone);
    geometry.setDrawRange(0, 0);

    this.uniforms = {
      ...paletteUniforms(THREE),
      uHead: { value: 0 },
      uCount: { value: 1 },
      uPixels: { value: 1 },
      uHue: { value: 0 },
      uGlow: { value: 0.5 },
    };
    this.points = new THREE.Points(geometry, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // Premultiplied additive, as nebula: dense regions bloom on their own.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    }));
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    // Chaos-game state, carried across frames.
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.hue = 0;
    this.bright = 1;
    this.write = 0;
    this.filled = 0;
  }

  /**
   * Solid: lit models of the drawing, the maps nested as many levels deep as
   * the budgets allow. Revolved into 3D the figure is nearly a volume, so as
   * points it would only ever be fog; surfaces and shading are what make it
   * read.
   */
  buildCubes() {
    const THREE = this.THREE;
    const n = this.maps.length;
    const shape = this.options.shape ?? 'blocks';
    if (!SHAPES.includes(shape)) {
      console.warn(`GloamingKit: glyph-fractal shape '${shape}'; expected ${SHAPES.join('|')}`);
    }
    // The finest detail that still fits one level of copies in the triangle
    // budget: a big structure's pieces are tiny on screen anyway.
    for (let detail = 2; detail >= 0; detail--) {
      this.piece?.dispose();
      this.piece = buildPiece(THREE, this.volume, SHAPES.includes(shape) ? shape : 'blocks', detail);
      if (n * (this.piece.attributes.position.count / 3) <= GlyphFractal.TRIANGLES) break;
    }
    // A flat reading's outermost copies are revolved into all the planes.
    // With a drawing in every piece, the copies within them stay in their
    // parent's plane: revolved again they pile into a thicket where no piece
    // can be read. Plain boxes have nothing to read, so they revolve at every
    // level; and copies already placed in space nest all of them.
    const inner = shape === 'box' || !this.revolved ? n : Math.round(n / GlyphFractal.REVOLVE);
    // As deep as the piece budget and the triangle budget both allow.
    const triangles = this.piece.attributes.position.count / 3;
    const most = Math.min(GlyphFractal.CUBES, GlyphFractal.TRIANGLES / triangles);
    this.widths = [1, n];   // copies at each level of nesting
    while (this.widths.at(-1) * inner <= most) this.widths.push(this.widths.at(-1) * inner);
    this.inner = inner;
    this.depth = this.widths.length - 1;
    const count = this.widths[this.depth];
    // Composed transforms for each level of nesting, reused every frame.
    this.nests = this.widths.map((w) => new Float32Array(w * 12));
    this.nests[0].set([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);

    const material = new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.35, vertexColors: true });
    this.glow = instanceGlow(material, 0.3);
    this.cubes = new THREE.InstancedMesh(this.piece, material, count);
    this.cubes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cubes.frustumCulled = false;
    // Address colour, composed alongside the transforms: the outermost copy
    // picks the hue, each level within shifts it by a quarter as much, as
    // the point cloud's colours do. (hue, brightness) per nest.
    this.nestTones = this.widths.map((w) => new Float32Array(w * 2));
    this.nestTones[0].set([0, 1]);
    this.cubes.setColorAt(0, new THREE.Color(1, 1, 1));
    this.cubes.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.cubes);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(0.5, 1, 0.7);
    this.scene.add(key);
    this.headlight = new THREE.PointLight(0xffffff, 2, 0, 0);
    this.scene.add(this.headlight);
    this.c = new THREE.Color();
  }

  /** Compose the maps `depth` levels deep into the cubes' instance matrices. */
  updateCubes() {
    const m = this.matrices;
    for (let d = 1; d <= this.depth; d++) {
      const n = d === 1 ? this.maps.length : this.inner;
      const parent = this.nests[d - 1];
      const out = this.nests[d];
      const parentTone = this.nestTones[d - 1];
      const outTone = this.nestTones[d];
      const hueScale = 0.25 ** (d - 1);
      const parents = this.widths[d - 1];
      // Address (a, b) is parent a applied after map b: P ∘ M.
      for (let a = 0; a < parents; a++) {
        const p = a * 12;
        const p00 = parent[p], p01 = parent[p + 1], p02 = parent[p + 2];
        const p10 = parent[p + 3], p11 = parent[p + 4], p12 = parent[p + 5];
        const p20 = parent[p + 6], p21 = parent[p + 7], p22 = parent[p + 8];
        for (let b = 0; b < n; b++) {
          const q = b * 12;
          const o = (a * n + b) * 12;
          outTone[(a * n + b) * 2] = parentTone[a * 2] + this.hues[b] * hueScale;
          outTone[(a * n + b) * 2 + 1] = parentTone[a * 2 + 1] * (0.4 + 0.6 * this.dims[b]);
          for (let r = 0; r < 3; r++) {
            const r0 = r === 0 ? p00 : r === 1 ? p10 : p20;
            const r1 = r === 0 ? p01 : r === 1 ? p11 : p21;
            const r2 = r === 0 ? p02 : r === 1 ? p12 : p22;
            out[o + r * 3] = r0 * m[q] + r1 * m[q + 3] + r2 * m[q + 6];
            out[o + r * 3 + 1] = r0 * m[q + 1] + r1 * m[q + 4] + r2 * m[q + 7];
            out[o + r * 3 + 2] = r0 * m[q + 2] + r1 * m[q + 5] + r2 * m[q + 8];
            out[o + 9 + r] = r0 * m[q + 9] + r1 * m[q + 10] + r2 * m[q + 11] + parent[p + 9 + r];
          }
        }
      }
    }
    // Into three's column-major 4×4s.
    const leaf = this.nests[this.depth];
    const tone = this.nestTones[this.depth];
    let mx = 0, my = 0, mz = 0, mass = 0;
    const e = this.cubes.instanceMatrix.array;
    const count = this.widths[this.depth];
    for (let i = 0; i < count; i++) {
      const s = i * 12;
      const t = i * 16;
      e[t] = leaf[s]; e[t + 1] = leaf[s + 3]; e[t + 2] = leaf[s + 6]; e[t + 3] = 0;
      e[t + 4] = leaf[s + 1]; e[t + 5] = leaf[s + 4]; e[t + 6] = leaf[s + 7]; e[t + 7] = 0;
      e[t + 8] = leaf[s + 2]; e[t + 9] = leaf[s + 5]; e[t + 10] = leaf[s + 8]; e[t + 11] = 0;
      e[t + 12] = leaf[s + 9]; e[t + 13] = leaf[s + 10]; e[t + 14] = leaf[s + 11]; e[t + 15] = 1;
      // Weighted by size, so absent (zero-size) cubes don't pull the centre.
      const size = Math.abs(leaf[s] * leaf[s + 4]);
      mx += leaf[s + 9] * size;
      my += leaf[s + 10] * size;
      mz += leaf[s + 11] * size;
      mass += size;
      paletteColor(this, tone[i * 2] * 0.5 + this.colorPhase, this.c);
      this.cubes.setColorAt(i, this.c.multiplyScalar(tone[i * 2 + 1]));
    }
    if (mass > 0) this.mean.set(mx / mass, my / mass, mz / mass);
    this.cubes.instanceMatrix.needsUpdate = true;
    this.cubes.instanceColor.needsUpdate = true;
  }

  /** Whether `reading` places the solid's copies in space directly. */
  inSpace(reading) {
    return reading === 'cells' && this.volume.mode !== 'flat';
  }

  /**
   * The solid's reading, in 3D. Cells read through the volume are already
   * in space: a copy at every cell of the structure, so the figure is the
   * structure made of copies of itself. The other readings are flat, so
   * every element is revolved round the vertical axis into REVOLVE planes,
   * plane by plane — the first plane's copies come first.
   */
  lift(reading) {
    if (this.inSpace(reading)) return volumeElements(this.volume);
    const { REVOLVE } = GlyphFractal;
    const flat = interpret(this.glyph, reading, GlyphFractal.options.interpret.default);
    return Array.from({ length: REVOLVE }, (_, k) => flat.map((e) => ({
      ...e, phi: (k / REVOLVE) * Math.PI * 2, hue: e.hue + k * 0.33,
    }))).flat();
  }

  /** One map per live element; placeMaps() fills them as the elements evolve. */
  createMaps(count) {
    return Array.from({ length: count }, (_, i) => ({ element: i }));
  }

  /** Copy this frame's live elements into the maps. */
  placeMaps() {
    const live = this.evolver.live;
    let reach = 1e-6;
    for (const e of live) if (e.sx > 0) reach = Math.max(reach, Math.hypot(e.x, e.y));
    this.maps.forEach((map, i) => {
      const e = live[map.element];
      const d = Math.hypot(e.x, e.y);
      const black = e.weight >= 0.5;
      map.x = e.x;
      map.y = e.y;
      map.z = e.z ?? 0;
      map.phi = e.phi ?? 0;
      map.angle = e.angle;
      map.sx = e.sx;
      map.sy = e.sy;
      // Tilt about the axis across the element's direction from the centre,
      // so the copy lifts like a petal. One at the centre has no direction;
      // it tilts about x.
      map.ax = d > 1e-6 ? -e.y / d : 1;
      map.ay = d > 1e-6 ? e.x / d : 0;
      map.lean = Math.min(1, d / reach) * (black ? 1 : -1);   // tilt, as a fraction of the fold
      map.twist = black ? 1 : -1;
      this.dims[i] = 0.45 + 0.55 * e.weight;
      this.hues[i] = e.hue;
    });
  }

  /**
   * Pick maps in proportion to their area, so every copy fills in at the
   * same density whatever its size — and an absent one is never picked.
   */
  reweigh() {
    let total = 0;
    for (const m of this.maps) total += m.sx * m.sy;
    this.alive = total > 1e-9;
    if (!this.alive) return;
    const n = this.maps.length;
    let k = 0;
    for (let i = 0, acc = 0; i < n; i++) {
      acc += (this.maps[i].sx * this.maps[i].sy) / total;
      for (; k < Math.round(acc * TABLE) && k < TABLE; k++) this.table[k] = i;
    }
    // Rounding can leave the last few entries; give them the last live map.
    for (; k < TABLE; k++) this.table[k] = this.table[k - 1] ?? 0;
  }

  onInput(slot, data) {
    if (slot !== 'jolt') return;
    this.kick = Math.max(this.kick, impact(data));
    this.evolver.hit(impact(data));
  }

  /**
   * Each map as a 3×4 matrix: stretch, turn in the plane (its own angle
   * plus the twist), tilt about its lean axis, revolve into its plane, and
   * move to its centre.
   */
  updateMaps() {
    const { SWELL, TWIST } = GlyphFractal;
    const m = this.matrices;
    const [A, R, B] = this.scratch;
    const swell = 1 + this.kick * SWELL;
    const twist = Math.sin(this.phase) * TWIST;
    // Revolved copies already stand in three planes; tilting them as far as
    // the bloom's petals tangles the solid.
    const tiltScale = this.solid ? 0.5 : 1;
    this.maps.forEach((map, i) => {
      // A = turn · stretch. Depth gets the geometric mean of the two sizes.
      const turn = map.angle + twist * map.twist;
      const ca = Math.cos(turn);
      const sa = Math.sin(turn);
      const sx = map.sx * swell;
      const sy = map.sy * swell;
      A.set([ca * sx, -sa * sy, 0, sa * sx, ca * sy, 0, 0, 0, Math.sqrt(sx * sy)]);
      // R = tilt by `a` about the unit axis (ax, ay, 0): Rodrigues.
      const a = (this.fold + this.kick * 0.25) * map.lean * tiltScale;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const t = 1 - c;
      const { ax, ay } = map;
      R.set([
        t * ax * ax + c, t * ax * ay, sn * ay,
        t * ax * ay, t * ay * ay + c, -sn * ax,
        -sn * ay, sn * ax, c,
      ]);
      mul3(B, R, A);
      let { x, y, z } = map;
      if (map.phi) {
        // Revolve about y: rows 0 and 2 of B, and the centre, turn by phi.
        const cp = Math.cos(map.phi);
        const sp = Math.sin(map.phi);
        for (let col = 0; col < 3; col++) {
          const r0 = B[col];
          const r2 = B[6 + col];
          B[col] = cp * r0 + sp * r2;
          B[6 + col] = -sp * r0 + cp * r2;
        }
        [x, z] = [cp * x + sp * z, -sp * x + cp * z];
      }
      const j = i * 12;
      for (let k = 0; k < 9; k++) m[j + k] = B[k];
      m[j + 9] = x;
      m[j + 10] = y;
      m[j + 11] = z;
    });
  }

  /** Run the chaos game PER_FRAME times into the ring buffer. */
  iterate() {
    const { PER_FRAME, CLOUD } = GlyphFractal;
    if (!this.alive) return;
    const { table, matrices: m, hues, dims, cloud, tones } = this;
    let { x, y, z, hue, bright, write: w } = this;
    let mx = 0, my = 0, mz = 0;
    for (let i = 0; i < PER_FRAME; i++) {
      const k = table[(Math.random() * TABLE) | 0];
      const j = k * 12;
      const nx = m[j] * x + m[j + 1] * y + m[j + 2] * z + m[j + 9];
      const ny = m[j + 3] * x + m[j + 4] * y + m[j + 5] * z + m[j + 10];
      const nz = m[j + 6] * x + m[j + 7] * y + m[j + 8] * z + m[j + 11];
      x = nx;
      y = ny;
      z = nz;
      // The last map applied picks the top-level copy the point is in, the
      // one before it the copy within that, and so on: weighting each by a
      // quarter of the last makes hue an address, so copies keep their own
      // colour at every scale.
      hue = hues[k] + hue * 0.25;
      bright = dims[k] * (0.4 + 0.6 * bright);
      const c = w * 3;
      cloud[c] = x;
      cloud[c + 1] = y;
      cloud[c + 2] = z;
      mx += x;
      my += y;
      mz += z;
      tones[w * 2] = hue;
      tones[w * 2 + 1] = bright;
      w = (w + 1) % CLOUD;
    }
    Object.assign(this, { x, y, z, hue, bright, write: w });
    this.mean.set(mx / PER_FRAME, my / PER_FRAME, mz / PER_FRAME);
    this.filled = Math.min(CLOUD, this.filled + PER_FRAME);
    this.position.needsUpdate = true;
    this.tone.needsUpdate = true;
  }

  draw(ctx, dt) {
    const { FOLD, SPIN, ORBIT, VIEW, KICK_DECAY } = GlyphFractal;
    const spin = this.in('spin');
    this.spinRate = approach(this.spinRate, SPIN[0] + spin * SPIN[1], 0.4, dt);
    this.phase += this.spinRate * dt;
    this.fold = approach(this.fold, FOLD[0] + this.in('fold') * FOLD[1], 0.25, dt);
    this.kick *= Math.exp(-dt * KICK_DECAY);
    this.colorPhase += dt * (0.03 + spin * 0.06);

    this.evolver.update(dt, this.in('mutate'));
    this.placeMaps();
    this.updateMaps();
    if (this.solid) {
      this.updateCubes();
    } else {
      this.reweigh();
      this.iterate();
    }

    const orbit = ORBIT[0] + spin * ORBIT[1];
    this.swoop.update(dt, orbit);
    this.lift += dt * orbit * 0.7;
    const { scale, angle } = this.swoop;
    const dist = VIEW * scale;
    const cam = this.camera;
    if (this.solid) {
      // A solid: circle it, rising and sinking.
      const elevation = Math.sin(this.lift) * 0.7;
      cam.position.set(
        Math.sin(angle) * Math.cos(elevation) * dist,
        Math.sin(elevation) * dist,
        Math.cos(angle) * Math.cos(elevation) * dist,
      );
    } else {
      // A flower facing +z: stay on its open side, circling round the axis
      // and swinging between face-on and oblique, where the tilted layers
      // separate. Never much past 45°: edge-on, the drawing is a line.
      const tilt = 0.15 + 0.32 * (1 + Math.sin(this.lift));
      cam.position.set(
        Math.sin(tilt) * Math.cos(angle) * dist,
        Math.sin(tilt) * Math.sin(angle) * dist,
        Math.cos(tilt) * dist,
      );
    }
    // Follow the figure's centre: a figure that is growing, drifting or
    // morphing doesn't stay centred on the origin.
    const follow = 1 - Math.exp(-dt / 0.8);
    this.center.lerp(this.mean, follow);
    cam.position.add(this.center);
    this.swoop.aim(cam, this.center);
    if (cam.aspect !== this.width / this.height) {
      cam.aspect = this.width / this.height;
      cam.updateProjectionMatrix();
    }

    if (this.solid) {
      this.headlight.position.copy(cam.position);
      this.glow.value = 0.15 + this.in('glow') * 0.4 + this.kick * 0.4;
      this.present(ctx);
      return;
    }
    const u = this.uniforms;
    updatePalette(this, u);
    u.uHead.value = this.write;
    u.uCount.value = this.filled;
    u.uHue.value = this.colorPhase;
    u.uGlow.value = 0.45 + this.in('glow') * 0.8 + this.kick * 0.4;
    const fov = (cam.fov * Math.PI) / 180;
    u.uPixels.value = (this.height * this.pixelScale()) / (2 * Math.tan(fov / 2));
    this.points.geometry.setDrawRange(0, this.filled);
    this.present(ctx);
  }
}

const VERTEX = /* glsl */ `
${PALETTE_GLSL}
attribute vec2 tone;   // (address hue, brightness)

uniform float uHead;
uniform float uCount;
uniform float uPixels;
uniform float uHue;
uniform float uGlow;

varying vec3 vColor;

void main() {
  // 1 for the newest point, toward 0 for the oldest, as point-cloud-3d.
  float behind = mod(uHead - float(gl_VertexID) - 1.0 + uCount, uCount);
  float age = 1.0 - behind / uCount;

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = 0.008 * uPixels / max(-mv.z, 0.02);
  gl_PointSize = clamp(px, 1.0, 6.0);

  // Spread a big near point's light over its area, so close passes stay soft.
  float spread = min(1.0, 4.0 / (px * px));
  vColor = palette(tone.x * 0.5 + uHue) * tone.y * age * spread * uGlow * 1.8;
}
`;

const FRAGMENT = /* glsl */ `
varying vec3 vColor;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.4, 1.0, d);
  gl_FragColor = vec4(vColor * a, a * 0.25);
}
`;

/** out = p · q, for 3×3 row-major matrices. */
function mul3(out, p, q) {
  for (let r = 0; r < 3; r++) {
    const p0 = p[r * 3];
    const p1 = p[r * 3 + 1];
    const p2 = p[r * 3 + 2];
    out[r * 3] = p0 * q[0] + p1 * q[3] + p2 * q[6];
    out[r * 3 + 1] = p0 * q[1] + p1 * q[4] + p2 * q[7];
    out[r * 3 + 2] = p0 * q[2] + p1 * q[5] + p2 * q[8];
  }
}

/*
 * Solid pieces ------------------------------------------------------------
 */

/**
 * The drawing's volume (see glyph-volume.js) as one lit model, in the
 * [-1, 1] frame every map is a copy of: a solid per node, and for the joined
 * shapes a rod or pipe per link. Grey cells are smaller and darker — the
 * darkness rides in a vertex colour, multiplied with each piece's own colour.
 * `detail` 2–0 trades roundness for triangles: faceted balls and joints,
 * fewer sides to the rods, and at 0 no joints on the pipes and no rods
 * between balls or diamonds.
 */
function buildPiece(THREE, volume, shape, detail = 2) {
  if (shape === 'box') return merge(THREE, [{ geometry: new THREE.BoxGeometry(2, 2, 2), shade: 1 }]);
  const { cell, nodes, links } = volume;
  const parts = [];
  const place = (geometry, position, shade, rotation = null) => {
    const matrix = new THREE.Matrix4();
    if (rotation) matrix.makeRotationFromQuaternion(rotation);
    matrix.setPosition(position);
    parts.push({ geometry, matrix, shade });
  };
  const up = new THREE.Vector3(0, 1, 0);
  const where = nodes.map((n) => new THREE.Vector3(...placeNode(n)));

  nodes.forEach((n, i) => {
    const p = where[i];
    const full = n.black;
    const shade = full ? 1 : 0.55;
    // Turned with its rib, so a lathe's blocks face outward.
    const turn = n.turn ? new THREE.Quaternion().setFromAxisAngle(up, n.turn) : null;
    if (shape === 'blocks') {
      const side = cell * (full ? 0.9 : 0.62);
      place(new THREE.BoxGeometry(side, side, side), p, shade, turn);
    } else if (shape === 'pipes') {
      // A joint at every cell, so bends are rounded and a lone cell still
      // shows; a little fatter than the pipe, like a fitting.
      const r = cell * (full ? 0.2 : 0.15);
      if (detail > 0) place(detail === 2 ? new THREE.SphereGeometry(r, 8, 4) : new THREE.OctahedronGeometry(r), p, shade);
    } else if (shape === 'spheres') {
      place(ball(THREE, cell * (full ? 0.36 : 0.26), detail), p, shade);
    } else {
      // Stood on a point, a little taller than wide.
      const g = new THREE.OctahedronGeometry(cell * (full ? 0.46 : 0.34));
      g.scale(0.85, 1.15, 0.85);
      place(g, p, shade, turn);
    }
  });

  if (shape === 'pipes' || (shape !== 'blocks' && detail > 0)) {
    const radius = cell * (shape === 'pipes' ? 0.15 : 0.07);
    const segments = [3, 4, shape === 'pipes' ? 6 : 5][detail];
    for (const [a, b] of links) {
      const along = where[b].clone().sub(where[a]);
      const length = along.length();
      // Thinner where it reaches a grey cell.
      const grey = !nodes[a].black || !nodes[b].black;
      const r = radius * (grey ? 0.7 : 1);
      const turn = new THREE.Quaternion().setFromUnitVectors(up, along.normalize());
      place(new THREE.CylinderGeometry(r, r, length, segments, 1, true),
        where[a].clone().add(where[b]).multiplyScalar(0.5), grey ? 0.7 : 1, turn);
    }
  }
  return merge(THREE, parts);
}

/** A ball of `radius`: round at detail 2, faceted below. */
function ball(THREE, radius, detail) {
  if (detail === 2) return new THREE.SphereGeometry(radius, 10, 6);
  return detail === 1 ? new THREE.IcosahedronGeometry(radius) : new THREE.OctahedronGeometry(radius);
}

/** One non-indexed geometry from parts, each moved by its matrix and given a grey shade. */
function merge(THREE, parts) {
  const flat = parts.map(({ geometry, matrix }) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) geometry.dispose();
    if (matrix) g.applyMatrix4(matrix);
    return g;
  });
  const total = flat.reduce((sum, g) => sum + g.attributes.position.count, 0);
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  let at = 0;
  flat.forEach((g, i) => {
    const n = g.attributes.position.count;
    position.set(g.attributes.position.array, at * 3);
    normal.set(g.attributes.normal.array, at * 3);
    color.fill(parts[i].shade, at * 3, (at + n) * 3);
    at += n;
    g.dispose();
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  return out;
}
