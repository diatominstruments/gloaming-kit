import { ThreeVisualization } from './three-base.js';
import { approach, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { LAYER } from './layers.js';
import { TRIGGER } from '../analyzer.js';
import {
  PALETTE_OPTION, PALETTE_GLSL, paletteUniforms, updatePalette, isPsychedelic, FULLSCREEN_VERTEX,
} from './three-shared.js';

const PULSES = 3;

// Named presets for `speed` and `deformAmount`, which are numbers now; the
// names are still accepted so configs written before stay valid.
const SPEEDS = { slow: 0.3, med: 0.55, fast: 1 };
const DEFORMS = ['twist', 'ripple', 'breathe'];
const AMOUNTS = { off: 0, low: 0.5, med: 1, high: 1.8 };

/**
 * FractalCathedral — a flight down a nave carved through an endless fractal.
 *
 * The world is an infinite Menger sponge — a cube lattice with cross-shaped
 * holes cut through it at every scale — ray-marched per pixel, with a
 * winding tunnel subtracted from it along the flight path so the camera never
 * hits a wall. What you see is arches opening onto arches, down to the limit
 * of the render.
 *
 * Nothing here is geometry: the whole scene is one full-screen fragment
 * shader, which is why it can be infinite and why it costs per pixel rather
 * than per object. RESOLUTION renders it at half size by default.
 *
 * Reactions:
 *
 *   pulse    a hit fires a ring of light down the nave ahead of the camera,
 *            and kicks the deformation
 *   warp     how deformed the walls are. Bass by default; bind it to any
 *            band to have that part of the mix bend the architecture:
 *            `bind: { warp: { intensity: 'treble' } }`
 *   morph    how fast the deformation cycles, so the arches slowly writhe
 *   shimmer  the haze of light the rays pick up grazing the walls, and how
 *            fast the colours cycle
 *   travel   flight speed within the `speed` setting, heavily smoothed —
 *            speed that follows the beat lurches, so the song sets the pace
 *            of a passage instead
 *
 * Options:
 *
 *   speed         'slow' | 'med' (default) | 'fast'
 *   deform        how the walls deform:
 *                   'twist'   (default) each cell turns about its own centre,
 *                             so arches wring and lean
 *                   'ripple'  space itself undulates, so walls flow like
 *                             liquid
 *                   'breathe' the holes at every scale open and close out of
 *                             phase, so walls thin to lace and thicken again
 *   deformAmount  'off' | 'low' | 'med' (default) | 'high'
 *
 * Deformations act on each cell about its own centre, never the world's
 * origin; rotating about the origin would swing distant cells through huge
 * arcs. The nave is carved after deforming, so the flight path stays clear
 * however hard the walls move.
 */
export class FractalCathedral extends ThreeVisualization {
  static id = 'fractal-cathedral';
  static label = 'Fractal Cathedral';
  static description = 'Flight down a nave carved through an endless fractal; hits fire rings of light ahead and twist the arches.';
  static category = CATEGORY.SPACES;
  static layer = LAYER.BACKGROUND;
  static fallback = 'perlin-glow';

  static inputs = {
    pulse:   { kind: 'event', default: TRIGGER.BASS },
    morph:   { kind: 'level', default: { intensity: 'mid', smooth: 0.5 } },
    shimmer: { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
      smooth: 0.15,
    } },
    travel:  { kind: 'level', default: { intensity: 'rms', smooth: 2 } },
    // How loud the bass is, with its movement on top so the walls flex on
    // the beat and not only across a passage.
    warp:    { kind: 'level', default: {
      sum: [{ intensity: 'bass', gain: 0.5 }, { relative: 'bass', gain: 0.5 }],
      smooth: 0.15,
    } },
  };

  static options = {
    palette: PALETTE_OPTION,
    speed: { kind: 'number', default: SPEEDS.med, min: 0.1, max: 1.5, step: 0.05 },
    deform: { kind: 'enum', values: DEFORMS, default: 'twist' },
    deformAmount: { kind: 'number', default: AMOUNTS.med, min: 0, max: 2.5, step: 0.1 },
  };

  // Every pixel marches up to ~100 steps through the fractal, so this is the
  // one to render small. Upscaled, the softness reads as atmosphere.
  static RESOLUTION = 0.5;

  // At 'fast'; the other speeds scale it (see SPEEDS).
  static SPEED = [0.7, 1.1];      // world units/s: [idle, added at full travel]
  // Deformation at 'med' amount, per unit of the warp mix below: the twist's
  // angle in radians, the ripple's amplitude and the breathing's depth.
  static TWIST = 0.3;
  static RIPPLE = 0.35;
  static BREATHE = 0.55;
  static WARP = [0.25, 0.9];      // deformation mix: [idle, added at full warp]
  static FOLD_RATE = [0.12, 0.5]; // cycle speed: [idle, added at full morph]
  static JOLT = 0.18;             // twist kick at full strength, rad
  static JOLT_DECAY = 1.4;
  static PULSE_SPEED = 7;         // world units/s the light rings travel ahead
  static PULSE_DECAY = 0.9;

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    this.psychedelic = isPsychedelic(this);
    // A preset name (the old enum values) or a number.
    const preset = (name, table) => (
      typeof this.options[name] === 'string' && this.options[name] in table
        ? table[this.options[name]]
        : this.option(name));
    this.pace = preset('speed', SPEEDS);
    this.amount = preset('deformAmount', AMOUNTS);
    this.deform = this.option('deform');

    this.z = 0;
    this.speed = FractalCathedral.SPEED[0] * this.pace;
    this.time = 0;
    this.kick = 0;
    this.foldT = Math.random() * 10;
    this.jolt = 0;
    this.hue = Math.random();
    this.roll = 0;
    this.pulses = [];   // { age, strength }

    this.uniforms = {
      ...paletteUniforms(THREE),
      uAspect: { value: 1 },
      uZ: { value: 0 },
      uRoll: { value: 0 },
      uFold: { value: 0 },
      uWarp: { value: 0 },
      uTime: { value: 0 },
      uStep: { value: 0.75 },
      uHue: { value: 0 },
      uHaze: { value: 0.3 },
      uPulses: { value: Array.from({ length: PULSES }, () => new THREE.Vector2(-1e3, 0)) },
    };
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: FRAGMENT,
        // Compiled in, not branched on: the map runs millions of times a frame.
        defines: { DEFORM: DEFORMS.indexOf(this.deform) },
        depthTest: false,
        depthWrite: false,
      }),
    );
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  onInput(slot, data) {
    if (slot !== 'pulse') return;
    const size = impact(data);
    const JOLT = FractalCathedral.JOLT * this.amount;
    this.jolt = Math.max(-JOLT, Math.min(JOLT, this.jolt + (Math.random() < 0.5 ? -1 : 1) * size * JOLT));
    this.kick = Math.max(this.kick, size);
    this.pulses.push({ age: 0, strength: size });
    if (this.pulses.length > PULSES) this.pulses.shift();
  }

  draw(ctx, dt) {
    const {
      SPEED, TWIST, RIPPLE, BREATHE, WARP, FOLD_RATE, JOLT_DECAY, PULSE_SPEED, PULSE_DECAY,
    } = FractalCathedral;

    // Rates, integrated — see "Drive rates, not positions" in the README.
    this.speed = approach(this.speed, (SPEED[0] + this.in('travel') * SPEED[1]) * this.pace, 1, dt);
    this.z += this.speed * dt;
    this.time += dt;
    this.foldT += dt * (FOLD_RATE[0] + this.in('morph') * FOLD_RATE[1]);
    this.jolt *= Math.exp(-dt * JOLT_DECAY);
    this.kick *= Math.exp(-dt * 2.5);
    this.hue += dt * (0.02 + this.in('shimmer') * 0.08);
    this.roll = Math.sin(this.foldT * 0.7) * 0.35;

    const u = this.uniforms;
    for (let i = 0; i < PULSES; i++) {
      const p = this.pulses[i];
      if (p) {
        p.age += dt;
        u.uPulses.value[i].set(this.z + 1 + p.age * PULSE_SPEED, p.strength * Math.exp(-p.age * PULSE_DECAY));
      } else {
        u.uPulses.value[i].set(-1e3, 0);
      }
    }
    this.pulses = this.pulses.filter((p) => p.age < 5);

    updatePalette(this, u);
    u.uAspect.value = this.width / this.height;
    u.uZ.value = this.z;
    u.uRoll.value = this.roll;
    // Deformation depth: the option's amount, scaled by the warp band.
    const warp = this.amount * (WARP[0] + this.in('warp') * WARP[1]);
    u.uFold.value = Math.sin(this.foldT) * TWIST * warp + this.jolt;
    u.uWarp.value = this.deform === 'ripple'
      ? (warp + this.kick * 0.6 * this.amount) * RIPPLE
      : (warp + this.kick * 0.6 * this.amount) * BREATHE;
    u.uTime.value = this.foldT * 4;
    // Ripples bend the distance field, so march in shorter steps to match.
    u.uStep.value = this.deform === 'ripple' ? 0.75 / (1 + u.uWarp.value * 1.2) : 0.75;
    u.uHue.value = this.hue;
    u.uHaze.value = 0.25 + this.in('shimmer') * 0.9;
    this.present(ctx);
  }
}

