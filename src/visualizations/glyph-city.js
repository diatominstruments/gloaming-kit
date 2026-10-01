import { ThreeVisualization } from './three-base.js';
import { approach, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { LAYER } from './layers.js';
import { TRIGGER } from '../analyzer.js';
import {
  PALETTE_OPTION, PALETTE_GLSL, paletteUniforms, updatePalette, isPsychedelic,
  FULLSCREEN_VERTEX, logSpectrum,
} from './three-shared.js';
import { mosaicOf } from './glyph-mosaic.js';
import { glyphOption, readGlyph, INVADER, MAX_SIZE } from './glyph.js';

const PULSES = 3;
const TWISTS = { off: 0, low: 0.012, med: 0.028, high: 0.055 };
const SPEEDS = { slow: 0.5, med: 1, fast: 1.8 };

/**
 * GlyphCity — flight between two endless cities laid out from the drawing.
 *
 * The drawing is a district plan: every filled cell is a tower, black ones
 * tall and grey ones low, and the plan tiles to the horizon, every other
 * tile mirrored so the city has no seams. A second city hangs upside down
 * overhead, offset so its towers fall between the ones below, and the camera
 * weaves down the gap between them.
 *
 * Each column of the drawing is a band of the spectrum, so every street of
 * towers rises and falls with its part of the mix — the city is an
 * equalizer the size of the world. Tower edges are lit, and the ground is
 * ruled with glowing streets.
 *
 * Like fractal-cathedral, it is one full-screen ray-marched shader, drawn in
 * the background layer at half resolution.
 *
 * Reactions:
 *
 *   pulse    a hit rolls a wave of light down the streets ahead, lifting the
 *            towers it passes
 *   twist    how far space corkscrews about the flight path, so the floor
 *            and ceiling wind round each other ahead and unwind as you
 *            reach them; the `twist` option sets its range
 *   shimmer  tower edge and street glow
 *   travel   flight speed within the `speed` setting, heavily smoothed
 *
 * Options: `twist` ('off' | 'low' | 'med' (default) | 'high'), `speed`
 * ('slow' | 'med' (default) | 'fast'), `palette`.
 */
export class GlyphCity extends ThreeVisualization {
  static id = 'glyph-city';
  static label = 'Glyph City';
  static description = 'Flight between two endless cities laid out from the drawing, each street of towers an equalizer band; hits roll light down the streets.';
  static category = CATEGORY.GLYPHS;
  static layer = LAYER.BACKGROUND;

  static inputs = {
    pulse:   { kind: 'event', default: TRIGGER.BASS },
    twist:   { kind: 'level', default: { intensity: 'mid', smooth: 0.6 } },
    shimmer: { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
      smooth: 0.12,
    } },
    travel:  { kind: 'level', default: { intensity: 'rms', smooth: 2 } },
  };

  static options = {
    glyph: glyphOption({ width: 12, height: 12, value: INVADER }),
    twist: { kind: 'enum', values: Object.keys(TWISTS), default: 'med' },
    speed: { kind: 'enum', values: Object.keys(SPEEDS), default: 'med' },
    palette: PALETTE_OPTION,
  };
  // The mosaic, wearing this one's default drawing.
  static fallback = mosaicOf(this.options.glyph);

  static RESOLUTION = 0.5;

  static SPEED = [2.2, 2.8];     // cells/s: [idle, added at full travel]
  static HEIGHT = 2.6;           // a black tower's height at a mid band, cells
  static TWIST_RATE = [0.08, 0.35];   // twist cycle: [idle, added at full twist]
  static PULSE_SPEED = 9;        // cells/s
  static PULSE_DECAY = 0.8;
  static BAND_TAU = 0.12;        // s; smoothing on each street's band

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    this.psychedelic = isPsychedelic(this);
    this.glyph = readGlyph(this);
    const pick = (name, table) => {
      const value = this.options[name] ?? GlyphCity.options[name].default;
      if (!(value in table)) console.warn(`GloamingKit: glyph-city ${name} '${value}'; expected ${Object.keys(table).join('|')}`);
      return table[value] ?? table[GlyphCity.options[name].default];
    };
    this.twistAmount = pick('twist', TWISTS);
    this.pace = pick('speed', SPEEDS);

    const { width, height, cells, levels } = this.glyph;
    const data = new Float32Array(width * height);
    for (let i = 0; i < data.length; i++) data[i] = cells[i] / levels;
    this.texture = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.FloatType);
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;

    this.bands = new Float32Array(width);
    this.raw = new Float32Array(width);

    this.uniforms = {
      ...paletteUniforms(THREE),
      uGlyph: { value: this.texture },
      uSize: { value: new THREE.Vector2(width, height) },
      uBands: { value: new Float32Array(MAX_SIZE) },
      uAspect: { value: 1 },
      uZ: { value: 0 },
      uTwist: { value: 0 },
      uRoll: { value: 0 },
      uHue: { value: 0 },
      uShimmer: { value: 0 },
      uHeight: { value: GlyphCity.HEIGHT },
      uPulses: { value: Array.from({ length: PULSES }, () => new THREE.Vector2(-1e3, 0)) },
    };
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: FRAGMENT,
        depthTest: false,
        depthWrite: false,
      }),
    );
    quad.frustumCulled = false;
    this.scene.add(quad);

    this.z = Math.random() * 100;
    this.speed = GlyphCity.SPEED[0] * this.pace;
    this.twistPhase = Math.random() * 10;
    this.hue = Math.random();
    this.pulses = [];   // { age, strength }
  }

  onInput(slot, data) {
    if (slot !== 'pulse') return;
    this.pulses.push({ age: 0, strength: impact(data) });
    if (this.pulses.length > PULSES) this.pulses.shift();
  }

  draw(ctx, dt) {
    const { SPEED, TWIST_RATE, PULSE_SPEED, PULSE_DECAY, BAND_TAU } = GlyphCity;
    this.speed = approach(this.speed, (SPEED[0] + this.in('travel') * SPEED[1]) * this.pace, 1, dt);
    this.z += this.speed * dt;
    this.twistPhase += dt * (TWIST_RATE[0] + this.in('twist') * TWIST_RATE[1]);
    const shimmer = this.in('shimmer');
    this.hue += dt * (0.015 + shimmer * 0.05);

    // Each column of the drawing follows its own band of the spectrum.
    logSpectrum(this.frame?.spectrum, this.raw);
    for (let i = 0; i < this.bands.length; i++) {
      this.bands[i] = approach(this.bands[i], this.raw[i], BAND_TAU, dt);
    }

    const u = this.uniforms;
    for (let i = 0; i < PULSES; i++) {
      const p = this.pulses[i];
      if (p) {
        p.age += dt;
        u.uPulses.value[i].set(this.z + 2 + p.age * PULSE_SPEED, p.strength * Math.exp(-p.age * PULSE_DECAY));
      } else {
        u.uPulses.value[i].set(-1e3, 0);
      }
    }
    this.pulses = this.pulses.filter((p) => p.age < 6);

    updatePalette(this, u);
    u.uBands.value.set(this.bands);
    u.uAspect.value = this.width / this.height;
    u.uZ.value = this.z;
    u.uTwist.value = this.twistAmount * Math.sin(this.twistPhase);
    u.uRoll.value = Math.sin(this.twistPhase * 0.37) * 0.25;
    u.uHue.value = this.hue;
    u.uShimmer.value = shimmer;
    this.present(ctx);
  }

  dispose() {
    super.dispose();
    this.texture.dispose();
  }
}

