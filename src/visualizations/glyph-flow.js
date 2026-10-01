import { ThreeVisualization } from './three-base.js';
import { approach, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';
import { mulberry32 } from '../noise.js';
import {
  PALETTE_OPTION, PALETTE_GLSL, paletteUniforms, updatePalette, isPsychedelic,
} from './three-shared.js';
import { mosaicOf } from './glyph-mosaic.js';
import { glyphOption, readGlyph, EYE } from './glyph.js';

const DISTANCES = { near: 0.55, med: 1, far: 1.5 };

// The field is precomputed on a grid over this box; outside it the stream
// is just the base flow.
const BOX = 6.5;    // half-width in x and y
const DEEP = 7;     // half-depth in z, along the flow
const NX = 64;
const NZ = 40;
const CHANNELS = 7; // density, its gradient (3), swirl (3)

/**
 * GlyphFlow — a stream of light parting around the drawing.
 *
 * The drawing stands in a current, as an obstacle: tens of thousands of
 * streaks pour toward it, slide around its outline and close up again behind
 * it, so the drawing is a hole in the stream — negative space, drawn by
 * everything that avoids it. Streaks race faster and burn brighter as they
 * skim its edges, which lights the outline.
 *
 * Every cell also stirs the water: black cells swirl the stream one way and
 * grey cells the other, so it corkscrews as it passes and leaves twisted
 * wakes behind each part of the drawing.
 *
 * The obstacle is the drawing blurred into a smooth field, so neighbouring
 * cells merge into one solid shape and a lone cell is a rounded bump; the
 * stream slides along that field's surface rather than bouncing off cells.
 *
 * Reactions:
 *
 *   surge  a hit inflates the obstacle and speeds the stream, so it bursts
 *          outward round the drawing and the hole flashes wider
 *   flow   how fast the stream runs, heavily smoothed
 *   swirl  how hard each cell twists the stream
 *   glow   brightness
 *
 * The camera hangs downstream looking into the current, swinging from
 * face-on — where the drawing reads as a hole — round to oblique, where the
 * wakes show. Option `distance`: 'near' | 'med' (default) | 'far'.
 */
export class GlyphFlow extends ThreeVisualization {
  static id = 'glyph-flow';
  static label = 'Glyph Flow';
  static description = 'A stream of light parting around the drawing, so it shows as a hole outlined in fire; hits burst the stream outward.';
  static category = CATEGORY.GLYPHS;

  static inputs = {
    surge: { kind: 'event', default: TRIGGER.BASS },
    flow:  { kind: 'level', default: { intensity: 'rms', smooth: 1.5 } },
    swirl: { kind: 'level', default: { intensity: 'mid', smooth: 0.4 } },
    glow:  { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
      smooth: 0.1,
    } },
  };

  static options = {
    glyph: glyphOption({ width: 12, height: 12, value: EYE }),
    distance: { kind: 'enum', values: Object.keys(DISTANCES), default: 'med' },
    count: { kind: 'number', default: 24000, min: 4000, max: 60000, step: 1000 },
    palette: PALETTE_OPTION,
  };
  // The mosaic, wearing this one's default drawing.
  static fallback = mosaicOf(this.options.glyph);

  static SPAN = 8;             // the drawing's width in world units
  static SPEED = [1.6, 2.4];   // stream speed: [idle, added at full flow]
  static SWIRL = [0.6, 2.6];   // swirl strength: [idle, added at full swirl]
  static TRAIL = 0.3;          // streak length, in seconds of travel
  static LIFE = 14;            // s; a streak stuck against the drawing respawns
  static MEMORY = 1.6;         // s; how long a streak glows after skimming the drawing
  static VIEW = 16;            // camera distance at `med`
  static KICK_DECAY = 2.2;

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    this.psychedelic = isPsychedelic(this);
    this.glyph = readGlyph(this);
    this.rand = mulberry32(Math.floor(Math.random() * 1e9));
    this.buildField();

    const count = Math.max(1000, Math.min(60000, Math.round(Number(this.options.count ?? 24000)) || 24000));
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.age = new Float32Array(count);
    this.lane = new Float32Array(count);   // fixed per streak, for colour
    // How recently each streak skimmed the drawing, 0–1. It keeps the
    // colour for a while after, so the wakes trace the outline downstream.
    this.touch = new Float32Array(count);
    for (let i = 0; i < count; i++) this.spawn(i, true);

    // Each streak is one segment: head at the particle, tail behind it.
    this.lines = new Float32Array(count * 6);
    this.tones = new Float32Array(count * 4);   // (hue, brightness) at each end
    const shade = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) shade[i * 2] = 1;
    const geometry = new THREE.BufferGeometry();
    this.position = new THREE.BufferAttribute(this.lines, 3).setUsage(THREE.DynamicDrawUsage);
    this.tone = new THREE.BufferAttribute(this.tones, 2).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.position);
    geometry.setAttribute('tone', this.tone);
    geometry.setAttribute('shade', new THREE.BufferAttribute(shade, 1));

    this.uniforms = { ...paletteUniforms(THREE), uHue: { value: 0 }, uGlow: { value: 1 } };
    const lines = new THREE.LineSegments(geometry, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    lines.frustumCulled = false;
    this.scene.add(lines);

    const distance = this.options.distance ?? 'med';
    if (!(distance in DISTANCES)) console.warn(`GloamingKit: glyph-flow distance '${distance}'; expected ${Object.keys(DISTANCES).join('|')}`);
    this.view = GlyphFlow.VIEW * (DISTANCES[distance] ?? 1);
    this.camera.fov = 55;
    this.camera.near = 0.05;
    this.camera.far = 200;
    this.center = new THREE.Vector3();

    this.time = 0;
    this.speed = GlyphFlow.SPEED[0];
    this.kick = 0;
    this.hue = this.rand();
    this.swing = this.rand() * 10;
    this.sample = new Float32Array(CHANNELS);
  }

  /**
   * Splat every cell into the grid: a density bump shaped like the cell
   * (blurred, so neighbours merge), and a swirl about the flow axis that
   * reaches a little wider. The obstacle's surface normal is the density's
   * gradient, taken by central differences once everything is in.
   */
  buildField() {
    const { SPAN } = GlyphFlow;
    const { width, height, levels } = this.glyph;
    const cell = SPAN / Math.max(width, height);
    const field = new Float32Array(NX * NX * NZ * CHANNELS);
    const hx = (2 * BOX) / (NX - 1);
    const hz = (2 * DEEP) / (NZ - 1);
    const sigma = cell * 0.55;
    const sigmaZ = cell * 0.8;
    const sigmaV = cell * 1.1;
    const reach = sigmaV * 3;
    const idx = (i, j, k) => ((k * NX + j) * NX + i) * CHANNELS;

    for (const { x, y, level, weight } of this.glyph.filled()) {
      const cx = (x - (width - 1) / 2) * cell;
      const cy = -(y - (height - 1) / 2) * cell;
      const sense = level === levels ? 1 : -1;
      const i0 = Math.max(0, Math.floor((cx - reach + BOX) / hx));
      const i1 = Math.min(NX - 1, Math.ceil((cx + reach + BOX) / hx));
      const j0 = Math.max(0, Math.floor((cy - reach + BOX) / hx));
      const j1 = Math.min(NX - 1, Math.ceil((cy + reach + BOX) / hx));
      const k0 = Math.max(0, Math.floor((-reach + DEEP) / hz));
      const k1 = Math.min(NZ - 1, Math.ceil((reach + DEEP) / hz));
      for (let k = k0; k <= k1; k++) {
        const dz = k * hz - DEEP;
        for (let j = j0; j <= j1; j++) {
          const dy = j * hx - BOX - cy;
          for (let i = i0; i <= i1; i++) {
            const dx = i * hx - BOX - cx;
            const r2 = dx * dx + dy * dy;
            const n = idx(i, j, k);
            field[n] += (0.55 + 0.45 * weight)
              * Math.exp(-r2 / (2 * sigma * sigma) - (dz * dz) / (2 * sigmaZ * sigmaZ));
            // Swirl about z through the cell's centre, fading with distance
            // from it in every direction.
            const v = sense * weight * Math.exp(-(r2 + dz * dz) / (2 * sigmaV * sigmaV)) / sigmaV;
            field[n + 4] += -dy * v;
            field[n + 5] += dx * v;
          }
        }
      }
    }
    // Gradient of the density, pointing into the obstacle.
    for (let k = 0; k < NZ; k++) {
      for (let j = 0; j < NX; j++) {
        for (let i = 0; i < NX; i++) {
          const n = idx(i, j, k);
          const at = (a, b, c) => field[idx(
            Math.max(0, Math.min(NX - 1, a)), Math.max(0, Math.min(NX - 1, b)), Math.max(0, Math.min(NZ - 1, c)),
          )];
          field[n + 1] = (at(i + 1, j, k) - at(i - 1, j, k)) / (2 * hx);
          field[n + 2] = (at(i, j + 1, k) - at(i, j - 1, k)) / (2 * hx);
          field[n + 3] = (at(i, j, k + 1) - at(i, j, k - 1)) / (2 * hz);
        }
      }
    }
    this.field = field;
    this.hx = hx;
    this.hz = hz;
  }

  /** Trilinear sample of every channel at (x, y, z) into `this.sample`; false outside the grid. */
  lookup(x, y, z) {
    const s = this.sample;
    const fx = (x + BOX) / this.hx;
    const fy = (y + BOX) / this.hx;
    const fz = (z + DEEP) / this.hz;
    if (!(fx >= 0 && fy >= 0 && fz >= 0 && fx < NX - 1 && fy < NX - 1 && fz < NZ - 1)) {
      s.fill(0);
      return false;
    }
    const i = fx | 0;
    const j = fy | 0;
    const k = fz | 0;
    const tx = fx - i;
    const ty = fy - j;
    const tz = fz - k;
    const f = this.field;
    const row = NX * CHANNELS;
    const slab = NX * NX * CHANNELS;
    const base = ((k * NX + j) * NX + i) * CHANNELS;
    const w000 = (1 - tx) * (1 - ty) * (1 - tz);
    const w100 = tx * (1 - ty) * (1 - tz);
    const w010 = (1 - tx) * ty * (1 - tz);
    const w110 = tx * ty * (1 - tz);
    const w001 = (1 - tx) * (1 - ty) * tz;
    const w101 = tx * (1 - ty) * tz;
    const w011 = (1 - tx) * ty * tz;
    const w111 = tx * ty * tz;
    for (let c = 0; c < CHANNELS; c++) {
      const b = base + c;
      s[c] = f[b] * w000 + f[b + CHANNELS] * w100 + f[b + row] * w010 + f[b + row + CHANNELS] * w110
        + f[b + slab] * w001 + f[b + slab + CHANNELS] * w101
        + f[b + slab + row] * w011 + f[b + slab + row + CHANNELS] * w111;
    }
    return true;
  }

  /** Put streak `i` back at the upstream end (anywhere along, at the start). */
  spawn(i, anywhere = false) {
    const r = this.rand;
    const p = this.pos;
    p[i * 3] = (r() * 2 - 1) * BOX * 0.95;
    p[i * 3 + 1] = (r() * 2 - 1) * BOX * 0.95;
    p[i * 3 + 2] = anywhere ? (r() * 2 - 1) * DEEP : -DEEP;
    this.age[i] = anywhere ? r() * GlyphFlow.LIFE : 0;
    this.lane[i] = r();
    this.touch[i] = 0;
  }

  onInput(slot, data) {
    if (slot === 'surge') this.kick = Math.max(this.kick, impact(data));
  }

  draw(ctx, dt) {
    const { SPEED, SWIRL, TRAIL, LIFE, KICK_DECAY } = GlyphFlow;
    this.time += dt;
    this.kick *= Math.exp(-dt * KICK_DECAY);
    this.speed = approach(this.speed, SPEED[0] + this.in('flow') * SPEED[1], 0.8, dt);
    const U = this.speed * (1 + this.kick * 0.8);
    const swirl = SWIRL[0] + this.in('swirl') * SWIRL[1];
    // The obstacle's skin: below `soft` density the stream flows freely,
    // past `hard` it can't move inward at all. A hit lowers both, so the
    // obstacle inflates.
    const soft = 0.12 - this.kick * 0.08;
    const hard = 0.42 - this.kick * 0.2;
    this.hue += dt * (0.02 + this.in('swirl') * 0.04);

    const { pos, age, lane, touch, lines, tones, sample: s, count, time } = this;
    const fade = Math.exp(-dt / GlyphFlow.MEMORY);
    const h = Math.min(dt, 1 / 30);
    for (let i = 0; i < count; i++) {
      const a = i * 3;
      let x = pos[a];
      let y = pos[a + 1];
      let z = pos[a + 2];
      age[i] += dt;
      this.lookup(x, y, z);
      // Base flow down +z, with a slow wobble so the lanes aren't ruled.
      let vx = U * 0.12 * Math.sin(y * 0.35 + time * 0.4);
      let vy = U * 0.12 * Math.sin(x * 0.31 - time * 0.33);
      let vz = U;
      // Slide along the obstacle: take away whatever part of the velocity
      // points into it, fully past `hard`, and push out of it once inside.
      const g = Math.hypot(s[1], s[2], s[3]);
      let skin = 0;
      if (g > 1e-5) {
        skin = Math.min(1, Math.max(0, (s[0] - soft) / (hard - soft)));
        const nx = s[1] / g;
        const ny = s[2] / g;
        const nz = s[3] / g;
        const inward = vx * nx + vy * ny + vz * nz;
        if (inward > 0) {
          vx -= nx * inward * skin;
          vy -= ny * inward * skin;
          vz -= nz * inward * skin;
        }
        // Skimming the outline speeds a streak up, so the edges burn.
        const boost = 1 + skin * 0.7;
        vx *= boost;
        vy *= boost;
        vz *= boost;
        const out = Math.max(0, s[0] - hard) * U * 3;
        vx -= nx * out;
        vy -= ny * out;
        vz -= nz * out;
      }
      vx += s[4] * swirl;
      vy += s[5] * swirl;

      x += vx * h;
      y += vy * h;
      z += vz * h;
      if (z > DEEP || Math.abs(x) > BOX || Math.abs(y) > BOX || age[i] > LIFE || s[0] > hard * 2.5) {
        this.spawn(i);
        x = pos[a];
        y = pos[a + 1];
        z = pos[a + 2];
        vx = vy = vz = 0;
      }
      pos[a] = x;
      pos[a + 1] = y;
      pos[a + 2] = z;

      const l = i * 6;
      lines[l] = x;
      lines[l + 1] = y;
      lines[l + 2] = z;
      lines[l + 3] = x - vx * TRAIL;
      lines[l + 4] = y - vy * TRAIL;
      lines[l + 5] = z - vz * TRAIL;
      // Fade in and out at the ends of the stream; brighter when fast, and
      // brightest skimming the drawing.
      const ends = Math.min(1, (DEEP - Math.abs(z)) * 0.6);
      const speed = Math.hypot(vx, vy, vz) / U;
      touch[i] = Math.max(touch[i] * fade, skin);
      const bright = Math.max(0, ends) * (0.3 + 0.3 * speed + touch[i] * 1.4);
      // In the style palette, 0.75 is the line colour and 0.25 the accent:
      // the open stream runs in one and the wakes in the other.
      const hue = 0.75 - touch[i] * 0.5 + lane[i] * 0.12 + z * 0.01;
      const t = i * 4;
      tones[t] = hue;
      tones[t + 1] = bright;
      tones[t + 2] = hue;
      tones[t + 3] = bright;
    }
    this.position.needsUpdate = true;
    this.tone.needsUpdate = true;

    // Downstream, looking back into the current; swinging between face-on
    // and oblique.
    this.swing += dt * (0.05 + this.in('swirl') * 0.08);
    const yaw = Math.sin(this.swing) * 0.65;
    const pitch = Math.sin(this.swing * 0.61 + 1) * 0.3;
    const cam = this.camera;
    cam.position.set(
      Math.sin(yaw) * Math.cos(pitch) * this.view,
      Math.sin(pitch) * this.view,
      Math.cos(yaw) * Math.cos(pitch) * this.view,
    );
    cam.lookAt(this.center);
    if (cam.aspect !== this.width / this.height) {
      cam.aspect = this.width / this.height;
      cam.updateProjectionMatrix();
    }

    const u = this.uniforms;
    updatePalette(this, u);
    u.uHue.value = this.hue;
    u.uGlow.value = 0.55 + this.in('glow') * 0.8 + this.kick * 0.5;
    this.present(ctx);
  }
}

const VERTEX = /* glsl */ `
${PALETTE_GLSL}
attribute vec2 tone;    // (hue, brightness)
attribute float shade;  // 1 at the head, 0 at the tail

uniform float uHue;
uniform float uGlow;

varying vec3 vColor;

void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vColor = palette(tone.x + uHue) * tone.y * shade * uGlow * 1.2;
}
`;

const FRAGMENT = /* glsl */ `
varying vec3 vColor;

void main() {
  gl_FragColor = vec4(vColor, 1.0);
}
`;
