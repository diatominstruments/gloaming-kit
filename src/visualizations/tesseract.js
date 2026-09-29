import { ThreeVisualization } from './three-base.js';
import { impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';
import {
  PALETTE_OPTION, DISTANCE_OPTION, Swoop, paletteColor, isPsychedelic, instanceGlow,
} from './three-shared.js';

const PHI = (1 + Math.sqrt(5)) / 2;

/** All 24 permutations of [0, 1, 2, 3], each with its parity. */
function permutations4() {
  const out = [];
  const walk = (prefix, rest) => {
    if (!rest.length) {
      let inversions = 0;
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) if (prefix[i] > prefix[j]) inversions++;
      out.push({ perm: prefix, even: inversions % 2 === 0 });
      return;
    }
    rest.forEach((v, i) => walk([...prefix, v], [...rest.slice(0, i), ...rest.slice(i + 1)]));
  };
  walk([], [0, 1, 2, 3]);
  return out;
}

/** Every sign combination of `v`'s non-zero entries. */
function signed(v) {
  let out = [[]];
  for (const x of v) out = out.flatMap((p) => (x === 0 ? [[...p, 0]] : [[...p, x], [...p, -x]]));
  return out;
}

/** Apply each permutation (optionally even ones only) to each vector; dedupe. */
function permuted(vectors, evenOnly = false) {
  const seen = new Map();
  for (const v of vectors) {
    for (const { perm, even } of permutations4()) {
      if (evenOnly && !even) continue;
      const p = perm.map((i) => v[i]);
      seen.set(p.map((x) => x.toFixed(6)).join(','), p);
    }
  }
  return [...seen.values()];
}

/**
 * The regular 4D polytopes on offer, as vertex lists on the unit 3-sphere.
 * Edges aren't listed: they are every pair at the shortest distance, which
 * holds for all regular polytopes.
 */
const POLYTOPES = {
  // 16 vertices, 32 edges: the hypercube.
  tesseract: () => signed([0.5, 0.5, 0.5, 0.5]),
  // 24 vertices, 96 edges: self-dual, with no 3D analogue.
  '24-cell': () => permuted(signed([1, 1, 0, 0])).map((v) => v.map((x) => x / Math.SQRT2)),
  // 120 vertices, 720 edges: twenty tetrahedra round every vertex.
  '600-cell': () => [
    ...permuted(signed([1, 0, 0, 0])),
    ...signed([0.5, 0.5, 0.5, 0.5]),
    ...permuted(signed([PHI / 2, 0.5, 1 / (2 * PHI), 0]), true),
  ],
};

function edgesOf(vertices) {
  const d2 = (a, b) => a.reduce((sum, x, i) => sum + (x - b[i]) ** 2, 0);
  let min = Infinity;
  for (let i = 0; i < vertices.length; i++) {
    for (let j = i + 1; j < vertices.length; j++) min = Math.min(min, d2(vertices[i], vertices[j]));
  }
  const edges = [];
  for (let i = 0; i < vertices.length; i++) {
    for (let j = i + 1; j < vertices.length; j++) {
      if (d2(vertices[i], vertices[j]) < min * 1.01) edges.push([i, j]);
    }
  }
  return edges;
}

// The six planes a 4D rotation can turn in, as axis pairs. The last three
// involve w, and are the ones that turn the figure inside out.
const PLANES = [[0, 1], [0, 2], [1, 2], [0, 3], [1, 3], [2, 3]];

/**
 * Tesseract — a four-dimensional solid turning through the fourth dimension.
 *
 * A regular 4D polytope rotates in all six of its planes and is projected
 * into 3D by perspective along w, the way a 3D cube's shadow falls on a
 * wall: the cell nearest in w swells into the outside of the figure and the
 * farthest shrinks to its centre. Rotations through w then pass cells from
 * outside to inside, so the solid appears to turn itself inside out in a way
 * no 3D object can. The projection is then viewed by an ordinary 3D camera
 * that orbits it slowly.
 *
 * Edges are lit tubes and vertices glowing beads, both sized by their 4D
 * depth — so the depth along w reads as thickness on top of the 3D
 * perspective — and coloured by it, so each cell keeps its hue as it travels
 * through the figure.
 *
 * Reactions:
 *
 *   whip     a hit kicks the rotation in one of the three w-planes and swells
 *            the figure, so beats turn it inside out
 *   spin     how fast every plane turns
 *   glow     how brightly the beads and tubes shine
 *
 * Options: `shape` picks the polytope — `tesseract` (the hypercube), `24-cell`
 * (the default: enough cells for the inside-out turning to read, few enough
 * to follow), or `600-cell`, a dense geodesic cage of 720 edges.
 * `distance` sets the camera: `near`, `med` or `far` circle it at a fixed
 * range, and `orbit` (the default) hangs back, then swoops in and sweeps the
 * figure past the camera close enough to fill the frame. See Swoop in
 * three-shared.js.
 */
