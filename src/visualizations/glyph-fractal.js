import { ThreeVisualization } from './three-base.js';
import { approach, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';
import {
  PALETTE_OPTION, PALETTE_GLSL, paletteUniforms, updatePalette, isPsychedelic,
  DISTANCE_OPTION, Swoop, paletteColor, instanceGlow,
} from './three-shared.js';
import { mosaicOf } from './glyph-mosaic.js';
import { Glyph, glyphOption, readGlyph, FLOWER } from './glyph.js';

const TABLE = 4096;   // resolution of the map-picking table

/**
 * GlyphFractal — the drawing made of copies of itself, all the way down.
 *
 * Every filled cell is a map that shrinks the whole figure into that cell.
 * Iterating them in random order (the chaos game) draws the one figure that
 * is made of copies of itself in exactly the drawn arrangement: draw a plus
 * and it is a Vicsek fractal, a ring of eight cells and it is a Sierpiński
 * carpet, anything else and it is a fractal nobody has named. It is rebuilt
 * every frame, so as the maps move the whole figure moves with them at
 * every scale.
 *
 * Option `form` sets how it stands up in 3D:
 *
 *   bloom   (default) the copies tilt out of the plane about the axis
 *           across their direction from the centre, like petals; black
 *           cells tilt one way and grey the other, so the figure opens into
 *           a layered flower, and every copy of a copy does the same
 *   sponge  the drawing is read three ways at once — a cube is kept where
 *           all three of its axis-aligned shadows land on filled cells —
 *           so a ring of eight gives the Menger sponge and other drawings
 *           give solids with the drawing for a silhouette from every side.
 *           Drawn as lit cubes, the drawing nested two or three levels deep
 *           (as many as CUBES allows), each copy twisting about its own
 *           centre in a checkerboard of opposing turns. A drawing too sparse
 *           to keep two cubes this way blooms instead
 *
 * Grey cells are smaller, and copies reached through them are dimmer, so
 * they read as fainter parts of the drawing at every scale.
 *
 * Reactions:
 *
 *   jolt   a hit swells every copy past its cell, so the figure blooms
 *          into overlapping light, and kicks the fold
 *   fold   how far the copies tilt (bloom) or turn (sponge)
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
    glow: { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
      smooth: 0.1,
    } },
  };

  static options = {
    glyph: glyphOption({ width: 7, height: 7, value: FLOWER }),
    form: { kind: 'enum', values: ['bloom', 'sponge'], default: 'bloom' },
    palette: PALETTE_OPTION,
    distance: DISTANCE_OPTION,
  };
  // The mosaic, wearing this one's default drawing.
  static fallback = mosaicOf(this.options.glyph);

  static CUBES = 12000;       // most cubes the sponge may nest into
  static PER_FRAME = 80000;   // bloom: chaos-game iterations per frame
  // Points kept: two frames. More history smears the finest copies as the
  // maps move, and fine copies are the point.
  static CLOUD = 160000;
  static GAP = 0.86;          // copy size as a fraction of its cell
  static GREY = 0.72;         // grey copies' size, relative to black ones
  // Added copy size at full hit strength. Kept under the gap: copies that
  // overlap fill each other in, and the bass is rarely fully at rest.
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
    // One cell is one map, whose fractal is a single point.
    if (this.glyph.count < 2) this.glyph = Glyph.parse(GlyphFractal.options.glyph.default);

    const form = this.options.form ?? 'bloom';
    if (form !== 'bloom' && form !== 'sponge') {
      console.warn(`GloamingKit: glyph-fractal form '${form}'; expected bloom|sponge`);
    }
    this.maps = form === 'sponge' ? this.spongeMaps() : null;
    if (!this.maps || this.maps.length < 2) this.maps = this.bloomMaps();
    this.sponge = this.maps.sponge === true;

    const n = this.maps.length;
    this.matrices = new Float32Array(n * 12);
    this.hues = Float32Array.from(this.maps, (m, i) => m.hue ?? i / n);
    this.dims = Float32Array.from(this.maps, (m) => m.dim);
    if (this.sponge) this.buildCubes();
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
  }

  /** Bloom: a chaos-game point cloud. */
  buildPoints() {
    const THREE = this.THREE;
    const { CLOUD } = GlyphFractal;
    // Pick maps in proportion to their area, so every copy fills in at the
    // same density whatever its size.
    const n = this.maps.length;
    const weights = this.maps.map((m) => m.size ** 2);
    const total = weights.reduce((a, b) => a + b, 0);
    this.table = new Uint16Array(TABLE);
    for (let i = 0, k = 0, acc = 0; i < n; i++) {
      acc += weights[i] / total;
      for (; k < Math.round(acc * TABLE) && k < TABLE; k++) this.table[k] = i;
    }

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
   * Sponge: lit cubes, the drawing nested as many levels deep as CUBES
   * allows. A solid fractal is nearly a volume — a 7×7 drawing can keep
   * eighty copies, a dimension over 2 — so as points it would only ever be
   * fog; surfaces and shading are what make it read.
   */
  buildCubes() {
    const THREE = this.THREE;
    const n = this.maps.length;
    this.depth = Math.max(1, Math.floor(Math.log(GlyphFractal.CUBES) / Math.log(n)));
    const count = n ** this.depth;
    // Composed transforms for each level of nesting, reused every frame.
    this.nests = Array.from({ length: this.depth + 1 }, (_, d) => new Float32Array((n ** d) * 12));
    this.nests[0].set([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);

    const material = new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.35 });
    this.glow = instanceGlow(material, 0.3);
    // BoxGeometry(2) spans [-1, 1], the cube every map is a copy of.
    this.cubes = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), material, count);
    this.cubes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cubes.frustumCulled = false;
    // Address colour: the outermost copy picks the hue, each level within
    // shifts it by a quarter as much, as the point cloud's colours do.
    this.address = new Float32Array(count * 2);   // (hue, brightness)
    for (let i = 0; i < count; i++) {
      let hue = 0;
      let bright = 1;
      for (let d = 0, rest = i; d < this.depth; d++) {
        const k = Math.floor(rest / n ** (this.depth - 1 - d));
        rest -= k * n ** (this.depth - 1 - d);
        hue += this.hues[k] * 0.25 ** d;
        bright *= 0.4 + 0.6 * this.dims[k];
      }
      this.address[i * 2] = hue;
      this.address[i * 2 + 1] = bright;
    }
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
    const n = this.maps.length;
    const m = this.matrices;
    for (let d = 1; d <= this.depth; d++) {
      const parent = this.nests[d - 1];
      const out = this.nests[d];
      const parents = n ** (d - 1);
      // Address (a, b) is parent a applied after map b: P ∘ M.
      for (let a = 0; a < parents; a++) {
        const p = a * 12;
        const p00 = parent[p], p01 = parent[p + 1], p02 = parent[p + 2];
        const p10 = parent[p + 3], p11 = parent[p + 4], p12 = parent[p + 5];
        const p20 = parent[p + 6], p21 = parent[p + 7], p22 = parent[p + 8];
        for (let b = 0; b < n; b++) {
          const q = b * 12;
          const o = (a * n + b) * 12;
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
    const e = this.cubes.instanceMatrix.array;
    const count = n ** this.depth;
    for (let i = 0; i < count; i++) {
      const s = i * 12;
      const t = i * 16;
      e[t] = leaf[s]; e[t + 1] = leaf[s + 3]; e[t + 2] = leaf[s + 6]; e[t + 3] = 0;
      e[t + 4] = leaf[s + 1]; e[t + 5] = leaf[s + 4]; e[t + 6] = leaf[s + 7]; e[t + 7] = 0;
      e[t + 8] = leaf[s + 2]; e[t + 9] = leaf[s + 5]; e[t + 10] = leaf[s + 8]; e[t + 11] = 0;
      e[t + 12] = leaf[s + 9]; e[t + 13] = leaf[s + 10]; e[t + 14] = leaf[s + 11]; e[t + 15] = 1;
      paletteColor(this, this.address[i * 2] * 0.5 + this.colorPhase, this.c);
      this.cubes.setColorAt(i, this.c.multiplyScalar(this.address[i * 2 + 1]));
    }
    this.cubes.instanceMatrix.needsUpdate = true;
    this.cubes.instanceColor.needsUpdate = true;
  }

  /** Cell (x, y) of the glyph → centre in [-1, 1], y up. */
  cellCenter(x, y) {
    const span = Math.max(this.glyph.width, this.glyph.height);
    return [
      ((x + 0.5) - this.glyph.width / 2) * (2 / span),
      -((y + 0.5) - this.glyph.height / 2) * (2 / span),
    ];
  }

  bloomMaps() {
    const { GAP, GREY } = GlyphFractal;
    const { levels, width, height } = this.glyph;
    const span = Math.max(width, height);
    const cells = this.glyph.filled();
    const reach = Math.max(1e-6, ...cells.map(({ x, y }) => Math.hypot(...this.cellCenter(x, y))));
    // Copies sized so their areas add up to about the whole figure's. Exactly
    // their cells' size, a drawing of twenty-odd cells in a 7×7 is sparse dust
    // two levels down; this lets sparse drawings overlap into something lush,
    // while a dense one like the carpet stays close to its cells.
    const size = Math.max(GAP / span, Math.min(1.8 / span, 1 / Math.sqrt(cells.length)));
    return cells.map(({ x, y, level, weight }) => {
      const [cx, cy] = this.cellCenter(x, y);
      const r = Math.hypot(cx, cy);
      // Tilt about the axis across the cell's direction from the centre, so
      // the copy lifts like a petal. The centre cell has no direction; it
      // tilts about x.
      const ax = r > 1e-6 ? -cy / r : 1;
      const ay = r > 1e-6 ? cx / r : 0;
      const black = level === levels;
      return {
        cx, cy, cz: 0, ax, ay, az: 0,
        size: size * (black ? 1 : GREY) * (0.6 + 0.4 * weight),
        lean: (r / reach) * (black ? 1 : -1),   // tilt, as a fraction of the fold
        twist: black ? 1 : -1,
        dim: black ? 1 : 0.55,
        hue: Math.atan2(cy, cx) / (Math.PI * 2) + r * 0.15,
      };
    });
  }

  /**
   * Cubes whose three axis-aligned shadows all land on filled cells; null if
   * the drawing doesn't fit a cube (it is read as its larger square).
   */
  spongeMaps() {
    const { GAP } = GlyphFractal;
    const g = this.glyph;
    const n = Math.max(g.width, g.height);
    const maps = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const a = g.get(i, j);
        if (!a) continue;
        for (let k = 0; k < n; k++) {
          const b = g.get(i, k);
          const c = g.get(j, k);
          if (!b || !c) continue;
          const level = Math.min(a, b, c);
          const c3 = (v) => ((v + 0.5) - n / 2) * (2 / n);
          maps.push({
            cx: c3(i), cy: -c3(j), cz: c3(k),
            // Turn about y, in a checkerboard of opposite senses, so
            // neighbouring copies wring against each other.
            ax: 0, ay: 1, az: 0,
            size: (1 / n) * GAP * (level === g.levels ? 1 : GlyphFractal.GREY),
            lean: (i + j + k) % 2 ? 1 : -1,
            twist: (i + j + k) % 2 ? -1 : 1,
            dim: level === g.levels ? 1 : 0.55,
            hue: (i + j * 0.6 + k * 0.3) / n,
          });
        }
      }
    }
    maps.sponge = true;
    return maps;
  }

  onInput(slot, data) {
    if (slot === 'jolt') this.kick = Math.max(this.kick, impact(data));
  }

  /**
   * Each map as a 3×4 matrix: scale, then twist about the copy's own normal
   * (z; y for the sponge), then tilt about its lean axis, then move to its cell.
   */
  updateMaps() {
    const { SWELL, TWIST } = GlyphFractal;
    const m = this.matrices;
    const swell = 1 + this.kick * SWELL;
    const twist = Math.sin(this.phase) * TWIST;
    this.maps.forEach((map, i) => {
      const s = map.size * swell;
      // Twist: about z for bloom, about the map's own axis for the sponge.
      const tw = twist * map.twist;
      const ct = Math.cos(tw);
      const st = Math.sin(tw);
      // Tilt by angle `a` about the unit axis (ax, ay, az): Rodrigues.
      // The sponge's copies turn in place rather than lift, and a cube
      // turned far reads as a mess rather than a sculpture: a third as far.
      const a = this.sponge
        ? this.fold * map.lean * 0.35
        : (this.fold + this.kick * 0.25) * map.lean;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const t = 1 - c;
      const { ax, ay, az } = this.sponge ? { ax: 1, ay: 0, az: 0 } : map;
      const r00 = t * ax * ax + c, r01 = t * ax * ay - sn * az, r02 = t * ax * az + sn * ay;
      const r10 = t * ax * ay + sn * az, r11 = t * ay * ay + c, r12 = t * ay * az - sn * ax;
      const r20 = t * ax * az - sn * ay, r21 = t * ay * az + sn * ax, r22 = t * az * az + c;
      // Twist matrix T: about z (bloom) or y (sponge).
      let t00, t01, t02, t10, t11, t12, t20, t21, t22;
      if (this.sponge) {
        t00 = ct; t01 = 0; t02 = st;
        t10 = 0; t11 = 1; t12 = 0;
        t20 = -st; t21 = 0; t22 = ct;
      } else {
        t00 = ct; t01 = -st; t02 = 0;
        t10 = st; t11 = ct; t12 = 0;
        t20 = 0; t21 = 0; t22 = 1;
      }
      const j = i * 12;
      m[j] = s * (r00 * t00 + r01 * t10 + r02 * t20);
      m[j + 1] = s * (r00 * t01 + r01 * t11 + r02 * t21);
      m[j + 2] = s * (r00 * t02 + r01 * t12 + r02 * t22);
      m[j + 3] = s * (r10 * t00 + r11 * t10 + r12 * t20);
      m[j + 4] = s * (r10 * t01 + r11 * t11 + r12 * t21);
      m[j + 5] = s * (r10 * t02 + r11 * t12 + r12 * t22);
      m[j + 6] = s * (r20 * t00 + r21 * t10 + r22 * t20);
      m[j + 7] = s * (r20 * t01 + r21 * t11 + r22 * t21);
      m[j + 8] = s * (r20 * t02 + r21 * t12 + r22 * t22);
      m[j + 9] = map.cx;
      m[j + 10] = map.cy;
      m[j + 11] = map.cz;
    });
  }

  /** Run the chaos game PER_FRAME times into the ring buffer. */
  iterate() {
    const { PER_FRAME, CLOUD } = GlyphFractal;
    const { table, matrices: m, hues, dims, cloud, tones } = this;
    let { x, y, z, hue, bright, write: w } = this;
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
      tones[w * 2] = hue;
      tones[w * 2 + 1] = bright;
      w = (w + 1) % CLOUD;
    }
    Object.assign(this, { x, y, z, hue, bright, write: w });
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

    this.updateMaps();
    if (this.sponge) this.updateCubes();
    else this.iterate();

    const orbit = ORBIT[0] + spin * ORBIT[1];
    this.swoop.update(dt, orbit);
    this.lift += dt * orbit * 0.7;
    const { scale, angle } = this.swoop;
    const dist = VIEW * scale;
    const cam = this.camera;
    if (this.sponge) {
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
    this.swoop.aim(cam, this.center);
    if (cam.aspect !== this.width / this.height) {
      cam.aspect = this.width / this.height;
      cam.updateProjectionMatrix();
    }

    if (this.sponge) {
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
