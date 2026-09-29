import { ThreeVisualization } from './three-base.js';
import { impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';
import { createNoise3D, fbm } from '../noise.js';
import {
  PALETTE_OPTION, PALETTE_GLSL, paletteUniforms, updatePalette, isPsychedelic, logSpectrum,
} from './three-shared.js';

const COLS = 128;   // across; the spectrum is mirrored about the centre line
const ROWS = 180;   // along; one per ROW_LENGTH of travel

/**
 * SpectrumTerrain — a low flight over a landscape made of the song's history.
 *
 * A new row of terrain is laid down at the horizon many times a second, its
 * profile taken from the spectrum at that instant, and the landscape scrolls
 * toward the camera — so the ground you pass over is what played a few
 * seconds ago, and the horizon is now. The spectrum is mirrored about the
 * flight line with the treble in the middle and the bass at the edges: a
 * valley floor that ripples with the hats, climbing through the mids into
 * canyon walls that heave with the low end, on top of noise ridges that keep
 * it a landscape even in silence. (Bass in the middle, the obvious layout,
 * puts the tallest peaks on the flight line and flies the camera into them.)
 *
 * Heights live in a float texture used as a ring buffer, one row per slot,
 * and the vertex shader reads its row by age — so laying down a row is one
 * small texture upload, not a geometry rebuild. The sky is left transparent
 * and the far rows fade out rather than into a fog colour, so a background
 * layer shows through as the sky.
 *
 * Reactions:
 *
 *   swell    how tall the spectrum stands — loudness, with the beat on top
 *   pulse    a hit sends a wave of light rolling out to the horizon
 *   sway     the camera banks and weaves; smoothed, so it glides
 *
 * Travel speed is constant, as in `road`: speed that tracks the audio makes
 * perspective motion stutter.
 */
export class SpectrumTerrain extends ThreeVisualization {
  static id = 'spectrum-terrain';
  static label = 'Spectrum Terrain';
  static description = 'Low flight over a landscape built from the spectrum as it played; hits roll waves of light to the horizon.';
  static category = CATEGORY.SPACES;
  static fallback = 'road';

  static inputs = {
    swell: { kind: 'level', default: {
      sum: [{ intensity: 'rms', gain: 0.6 }, { relative: 'rms', gain: 0.4 }],
    } },
    pulse: { kind: 'event', default: TRIGGER.BASS },
    sway:  { kind: 'level', default: { intensity: 'mid', smooth: 1.5 } },
  };

  static options = {
    palette: PALETTE_OPTION,
  };

  static SPEED = 11;          // world units per second
  static ROW_LENGTH = 0.32;   // world units between rows
  static COL_WIDTH = 0.17;   // narrow enough that the walls are in frame on a portrait screen
  static HEIGHT = 7.5;        // spectrum height at full scale
  // Spectrum level that reads as flat ground. The analyser's byte spectrum
  // rarely falls to zero — most bins idle around 0.4 — so without a floor
  // the whole landscape is a raised plateau instead of peaks and valleys.
  static FLOOR = 0.42;
  static MOUNTAINS = 7;       // noise ridge height at the edges
  static DECAY = 2.2;         // how fast a column falls after a peak, per second
  static WAVE_SPEED = 24;     // world units/s the hit waves roll outward

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    const { ROW_LENGTH, COL_WIDTH } = SpectrumTerrain;
    this.psychedelic = isPsychedelic(this);

    this.heights = new Float32Array(COLS * ROWS);
    this.texture = new THREE.DataTexture(this.heights, COLS, ROWS, THREE.RedFormat, THREE.FloatType);
    this.texture.needsUpdate = true;
    this.head = 0;        // slot of the newest row
    this.laid = 0;        // rows laid since the start: the newest row's absolute index
    this.travel = 0;      // distance since the newest row was laid, 0..ROW_LENGTH
    this.bins = new Float32Array(COLS / 2);
    this.peaks = new Float32Array(COLS / 2);   // fast attack, slow decay
    this.noise = createNoise3D(Math.floor(Math.random() * 1e6));
    this.hue = Math.random();
    this.swayT = 0;
    this.waves = [];      // { dist, strength }

    // Fill the landscape so the first frame isn't a flat plane rolling in.
    for (let i = 0; i < ROWS; i++) this.layRow();

    // One vertex per (column, row age); positions are all in the shader.
    const count = COLS * ROWS;
    const grid = new Float32Array(count * 2);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        grid[(r * COLS + c) * 2] = c;
        grid[(r * COLS + c) * 2 + 1] = r;
      }
    }
    const index = [];
    for (let r = 0; r < ROWS - 1; r++) {
      for (let c = 0; c < COLS - 1; c++) {
        const a = r * COLS + c;
        index.push(a, a + COLS, a + 1, a + 1, a + COLS, a + COLS + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('grid', new THREE.Float32BufferAttribute(grid, 2));
    // three.js wants a position attribute to size draws; the shader ignores it.
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setIndex(index);

    this.uniforms = {
      ...paletteUniforms(THREE),
      uHeights: { value: this.texture },
      uHead: { value: 0 },
      uLaid: { value: 0 },
      uTravel: { value: 0 },
      uCell: { value: new THREE.Vector2(COL_WIDTH, ROW_LENGTH) },
      uHue: { value: 0 },
      uFar: { value: (ROWS - 1) * ROW_LENGTH },
      uWaves: { value: Array.from({ length: 3 }, () => new THREE.Vector2(-1e3, 0)) },
    };
    const mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      side: THREE.DoubleSide,
    }));
    mesh.frustumCulled = false;
    this.scene.add(mesh);

    this.camera.fov = 62;
    this.camera.near = 0.1;
    this.camera.far = 200;
  }

  /** Lay down the newest row at the horizon, from the current spectrum. */
  layRow() {
    const { HEIGHT, FLOOR, MOUNTAINS, COL_WIDTH, ROW_LENGTH } = SpectrumTerrain;
    this.head = (this.head + 1) % ROWS;
    this.laid++;
    const swell = 0.35 + this.in('swell') * 0.9;
    const half = COLS / 2;
    const row = this.head * COLS;
    const z = this.laid * ROW_LENGTH;
    for (let c = 0; c < COLS; c++) {
      // 0 on the centre line, 1 at the edges; the bin that column shows.
      const u = Math.abs(c - (COLS - 1) / 2) / ((COLS - 1) / 2);
      const bin = Math.min(half - 1, Math.floor((1 - u) * half));
      const level = Math.max(0, (this.peaks[bin] - FLOOR) / (1 - FLOOR));
      // Kept low near the flight line, full height at the walls.
      const spectrum = Math.pow(level, 1.4) * HEIGHT * swell * (0.2 + 0.8 * u);
      // Ridges rise toward the edges and stay low along the flight line.
      const x = (c - half) * COL_WIDTH;
      const ridge = Math.max(0, fbm(this.noise, x * 0.14, z * 0.07, 0.5, { octaves: 4 }) * 0.6 + 0.45)
        * MOUNTAINS * Math.pow(u, 1.6);
      this.heights[row + c] = spectrum + ridge;
    }
    this.texture.needsUpdate = true;
  }

  onInput(slot, data) {
    if (slot !== 'pulse') return;
    this.waves.push({ dist: 0, strength: impact(data) });
    if (this.waves.length > 3) this.waves.shift();
  }

  draw(ctx, dt) {
    const { SPEED, ROW_LENGTH, DECAY, WAVE_SPEED } = SpectrumTerrain;

    // Track the spectrum continuously, so a row laid between frames still
    // gets a peak that landed in one: fast attack, slow decay, like eq-bars.
    logSpectrum(this.frame?.spectrum, this.bins);
    for (let i = 0; i < this.bins.length; i++) {
      this.peaks[i] = Math.max(this.bins[i], this.peaks[i] - dt * DECAY * 0.5);
    }

    this.travel += SPEED * dt;
    while (this.travel >= ROW_LENGTH) {
      this.travel -= ROW_LENGTH;
      this.layRow();
    }

    this.hue += dt * 0.03;
    this.swayT += dt * (0.25 + this.in('sway') * 0.5);
    const u = this.uniforms;
    for (let i = 0; i < 3; i++) {
      const w = this.waves[i];
      if (w) {
        w.dist += WAVE_SPEED * dt;
        w.strength *= Math.exp(-dt * 0.6);
        u.uWaves.value[i].set(w.dist, w.strength);
      } else {
        u.uWaves.value[i].set(-1e3, 0);
      }
    }
    this.waves = this.waves.filter((w) => w.dist < 80);

    updatePalette(this, u);
    u.uHead.value = this.head;
    u.uLaid.value = this.laid;
    u.uTravel.value = this.travel;
    u.uHue.value = this.hue;

    // Low over the canyon floor, weaving and banking into the weave.
    const cam = this.camera;
    const weave = Math.sin(this.swayT) * 1.6;
    cam.position.set(weave, 3.6 + Math.sin(this.swayT * 0.7) * 0.5, 0);
    cam.up.set(Math.sin(this.swayT + 0.6) * 0.18, 1, 0).normalize();
    cam.lookAt(weave * 0.4, 1.6, -30);
    if (cam.aspect !== this.width / this.height) {
      cam.aspect = this.width / this.height;
      cam.updateProjectionMatrix();
    }
    this.present(ctx);
  }

  dispose() {
    super.dispose();
    this.texture.dispose();
  }
}

