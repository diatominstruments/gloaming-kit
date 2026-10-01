import { ThreeVisualization } from './three-base.js';
import { approach, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';
import { mulberry32 } from '../noise.js';
import {
  PALETTE_OPTION, DISTANCE_OPTION, Swoop, paletteColor, isPsychedelic, instanceGlow,
} from './three-shared.js';
import { glyphOption, readGlyph, SPIRAL } from './glyph.js';
import { windowOf } from './glyph-window.js';

const TAU = Math.PI * 2;

/**
 * How each crystal grows. Every solid sprouts `children` smaller ones from
 * its upper part (between `attach` of the way up and the top), turned evenly
 * round it and splayed outward by `tilt`, each `ratio` of its parent's size;
 * the root leans `lean` along the stroke it grew from.
 */
const SHAPES = {
  // Square prisms branching off the tops of each other: clusters of quartz.
  crystal: { geometry: 'box', children: 3, tilt: 0.42, ratio: 0.6, attach: [0.55, 1], width: 0.32, height: 1.5, lean: 0.22 },
  // Rounded lumps budding all over, splayed wide: coral.
  coral: { geometry: 'ico', children: 4, tilt: 0.85, ratio: 0.55, attach: [0.3, 1], width: 0.5, height: 0.9, lean: 0.4 },
  // Tall, nearly upright diamonds forking near the top: a forest of spires.
  spire: { geometry: 'octa', children: 2, tilt: 0.38, ratio: 0.72, attach: [0.75, 1], width: 0.34, height: 2.6, lean: 0.18 },
};

const MAX_SOLIDS = 7000;   // crystal depth is cut to keep under this
const MAX_DEPTH = 3;       // levels of branching below each root
const WAVES = 4;

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
// Overshoots a little before settling: crystals pop into place.
const pop = (t) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const s = 1.6;
  const u = t - 1;
  return 1 + (s + 1) * u * u * u + s * u * u;
};

/**
 * GlyphMosaic — a crystal garden grown along the drawing.
 *
 * The drawing is a plan laid on the ground, every filled cell a seed bed.
 * Growth starts at the end of each stroke farthest from the middle and
 * travels along the drawing cell to cell, the way a vine follows a trellis:
 * as the front reaches a cell, a crystal sprouts there, its root leaning the
 * way the growth came, and branches into smaller solids, which branch again,
 * two to four levels deep. So the drawing is never shown as cells; it is the
 * path a sculpture grew along, readable from above as the shape of the
 * garden and from the side as a skyline.
 *
 * Once it is fully grown it holds a while, then dissolves in the order it
 * grew, finest branches first, and regrows from where the last growth ended
 * — running the other way along the strokes — with every crystal mutated:
 * new turns, splay and proportions. So it is never the same garden twice.
 *
 * Grey cells grow smaller, dimmer crystals. Colour flows along the drawing
 * from where growth began.
 *
 * Options: `shape` — `crystal` (default; branching prisms), `coral` (wide
 * budding lumps) or `spire` (tall forking diamonds); `palette`; `distance`.
 *
 * Reactions:
 *
 *   pulse  a hit sends a wave of light along the drawing from where growth
 *          began, lighting each crystal as it passes, and spurs the growth
 *   grow   how fast it grows, dissolves and regrows
 *   sway   how much the branches sway
 *   glow   how brightly the crystals shine in their own colour
 */
export class GlyphMosaic extends ThreeVisualization {
  static id = 'glyph-mosaic';
  static label = 'Glyph Mosaic';
  static description = 'A crystal garden grown along the drawing: crystals sprout and branch as growth travels its strokes, dissolve, and regrow mutated; hits send light along it.';
  static category = CATEGORY.GLYPHS;

