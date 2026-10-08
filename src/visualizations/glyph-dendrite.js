import { ThreeVisualization } from './three-base.js';
import { approach, clamp01, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { LAYER } from './layers.js';
import { TRIGGER } from '../analyzer.js';
import { createNoise3D, mulberry32 } from '../noise.js';
import {
  PALETTE_OPTION, PALETTE_GLSL, paletteUniforms, updatePalette, isPsychedelic,
  DISTANCE_OPTION, Swoop, logSpectrum,
} from './three-shared.js';
import { glyphOption, readGlyph, FERN } from './glyph.js';

const PULSES = 6;
const BINS = 12;
// The golden angle: each generation's children leave in a plane turned this
// far round the stem from the last, as leaves do, so no two rows overlap.
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * GlyphDendrite — the drawing as a branching rule, grown in three
 * dimensions. Each row is one generation of growth: a filled cell is a child
 * branch, its column the angle it leaves the stem at (left of centre to one
 * side, right to the other) and its strength how long and thick it grows; an
 * empty row grows straight on. Each generation's children leave in a plane
 * turned the golden angle round the stem from the last, so a flat fern of a
 * drawing grows as a spiralling 3D one. Tips follow the rows in turn, over
 * and over, finer each time, wandering through a noise field and stopping
 * dead when they reach anything already grown — so the branches never pass
 * through each other and the whole thing packs into a coral.
 *
 * The coral is drawn as glowing filaments, wider and brighter the nearer
 * they are and dimmed toward the back, while the camera circles it (or, on
 * `orbit`, swoops through it), so its depth reads at a glance. When nothing
 * is left growing it thaws — burns back from its twigs to its roots and
 * blows apart — while a new one grows in its place.
 *
 * The sound runs along the branches. Distance from the root is frequency:
 * the spectrum lights the coral from the trunks (bass) out to the finest
 * twigs (treble), so every part of it is always answering some part of the
 * mix.
 *
 *   sprout  a hit: a pulse of light fires from the roots out along every
 *           branch, shoving them outward as it passes; tips branch at once,
 *           a fresh seed lands and the coral lurches round
 *   grow    how fast the tips advance
 *   glow    how brightly the growing tips and new growth burn
 *   sway    how far the outer branches stream in the current
 *
 * Options:
 *   glyph    the drawing
 *   spread   'narrow' | 'wide' — how far the outermost column turns a branch
 *   from     'centre' (default; a coral radiating from a core) | 'ground'
 *            (a thicket growing up from a floor) | 'scatter'
 *   seed     which noise bends the branches
 *   width    trunk thickness
 *   wander   how far branches bend off straight
 *   palette, distance — as the other 3D visualizations; see three-shared.js
 */
export class GlyphDendrite extends ThreeVisualization {
  static id = 'glyph-dendrite';
  static label = 'Glyph Dendrite';
  static description = 'A 3D coral that reads the drawing\'s rows as its branching rule; the spectrum lights it from trunk to twig and hits fire pulses out along every branch.';
  static category = CATEGORY.GLYPHS;
  static layer = LAYER.MAIN;
  static fallback = 'glyph-crystal';
  static inputs = {
    sprout: { kind: 'event', default: TRIGGER.BASS },
    grow:   { kind: 'level', default: { intensity: 'mid' } },
    glow:   { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
      smooth: 0.08,
    } },
    sway:   { kind: 'level', default: { intensity: 'rms', smooth: 0.3 } },
  };
  static options = {
    glyph:    glyphOption({ width: 9, height: 9, value: FERN }),
    spread:   { kind: 'enum', values: ['narrow', 'wide'], default: 'wide' },
    from:     { kind: 'enum', values: ['centre', 'ground', 'scatter'], default: 'centre' },
    seed:     { kind: 'number', default: 1, min: 0, max: 9999, step: 1 },
    width:    { kind: 'number', default: 1, min: 0.3, max: 3, step: 0.1 },
    wander:   { kind: 'number', default: 1, min: 0, max: 3, step: 0.1 },
    palette:  PALETTE_OPTION,
    distance: DISTANCE_OPTION,
  };

  static SPREADS = { narrow: Math.PI * 0.4, wide: Math.PI * 0.7 };
  static RADIUS = 10;         // world units; the coral grows within this
  static VIEW = 2.3;          // camera distance at `med`, in radii
  static SEEDS = { centre: 6, ground: 9, scatter: 8 };   // the opening wave
  static MAX_SEEDS = 28;      // per growth
  static MIN_SEEDS = 12;      // before a thaw is allowed
  static CANDIDATES = 10;     // spots tried for each seed; the emptiest wins
  static CROWD = 3;           // cells; the radius that counts as a spot's surroundings
  static CORE = 1.2;          // a centre seed's free run out of the crowded core
  static SPEED = 1.8;         // units per second at full grow
  static BASE_GROW = 0.3;     // of SPEED at silence
  static GROW_TAU = 0.4;
  static HIT_GROW = 1.5;      // extra speed at a full hit
  static HIT_DECAY = 3;       // per second
  static SEGMENT = 1.1;       // first generation's length, units
  static STRIDE = 0.985;      // a trunk's generation length per generation
  static SHRINK = 0.93;       // a lateral's or fork's
  static LATERAL_SHORT = 0.35; // how much shorter an outermost lateral grows than a trunk
  static LATERAL_THIN = 0.35;  // and how much thinner
  static MIN_SEGMENT = 0.14;  // a tip this fine stops
  static MAX_DEPTH = 48;
  static WIDTH = 0.075;       // trunk half-width, units, at width 1
  static THIN = 0.8;          // a lateral's width per generation
  static TRUNK_THIN = 0.95;   // a trunk's
  static TAPER = 0.05;        // narrowing along one generation
  static MIN_WIDTH = 0.012;
  static SUB = 0.3;           // units of growth per drawn segment
  static MAX_SEGMENTS = 40000;
  static MAX_TIPS = 700;
  static WANDER = 0.9;        // radians per second of noise bend at full
  static NOISE_SCALE = 2.2;   // noise units across one radius
  static TROPISM = { centre: 0.3, ground: 0.45, scatter: 0 };   // pull outward / upward
  static CELL = 0.36;         // units; occupancy grid cell
  static GRACE = 3;           // cells a new branch may share with its own tree
  static SELF_CROSS = 0.12;   // chance a tip may cross its own tree after that
  static SEED_RATE = 2;       // seeds per second while seeding
  static MIN_LIVE = 120;      // keep seeding while fewer tips than this are alive
  static THAW_WAIT = 6;       // seconds a finished coral stands before thawing
  static THAW = 3.5;          // seconds the old growth takes to burn away
  static GLOW_TAU = 0.1;
  static PULSE_SPEED = 1.5;   // root-to-tip lengths per second
  static PULSE_DECAY = 0.9;
  static TURN = [0.05, 0.25]; // coral rotation, rad/s: [idle, added at full sway]
  static SPIN_KICK = 0.9;     // extra rad/s at a full hit
  static SPIN_DECAY = 1.8;
  static ORBIT = 0.07;        // camera circling, rad/s

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    const G = GlyphDendrite;
    this.psychedelic = isPsychedelic(this);
    this.glyph = readGlyph(this);
    this.spread = G.SPREADS[this.option('spread')];
    this.from = this.option('from');
    const seed = this.option('seed');
    this.thick = this.option('width');
    this.wander = this.option('wander');
    this.noise = createNoise3D(seed);
    this.rand = mulberry32(seed * 1021 + 7);
    this.rules = this.readRules();

    const R = G.RADIUS;
    this.floor = -0.85 * R;   // where 'ground' roots sit
    this.gridHalf = 1.2 * R;
    this.gridN = Math.ceil((2 * this.gridHalf) / G.CELL);
    this.grid = new Int32Array(this.gridN ** 3);

    this.uniforms = {
      ...paletteUniforms(THREE),
      uTime: { value: 0 },
      uHue: { value: 0 },
      uSway: { value: 0 },
      uGlow: { value: 0 },
      uKick: { value: 0 },
      uSpec: { value: new Float32Array(BINS) },
      uPulses: { value: Array.from({ length: PULSES }, () => new THREE.Vector2(-10, 0)) },
      uRoot: { value: new THREE.Vector3(0, this.from === 'ground' ? this.floor - R : 0, 0) },
      uAspect: { value: 1 },
      uPixels: { value: 1 },
      uFocus: { value: R * G.VIEW },
      uRadius: { value: R },
      uTip: { value: 0.12 },
    };
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.current = this.makeStructure();
    this.old = this.makeStructure();
    this.makeTips();

    this.tips = [];
    this.t = 0;
    this.grow = 0;
    this.glow = 0;
    this.kick = 0;
    this.seeded = 0;
    this.seedDebt = 0;
    this.seedDirs = [];
    this.still = 0;
    this.thaw = 0;
    this.nextTree = 1;
    this.pulses = [];   // { front (fraction of root-to-tip), strength }
    this.turn = this.rand() * Math.PI * 2;
    this.spin = 0;
    this.hue = this.rand();
    this.raw = new Float32Array(BINS);
    this.avg = new Float32Array(BINS);
    this.top = new Float32Array(BINS);
    this.spec = this.uniforms.uSpec.value;

    this.camera.fov = 45;
    this.camera.near = 0.1;
    this.camera.far = 400;
    this.camera.updateProjectionMatrix();
    this.center = new THREE.Vector3(0, this.from === 'ground' ? -0.45 * R : 0, 0);
    this.swoop = new Swoop(this.options.distance, { near: 0.45, far: 1.5, period: 32 });
  }

  /** One rule per row: the children a branch splits into at that generation. */
  readRules() {
    const g = this.glyph;
    const rules = [];
    for (let y = 0; y < g.height; y++) {
      const children = [];
      for (let x = 0; x < g.width; x++) {
        const w = g.weight(x, y);
        if (!w) continue;
        const angle = ((x + 0.5) / g.width - 0.5) * this.spread;
        // How far off the parent's heading, 0 for a trunk that carries on
        // to 1 at the outermost column: laterals grow shorter and thinner.
        children.push({ angle, weight: w, lateral: Math.abs(angle) / (this.spread / 2) });
      }
      rules.push(children.length ? children : [{ angle: 0, weight: 0.7, lateral: 0, straight: true }]);
    }
    return rules;
  }

  /**
   * One coral's worth of geometry: every drawn segment is a quad that the
   * vertex shader turns to face the camera, from its start (aA) to its end
   * (aB), each carrying its distance from the root in w; aC is (start
   * width, end width, birth time, random). Segments are appended as the
   * tips grow, and only the touched range is uploaded each frame.
   */
  makeStructure() {
    const THREE = this.THREE;
    const n = GlyphDendrite.MAX_SEGMENTS;
    const geometry = new THREE.BufferGeometry();
    const attr = () => new THREE.BufferAttribute(new Float32Array(n * 16), 4).setUsage(THREE.DynamicDrawUsage);
    const A = attr();
    const B = attr();
    const C = attr();
    const corner = new Float32Array(n * 8);
    const index = new Uint32Array(n * 6);
    for (let s = 0; s < n; s++) {
      corner.set([0, -1, 0, 1, 1, -1, 1, 1], s * 8);
      const v = s * 4;
      // Counter-clockwise on screen, so the quads face the camera.
      index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], s * 6);
    }
    geometry.setAttribute('aA', A);
    geometry.setAttribute('aB', B);
    geometry.setAttribute('aC', C);
    geometry.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.setDrawRange(0, 0);
    const uniforms = { ...this.uniforms, uThaw: { value: 0 }, uMaxPath: { value: 1 } };
    const mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      uniforms,
      vertexShader: BRANCH_VERTEX,
      fragmentShader: BRANCH_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // Premultiplied additive, as nebula: where branches cross they bloom.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    }));
    mesh.frustumCulled = false;   // the shader moves everything
    this.group.add(mesh);
    return { mesh, geometry, A, B, C, uniforms, count: 0, lo: Infinity, hi: -1, maxPath: 0 };
  }

  /** A spark at every growing tip. */
  makeTips() {
    const THREE = this.THREE;
    const n = GlyphDendrite.MAX_TIPS;
    const geometry = new THREE.BufferGeometry();
    this.tipPos = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.tipInfo = new THREE.BufferAttribute(new Float32Array(n * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.tipPos);
    geometry.setAttribute('aInfo', this.tipInfo);
    geometry.setDrawRange(0, 0);
    this.tipUniforms = { ...this.uniforms, uThaw: { value: 0 }, uMaxPath: { value: 1 } };
    this.sparks = new THREE.Points(geometry, new THREE.ShaderMaterial({
      uniforms: this.tipUniforms,
      vertexShader: TIP_VERTEX,
      fragmentShader: TIP_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    }));
    this.sparks.frustumCulled = false;
    this.group.add(this.sparks);
  }

  onInput(slot, data) {
    if (slot !== 'sprout') return;
    const k = impact(data);
    this.kick = Math.max(this.kick, k);
    this.pulses.push({ front: 0, strength: 0.4 + 0.8 * k });
    if (this.pulses.length > PULSES) this.pulses.shift();
    // A share of the live tips branch at once.
    for (const tip of this.tips) if (this.rand() < 0.25 + 0.5 * k) tip.done = tip.seg;
    this.seedDebt += 1;
    this.spin += (this.rand() < 0.5 ? -1 : 1) * k * GlyphDendrite.SPIN_KICK;
  }

  /** Occupancy grid index of a point, or -1 outside the grid. */
  cellAt(x, y, z) {
    const n = this.gridN;
    const c = GlyphDendrite.CELL;
    const i = Math.floor((x + this.gridHalf) / c);
    const j = Math.floor((y + this.gridHalf) / c);
    const k = Math.floor((z + this.gridHalf) / c);
    if (i < 0 || j < 0 || k < 0 || i >= n || j >= n || k >= n) return -1;
    return (k * n + j) * n + i;
  }

  /** How much is already grown within CROWD cells of a point. */
  crowding(x, y, z) {
    const n = this.gridN;
    const c = GlyphDendrite.CELL;
    const r = GlyphDendrite.CROWD;
    const ci = Math.floor((x + this.gridHalf) / c);
    const cj = Math.floor((y + this.gridHalf) / c);
    const ck = Math.floor((z + this.gridHalf) / c);
    let count = 0;
    for (let k = Math.max(0, ck - r); k <= Math.min(n - 1, ck + r); k++) {
      for (let j = Math.max(0, cj - r); j <= Math.min(n - 1, cj + r); j++) {
        for (let i = Math.max(0, ci - r); i <= Math.min(n - 1, ci + r); i++) {
          if (this.grid[(k * n + j) * n + i]) count++;
        }
      }
    }
    return count;
  }

  /** May a tip be here at all? */
  inside(x, y, z) {
    const R = GlyphDendrite.RADIUS;
    if (this.from === 'ground') return x * x + z * z < R * R && y > this.floor - 0.5 && y < 1.05 * R;
    return x * x + y * y + z * z < R * R;
  }

  randomDirection() {
    const z = this.rand() * 2 - 1;
    const a = this.rand() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    return [s * Math.cos(a), s * Math.sin(a), z];
  }

  plant() {
    const G = GlyphDendrite;
    const R = G.RADIUS;
    let p;
    let d;
    let free = 0;
    if (this.from === 'centre') {
      // Out of the core, in whichever direction is furthest from every
      // earlier seed's, so the primaries spread round the sphere.
      let best = Infinity;
      for (let i = 0; i < G.CANDIDATES; i++) {
        const c = this.randomDirection();
        let near = -1;
        for (const s of this.seedDirs) near = Math.max(near, c[0] * s[0] + c[1] * s[1] + c[2] * s[2]);
        near += this.crowding(c[0] * R * 0.5, c[1] * R * 0.5, c[2] * R * 0.5) * 0.004;
        if (near < best) { best = near; d = c; }
      }
      this.seedDirs.push(d);
      p = [d[0] * 0.3, d[1] * 0.3, d[2] * 0.3];
      free = G.CORE;
    } else {
      let best = Infinity;
      for (let i = 0; i < G.CANDIDATES; i++) {
        let c;
        let probe;
        if (this.from === 'ground') {
          const r = 0.85 * R * Math.sqrt(this.rand());
          const a = this.rand() * Math.PI * 2;
          c = [Math.cos(a) * r, this.floor, Math.sin(a) * r];
          probe = [c[0], this.floor + 0.3 * R, c[2]];
        } else {
          const [x, y, z] = this.randomDirection();
          const r = 0.8 * R * Math.cbrt(this.rand());
          c = [x * r, y * r, z * r];
          probe = c;
        }
        const crowd = this.crowding(probe[0], probe[1], probe[2]);
        if (crowd < best) { best = crowd; p = c; }
      }
      if (this.from === 'ground') {
        const r = this.randomDirection();
        d = normalize([r[0] * 0.4, 1, r[2] * 0.4]);
      } else {
        d = this.randomDirection();
      }
    }
    const a = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = normalize(sub(a, scale(d, dot(a, d))));
    this.tips.push({
      x: p[0], y: p[1], z: p[2], d, u,
      depth: 0, seg: G.SEGMENT * (0.85 + 0.3 * this.rand()), done: 0,
      w: G.WIDTH * this.thick * (0.8 + 0.4 * this.rand()),
      tree: this.nextTree++, grace: G.GRACE, cell: -1,
      path: 0, free, slot: -1, slotLen: 0, wStart: 0, r: this.rand(),
    });
    this.seeded++;
  }

  /** The tip steps into its current cell: may it, and does it claim it? */
  enter(tip) {
    if (tip.path < tip.free) return true;
    const c = this.cellAt(tip.x, tip.y, tip.z);
    if (c < 0) return false;
    if (c === tip.cell) return true;
    const owner = this.grid[c];
    if (owner && owner !== tip.tree) return false;
    if (owner === tip.tree && tip.grace <= 0 && this.rand() > GlyphDendrite.SELF_CROSS) return false;
    this.grid[c] = tip.tree;
    tip.cell = c;
    tip.grace--;
    return true;
  }

  branch(tip, out) {
    const G = GlyphDendrite;
    const rule = this.rules[tip.depth % this.rules.length];
    const room = Math.max(0, G.MAX_TIPS - this.tips.length - out.length);
    const keep = room >= rule.length ? 1 : room / rule.length;
    // Turn the plane the children leave in round the stem, so successive
    // rows spiral rather than stacking in one flat frond.
    const { d, u } = tip;
    const roll = GOLDEN + (this.rand() - 0.5) * 0.3;
    const v = cross(d, u);
    const side = normalize(add(scale(u, Math.cos(roll)), scale(v, Math.sin(roll))));
    for (const child of rule) {
      if (this.rand() > keep) continue;
      // A trunk keeps its stride; laterals and forks grow shorter each time.
      const trunk = child.lateral < 0.15;
      const seg = tip.seg * (trunk ? G.STRIDE : G.SHRINK * (1 - G.LATERAL_SHORT * child.lateral))
        * (0.55 + 0.45 * child.weight);
      if (seg < G.MIN_SEGMENT || tip.depth + 1 > G.MAX_DEPTH) continue;
      const thin = trunk ? G.TRUNK_THIN * (0.85 + 0.15 * child.weight)
        : G.THIN * (0.75 + 0.25 * child.weight) * (1 - G.LATERAL_THIN * child.lateral);
      const a = child.angle + (this.rand() - 0.5) * 0.15;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      out.push({
        x: tip.x, y: tip.y, z: tip.z,
        d: normalize(add(scale(d, ca), scale(side, sa))),
        u: normalize(sub(scale(side, ca), scale(d, sa))),
        depth: tip.depth + 1, seg, done: 0,
        w: Math.max(G.MIN_WIDTH, this.widthOf(tip) * thin),
        tree: tip.tree, grace: G.GRACE, cell: tip.cell,
        path: tip.path, free: tip.free, slot: -1, slotLen: 0, wStart: 0, r: tip.r,
      });
    }
  }

  /** Write (x, y, z, w) into all four corners of segment `s` of `attr`. */
  put(attr, s, x, y, z, w) {
    const a = attr.array;
    let i = s * 16;
    for (let k = 0; k < 4; k++, i += 4) {
      a[i] = x; a[i + 1] = y; a[i + 2] = z; a[i + 3] = w;
    }
  }

  /** The tip's width at its current point along its generation. */
  widthOf(tip) {
    return tip.w * (1 - GlyphDendrite.TAPER * Math.min(1, tip.done / tip.seg));
  }

  /** Lay down the tip's step from (x0, y0, z0); false if the coral is full. */
  lay(tip, x0, y0, z0, path0, step) {
    const st = this.current;
    if (tip.slot < 0 || tip.slotLen >= GlyphDendrite.SUB) {
      if (st.count >= GlyphDendrite.MAX_SEGMENTS) return false;
      tip.slot = st.count++;
      tip.slotLen = 0;
      tip.wStart = this.widthOf(tip);
      this.put(st.A, tip.slot, x0, y0, z0, path0);
      st.lo = Math.min(st.lo, tip.slot);
    }
    tip.slotLen += step;
    this.put(st.B, tip.slot, tip.x, tip.y, tip.z, tip.path);
    this.put(st.C, tip.slot, tip.wStart, this.widthOf(tip), this.t, tip.r);
    st.hi = Math.max(st.hi, tip.slot);
    st.lo = Math.min(st.lo, tip.slot);
    st.maxPath = Math.max(st.maxPath, tip.path);
    return true;
  }

  /** Upload the segments touched this frame. */
  upload(st) {
    if (st.hi >= st.lo) {
      for (const attr of [st.A, st.B, st.C]) {
        attr.clearUpdateRanges();
        attr.addUpdateRange(st.lo * 16, (st.hi - st.lo + 1) * 16);
        attr.needsUpdate = true;
      }
    }
    st.lo = Infinity;
    st.hi = -1;
    st.geometry.setDrawRange(0, st.count * 6);
  }

  /** Start over: the current coral thaws away while a new one grows. */
  thawOut() {
    [this.current, this.old] = [this.old, this.current];
    const st = this.current;
    st.count = 0;
    st.maxPath = 0;
    st.lo = Infinity;
    st.hi = -1;
    st.geometry.setDrawRange(0, 0);
    st.uniforms.uThaw.value = 0;
    st.mesh.visible = true;
    this.old.mesh.visible = true;
    this.grid.fill(0);
    this.tips = [];
    this.seeded = 0;
    this.seedDirs = [];
    this.thaw = GlyphDendrite.THAW;
  }

  /**
   * The spectrum as BINS levels from bass to treble, each partly absolute
   * and mostly against its own recent range, so every band flickers on its
   * own notes whatever the mix's tilt. Snaps up, eases down.
   */
  listen(dt) {
    logSpectrum(this.frame?.spectrum, this.raw);
    for (let i = 0; i < BINS; i++) {
      const x = this.raw[i];
      this.avg[i] = approach(this.avg[i], x, 1.5, dt);
      this.top[i] = Math.max(x, approach(this.top[i], this.avg[i], 2, dt));
      const rel = clamp01((x - this.avg[i]) / Math.max(0.06, this.top[i] - this.avg[i]));
      const target = 0.35 * x * x + 0.8 * rel;
      this.spec[i] = approach(this.spec[i], target, target > this.spec[i] ? 0.02 : 0.15, dt);
    }
  }

  draw(ctx, dt) {
    const G = GlyphDendrite;
    const R = G.RADIUS;
    this.grow = approach(this.grow, clamp01(this.in('grow')), G.GROW_TAU, dt);
    this.glow = approach(this.glow, clamp01(this.in('glow')), G.GLOW_TAU, dt);
    const sway = clamp01(this.in('sway'));
    this.kick *= Math.exp(-G.HIT_DECAY * dt);
    this.t += dt;
    this.listen(dt);
    const speed = G.SPEED * (G.BASE_GROW + (1 - G.BASE_GROW) * this.grow) * (1 + G.HIT_GROW * this.kick);

    // Seeding, while the growth is thin.
    if (this.seeded < G.SEEDS[this.from]) this.seedDebt = Math.max(this.seedDebt, G.SEEDS[this.from] - this.seeded);
    if (this.seeded < G.MAX_SEEDS && this.tips.length < G.MIN_LIVE) this.seedDebt += dt * G.SEED_RATE;
    while (this.seedDebt >= 1) {
      this.seedDebt -= 1;
      if (this.seeded < G.MAX_SEEDS) this.plant();
    }

    // Advance every tip, laying down its step; branch the ones that
    // finished a generation; drop the ones that ran into something.
    const k = G.NOISE_SCALE / R;
    const bend = this.wander * G.WANDER * dt;
    const pull = G.TROPISM[this.from] * dt;
    const step = speed * dt;
    const born = [];
    const alive = [];
    for (const tip of this.tips) {
      const { d, u } = tip;
      const nx = this.noise(tip.x * k, tip.y * k, tip.z * k + tip.tree * 0.37);
      const ny = this.noise(tip.x * k + 31.7, tip.y * k, tip.z * k - tip.tree * 0.21);
      const nz = this.noise(tip.x * k, tip.y * k - 17.3, tip.z * k + tip.tree * 0.53);
      const along = nx * d[0] + ny * d[1] + nz * d[2];
      d[0] += (nx - d[0] * along) * bend;
      d[1] += (ny - d[1] * along) * bend;
      d[2] += (nz - d[2] * along) * bend;
      if (pull) {
        let tx = 0; let ty = 1; let tz = 0;
        if (this.from === 'centre') {
          const r = Math.hypot(tip.x, tip.y, tip.z) || 1;
          tx = tip.x / r; ty = tip.y / r; tz = tip.z / r;
        }
        const t = tx * d[0] + ty * d[1] + tz * d[2];
        d[0] += (tx - d[0] * t) * pull;
        d[1] += (ty - d[1] * t) * pull;
        d[2] += (tz - d[2] * t) * pull;
      }
      normalizeIn(d);
      const ud = dot(u, d);
      u[0] -= d[0] * ud; u[1] -= d[1] * ud; u[2] -= d[2] * ud;
      normalizeIn(u);

      const x0 = tip.x;
      const y0 = tip.y;
      const z0 = tip.z;
      const path0 = tip.path;
      tip.x += d[0] * step;
      tip.y += d[1] * step;
      tip.z += d[2] * step;
      tip.done += step;
      tip.path += step;
      if (!this.inside(tip.x, tip.y, tip.z)) continue;
      if (!this.enter(tip)) continue;
      if (!this.lay(tip, x0, y0, z0, path0, step)) continue;
      if (tip.done >= tip.seg) this.branch(tip, born);
      else alive.push(tip);
    }
    this.tips = alive.concat(born);
    this.upload(this.current);
    const cu = this.current.uniforms;
    cu.uMaxPath.value = approach(cu.uMaxPath.value, Math.max(this.current.maxPath, 3 * G.SEGMENT), 0.5, dt);

    // Thaw: when growth has stopped, or the coral is full, burn it away
    // while a new one begins.
    const full = this.current.count >= G.MAX_SEGMENTS * 0.98;
    if (full || (this.tips.length === 0 && this.seeded >= Math.max(G.SEEDS[this.from], G.MIN_SEEDS))) {
      this.still += dt;
      if (this.still >= G.THAW_WAIT) {
        this.still = 0;
        this.thawOut();
      }
    } else {
      this.still = 0;
    }
    if (this.thaw > 0) {
      this.thaw = Math.max(0, this.thaw - dt);
      this.old.uniforms.uThaw.value = 1 - this.thaw / G.THAW;
      if (this.thaw === 0) this.old.mesh.visible = false;
    }

    // Pulses run out from the roots.
    for (const p of this.pulses) {
      p.front += dt * G.PULSE_SPEED;
      p.strength *= Math.exp(-dt * G.PULSE_DECAY);
    }
    this.pulses = this.pulses.filter((p) => p.front < 1.6);
    const u = this.uniforms;
    for (let i = 0; i < PULSES; i++) {
      const p = this.pulses[i];
      u.uPulses.value[i].set(p ? p.front : -10, p ? p.strength : 0);
    }

    // The sparks at the growing tips.
    const pos = this.tipPos.array;
    const info = this.tipInfo.array;
    const n = Math.min(this.tips.length, G.MAX_TIPS);
    for (let i = 0; i < n; i++) {
      const tip = this.tips[i];
      pos[i * 3] = tip.x; pos[i * 3 + 1] = tip.y; pos[i * 3 + 2] = tip.z;
      info[i * 2] = tip.path; info[i * 2 + 1] = tip.r;
    }
    this.tipPos.needsUpdate = true;
    this.tipInfo.needsUpdate = true;
    this.sparks.geometry.setDrawRange(0, n);
    this.tipUniforms.uMaxPath.value = cu.uMaxPath.value;

    // The coral turns, faster with the mix and lurching on hits.
    this.spin *= Math.exp(-dt * G.SPIN_DECAY);
    this.turn += dt * (G.TURN[0] + G.TURN[1] * sway + this.spin);
    this.hue += dt * (0.015 + 0.04 * this.glow);
    this.group.rotation.y = this.turn;
    if (this.from !== 'ground') this.group.rotation.x = Math.sin(this.t * 0.043) * 0.35;

    // The camera circles, looking a little down on it.
    this.swoop.update(dt, G.ORBIT);
    const { angle, scale: range } = this.swoop;
    const dist = R * G.VIEW * range;
    const lift = this.from === 'ground' ? 0.15 + 0.1 * Math.sin(this.t * 0.05) : 0.3 * Math.sin(this.t * 0.031);
    const cam = this.camera;
    cam.position.set(
      this.center.x + Math.cos(angle) * Math.cos(lift) * dist,
      this.center.y + Math.sin(lift) * dist,
      this.center.z + Math.sin(angle) * Math.cos(lift) * dist,
    );
    this.swoop.aim(cam, this.center);
    if (cam.aspect !== this.width / this.height) {
      cam.aspect = this.width / this.height;
      cam.updateProjectionMatrix();
    }

    updatePalette(this, u);
    u.uTime.value = this.t;
    u.uHue.value = this.hue;
    u.uSway.value = 0.15 + 1.1 * sway + 0.5 * this.kick;
    u.uGlow.value = this.glow;
    u.uKick.value = this.kick;
    u.uAspect.value = this.width / this.height;
    u.uFocus.value = dist;
    const fov = (cam.fov * Math.PI) / 180;
    // World size → device pixels at unit distance.
    u.uPixels.value = (this.height * this.pixelScale()) / (2 * Math.tan(fov / 2));
    u.uTip.value = 0.1 * this.thick * (1 + 1.5 * this.glow + this.kick);
    this.present(ctx);
  }
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalizeIn = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  a[0] /= l; a[1] /= l; a[2] /= l;
  return a;
};
const normalize = (a) => normalizeIn([...a]);