const FRAGMENT = /* glsl */ `
${PALETTE_GLSL}
uniform float uAspect;
uniform float uZ;
uniform float uRoll;
uniform float uFold;   // twist angle
uniform float uWarp;   // ripple amplitude / breathing depth
uniform float uTime;   // deformation clock, driven by morph
uniform float uStep;   // march step, as a fraction of the distance
uniform float uHue;
uniform float uHaze;
uniform vec2 uPulses[${PULSES}];   // (world z, strength)

varying vec2 vUv;

const float CELL = 0.42;      // lattice scale: cells are 2 / CELL world units
// The sponge's largest holes are straight square tunnels through every cell
// centre, 1/3 of a cell wide. The flight path runs down one; the nave carved
// around it is only a safety margin for when the fold twist leans a wall in.
const float NAVE = 0.42;
const int STEPS = 96;
const float FAR = 32.0;

// The flight path: down the tunnel at x = y = 1 / CELL, wandering within it
// on two incommensurate wobbles per axis so it never repeats.
vec2 path(float z) {
  return vec2(1.0 / CELL) + vec2(
    sin(z * 0.21) * 0.18 + sin(z * 0.077) * 0.12,
    cos(z * 0.17) * 0.15 + sin(z * 0.063) * 0.12
  );
}

mat2 rot(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, s, -s, c);
}

float trap;   // which scale a hit landed on, for colouring; set by map()

float map(vec3 p) {
  // Infinite Menger sponge: starting from solid space, cut the cross-shaped
  // hole of every cell at each scale (iq's construction, without the
  // bounding box), deformed per DEFORM.
  vec3 q = p * CELL;
#if DEFORM == 1
  // Ripple: displace the space the sponge is built in. Three crossed waves,
  // each along a different axis, so no wall stays flat.
  q += sin(q.zxy * 2.1 + vec3(uTime, uTime * 0.8, uTime * 1.2)) * uWarp * CELL;
#endif
  float d = -1e9;
  float s = 1.0;
  trap = 0.0;
  for (int m = 0; m < 4; m++) {
    vec3 a = mod(q * s, 2.0) - 1.0;
    float k = float(m + 1);
#if DEFORM == 0
    // Twist each cell about its own centre. The first scale only turns about
    // the flight axis, which spins the tunnel around the camera without
    // leaning its walls into the path.
    a.xy *= rot(uFold * k);
    if (m > 0) a.yz *= rot(uFold * 0.6 * k);
    float hole = 1.0;
#elif DEFORM == 2
    // Breathe: each scale's holes open and close on their own phase.
    float hole = clamp(1.0 + uWarp * sin(uTime * 1.3 + k * 1.9), 0.3, 2.2);
#else
    float hole = 1.0;
#endif
    s *= 3.0;
    vec3 r = abs(1.0 - 3.0 * abs(a));
    float da = max(r.x, r.y);
    float db = max(r.y, r.z);
    float dc = max(r.z, r.x);
    float c = (min(da, min(db, dc)) - hole) / s;
    if (c > d) {
      d = c;
      trap = float(m) * 0.23 + length(a) * 0.12;
    }
  }
  d /= CELL;
  // Subtract the nave: nothing solid within NAVE of the path.
  float nave = NAVE - length(p.xy - path(p.z));
  return max(d, nave);
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

  // Camera on the path, looking a little way along it, rolled.
  vec3 ro = vec3(path(uZ), uZ);
  vec3 ta = vec3(path(uZ + 2.5), uZ + 2.5);
  vec3 fw = normalize(ta - ro);
  vec3 rt = normalize(cross(fw, vec3(sin(uRoll), cos(uRoll), 0.0)));
  vec3 up = cross(rt, fw);
  vec3 rd = normalize(fw * 1.25 + uv.x * rt + uv.y * up);

  float t = 0.05;
  float haze = 0.0;
  float steps = 0.0;
  bool hit = false;
  for (int i = 0; i < STEPS; i++) {
    float d = map(ro + rd * t);
    // Light picked up passing close to a surface: the glowing air.
    haze += exp(-d * 14.0);
    if (d < 0.0006 * t + 0.0004) { hit = true; break; }
    t += d * uStep;   // under-step: deformation bends the distance field
    steps += 1.0;
    if (t > FAR) break;
  }
  t = min(t, FAR);

  vec3 col = vec3(0.0);
  vec3 p = ro + rd * t;
  if (hit) {
    float tr = trap;   // normalAt() overwrites it
    vec3 n = normalAt(p);
    float facing = max(dot(n, -rd), 0.0);
    float ao = 1.0 - steps / float(STEPS);
    // A headlight: near walls lit, far ones falling into shadow, which is
    // most of what makes the depth read.
    float light = 1.6 / (1.0 + t * t * 0.06);
    vec3 base = palette(tr + uHue + p.z * 0.015);
    col = base * (0.06 + facing * facing) * ao * light;
    // Iridescent rim where surfaces turn away.
    col += palette(tr + uHue + 0.45) * pow(1.0 - facing, 4.0) * 0.6 * ao * light;
  }

  // Rings of light travelling down the nave: they light whatever the ray
  // reaches near their depth.
  for (int k = 0; k < ${PULSES}; k++) {
    float ring = exp(-abs(p.z - uPulses[k].x) * 1.3) * uPulses[k].y;
    // A ring from a hard hit burns toward the peak colour.
    col += peak(palette(uHue + 0.5 + float(k) * 0.13), uPulses[k].y) * ring * (hit ? 1.6 : 0.4);
  }

  col += palette(uHue + t * 0.02 + 0.2) * haze * 0.012 * uHaze;

  // Fog into the background colour, so the far end of the nave dissolves.
  col = mix(col, uBg, 1.0 - exp(-t * 0.085));
  gl_FragColor = vec4(col, 1.0);
}
`;
