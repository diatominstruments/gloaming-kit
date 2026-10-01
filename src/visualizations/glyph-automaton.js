import { ThreeVisualization } from './three-base.js';
import { approach, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';
import {
  PALETTE_OPTION, DISTANCE_OPTION, Swoop, paletteColor, isPsychedelic, instanceGlow,
} from './three-shared.js';
import { mosaicOf } from './glyph-mosaic.js';
import { glyphOption, readGlyph, MANDALA } from './glyph.js';

/**
 * Rules, in the "Generations" family: a cell is dead (0), alive (1), or
 * dying (2 and up), counting down through `states` before it is dead again.
 * Only living cells count as neighbours; a dead cell with a `born` count of
 * them comes alive, and a living one with a `survive` count stays alive —
 * otherwise it starts dying.
 *
 * Three states is the drawing's own format: black cells start alive and grey
 * ones dying.
 */
const RULES = {
  // Brian's Brain: nothing survives, so it never settles — gliders stream
  // out of almost any drawing and keep colliding.
  brain: { born: [2], survive: [], states: 3 },
  // Conway's Life, with a one-generation dying trail.
  life: { born: [3], survive: [2, 3], states: 3 },
  // Star Wars: dense, sparking clusters with long trails.
  'star-wars': { born: [2], survive: [3, 4, 5], states: 4 },
};

const HISTORY = 6;   // generations remembered to spot a pattern that's stuck

/**
 * GlyphAutomaton — the drawing as the first generation of a cellular
 * automaton, its history stacked into a tower.
 *
 * Each generation is a slice of lit cubes; new slices land on top and the
 * tower sinks beneath them, older generations tapering into dust at the
 * bottom. So the top face is the pattern now — the drawing itself, at first
 * — and the sides are a record of how it got there: gliders leave diagonal
 * tubes, oscillators leave pillars, and a symmetric drawing grows a
 * symmetric spire.
 *
 * The drawing sits in the middle of a field twice its size that wraps at the
 * edges. When the pattern dies out or gets stuck repeating itself, the
 * drawing is planted again and the tower starts over from it.
 *
 * Option `rule`: 'brain' (default), 'life' or 'star-wars'; see RULES.
 *
 * Reactions:
 *
 *   step   a hit advances a generation at once, and that slice is lit
 *          brighter for the rest of its life — so the tower's sides keep a
 *          record of where the beats fell
 *   stamp  a hit plants the drawing again on top of whatever is there
 *   rate   how many generations pass per second between hits
 *   glow   how brightly the cubes shine
 */
export class GlyphAutomaton extends ThreeVisualization {
  static id = 'glyph-automaton';
  static label = 'Glyph Automaton';
  static description = 'The drawing as a cellular automaton, each generation stacked into a growing tower; beats advance it and light their slices.';
  static category = CATEGORY.GLYPHS;

  static inputs = {
    step:  { kind: 'event', default: TRIGGER.BASS },
    stamp: { kind: 'event', default: TRIGGER.SNARE },
    rate:  { kind: 'level', default: { intensity: 'mid', smooth: 0.5 } },
    glow:  { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
      smooth: 0.1,
    } },
  };

  static options = {
    glyph: glyphOption({ width: 16, height: 16, value: MANDALA }),
    rule: { kind: 'enum', values: Object.keys(RULES), default: 'brain' },
    palette: PALETTE_OPTION,
    distance: DISTANCE_OPTION,
  };
  // The mosaic, wearing this one's default drawing.
  static fallback = mosaicOf(this.options.glyph);

  static SLICES = 44;          // generations shown
  static RATE = [1.2, 4];      // generations/s: [idle, added at full rate]
  static MIN_GAP = 0.09;       // s; hits closer together than this don't step
  static STUCK = 10;           // generations a dead or repeating pattern shows before replanting
  static VIEW = 2.1;           // camera distance at `med`, in field widths
  static ORBIT = [0.05, 0.12];

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    const { SLICES } = GlyphAutomaton;
    this.psychedelic = isPsychedelic(this);
    this.glyph = readGlyph(this);

    const ruleName = this.options.rule ?? 'brain';
    if (!(ruleName in RULES)) {
      console.warn(`GloamingKit: glyph-automaton rule '${ruleName}'; expected ${Object.keys(RULES).join('|')}`);
    }
    const rule = RULES[ruleName] ?? RULES.brain;
    this.states = rule.states;
    this.born = new Uint8Array(9);
    this.survive = new Uint8Array(9);
    for (const n of rule.born) this.born[n] = 1;
    for (const n of rule.survive) this.survive[n] = 1;

    const span = Math.max(this.glyph.width, this.glyph.height);
    this.n = Math.max(16, Math.min(48, span * 2));
    this.state = new Uint8Array(this.n * this.n);
    this.next = new Uint8Array(this.n * this.n);
    // Newest first: { cells, flash, hue }.
    this.slices = [];
    this.hashes = [];
    this.stuck = 0;
    this.stampPending = 0;

    const capacity = this.n * this.n * SLICES;
    const material = new THREE.MeshStandardMaterial({ metalness: 0.1, roughness: 0.45 });
    this.glow = instanceGlow(material, 0.3);
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.tower = new THREE.Group();
    this.tower.add(this.mesh);
    this.scene.add(this.tower);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.3));
    this.key = new THREE.DirectionalLight(0xffffff, 1.1);
    this.key.position.set(0.4, 1, 0.3);
    this.scene.add(this.key);
    this.headlight = new THREE.PointLight(0xffffff, 3, 0, 0);
    this.scene.add(this.headlight);

    this.hue = Math.random();
    this.timer = 0;
    this.sinceStep = 1;
    this.shift = 0;          // slices the tower is drawn raised by; eases to 0
    this.newest = 0;         // instances in the newest slice, which grows in
    this.rateNow = GlyphAutomaton.RATE[0];
    this.swoop = new Swoop(this.options.distance, { near: 0.4, far: 2.2, period: 34 });
    this.lift = Math.random() * 10;
    this.camera.fov = 55;
    this.camera.near = 0.1;
    this.camera.far = 1000;
    this.target = new THREE.Vector3();

    // Scratch, so the per-instance loops never allocate.
    this.m = new THREE.Matrix4();
    this.c = new THREE.Color();

    this.plant(this.state);
    this.push(1);
  }

  /** Write the drawing into `cells`, centred, over whatever is there. */
  plant(cells) {
    const { width, height, levels } = this.glyph;
    const ox = Math.floor((this.n - width) / 2);
    const oy = Math.floor((this.n - height) / 2);
    for (const { x, y, level } of this.glyph.filled()) {
      // Black starts alive, anything fainter starts dying.
      cells[(oy + y) * this.n + ox + x] = level === levels || this.states < 3 ? 1 : 2;
    }
  }

  onInput(slot, data) {
    if (slot === 'stamp') {
      this.stampPending = Math.max(this.stampPending, impact(data));
    } else if (slot === 'step' && this.sinceStep >= GlyphAutomaton.MIN_GAP) {
      this.advance(impact(data));
    }
  }

  /** One generation, pushed onto the tower; `flash` lights its slice. */
  advance(flash) {
    const { n, state, next, born, survive, states } = this;
    for (let y = 0; y < n; y++) {
      const up = ((y + n - 1) % n) * n;
      const row = y * n;
      const down = ((y + 1) % n) * n;
      for (let x = 0; x < n; x++) {
        const l = (x + n - 1) % n;
        const r = (x + 1) % n;
        const count = (state[up + l] === 1) + (state[up + x] === 1) + (state[up + r] === 1)
          + (state[row + l] === 1) + (state[row + r] === 1)
          + (state[down + l] === 1) + (state[down + x] === 1) + (state[down + r] === 1);
        const s = state[row + x];
        let out;
        if (s === 0) out = born[count] ? 1 : 0;
        else if (s === 1) out = survive[count] ? 1 : (states > 2 ? 2 : 0);
        else out = s + 1 < states ? s + 1 : 0;
        next[row + x] = out;
      }
    }
    if (this.stampPending > 0) {
      this.plant(next);
      flash = Math.max(flash, this.stampPending);
      this.stampPending = 0;
    }
    this.state = next;
    this.next = state;

    // Dead, or repeating within a few generations: let it show for a while
    // as a pillar, then plant the drawing again.
    let hash = 2166136261;
    let alive = 0;
    for (let i = 0; i < next.length; i++) {
      hash = Math.imul(hash ^ next[i], 16777619);
      if (next[i]) alive++;
    }
    const repeating = !alive || this.hashes.includes(hash);
    this.hashes.push(hash);
    if (this.hashes.length > HISTORY) this.hashes.shift();
    this.stuck = repeating ? this.stuck + 1 : 0;
    if (this.stuck >= GlyphAutomaton.STUCK) {
      this.state.fill(0);
      this.plant(this.state);
      this.hashes.length = 0;
      this.stuck = 0;
      flash = Math.max(flash, 1);
    }
    this.push(flash);
  }

  /** Record the current state as the newest slice and rebuild the tower. */
  push(flash) {
    this.slices.unshift({ cells: this.state.slice(), flash, hue: this.hue });
    if (this.slices.length > GlyphAutomaton.SLICES) this.slices.pop();
    this.shift += 1;
    this.sinceStep = 0;
    this.timer = 0;
    this.rebuild();
  }

  /**
   * Instance matrices and colours for every live cell of every slice. Slices
   * only change when a generation is added, so this runs a few times a
   * second, not every frame.
   */
  rebuild() {
    const { SLICES } = GlyphAutomaton;
    const { n, mesh, m, c, states } = this;
    const half = (n - 1) / 2;
    let i = 0;
    this.slices.forEach((slice, k) => {
      // Older generations taper away toward the bottom of the tower.
      const taper = Math.pow(1 - k / SLICES, 0.6);
      const bright = (0.45 + 0.4 * (1 - k / SLICES)) * (1 + slice.flash * 0.9);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const s = slice.cells[y * n + x];
          if (!s) continue;
          // Dying cells shrink as they count down.
          const size = (s === 1 ? 0.92 : 0.62 * (1 - (s - 2) / Math.max(1, states - 2) * 0.4)) * taper;
          m.makeScale(size, size, size).setPosition(x - half, -k, y - half);
          mesh.setMatrixAt(i, m);
          const radial = Math.hypot(x - half, y - half) / n;
          paletteColor(this, slice.hue + radial * 0.5 + (s === 1 ? 0 : 0.4), c);
          c.multiplyScalar(s === 1 ? bright : bright * 0.6);
          mesh.setColorAt(i, c);
          i++;
        }
      }
      if (k === 0) this.newest = i;
    });
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
  }

  /** Grow the newest slice's cubes in as the tower sinks under it. */
  growNewest() {
    const { n, mesh, m } = this;
    const slice = this.slices[0];
    const grow = Math.max(0, Math.min(1, 1 - this.shift));
    const half = (n - 1) / 2;
    let i = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const s = slice.cells[y * n + x];
        if (!s) continue;
        const size = (s === 1 ? 0.92 : 0.62) * grow;
        m.makeScale(size, size, size).setPosition(x - half, 0, y - half);
        mesh.setMatrixAt(i++, m);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  draw(ctx, dt) {
    const { RATE, VIEW, ORBIT, SLICES } = GlyphAutomaton;
    const rate = this.in('rate');
    this.hue += dt * (0.02 + rate * 0.05);
    this.sinceStep += dt;
    this.rateNow = approach(this.rateNow, RATE[0] + rate * RATE[1], 0.5, dt);
    this.timer += dt * this.rateNow;
    if (this.timer >= 1) this.advance(0);

    const settling = this.shift > 1e-3;
    this.shift = approach(this.shift, 0, 0.12, dt);
    if (settling) this.growNewest();
    this.tower.position.y = this.shift;

    // Circle the tower from above its top, so the newest generation — the
    // drawing, at first — faces the camera, and the history falls away below.
    const spin = ORBIT[0] + this.in('rate') * ORBIT[1];
    this.swoop.update(dt, spin);
    this.lift += dt * spin * 0.8;
    const { scale, angle } = this.swoop;
    const dist = this.n * VIEW * scale;
    const elevation = 0.8 + Math.sin(this.lift) * 0.25;
    const cam = this.camera;
    this.target.set(0, -SLICES * 0.3, 0);
    cam.position.set(
      Math.cos(angle) * Math.cos(elevation) * dist,
      this.target.y + Math.sin(elevation) * dist,
      Math.sin(angle) * Math.cos(elevation) * dist,
    );
    this.swoop.aim(cam, this.target);
    this.headlight.position.copy(cam.position);
    if (cam.aspect !== this.width / this.height) {
      cam.aspect = this.width / this.height;
      cam.updateProjectionMatrix();
    }

    this.glow.value = 0.2 + this.in('glow') * 0.5;
    this.present(ctx);
  }
}