  static inputs = {
    pulse: { kind: 'event', default: TRIGGER.BASS },
    grow:  { kind: 'level', default: { intensity: 'mid', smooth: 1 } },
    sway:  { kind: 'level', default: { intensity: 'highMid', smooth: 0.5 } },
    glow:  { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
      smooth: 0.1,
    } },
  };

  static options = {
    glyph: glyphOption({ width: 12, height: 12, value: SPIRAL }),
    shape: { kind: 'enum', values: Object.keys(SHAPES), default: 'crystal' },
    palette: PALETTE_OPTION,
    distance: DISTANCE_OPTION,
  };
  // The 2D window, wearing this one's default drawing.
  static fallback = windowOf(this.options);

  static STEP = 0.22;          // s between cells along the growth, at speed 1
  static LEVEL_DELAY = 0.3;    // s between a solid and its branches sprouting
  static GROW_TIME = 0.7;      // s for one solid to grow
  static HOLD = 4;             // s fully grown before dissolving
  static FADE = 1.1;           // s for one crystal to dissolve
  static DISSOLVE = 0.5;       // dissolving runs this many times the growth's pace
  static SPEED = [0.6, 1.4];   // growth clock rate: [idle, added at full grow]
  static SPUR = 0.3;           // s a full-strength hit pushes the growth on
  static SWAY = [0.04, 0.22];  // branch sway, rad: [idle, added at full sway]
  static WAVE_SPEED = 16;      // cells/s the light travels along the drawing
  static WAVE_DECAY = 0.8;
  static VIEW = 1.25;          // camera distance at `med`, in drawing widths
  static ORBIT = [0.05, 0.12];

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    this.psychedelic = isPsychedelic(this);
    this.glyph = readGlyph(this);
    this.rand = mulberry32(Math.floor(Math.random() * 1e9));

    const shapeName = this.options.shape ?? 'crystal';
    if (!(shapeName in SHAPES)) console.warn(`GloamingKit: glyph-mosaic shape '${shapeName}'; expected ${Object.keys(SHAPES).join('|')}`);
    this.shape = SHAPES[shapeName] ?? SHAPES.crystal;

    this.buildPlan();
    // As deep as fits under MAX_SOLIDS: (K^(d+1) - 1) / (K - 1) solids each.
    const K = this.shape.children;
    const per = (d) => (K ** (d + 1) - 1) / (K - 1);
    this.depth = 0;
    while (this.depth < MAX_DEPTH && this.nodes.length * per(this.depth + 1) <= MAX_SOLIDS) this.depth++;
    this.count = this.nodes.length * per(this.depth);

    // Per solid, rebuilt with fresh mutations every cycle (see grow()).
    const n = this.count;
    this.parent = new Int32Array(n);
    this.node = new Int32Array(n);
    this.level = new Uint8Array(n);
    this.attach = new Float32Array(n);   // height up the parent it grows from
    this.yaw = new Float32Array(n * 2);  // (cos, sin)
    this.tilt = new Float32Array(n);
    this.ratio = new Float32Array(n);
    this.size = new Float32Array(n * 2); // (width, height), in its own frame
    this.phase = new Float32Array(n);
    this.frames = new Float64Array(n * 12);   // 3×4, row-major

    const geometry = {
      box: () => new THREE.BoxGeometry(1, 1, 1),
      ico: () => new THREE.IcosahedronGeometry(0.62, 0),
      octa: () => new THREE.OctahedronGeometry(0.62, 0),
    }[this.shape.geometry]();
    geometry.translate(0, 0.5, 0);   // grow up from the base
    const material = new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.35, flatShading: true });
    this.glow = instanceGlow(material, 0.25);
    this.solids = new THREE.InstancedMesh(geometry, material, n);
    this.solids.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.solids.setColorAt(0, new THREE.Color(1, 1, 1));
    this.solids.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.solids.frustumCulled = false;
    this.scene.add(this.solids);

    // Seed beds: the plan, glowing faintly on the ground, lit as growth and
    // light pass over it.
    this.beds = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.86, 0.03, 0.86),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
      this.nodes.length,
    );
    this.beds.setColorAt(0, new THREE.Color(1, 1, 1));
    this.beds.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.beds.frustumCulled = false;
    const m = new THREE.Matrix4();
    this.nodes.forEach((nd, i) => this.beds.setMatrixAt(i, m.makeTranslation(nd.x, 0.015, nd.z)));
    this.scene.add(this.beds);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(0.4, 1, 0.3);
    this.scene.add(key);
    this.headlight = new THREE.PointLight(0xffffff, 1.5, 0, 0);
    this.scene.add(this.headlight);
    this.lamp = new THREE.PointLight(0xffffff, 3, 0, 0);
    this.scene.add(this.lamp);

    this.time = 0;
    this.hue = this.rand();
    this.waves = [];   // { front, strength }, front in cells along the growth
    this.swoop = new Swoop(this.options.distance, { near: 0.45, far: 1.9, period: 32 });
    this.lift = this.rand() * 10;
    this.camera.fov = 50;
    this.camera.near = 0.05;
    this.camera.far = 500;
    this.target = new THREE.Vector3();
    this.c = new THREE.Color();

    this.seedOrder(this.farthestSeeds());
    this.mutate();
  }

  /** Filled cells as ground positions, one cell to a world unit, with their neighbours. */
  buildPlan() {
    const { width, height, levels } = this.glyph;
    const cells = this.glyph.filled();
    const index = new Map(cells.map((c, i) => [`${c.x},${c.y}`, i]));
    this.nodes = cells.map(({ x, y, level, weight }) => ({
      gx: x,
      gy: y,
      // A little off the grid, so the garden doesn't stand in rows.
      x: x + 0.5 - width / 2 + (this.rand() - 0.5) * 0.3,
      z: y + 0.5 - height / 2 + (this.rand() - 0.5) * 0.3,
      weight,
      black: level === levels,
      links: [],
      depth: 0, from: -1, birth: 0, component: 0,
    }));
    for (const nd of this.nodes) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const j = index.get(`${nd.gx + dx},${nd.gy + dy}`);
          if (j !== undefined && (dx || dy)) nd.links.push(j);
        }
      }
    }
    // Connected strokes, so each can grow from its own seed.
    let component = 0;
    const seen = new Uint8Array(this.nodes.length);
    this.components = [];
    this.nodes.forEach((_, start) => {
      if (seen[start]) return;
      const members = [];
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop();
        members.push(i);
        this.nodes[i].component = component;
        for (const j of this.nodes[i].links) if (!seen[j]) { seen[j] = 1; stack.push(j); }
      }
      this.components.push(members);
      component++;
    });
    this.span = Math.max(width, height);
  }

  /** In each stroke, the cell farthest from the middle of the drawing. */
  farthestSeeds() {
    return this.components.map((members) => members.reduce(
      (best, i) => (Math.hypot(this.nodes[i].x, this.nodes[i].z) > Math.hypot(this.nodes[best].x, this.nodes[best].z) ? i : best),
      members[0],
    ));
  }

  /** In each stroke, where the last growth ended: the next grows back from there. */
  tipSeeds() {
    return this.components.map((members) => members.reduce(
      (best, i) => (this.nodes[i].depth > this.nodes[best].depth ? i : best),
      members[0],
    ));
  }

  /** Breadth-first from each seed: every cell's distance along the growth and where it grew from. */
  seedOrder(seeds) {
    const { STEP } = GlyphMosaic;
    for (const nd of this.nodes) nd.depth = -1;
    for (const seed of seeds) {
      const queue = [seed];
      this.nodes[seed].depth = 0;
      this.nodes[seed].from = -1;
      for (let q = 0; q < queue.length; q++) {
        const i = queue[q];
        for (const j of this.nodes[i].links) {
          if (this.nodes[j].depth >= 0) continue;
          this.nodes[j].depth = this.nodes[i].depth + 1;
          this.nodes[j].from = i;
          queue.push(j);
        }
      }
    }
    this.maxDepth = Math.max(1, ...this.nodes.map((nd) => nd.depth));
    for (const nd of this.nodes) nd.birth = nd.depth * STEP + this.rand() * STEP * 0.8;
    this.lastBirth = Math.max(...this.nodes.map((nd) => nd.birth));
    this.grown = this.lastBirth + this.depth * GlyphMosaic.LEVEL_DELAY + GlyphMosaic.GROW_TIME;
    this.clock = 0;
  }

  /** Fresh crystals for every cell: new turns, splay and proportions. */
  mutate() {
    const { children: K, tilt, ratio, attach, width, height, lean } = this.shape;
    const r = this.rand;
    let i = 0;
    this.nodes.forEach((nd, n) => {
      // Lean the way the growth came from, so crystals follow the stroke.
      const from = nd.from >= 0 ? this.nodes[nd.from] : null;
      const heading = from ? Math.atan2(nd.x - from.x, nd.z - from.z) : r() * TAU;
      const strength = nd.black ? 1 : 0.6;
      const root = i;
      this.add(i++, -1, n, 0, 0, heading, lean * (0.5 + r()),
        0.55 + 0.45 * nd.weight,
        width * (0.85 + 0.3 * r()) * strength, height * (0.75 + 0.5 * r()) * strength);
      // Branches, breadth-first, so every parent is placed before its children.
      let levelStart = root;
      let levelEnd = i;
      for (let level = 1; level <= this.depth; level++) {
        for (let p = levelStart; p < levelEnd; p++) {
          const spin = r() * TAU;
          for (let c = 0; c < K; c++) {
            const h = this.size[p * 2 + 1];
            this.add(i++, p, n, level,
              h * (attach[0] + (attach[1] - attach[0]) * r()),
              spin + (c / K) * TAU + (r() - 0.5) * 0.6,
              tilt * (0.7 + 0.6 * r()),
              ratio * (0.85 + 0.3 * r()),
              this.size[p * 2] * (0.85 + 0.3 * r()),
              h * (0.8 + 0.4 * r()));
          }
        }
        levelStart = levelEnd;
        levelEnd = i;
      }
    });
  }

  add(i, parent, node, level, attach, yaw, tilt, ratio, w, h) {
    this.parent[i] = parent;
    this.node[i] = node;
    this.level[i] = level;
    this.attach[i] = attach;
    this.yaw[i * 2] = Math.cos(yaw);
    this.yaw[i * 2 + 1] = Math.sin(yaw);
    this.tilt[i] = tilt;
    this.ratio[i] = ratio;
    this.size[i * 2] = w;
    this.size[i * 2 + 1] = h;
    this.phase[i] = this.rand();
  }

  onInput(slot, data) {
    if (slot !== 'pulse') return;
    const s = impact(data);
    this.waves.push({ front: -1, strength: s });
    if (this.waves.length > WAVES) this.waves.shift();
    // Growth spurts on the beat.
    if (this.clock < this.grown) this.clock += GlyphMosaic.SPUR * s;
  }

  /** How grown solid `i` is now, 0–1 (a little over while it pops in). */
  growthOf(i) {
    const { LEVEL_DELAY, GROW_TIME, HOLD, FADE, DISSOLVE } = GlyphMosaic;
    const nd = this.nodes[this.node[i]];
    const level = this.level[i];
    const g = pop((this.clock - nd.birth - level * LEVEL_DELAY) / GROW_TIME);
    const since = this.clock - this.grown - HOLD;
    if (since <= 0) return g;
    // Dissolving in the order it grew, the finest branches of each first.
    const start = nd.birth * DISSOLVE + (this.depth - level) * 0.15;
    return g * (1 - smooth((since - start) / FADE));
  }

  draw(ctx, dt) {
    const {
      SPEED, HOLD, FADE, DISSOLVE, SWAY, WAVE_SPEED, WAVE_DECAY, VIEW, ORBIT,
    } = GlyphMosaic;
    this.time += dt;
    this.clock += dt * (SPEED[0] + this.in('grow') * SPEED[1]);
    this.hue += dt * 0.025;
    // Fully dissolved: regrow from where the last growth ended, mutated.
    if (this.clock > this.grown + HOLD + this.lastBirth * DISSOLVE + this.depth * 0.15 + FADE) {
      this.seedOrder(this.tipSeeds());
      this.mutate();
    }
    for (const w of this.waves) {
      w.front += WAVE_SPEED * dt;
      w.strength *= Math.exp(-dt * WAVE_DECAY);
    }
    this.waves = this.waves.filter((w) => w.front < this.maxDepth + 4 && w.strength > 0.02);

    const light = this.nodes.map((nd) => {
      let s = 0;
      for (const w of this.waves) {
        const d = nd.depth - w.front;
        s += Math.exp(-d * d * 0.4) * w.strength;
      }
      return s;
    });

    this.updateSolids(SWAY[0] + this.in('sway') * SWAY[1], light);

    // Seed beds: faint until growth reaches them, then lit with their crystal.
    this.nodes.forEach((nd, i) => {
      const reached = smooth((this.clock - nd.birth) / 0.4);
      paletteColor(this, nd.depth / this.maxDepth * 0.6 + this.hue, this.c);
      this.beds.setColorAt(i, this.c.multiplyScalar((0.08 + 0.25 * reached) * (nd.black ? 1 : 0.6) + light[i] * 0.8));
    });
    this.beds.instanceColor.needsUpdate = true;

    // Circle the garden from above, so the plan reads as the drawing and the
    // crystals stand up out of it.
    const orbit = ORBIT[0] + this.in('grow') * ORBIT[1];
    this.swoop.update(dt, orbit);
    this.lift += dt * orbit * 0.8;
    const { scale, angle } = this.swoop;
    const dist = this.span * VIEW * scale + 2;
    const elevation = 0.9 + Math.sin(this.lift) * 0.22;
    const cam = this.camera;
    this.target.set(0, this.shape.height * 0.45, 0);
    cam.position.set(
      Math.cos(angle) * Math.cos(elevation) * dist,
      this.target.y + Math.sin(elevation) * dist,
      Math.sin(angle) * Math.cos(elevation) * dist,
    );
    this.swoop.aim(cam, this.target);
    this.headlight.position.copy(cam.position);
    this.lamp.position.set(Math.cos(this.time * 0.3) * this.span * 0.4, this.shape.height * 2, Math.sin(this.time * 0.3) * this.span * 0.4);
    paletteColor(this, this.hue + 0.5, this.lamp.color);
    if (cam.aspect !== this.width / this.height) {
      cam.aspect = this.width / this.height;
      cam.updateProjectionMatrix();
    }

    this.glow.value = 0.15 + this.in('glow') * 0.45;
    this.present(ctx);
  }

  /**
   * Compose every solid's frame from its parent's — grown, swayed — and
   * write it out stretched to the solid's own proportions.
   */
  updateSolids(swayAmount, light) {
    const { frames: F, parent, attach, yaw, tilt, ratio, size, phase, level } = this;
    const e = this.solids.instanceMatrix.array;
    const time = this.time;
    for (let i = 0; i < this.count; i++) {
      const g = Math.max(0, this.growthOf(i));
      const lv = level[i];
      const sway = Math.sin(time * (0.7 + phase[i] * 0.6) + phase[i] * TAU) * swayAmount * (0.3 + lv * 0.4);
      const cy = yaw[i * 2];
      const sy = yaw[i * 2 + 1];
      const cx = Math.cos(tilt[i] + sway);
      const sx = Math.sin(tilt[i] + sway);
      const p = parent[i];
      // local = translate · Ry(yaw) · Rx(tilt + sway) · scale(s)
      const s = (p < 0 ? 1 : ratio[i]) * g;
      const l00 = cy * s, l01 = sy * sx * s, l02 = sy * cx * s;
      const l10 = 0, l11 = cx * s, l12 = -sx * s;
      const l20 = -sy * s, l21 = cy * sx * s, l22 = cy * cx * s;
      const j = i * 12;
      if (p < 0) {
        // A root: placed on its seed bed, scaled by its cell's strength.
        const nd = this.nodes[this.node[i]];
        const k = ratio[i];
        F[j] = l00 * k; F[j + 1] = l01 * k; F[j + 2] = l02 * k;
        F[j + 3] = l10 * k; F[j + 4] = l11 * k; F[j + 5] = l12 * k;
        F[j + 6] = l20 * k; F[j + 7] = l21 * k; F[j + 8] = l22 * k;
        F[j + 9] = nd.x; F[j + 10] = 0; F[j + 11] = nd.z;
      } else {
        // frame = parent · local, the local origin `attach` up the parent.
        const q = p * 12;
        for (let r = 0; r < 3; r++) {
          const a = F[q + r * 3];
          const b = F[q + r * 3 + 1];
          const c = F[q + r * 3 + 2];
          F[j + r * 3] = a * l00 + b * l10 + c * l20;
          F[j + r * 3 + 1] = a * l01 + b * l11 + c * l21;
          F[j + r * 3 + 2] = a * l02 + b * l12 + c * l22;
          F[j + 9 + r] = b * attach[i] + F[q + 9 + r];
        }
      }
      // Instance: the frame stretched to (width, height, width), column-major.
      const w = size[i * 2];
      const h = size[i * 2 + 1];
      const t = i * 16;
      e[t] = F[j] * w; e[t + 1] = F[j + 3] * w; e[t + 2] = F[j + 6] * w; e[t + 3] = 0;
      e[t + 4] = F[j + 1] * h; e[t + 5] = F[j + 4] * h; e[t + 6] = F[j + 7] * h; e[t + 7] = 0;
      e[t + 8] = F[j + 2] * w; e[t + 9] = F[j + 5] * w; e[t + 10] = F[j + 8] * w; e[t + 11] = 0;
      e[t + 12] = F[j + 9]; e[t + 13] = F[j + 10]; e[t + 14] = F[j + 11]; e[t + 15] = 1;

      const n = this.node[i];
      const nd = this.nodes[n];
      paletteColor(this, nd.depth / this.maxDepth * 0.6 + lv * 0.08 + this.hue, this.c);
      this.c.multiplyScalar((nd.black ? 1 : 0.55) * (0.75 + 0.25 * lv / Math.max(1, this.depth)) * (1 + light[n] * 2.5));
      this.solids.setColorAt(i, this.c);
    }
    this.solids.instanceMatrix.needsUpdate = true;
    this.solids.instanceColor.needsUpdate = true;
  }
}