const FRAGMENT = /* glsl */ `
${PALETTE_GLSL}
uniform sampler2D uGlyph;   // strength 0–1 per cell, top row first
uniform vec2 uSize;
uniform float uBands[${MAX_SIZE}];
uniform float uAspect;
uniform float uZ;
uniform float uTwist;   // corkscrew, radians per cell ahead of the camera
uniform float uRoll;
uniform float uHue;
uniform float uShimmer;
uniform float uHeight;
uniform vec2 uPulses[${PULSES}];   // (z, strength)

varying vec2 vUv;

const float MID = 4.0;          // flight height; the upper city's ground is at 2·MID
const float HALF = 0.36;        // tower half-width; streets take the rest of a cell
const float HMAX = MID - 0.7;   // towers stop short of the flight path
const float CLEAR = 2.0 * MID - HMAX - MID;   // gap from the midplane to the upper towers
const int STEPS = 100;
const float FAR = 70.0;

// The flight path weaves across the streets on two slow wobbles.
float pathX(float z) {
  return sin(z * 0.045) * 3.0 + sin(z * 0.017) * 5.0;
}

mat2 rot(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, s, -s, c);
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

// (strength, column) of the drawing at a cell of the endless plan. Tiles
// alternate mirrored, so neighbouring tiles meet without a seam.
vec2 cellAt(vec2 id) {
  vec2 t = floor(id / uSize);
  vec2 g = id - t * uSize;
  if (mod(t.x, 2.0) > 0.5) g.x = uSize.x - 1.0 - g.x;
  if (mod(t.y, 2.0) > 0.5) g.y = uSize.y - 1.0 - g.y;
  return vec2(texelFetch(uGlyph, ivec2(g), 0).r, g.x);
}

float gWorldZ;   // the sample's z before any offset, for the light pulses

float pulseAt(float z) {
  float s = 0.0;
  for (int k = 0; k < ${PULSES}; k++) s += exp(-abs(z - uPulses[k].x) * 0.9) * uPulses[k].y;
  return s;
}

// What the last city() call found nearest: the tower's cell and strength,
// the sample relative to the tower's centre, and its half-extents. kind is
// 1 for a tower and 0 for the ground.
vec4 gInfo;
vec3 gLocal;
vec3 gExt;
float gKind;

// One city, with p.y the height above its ground. Exact within the 3×3
// cells around the sample; anything farther is at least 1.5 - HALF away.
float city(vec3 p) {
  if (p.y > HMAX + 1.0) {
    gKind = -1.0;
    return p.y - HMAX;
  }
  vec2 id = floor(p.xz);
  vec2 f = p.xz - id - 0.5;
  float d = 1.5 - HALF;
  gKind = -1.0;
  float lift = 1.0 + 0.6 * pulseAt(gWorldZ);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cid = id + vec2(i, j);
      // Negated so the drawing reads upright looking down the flight path.
      vec2 c = cellAt(-cid - 1.0);
      if (c.x <= 0.0) continue;
      float h = min(HMAX, c.x * uHeight * (0.45 + uBands[int(c.y)]) * lift);
      vec3 b = vec3(f.x - float(i), p.y - h * 0.5, f.y - float(j));
      vec3 ext = vec3(HALF, h * 0.5, HALF);
      vec3 q = abs(b) - ext + 0.04;
      float bd = length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - 0.04;
      if (bd < d) {
        d = bd;
        gInfo = vec4(cid, c.x, c.y);
        gLocal = b;
        gExt = ext;
        gKind = 1.0;
      }
    }
  }
  if (p.y < d) {
    d = p.y;
    gInfo = vec4(id, 0.0, 0.0);
    gLocal = vec3(f.x, 0.0, f.y);
    gKind = 0.0;
  }
  return d;
}

float gSide;   // 0 the city below, 1 the one above

float map(vec3 p) {
  gWorldZ = p.z;
  float px = pathX(p.z);
  // Corkscrew about the flight path, more the farther ahead: the two cities
  // wind round each other in the distance and unwind as you reach them.
  vec2 a = rot(uTwist * (p.z - uZ) + uRoll) * vec2(p.x - px, p.y - MID);
  // Only the city on this side of the midplane can be near; the other is at
  // least its clearance plus the distance to the midplane away.
  if (a.y < 0.0) {
    gSide = 0.0;
    return min(city(vec3(a.x + px, MID + a.y, p.z)), CLEAR - a.y);
  }
  gSide = 1.0;
  // Upside down, and offset half a plan so its towers fall between ours.
  vec3 q = vec3(a.x + px + uSize.x * 0.5, MID - a.y, p.z + uSize.y * 0.5 + 3.0);
  return min(city(q), CLEAR + a.y);
}

vec3 normalAt(vec3 p) {
  const vec2 e = vec2(0.002, -0.002);
  return normalize(
    e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) +
    e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx)
  );
}

void main() {
  vec2 uv = (vUv * 2.0 - 1.0) * vec2(uAspect, 1.0);

  vec3 ro = vec3(pathX(uZ), MID, uZ);
  vec3 ta = vec3(pathX(uZ + 3.0), MID, uZ + 3.0);
  vec3 fw = normalize(ta - ro);
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  vec3 rd = normalize(fw * 1.2 + uv.x * rt + uv.y * up);

  float t = 0.05;
  float haze = 0.0;
  bool hit = false;
  for (int i = 0; i < STEPS; i++) {
    float d = map(ro + rd * t);
    haze += exp(-d * 10.0);
    if (d < 0.0008 * t + 0.0005) { hit = true; break; }
    // Under-stepped: the corkscrew stretches the distance field.
    t += d * 0.7;
    if (t > FAR) break;
  }
  t = min(t, FAR);

  vec3 p = ro + rd * t;
  vec3 col = vec3(0.0);
  if (hit) {
    vec4 info = gInfo;
    vec3 local = gLocal;
    vec3 ext = gExt;
    float kind = gKind;
    float side = gSide;
    vec3 n = normalAt(p);
    float facing = max(dot(n, -rd), 0.0);
    float light = 1.8 / (1.0 + t * t * 0.012);
    float lit = pulseAt(p.z);

    if (kind > 0.5) {
      vec3 base = palette(hash(info.xy) * 0.25 + info.z * 0.35 + uHue + side * 0.5 + p.z * 0.004);
      col = base * (0.06 + 0.8 * facing * facing) * light;
      // Glowing edges: near an edge, two of the three distances to the
      // box's faces are small at once.
      vec3 r = ext - abs(local);
      float lo = min(r.x, min(r.y, r.z));
      float hi = max(r.x, max(r.y, r.z));
      float mid = r.x + r.y + r.z - lo - hi;
      float edge = exp(-mid * 30.0);
      col += palette(uHue + 0.5 + info.w / uSize.x * 0.5) * edge * (0.5 + uShimmer * 1.5) * light;
      // Neon floors: bands up the facades, brighter where the pulse passes.
      float band = smoothstep(0.38, 0.5, abs(fract(local.y * 2.2) - 0.5)) * (1.0 - abs(n.y));
      col += base * band * (0.15 + lit * 1.5) * light;
    } else {
      // Ground: dark, ruled with glowing streets along the cell edges.
      vec2 f = local.xz;
      float street = 0.5 - max(abs(f.x), abs(f.y));
      col = palette(uHue + 0.25 + side * 0.5) * (0.03 + exp(-street * 40.0) * (0.35 + uShimmer)) * light;
      col *= 1.0 + lit * 2.0;
    }
  }

  // Rings of light rolling ahead: they light whatever the ray reaches near them.
  for (int k = 0; k < ${PULSES}; k++) {
    float ring = exp(-abs(p.z - uPulses[k].x) * 1.2) * uPulses[k].y;
    col += palette(uHue + 0.5 + float(k) * 0.13) * ring * (hit ? 0.5 : 0.15);
  }
  col += palette(uHue + t * 0.015 + 0.2) * haze * 0.006 * (0.4 + uShimmer);

  col = mix(col, uBg, 1.0 - exp(-t * 0.045));
  gl_FragColor = vec4(col, 1.0);
}
`;