const VERTEX = /* glsl */ `
attribute vec2 grid;   // (column, row age: 0 = newest, at the horizon)

uniform sampler2D uHeights;
uniform float uHead;
uniform float uLaid;
uniform float uTravel;
uniform vec2 uCell;

varying vec2 vGrid;    // (column, absolute row), for the grid lines
varying float vHeight;
varying float vDist;   // distance ahead of the camera
varying vec3 vNormal;

const float COLS = ${COLS}.0;
const float ROWS = ${ROWS}.0;

float heightAt(float col, float age) {
  col = clamp(col, 0.0, COLS - 1.0);
  age = clamp(age, 0.0, ROWS - 1.0);
  float slot = mod(uHead - age + ROWS, ROWS);
  return texelFetch(uHeights, ivec2(int(col), int(slot)), 0).r;
}

void main() {
  float col = grid.x;
  float age = grid.y;
  float h = heightAt(col, age);

  // The newest row sits at the far end; each older one a row nearer, and
  // everything slides toward the camera by the travel since the last row.
  float z = -(ROWS - 1.0 - age) * uCell.y + uTravel + 1.5;
  float x = (col - (COLS - 1.0) * 0.5) * uCell.x;
  vec3 pos = vec3(x, h, z);

  float dhdx = (heightAt(col + 1.0, age) - heightAt(col - 1.0, age)) / (2.0 * uCell.x);
  // Age grows toward the camera, which is +z.
  float dhdz = (heightAt(col, age + 1.0) - heightAt(col, age - 1.0)) / (2.0 * uCell.y);
  vNormal = normalize(vec3(-dhdx, 1.0, -dhdz));

  vGrid = vec2(col, uLaid - age);
  vHeight = h;
  vDist = -z;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
${PALETTE_GLSL}
uniform float uHue;
uniform float uFar;       // distance to the horizon row
uniform vec2 uWaves[3];   // (distance ahead, strength)

varying vec2 vGrid;
varying float vHeight;
varying float vDist;
varying vec3 vNormal;

// 1 on a grid line, 0 between; fwidth keeps lines ~1px at any distance.
float gridLine(vec2 g) {
  vec2 d = abs(fract(g - 0.5) - 0.5) / fwidth(g);
  return 1.0 - clamp(min(d.x, d.y) - 0.5, 0.0, 1.0);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 lightDir = normalize(vec3(-0.35, 0.75, -0.55));   // low sun at the horizon
  float diffuse = max(dot(n, lightDir), 0.0);

  float t = vHeight * 0.12 + vGrid.y * 0.004 + uHue;
  vec3 surface = palette(t) * (0.08 + 0.55 * diffuse);

  // Every other row and column, so the grid doesn't moiré at the horizon.
  float line = gridLine(vGrid * 0.5);
  float wave = 0.0;
  for (int k = 0; k < 3; k++) {
    wave += exp(-abs(vDist - uWaves[k].x) * 0.35) * uWaves[k].y;
  }
  vec3 lines = palette(t + 0.35) * (1.2 + wave * 2.5);
  vec3 col = mix(surface + palette(t + 0.35) * wave * 0.35, lines, line);

  // Fade to transparent toward the horizon rather than into a fog colour, so
  // whatever is beneath shows through as the sky.
  float alpha = 1.0 - smoothstep(uFar * 0.65, uFar * 0.98, vDist);
  gl_FragColor = vec4(col, alpha);
}
`;