/*
 * Shared by the branches and the sparks: where a point of the coral is
 * drawn, and how lit it is, from its rest position and its distance from the
 * root `s` (as a fraction of the furthest any tip has grown).
 */
const COMMON = /* glsl */ `
uniform float uTime;
uniform float uHue;
uniform float uSway;
uniform float uGlow;
uniform float uKick;
uniform float uSpec[${BINS}];
uniform vec2 uPulses[${PULSES}];   // (front, strength), front as a fraction of root-to-tip
uniform vec3 uRoot;
uniform float uThaw;
uniform float uMaxPath;
uniform float uPixels;
uniform float uFocus;
uniform float uRadius;

// Light running out along the branches: a bright front and a fading wake.
float pulse(float s) {
  float lit = 0.0;
  for (int k = 0; k < ${PULSES}; k++) {
    float d = s - uPulses[k].x;
    float wake = d < 0.0 ? 0.3 * exp(d * 6.0) : 0.0;
    lit += uPulses[k].y * (exp(-d * d * 160.0) + wake);
  }
  return lit;
}

// The spectrum along the branches: bass at the roots, treble at the tips.
float spectrum(float s) {
  float x = clamp(s, 0.0, 1.0) * float(${BINS - 1});
  int i = int(floor(x));
  int j = min(i + 1, ${BINS - 1});
  return mix(uSpec[i], uSpec[j], fract(x));
}

// Burning back from the twigs: 0 untouched, 1 gone.
float thawed(float s) {
  return smoothstep(0.0, 1.0, uThaw * 2.0 - (1.0 - clamp(s, 0.0, 1.0)));
}

vec3 flow(vec3 p, float t) {
  return vec3(
    sin(p.y * 1.7 + t) + sin(p.z * 2.3 - t * 0.7),
    sin(p.z * 1.9 + t * 0.8) + sin(p.x * 2.1 + t * 0.5),
    sin(p.x * 1.5 - t * 0.6) + sin(p.y * 2.7 + t * 0.9)
  );
}

vec3 displace(vec3 p, float s, float lit, float r) {
  vec3 away = p - uRoot;
  float len = length(away);
  away = len > 1e-3 ? away / len : vec3(0.0, 1.0, 0.0);
  float reach = clamp(s, 0.0, 1.3);
  // The outer branches stream in a current; the trunks barely move.
  p += flow(p * 0.16 + r * 0.5, uTime * 0.7) * uSway * reach * reach * 0.45;
  // A pulse shoves what it passes outward.
  p += away * lit * 0.4 * reach;
  // Thawing growth blows away.
  p += away * thawed(s) * (2.0 + 4.0 * r);
  return p;
}

// Rolls bright light off toward 1 rather than clipping it, so the hue
// survives where the coral is loudest.
vec3 tone(vec3 c) {
  return 1.0 - exp(-c * 1.4);
}

// Dimmer toward the back of the coral, and fading right at the lens.
float depthFade(float w) {
  float back = clamp((w - (uFocus - uRadius)) / (2.0 * uRadius), 0.0, 1.0);
  return mix(1.0, 0.22, back) * smoothstep(0.3, 2.5, w);
}
`;