export class Tesseract extends ThreeVisualization {
  static id = 'tesseract';
  static label = 'Tesseract';
  static description = 'A 4D solid rotating through the fourth dimension, turning itself inside out; hits whip it through w.';
  static category = CATEGORY.SPACES;
  static fallback = 'rolling-ball';

  static inputs = {
    whip: { kind: 'event', default: TRIGGER.BASS },
    spin: { kind: 'level', default: { intensity: 'mid', smooth: 0.6 } },
    glow: { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
      smooth: 0.1,
    } },
  };

  static options = {
    palette: PALETTE_OPTION,
    shape: { kind: 'enum', values: Object.keys(POLYTOPES), default: '24-cell' },
    distance: DISTANCE_OPTION,
  };

  static W_DISTANCE = 2.2;   // 4D viewpoint distance along w, in 3-sphere radii
  static SCALE = 1.6;        // projected size, world units
  // Plane rates in rad/s at idle, per plane in PLANES order: slow in the
  // ordinary 3D planes, faster through w, all different so it never repeats.
  static RATES = [0.07, 0.05, 0.09, 0.23, 0.17, 0.29];
  static SPIN_GAIN = 2.5;    // rate multiplier added at full `spin`
  static WHIP = 2.2;         // extra rad/s through w at full strength
  static WHIP_DECAY = 1.6;
  static PULSE = 0.18;
  static TUBE = 0.028;       // edge radius at unit projection
  static BEAD = 0.065;       // vertex radius at unit projection
  static VIEW = 8;           // camera distance at `med`, world units

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    this.psychedelic = isPsychedelic(this);

    const shape = this.options.shape in POLYTOPES ? this.options.shape : Tesseract.options.shape.default;
    this.vertices = POLYTOPES[shape]();
    this.edges = edgesOf(this.vertices);
    this.projected = this.vertices.map(() => ({ p: new THREE.Vector3(), k: 1, w: 0 }));
    // A dense cage wants thinner members.
    const density = Math.sqrt(32 / this.edges.length);
    this.tube = Tesseract.TUBE * Math.max(0.45, density);
    this.bead = Tesseract.BEAD * Math.max(0.5, density);

    const tubeMaterial = new THREE.MeshStandardMaterial({ metalness: 0.4, roughness: 0.35 });
    const beadMaterial = new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.2 });
    this.tubeGlow = instanceGlow(tubeMaterial, 0.2);
    this.beadGlow = instanceGlow(beadMaterial, 0.6);

    this.tubes = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1, 1, 10, 1, true), tubeMaterial, this.edges.length,
    );
    this.beads = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 2), beadMaterial, this.vertices.length,
    );
    for (const mesh of [this.tubes, this.beads]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
    }

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    this.lights = [0, 1, 2].map(() => {
      const light = new THREE.PointLight(0xffffff, 10, 0, 1);
      this.scene.add(light);
      return light;
    });

    this.angles = new Float64Array(PLANES.length);
    this.whip = new Float64Array(PLANES.length);
    this.kick = 0;
    this.time = 0;
    this.hue = Math.random();
    this.camera.fov = 45;
    this.camera.near = 0.05;
    this.center = new THREE.Vector3();
    // At the close point the camera is just outside the figure's outer cell,
    // so edges stream past the lens.
    this.swoop = new Swoop(this.options.distance, { near: 0.42, far: 2.1, period: 22 });

    // Scratch, so the per-frame loops never allocate.
    this.v = new Float64Array(4);
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.s = new THREE.Vector3();
    this.dir = new THREE.Vector3();
    this.mid = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.c = new THREE.Color();
  }

  onInput(slot, data) {
    if (slot !== 'whip') return;
    const size = impact(data);
    // One of the three w-planes, either way round.
    const plane = 3 + Math.floor(Math.random() * 3);
    this.whip[plane] += (Math.random() < 0.5 ? -1 : 1) * size * Tesseract.WHIP;
    this.kick = Math.max(this.kick, size);
  }

  /** Rotate vertex `src` by the current angles into `this.v`. */
  rotate(src) {
    const v = this.v;
    v[0] = src[0]; v[1] = src[1]; v[2] = src[2]; v[3] = src[3];
    for (let n = 0; n < PLANES.length; n++) {
      const [a, b] = PLANES[n];
      const c = Math.cos(this.angles[n]);
      const s = Math.sin(this.angles[n]);
      const x = v[a];
      const y = v[b];
      v[a] = x * c - y * s;
      v[b] = x * s + y * c;
    }
    return v;
  }

  draw(ctx, dt) {
    const {
      RATES, SPIN_GAIN, WHIP_DECAY, PULSE, W_DISTANCE, SCALE,
    } = Tesseract;
    this.time += dt;
    this.hue += dt * 0.025;
    const rate = 1 + this.in('spin') * SPIN_GAIN;
    const decay = Math.exp(-dt * WHIP_DECAY);
    for (let n = 0; n < PLANES.length; n++) {
      this.whip[n] *= decay;
      this.angles[n] += (RATES[n] * rate + this.whip[n]) * dt;
    }
    this.kick *= Math.exp(-dt * 2.5);
    const swell = SCALE * (1 + PULSE * this.kick);

    // Perspective from 4D: the nearer in w, the larger.
    for (let i = 0; i < this.vertices.length; i++) {
      const v = this.rotate(this.vertices[i]);
      const k = W_DISTANCE / (W_DISTANCE - v[3]);
      const out = this.projected[i];
      out.p.set(v[0] * k * swell, v[1] * k * swell, v[2] * k * swell);
      out.k = k;
      out.w = v[3];
    }

    const { m, q, s, dir, mid, up, c } = this;
    for (let e = 0; e < this.edges.length; e++) {
      const a = this.projected[this.edges[e][0]];
      const b = this.projected[this.edges[e][1]];
      dir.subVectors(b.p, a.p);
      const len = dir.length();
      mid.addVectors(a.p, b.p).multiplyScalar(0.5);
      q.setFromUnitVectors(up, dir.divideScalar(len || 1));
      const r = this.tube * swell * (a.k + b.k) * 0.5;
      s.set(r, len, r);
      m.compose(mid, q, s);
      this.tubes.setMatrixAt(e, m);
      this.tubes.setColorAt(e, paletteColor(this, (a.w + b.w) * 0.25 + this.hue, c));
    }
    q.identity();
    for (let i = 0; i < this.projected.length; i++) {
      const { p, k, w } = this.projected[i];
      s.setScalar(this.bead * swell * k * (1 + this.kick * 0.6));
      m.compose(p, q, s);
      this.beads.setMatrixAt(i, m);
      this.beads.setColorAt(i, paletteColor(this, w * 0.5 + this.hue + 0.15, c));
    }
    for (const mesh of [this.tubes, this.beads]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }

    const glow = this.in('glow');
    this.tubeGlow.value = 0.15 + glow * 0.5 + this.kick * 0.4;
    this.beadGlow.value = 0.5 + glow * 1.2 + this.kick;

    // Circling, so the 3D projection shows its depth too.
    this.swoop.update(dt, 0.11);
    const { angle, scale } = this.swoop;
    const dist = Tesseract.VIEW * scale;
    const cam = this.camera;
    cam.position.set(Math.cos(angle) * dist, Math.sin(this.time * 0.07) * 0.3 * dist, Math.sin(angle) * dist);
    this.swoop.aim(cam, this.center, SCALE);
    if (cam.aspect !== this.width / this.height) {
      cam.aspect = this.width / this.height;
      cam.updateProjectionMatrix();
    }
    this.lights.forEach((light, n) => {
      const a = this.time * (0.2 + n * 0.07) + (n * Math.PI * 2) / 3;
      light.position.set(Math.cos(a) * 5, Math.sin(a * 1.3) * 3, Math.sin(a) * 5);
      paletteColor(this, this.hue + n / 3, light.color);
    });
    this.present(ctx);
  }
}