const BRANCH_VERTEX = /* glsl */ `
${PALETTE_GLSL}
${COMMON}
attribute vec4 aA;        // start, and its distance from the root
attribute vec4 aB;        // end, likewise
attribute vec4 aC;        // (start width, end width, birth time, random)
attribute vec2 aCorner;   // (0 start | 1 end, -1 | +1 side)
uniform float uAspect;

varying vec3 vColor;
varying float vSide;

void main() {
  float s0 = aA.w / uMaxPath;
  float s1 = aB.w / uMaxPath;
  float lit0 = pulse(s0);
  float lit1 = pulse(s1);
  vec4 ca = projectionMatrix * modelViewMatrix * vec4(displace(aA.xyz, s0, lit0, aC.w), 1.0);
  vec4 cb = projectionMatrix * modelViewMatrix * vec4(displace(aB.xyz, s1, lit1, aC.w), 1.0);
  vSide = aCorner.y;
  if (ca.w < 0.1 || cb.w < 0.1) {
    // Behind the lens.
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vColor = vec3(0.0);
    return;
  }

  // A ribbon facing the camera, from start to end.
  vec2 dir = (cb.xy / cb.w - ca.xy / ca.w) * vec2(uAspect, 1.0);
  float len = length(dir);
  dir = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
  vec2 across = vec2(-dir.y, dir.x) * vec2(1.0 / uAspect, 1.0);
  float t = aCorner.x;
  vec4 c = mix(ca, cb, t);
  float s = mix(s0, s1, t);
  float lit = mix(lit0, lit1, t);
  float spec = spectrum(s);
  float fresh = exp(-(uTime - aC.z) * 1.3);

  // Swelling with its band of the spectrum, with a passing pulse and while new.
  float w = mix(aC.x, aC.y, t) * (1.0 + 0.9 * spec + 1.5 * lit + (0.5 + uGlow) * fresh);
  // The ribbon is twice the branch's width: the outer half is its glow.
  float px = 2.0 * w * uPixels / c.w;
  float light = 1.0;
  // Keep far twigs a pixel wide, dimmed to the light they'd really give;
  // spread a near branch's light over its width, as defocus would.
  if (px < 1.2) { light = px / 1.2; w *= 1.2 / px; px = 1.2; }
  light *= min(1.0, 24.0 / px);
  c.xy += across * 2.0 * w * projectionMatrix[1][1] * aCorner.y;
  gl_Position = c;

  float bright = 0.45 + 1.3 * spec + 2.2 * lit + (0.4 + 1.2 * uGlow) * fresh + 0.2 * uKick;
  vec3 color = palette(s * 0.55 + uHue + aC.w * 0.06);
  vColor = tone(peak(color, lit) * bright) * light * depthFade(c.w) * (1.0 - thawed(s));
}
`;

const BRANCH_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vSide;

void main() {
  float a = exp(-vSide * vSide * 5.0);
  vec3 c = vColor * a;
  // Premultiplied: alpha must cover the colour or the compositor clips it.
  gl_FragColor = vec4(c, min(1.0, max(c.r, max(c.g, c.b))));
}
`;

const TIP_VERTEX = /* glsl */ `
${PALETTE_GLSL}
${COMMON}
attribute vec2 aInfo;   // (distance from the root, random)
uniform float uTip;

varying vec3 vColor;

void main() {
  float s = aInfo.x / uMaxPath;
  float lit = pulse(s);
  vec4 mv = modelViewMatrix * vec4(displace(position, s, lit, aInfo.y), 1.0);
  gl_Position = projectionMatrix * mv;
  float twinkle = 0.75 + 0.25 * sin(uTime * 11.0 + aInfo.y * 300.0);
  float px = uTip * (1.0 + lit) * uPixels / max(-mv.z, 0.1);
  gl_PointSize = clamp(px, 2.0, 48.0);
  float bright = (0.35 + 1.5 * uGlow + 0.8 * uKick + lit) * twinkle * min(1.0, 16.0 / (px * px));
  vColor = tone(peak(palette(s * 0.55 + uHue + 0.25), uKick) * bright) * depthFade(-mv.z);
}
`;

const TIP_FRAGMENT = /* glsl */ `
varying vec3 vColor;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.0, 1.0, d);
  vec3 c = vColor * a * a;
  gl_FragColor = vec4(c, min(1.0, max(c.r, max(c.g, c.b))));
}
`;
