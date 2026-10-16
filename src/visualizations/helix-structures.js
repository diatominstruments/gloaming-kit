import { instanceGlow, fogToAlpha } from './three-shared.js';
import { Blooms } from './helix-blooms.js';

/**
 * The structures helix-corridor can fly through, and the unfolding that
 * drives them all.
 *
 * Every structure reads one number along the corridor's length: how far it
 * is unfolded there, 0 wound shut to 1 fully open. A hit doesn't move
 * anything directly; it sends a front racing away down the corridor, and
 * the stretch the front has passed unfolds behind it, lingers, then winds
 * back up. Loudness holds the whole corridor part-open between hits. Each
 * structure turns that number into its own kind of opening — a rope
 * unravelling, a lattice filling in, threads weaving across, fins turning
 * into broad ribbons — and colours its levels with the style's three
 * colours: the base in the first, what unfolding reveals in the second, the
 * finest detail reaching the third only at the extremes.
 */

const TAU = Math.PI * 2;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mod = (a, n) => ((a % n) + n) % n;
// A float literal for GLSL.
const f = (x) => Number(x).toFixed(4);
// A stable pseudo-random 0–1 for an integer, for per-piece variety that
// survives a piece wrapping round.
const hash = (n) => {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
};

export const FIELD_BUCKETS = 128;
// The music winds extra twist into the helix over this many units ahead,
// then holds it.
export const WIND_REACH = 10;
// How much wider the corridor swells where it is fully unfolded.
export const SWELL = 0.15;
// A front's ring of light: its half-width in units, and its brightness.
export const FRONT_WIDTH = 1.5;
const FRONT_GLOW = 1.6;

/**
 * UnfoldField — how far the corridor is unfolded, along its length.
 *
 * Buckets are fixed to the corridor, not the camera, so an unfolded stretch
 * stays where it is as you fly into it; a bucket that falls behind the
 * camera comes round again at the far end, fresh. Each bucket's value
 * follows its target on a damped spring, so nothing snaps: a front passes,
 * the target jumps, and the bucket opens over a few tenths of a second.
 */
export class UnfoldField {
  static FRONT_SPEED = 60;   // world units per second, away from the camera: across
                             // the near stretch in a beat's first tenth
  static FRONT_FADE = 0.3;   // per second, as a front travels
  static LINGER = 0.12;      // seconds a front holds a stretch open
  static HOLD = 0.25;        // seconds, then, for it to wind most of the way shut:
                             // quick enough that each beat opens and closes
  static SUSTAIN = 1.5;      // seconds the sustained unfolding averages over
  static SPRING = 13;        // natural frequency, rad/s: opens in about a tenth of a second
  static DAMPING = 0.78;     // damping ratio: settles with a breath of overshoot
  static IDLE = 0.06;        // a slow swell that always runs down the corridor

  constructor(length, viz) {
    this.viz = viz;
    this.length = length;
    this.count = FIELD_BUCKETS;
    this.step = length / FIELD_BUCKETS;
    this.value = new Float32Array(FIELD_BUCKETS);
    this.velocity = new Float32Array(FIELD_BUCKETS);
    this.held = new Float32Array(FIELD_BUCKETS);
    this.linger = new Float32Array(FIELD_BUCKETS);
    this.heat = new Float32Array(FIELD_BUCKETS);
    // The unfolding averaged over a couple of seconds: high only where beat
    // after beat has kept it open, for what should mark a whole passage.
    this.sustain = new Float32Array(FIELD_BUCKETS);
    this.fronts = [];   // { dist, strength }
    this.travel = 0;
    this.passed = 0;    // world buckets recycled so far
    this.time = 0;
  }

  hit(strength) {
    this.fronts.push({ dist: 0, strength });
    if (this.fronts.length > 8) this.fronts.shift();
  }

  update(dt, travel, resting) {
    const {
      FRONT_SPEED, FRONT_FADE, LINGER, HOLD, SPRING, DAMPING, IDLE,
    } = UnfoldField;
    const { count, step } = this;
    this.time += dt;

    // Buckets fallen behind the camera come round at the far end, fresh.
    const behind = Math.floor(travel / step) - 2;
    for (let q = Math.max(this.passed, behind - count); q < behind; q++) {
      const i = mod(q, count);
      this.value[i] = resting;
      this.sustain[i] = resting;
      this.velocity[i] = 0;
      this.held[i] = 0;
      this.linger[i] = 0;
    }
    this.passed = Math.max(this.passed, behind);

    // A front opens every bucket whose centre it passed this frame.
    for (const front of this.fronts) {
      const from = this.travel + front.dist;
      front.dist += FRONT_SPEED * dt;
      front.strength *= Math.exp(-dt * FRONT_FADE);
      const to = travel + front.dist;
      for (let q = Math.floor(from / step - 0.5) + 1; (q + 0.5) * step <= to; q++) {
        const i = mod(q, count);
        if (front.strength > this.held[i]) {
          this.held[i] = front.strength;
          this.linger[i] = LINGER;
        }
      }
    }
    this.fronts = this.fronts.filter((fr) => fr.dist < this.length && fr.strength > 0.03);
    this.travel = travel;

    const settle = Math.exp(-dt / HOLD);
    const average = 1 - Math.exp(-dt / UnfoldField.SUSTAIN);
    const h = Math.min(dt, 1 / 30);   // a long frame just lags
    for (let i = 0; i < count; i++) {
      if (this.linger[i] > 0) this.linger[i] -= dt;
      else this.held[i] *= settle;
      // Where this bucket is now, for the idle swell.
      const x = (behind + mod(i - behind, count) + 0.5) * step;
      const idle = IDLE * (0.5 + 0.5 * Math.sin(x * 0.22 - this.time * 0.8));
      const floor = resting + idle;
      const target = floor + (1 - floor) * Math.min(1, this.held[i]);
      this.velocity[i] += (SPRING * SPRING * (target - this.value[i])
        - 2 * DAMPING * SPRING * this.velocity[i]) * h;
      this.value[i] += this.velocity[i] * h;
      this.sustain[i] += (this.value[i] - this.sustain[i]) * average;
      this.heat[i] = this.viz.peakAmount(this.held[i]);
    }
  }

  sample(array, ahead) {
    const x = (this.travel + ahead) / this.step - 0.5;
    const q = Math.floor(x);
    const a = array[mod(q, this.count)];
    return a + (array[mod(q + 1, this.count)] - a) * (x - q);
  }

  /** How far unfolded the corridor is `ahead` units in front of the camera. */
  at(ahead) {
    return this.sample(this.value, ahead);
  }

  /** How far toward the peak colour the hit that opened it there was, 0–1. */
  heatAt(ahead) {
    return this.sample(this.heat, ahead);
  }

  /** How far unfolded it has stayed there, over the last couple of seconds. */
  sustainAt(ahead) {
    return this.sample(this.sustain, ahead);
  }
}

/**
 * GLSL every structure shares: the field (uploaded as vec4s, sampled
 * between bucket centres), the corridor's shape, and the three colours.
 */
const SHARED_VERTEX = /* glsl */ `
uniform vec4 uField[${FIELD_BUCKETS / 4}];
uniform vec4 uHeat[${FIELD_BUCKETS / 4}];
uniform float uFieldShift;   // the camera's travel, modulo the corridor's length
uniform float uFieldStep;    // corridor length per bucket
uniform float uLength;
uniform float uRadius;
uniform float uTwist;
uniform float uWind;         // extra twist the music winds in, radians per unit
uniform float uPhase;        // the helix's turn
uniform vec4 uFrontAt;       // the newest fronts' distances ahead
uniform vec4 uFrontPower;    // and their strengths
uniform float uStrands;
uniform float uThick;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
varying vec3 vTint;
varying float vLift;
varying float vFront;

float fieldPick(vec4 q, int c) {
  return c == 0 ? q.x : (c == 1 ? q.y : (c == 2 ? q.z : q.w));
}

float unfoldAt(float ahead) {
  float x = (ahead + uFieldShift) / uFieldStep - 0.5;
  float f = floor(x);
  int i = int(mod(f, ${FIELD_BUCKETS}.0));
  int j = int(mod(f + 1.0, ${FIELD_BUCKETS}.0));
  return mix(fieldPick(uField[i / 4], i - i / 4 * 4), fieldPick(uField[j / 4], j - j / 4 * 4), x - f);
}

float heatAt(float ahead) {
  float x = (ahead + uFieldShift) / uFieldStep - 0.5;
  float f = floor(x);
  int i = int(mod(f, ${FIELD_BUCKETS}.0));
  int j = int(mod(f + 1.0, ${FIELD_BUCKETS}.0));
  return mix(fieldPick(uHeat[i / 4], i - i / 4 * 4), fieldPick(uHeat[j / 4], j - j / 4 * 4), x - f);
}

// Distance ahead for a point 0 to 1 along a strand: denser near the camera,
// where the strands are large on screen.
float aheadOf(float t) {
  return uLength * (0.02 + 0.98 * t * (0.35 + 0.65 * t));
}

// How far round the helix has turned ahead units in front of the camera.
// The wound-in twist builds over the first stretch and then holds, so the
// far end turns rigidly rather than whirling.
float turnAt(float ahead) {
  return uTwist * ahead + uWind * ${f(WIND_REACH)} * tanh(ahead / ${f(WIND_REACH)}) + uPhase;
}

// Its rate of turn there: radians per unit along.
float twistAt(float ahead) {
  float t = tanh(ahead / ${f(WIND_REACH)});
  return uTwist + uWind * (1.0 - t * t);
}

// The corridor's radius where it is unfolded u: it swells as it opens.
float radiusAt(float u) {
  return uRadius * (1.0 + ${f(SWELL)} * u);
}

// The rings of light the fronts carry down the corridor.
float frontLight(float ahead) {
  vec4 d = (vec4(ahead) - uFrontAt) / ${f(FRONT_WIDTH)};
  return dot(uFrontPower, exp(-d * d));
}

// The finest level's colour: the accent lifted toward white, reaching the
// third colour on the hardest hits.
vec3 fineColor(float heat) {
  return mix(mix(uC1, vec3(1.0), 0.3), uC2, heat);
}
`;

const SHARED_FRAGMENT = /* glsl */ `
uniform float uGlow;
varying vec3 vTint;
varying float vLift;
varying float vFront;
`;

const PLAIN_COLOR = /* glsl */ `
vec3 face = vTint;
diffuseColor.rgb *= face;
`;

// Unfolded parts glow more, and a passing front lights them up.
const PLAIN_GLOW = /* glsl */ `
totalEmissiveRadiance += face * (uGlow * (0.25 + vLift) + ${f(FRONT_GLOW)} * vFront);
`;

/**
 * A stock lit material whose vertex shader places the geometry itself.
 * `vertex` replaces beginnormal_vertex and must declare `objectNormal` and
 * `shaped` (the position) and set vTint and vLift; `color` replaces
 * color_fragment and must declare `face`.
 */
function shapedMaterial(viz, {
  key, uniforms = {}, vertexHead = '', vertex, fragmentHead = '',
  color = PLAIN_COLOR, glow = PLAIN_GLOW, side, roughness = 0.4,
}) {
  const THREE = viz.THREE;
  const material = new THREE.MeshStandardMaterial({
    metalness: 0.15, roughness, side: side ?? THREE.FrontSide,
  });
  material.forceSinglePass = true;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, viz.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${SHARED_VERTEX}\n${vertexHead}\nvoid main() {`)
      .replace('#include <beginnormal_vertex>', vertex)
      .replace('#include <begin_vertex>', 'vec3 transformed = shaped;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${SHARED_FRAGMENT}\n${fragmentHead}\nvoid main() {`)
      .replace('#include <color_fragment>', color)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${glow}`);
  };
  fogToAlpha(material);
  // Programs are cached by onBeforeCompile's source, which is the same for
  // every structure; key each apart.
  material.customProgramCacheKey = () => key;
  return material;
}

/**
 * A surface as a grid for the vertex shader to place: position.x runs 0–1
 * along, position.y from `y0` to `y1` across (an angle round a tube, or a
 * ribbon's width). Wound so a tube's outside faces front.
 */
function grid(THREE, along, across, y0, y1) {
  const position = new Float32Array((along + 1) * (across + 1) * 3);
  let o = 0;
  for (let i = 0; i <= along; i++) {
    for (let j = 0; j <= across; j++) {
      position[o++] = i / along;
      position[o++] = y0 + (y1 - y0) * (j / across);
      position[o++] = 0;
    }
  }
  const index = [];
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < across; j++) {
      const a = i * (across + 1) + j;
      const b = a + across + 1;
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setIndex(index);
  return geometry;
}

/** An InstancedMesh of `geometry` whose instances carry `attrs`: { name: [size, Float32Array] }. */
function instanced(viz, geometry, material, count, attrs) {
  const THREE = viz.THREE;
  for (const [name, [size, array]] of Object.entries(attrs)) {
    geometry.setAttribute(name, new THREE.InstancedBufferAttribute(array, size));
  }
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.frustumCulled = false;
  viz.scene.add(mesh);
  return mesh;
}

/** A unit vector facing in from the wall at angle `th`, tilted toward the camera. */
const facing = (th, tilt) => {
  const ct = Math.cos(tilt);
  return [-Math.cos(th) * ct, -Math.sin(th) * ct, Math.sin(tilt)];
};

/**
 * Braid — each strand is a rope that unravels.
 *
 * Wound shut, a strand is three sub-strands twisted tight round it, each of
 * those three threads twisted tight round that: one braided rope. As the
 * corridor unfolds the sub-strands peel apart into their own helices
 * winding round the strand's path, and further open each one's threads
 * peel apart round it in turn: four ropes become twelve helices become
 * thirty-six. All of it turns — strands round the flight line, sub-strands
 * round their strand one way, threads round their sub-strand the other —
 * and every radius follows the field, so the unravelling is continuous.
 *
 * Where it stays open beat after beat, in the most intense passages, buds
 * appear along the unwound sub-strands and bloom.
 */
export class Braid {
  static W1 = 2.2;              // radians a sub-strand winds round its strand, per unit along
  static W2 = 7;                // radians a thread winds round its sub-strand, per unit along
  static R1 = [0.035, 0.55];    // a sub-strand's distance from its strand: wound, open
  static R2 = [0.014, 0.17];    // a thread's from its sub-strand
  static OPEN1 = [0.05, 0.6];   // the stretch of unfolding over which each level opens
  static OPEN2 = [0.4, 0.95];
  // Over which sustained unfolding buds appear, then open: a passage that
  // keeps the braid open beat after beat, not a single hit.
  static BUDS = [0.5, 0.75];
  static SEGMENTS = 900;

  constructor(viz) {
    const THREE = viz.THREE;
    const {
      W1, W2, R1, R2, OPEN1, OPEN2, SEGMENTS,
    } = Braid;
    this.viz = viz;
    const S = viz.strands;
    const k = viz.sizeScale;
    viz.uniforms.uThick.value = 0.016 * k;
    this.uniforms = { uPhase1: { value: 0 }, uPhase2: { value: 0 } };
    const material = shapedMaterial(viz, {
      key: 'helix-corridor-braid',
      uniforms: this.uniforms,
      vertexHead: /* glsl */ `
        attribute vec3 aThread;   // strand, sub-strand, thread
        uniform float uPhase1;
        uniform float uPhase2;
      `,
      vertex: /* glsl */ `
        float ahead = aheadOf(position.x);
        float u = unfoldAt(ahead);
        float open1 = smoothstep(${f(OPEN1[0])}, ${f(OPEN1[1])}, u);
        float open2 = smoothstep(${f(OPEN2[0])}, ${f(OPEN2[1])}, u);
        // The strand: a helix round the flight line.
        float th = PI2 * aThread.x / uStrands + turnAt(ahead);
        vec3 n0 = vec3(cos(th), sin(th), 0.0);
        float R = radiusAt(u);
        float tw = twistAt(ahead);
        vec3 dP0 = vec3(-n0.y * R * tw, n0.x * R * tw, -1.0);
        vec3 b0 = cross(normalize(dP0), n0);
        // Its three sub-strands wind round it, further out the more it has unwound...
        float r1 = mix(${f(R1[0] * k)}, ${f(R1[1])}, open1);
        float ph1 = uPhase1 + ${f(W1)} * ahead + PI2 * aThread.y / 3.0;
        vec3 d1 = n0 * cos(ph1) + b0 * sin(ph1);
        vec3 dP1 = dP0 + r1 * ${f(W1)} * (b0 * cos(ph1) - n0 * sin(ph1));
        vec3 f1 = cross(normalize(dP1), d1);
        // ...and each sub-strand's three threads round it.
        float r2 = mix(${f(R2[0] * k)}, ${f(R2[1])}, open2);
        float ph2 = uPhase2 + ${f(W2)} * ahead + PI2 * aThread.z / 3.0;
        vec3 g2 = d1 * cos(ph2) + f1 * sin(ph2);
        vec3 t2 = normalize(dP1 + r2 * ${f(W2)} * (f1 * cos(ph2) - d1 * sin(ph2)));
        vec3 objectNormal = g2 * cos(position.y) + cross(t2, g2) * sin(position.y);
        vec3 shaped = vec3(n0.xy * R, -ahead) + r1 * d1 + r2 * g2 + uThick * objectNormal;
        // Wound, the first colour; unwinding, the second; fully open, the finest.
        vTint = mix(uC0, uC1, smoothstep(0.1, 0.55, u));
        vTint = mix(vTint, fineColor(heatAt(ahead)), smoothstep(0.7, 1.0, u));
        vLift = u;
        vFront = frontLight(ahead);
      `,
    });
    const ids = new Float32Array(S * 9 * 3);
    for (let n = 0; n < S * 9; n++) {
      ids.set([Math.floor(n / 9), Math.floor(n / 3) % 3, n % 3], n * 3);
    }
    this.mesh = instanced(viz, grid(THREE, SEGMENTS, 6, 0, TAU), material, S * 9, {
      aThread: [3, ids],
    });

    this.spin1 = 0;
    this.spin2 = 0;
    this.budsPerSub = Math.max(4, Math.round(viz.density / 3));
    this.blooms = new Blooms(viz, { capacity: S * 3 * this.budsPerSub, shape: viz.shape });
  }

  update(dt, { spinIn, glow }) {
    const { W1, W2 } = Braid;
    const { viz } = this;
    // Sub-strands turn round their strands one way, threads the other.
    const t = dt * viz.tempo;
    this.spin1 = (this.spin1 + t * (0.25 + spinIn * 0.6)) % TAU;
    this.spin2 = (this.spin2 - t * (0.4 + spinIn * 1.2)) % TAU;
    this.uniforms.uPhase1.value = ((W1 * viz.travel) % TAU) + this.spin1;
    this.uniforms.uPhase2.value = ((W2 * viz.travel) % TAU) + this.spin2;
    this.placeBuds(glow);
  }

  placeBuds(glow) {
    const { W1, R1, OPEN1, BUDS } = Braid;
    const { viz, blooms, budsPerSub } = this;
    const {
      field, strands: S, travel, time, length: L, levelColors,
    } = viz;
    const k = viz.sizeScale;
    const spacing = L / budsPerSub;
    const phase1 = this.uniforms.uPhase1.value;
    blooms.begin();
    for (let i = 0; i < S; i++) {
      for (let j = 0; j < 3; j++) {
        for (let m = 0; m < budsPerSub; m++) {
          // Fixed to the corridor; the three sub-strands' buds staggered.
          const ahead = mod((m + j / 3) * spacing - travel, L);
          const held = field.sustainAt(ahead);
          if (held < BUDS[0]) continue;
          const u = field.at(ahead);
          // The sub-strand's centre here, as the shader places it.
          const th = (TAU * i) / S + viz.turnAt(ahead);
          const c = Math.cos(th);
          const s = Math.sin(th);
          const R = viz.radiusAt(u);
          const tw = viz.twistAt(ahead);
          const len = Math.hypot(R * tw, 1);
          const tx = (-s * R * tw) / len;
          const ty = (c * R * tw) / len;
          const tz = -1 / len;
          const b = [-tz * s, tz * c, tx * s - ty * c];   // tangent × radial
          const r1 = R1[0] * k + (R1[1] - R1[0] * k) * smoothstep(OPEN1[0], OPEN1[1], u);
          const ph1 = phase1 + W1 * ahead + (TAU * j) / 3;
          const cp = Math.cos(ph1);
          const sp = Math.sin(ph1);
          const seedIndex = Math.round((travel + ahead) / spacing - j / 3) * 31 + i * 3 + j;
          const seed = hash(seedIndex) * TAU;
          const axis = facing(th, 0.5 + 0.15 * Math.sin(time * 0.3 + seed));
          const lift = viz.uniforms.uThick.value * 2;
          const p = [
            c * R + r1 * (c * cp + b[0] * sp) + axis[0] * lift,
            s * R + r1 * (s * cp + b[1] * sp) + axis[1] * lift,
            -ahead + r1 * b[2] * sp + axis[2] * lift,
          ];
          blooms.add(
            p, axis, [-s, c, 0],
            seed + time * (hash(seedIndex + 7) - 0.5) * 0.6,
            viz.size * 0.9 * smoothstep(BUDS[0], (BUDS[0] + BUDS[1]) / 2, held),
            Math.min(1, Math.max(0, (held - BUDS[0]) / (BUDS[1] - BUDS[0]))),
            field.heatAt(ahead),
            levelColors[0], levelColors[1],
          );
        }
      }
    }
    blooms.end(glow);
  }
}

/**
 * Phyllotaxis — the corridor's wall as a sunflower's head.
 *
 * Florets sit on one endless generative spiral, each a golden angle round
 * from the last: the arrangement that packs a sunflower or a pinecone, where
 * the eye picks out families of spirals crossing each other. Unfolding
 * fills it in. Wound shut, only every sixteenth floret shows: a sparse
 * lattice of big florets in the first colour. As it opens the eighths grow
 * in between, then the quarters and halves in the second colour, and fully
 * open the finest florets fill every gap — each time the spiral families
 * the eye finds reorganise, from a few lazy ones to dozens interlocking.
 * Nothing moves to do it: florets only grow and shrink, so the change is
 * smooth however fast the music asks for it.
 */
export class Phyllotaxis {
  // The unfolding over which florets of each rank grow in: rank r is every
  // 2^r-th floret, and the coarsest, rank 4, always shows.
  static REVEAL = [[0.62, 0.92], [0.4, 0.7], [0.18, 0.48], [0.0, 0.26]];
  static TILT = 0.35;

  constructor(viz) {
    const THREE = viz.THREE;
    this.viz = viz;
    // A multiple of 16, so a floret's rank survives wrapping round.
    this.count = Math.max(256, Math.round((viz.density * 24) / 16) * 16);
    this.spacing = viz.length / this.count;
    // Nearest-neighbour distance with every floret showing: on a golden
    // spiral each takes an equal share of the wall.
    this.neighbour = Math.sqrt((TAU * viz.radius * this.spacing) / (Math.sqrt(3) / 2));
    this.rank = Uint8Array.from({ length: this.count }, (_, n) => {
      let r = 0;
      while (r < 4 && n > 0 && n % (2 << r) === 0) r++;
      return n === 0 ? 4 : r;
    });
    // A hexagonal scale, its broad face to the axis.
    const geometry = new THREE.CylinderGeometry(1, 0.55, 0.3, 6);
    geometry.rotateX(Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({ metalness: 0.15, roughness: 0.4, flatShading: true });
    this.glow = instanceGlow(material, 0.2);
    fogToAlpha(material);
    material.customProgramCacheKey = () => 'helix-corridor-floret';
    this.mesh = new THREE.InstancedMesh(geometry, material, this.count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, new THREE.Color());
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    viz.scene.add(this.mesh);
    this.c = new THREE.Color();
    this.white = new THREE.Color(1, 1, 1);
  }

  update(dt, { glow }) {
    const { REVEAL, TILT } = Phyllotaxis;
    const { viz, count, spacing, c } = this;
    const {
      field, travel, length: L, spin, levelColors,
    } = viz;
    const k = viz.sizeScale;
    const M = this.mesh.instanceMatrix.array;
    const C = this.mesh.instanceColor.array;
    let shown = 0;
    for (let n = 0; n < count; n++) {
      const ahead = mod(n * spacing - travel, L);
      const u = field.at(ahead);
      const rank = this.rank[n];
      const reveal = rank === 4 ? 1 : smoothstep(REVEAL[rank][0], REVEAL[rank][1], u);
      if (reveal < 0.002) continue;
      // How many ranks are still hidden here, fractionally. Florets are
      // sized to pack the wall when all show, and a little larger while
      // sparse, shrinking back as the finer ones grow in between.
      let hidden = 4;
      for (let q = 0; q < 4; q++) hidden -= smoothstep(REVEAL[q][0], REVEAL[q][1], u);
      // Its place on the endless spiral fixes its angle.
      const index = Math.round((travel + ahead) / spacing);
      const th = ((index * GOLDEN) % TAU) + spin + viz.windAt(ahead);
      const ct = Math.cos(th);
      const st = Math.sin(th);
      const r = viz.radiusAt(u) - 0.04 * rank * k;
      const [ax, ay, az] = facing(th, TILT);
      // Across the wall, and axis × that.
      const tx = -st;
      const ty = ct;
      const bx = -az * ty;
      const by = az * tx;
      const bz = ax * ty - ay * tx;
      const s = 0.42 * k * this.neighbour * (1 + 0.15 * hidden) * reveal;
      const o = shown * 16;
      M[o] = tx * s;
      M[o + 1] = ty * s;
      M[o + 2] = 0;
      M[o + 3] = 0;
      M[o + 4] = bx * s;
      M[o + 5] = by * s;
      M[o + 6] = bz * s;
      M[o + 7] = 0;
      M[o + 8] = ax * s;
      M[o + 9] = ay * s;
      M[o + 10] = az * s;
      M[o + 11] = 0;
      M[o + 12] = ct * r;
      M[o + 13] = st * r;
      M[o + 14] = -ahead;
      M[o + 15] = 1;
      // Coarse florets the first colour, the middle ranks the second, the
      // finest lifted toward white and, on the hardest hits, the third.
      if (rank >= 3) c.copy(levelColors[0]);
      else if (rank >= 1) c.copy(levelColors[1]);
      else c.copy(levelColors[1]).lerp(this.white, 0.3).lerp(levelColors[2], field.heatAt(ahead));
      c.multiplyScalar(0.75 + 0.4 * u + 1.5 * viz.frontLight(ahead));
      C[shown * 3] = c.r;
      C[shown * 3 + 1] = c.g;
      C[shown * 3 + 2] = c.b;
      shown++;
    }
    this.mesh.count = shown;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    this.glow.value = 0.15 + glow * 0.45;
  }
}

/**
 * Weave — the strands weave a basket round you.
 *
 * Wound shut, the corridor is its bare strands. Unfolding, threads grow
 * across between them: first hoops from each strand to the next (a ladder),
 * then diagonals both ways through every cell and a strand between each
 * pair (a basket), and fully open a fine diamond inside each cell. The
 * cells are as long as they are wide, so the diagonals run as crossing
 * spirals rather than round the wall. A thread grows from one node toward
 * the next with a tapering tip rather than appearing, and threads bow
 * alternately over and under. Knots sit at the nodes, and at the height of
 * the music buds open on the strands' knots.
 */
export class Weave {
  // The unfolding over which threads of each level grow across.
  static GROW = [[-1, -0.5], [0.08, 0.42], [0.35, 0.7], [0.65, 0.95]];
  static THICK = [1, 0.7, 0.55, 0.4];
  static BUDS = [0.5, 0.75];    // as Braid's, for buds on the knots

  constructor(viz) {
    const THREE = viz.THREE;
    const { GROW, THICK } = Weave;
    this.viz = viz;
    const S = viz.strands;
    const k = viz.sizeScale;
    // Columns: the strands, and one between each pair. Rows as far apart
    // as columns, and an even number, so a node's over/under survives
    // wrapping round.
    this.columns = S * 2;
    const width = (TAU * viz.radius) / this.columns;
    this.rows = Math.max(8, Math.round(viz.length / width / 2) * 2);
    this.rowStep = viz.length / this.rows;
    viz.uniforms.uThick.value = 0.028 * k;

    const arcs = [];
    const arc = (c0, r0, c1, r1, level, over) => arcs.push([c0, r0, c1, r1, level, over]);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.columns; c++) {
        const over = (c + r) % 2 ? 1 : -1;
        arc(c, r, c, r + 1, c % 2 ? 2 : 0, 0);        // a strand, or one between
        arc(c, r, c + 1, r, 1, over);                 // hoop
        arc(c, r, c + 1, r + 1, 2, over);             // diagonals
        arc(c + 1, r, c, r + 1, 2, -over);
        arc(c + 0.5, r, c + 1, r + 0.5, 3, over);     // the fine diamond
        arc(c + 1, r + 0.5, c + 0.5, r + 1, 3, -over);
        arc(c + 0.5, r + 1, c, r + 0.5, 3, over);
        arc(c, r + 0.5, c + 0.5, r, 3, -over);
      }
    }
    const window = (g) => `vec2(${f(g[0])}, ${f(g[1])})`;
    const material = shapedMaterial(viz, {
      key: 'helix-corridor-weave',
      uniforms: { uRowStep: { value: this.rowStep }, uColumns: { value: this.columns } },
      vertexHead: /* glsl */ `
        attribute vec4 aArc;    // from (column, row), to (column, row)
        attribute vec2 aKind;   // level; +1 bows over, -1 under
        uniform float uRowStep;
        uniform float uColumns;

        vec3 arcPoint(float s, float start, float span) {
          float ahead = start + s * span;
          float th = PI2 * mix(aArc.x, aArc.z, s) / uColumns + turnAt(ahead);
          float r = radiusAt(unfoldAt(ahead)) + aKind.y * 0.05 * sin(PI * s);
          return vec3(cos(th) * r, sin(th) * r, -ahead);
        }
      `,
      vertex: /* glsl */ `
        float start = mod(aArc.y * uRowStep - uFieldShift, uLength);
        float span = (aArc.w - aArc.y) * uRowStep;
        float level = aKind.x;
        float u = unfoldAt(start + 0.5 * span);
        vec2 window = level < 0.5 ? ${window(GROW[0])}
          : (level < 1.5 ? ${window(GROW[1])} : (level < 2.5 ? ${window(GROW[2])} : ${window(GROW[3])}));
        float grow = smoothstep(window.x, window.y, u);
        float s = position.x * grow;
        vec3 c = arcPoint(s, start, span);
        vec3 T = normalize(arcPoint(s + 0.02, start, span) - c);
        vec3 B = normalize(cross(T, normalize(vec3(c.xy, 0.0))));
        vec3 objectNormal = cross(B, T) * cos(position.y) + B * sin(position.y);
        float thick = uThick * (level < 0.5 ? ${f(THICK[0])} : (level < 1.5 ? ${f(THICK[1])}
          : (level < 2.5 ? ${f(THICK[2])} : ${f(THICK[3])})));
        // A growing thread tapers to its tip.
        thick *= smoothstep(0.0, 0.06, grow) * (grow < 0.999 ? smoothstep(0.0, 0.15, 1.0 - position.x) : 1.0);
        vec3 shaped = c + thick * objectNormal;
        vTint = level < 0.5 ? uC0 : (level < 1.5 ? uC1
          : (level < 2.5 ? mix(uC1, uC0, 0.3) : fineColor(heatAt(start + 0.5 * span))));
        vLift = u;
        vFront = frontLight(start + s * span);
      `,
    });
    const arcData = new Float32Array(arcs.length * 4);
    const kindData = new Float32Array(arcs.length * 2);
    arcs.forEach(([i0, r0, i1, r1, level, over], n) => {
      arcData.set([i0, r0, i1, r1], n * 4);
      kindData.set([level, over], n * 2);
    });
    this.mesh = instanced(viz, grid(THREE, 10, 5, 0, TAU), material, arcs.length, {
      aArc: [4, arcData], aKind: [2, kindData],
    });

    // Knots where strands cross rows.
    const knotMaterial = new THREE.MeshStandardMaterial({ metalness: 0.15, roughness: 0.35 });
    this.knotGlow = instanceGlow(knotMaterial, 0.3);
    fogToAlpha(knotMaterial);
    knotMaterial.customProgramCacheKey = () => 'helix-corridor-knot';
    this.knots = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), knotMaterial, this.columns * this.rows);
    this.knots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.knots.frustumCulled = false;
    this.knots.setColorAt(0, new THREE.Color());
    this.knots.instanceColor.setUsage(THREE.DynamicDrawUsage);
    viz.scene.add(this.knots);
    this.c = new THREE.Color();

    this.blooms = new Blooms(viz, { capacity: Math.ceil((S * this.rows) / 2), shape: viz.shape });
  }

  update(dt, { glow }) {
    const { BUDS } = Weave;
    const {
      viz, rows, columns, rowStep, blooms, c,
    } = this;
    const {
      field, travel, time, length: L, levelColors,
    } = viz;
    const thick = viz.uniforms.uThick.value;
    const M = this.knots.instanceMatrix.array;
    const C = this.knots.instanceColor.array;
    blooms.begin();
    let n = 0;
    for (let r = 0; r < rows; r++) {
      const ahead = mod(r * rowStep - travel, L);
      const u = field.at(ahead);
      const R = viz.radiusAt(u);
      const light = viz.frontLight(ahead);
      for (let i = 0; i < columns; i++, n++) {
        const th = (TAU * i) / columns + viz.turnAt(ahead);
        const ct = Math.cos(th);
        const st = Math.sin(th);
        const s = thick * 1.6 * (0.6 + 0.8 * u);
        const o = n * 16;
        M.fill(0, o, o + 15);
        M[o] = s;
        M[o + 5] = s;
        M[o + 10] = s;
        M[o + 12] = ct * R;
        M[o + 13] = st * R;
        M[o + 14] = -ahead;
        M[o + 15] = 1;
        c.copy(levelColors[0]).lerp(levelColors[1], smoothstep(0.1, 0.6, u)).multiplyScalar(1 + 1.5 * light);
        C[n * 3] = c.r;
        C[n * 3 + 1] = c.g;
        C[n * 3 + 2] = c.b;

        // Buds on every other knot of the strands proper.
        if (i % 2 || (i / 2 + r) % 2) continue;
        const held = field.sustainAt(ahead);
        if (held < BUDS[0]) continue;
        const seedIndex = Math.round((travel + ahead) / rowStep) * 17 + i;
        const seed = hash(seedIndex) * TAU;
        const axis = facing(th, 0.5 + 0.15 * Math.sin(time * 0.3 + seed));
        blooms.add(
          [ct * R + axis[0] * s, st * R + axis[1] * s, -ahead + axis[2] * s],
          axis, [-st, ct, 0],
          seed + time * (hash(seedIndex + 7) - 0.5) * 0.6,
          viz.size * 0.9 * smoothstep(BUDS[0], (BUDS[0] + BUDS[1]) / 2, held),
          Math.min(1, Math.max(0, (held - BUDS[0]) / (BUDS[1] - BUDS[0]))),
          field.heatAt(ahead),
          levelColors[0], levelColors[1],
        );
      }
    }
    this.knots.instanceMatrix.needsUpdate = true;
    this.knots.instanceColor.needsUpdate = true;
    this.knotGlow.value = 0.15 + glow * 0.45;
    blooms.end(glow);
  }
}

/**
 * Ribbons — the strands are bands that turn and fan open.
 *
 * Wound shut, each strand is a narrow fin standing edge-on to the flight
 * line, so it reads as a thin line, rippling as a slow wave runs along it.
 * Unfolding rolls it face-on to you and widens it, showing the second
 * colour on the side that faces the axis; further open, two more ribbons
 * fan out from behind it either side, and fully open their edges ruffle
 * into a frill tinted toward the finest colour.
 */
export class Ribbons {
  static SEGMENTS = 900;

  constructor(viz) {
    const THREE = viz.THREE;
    this.viz = viz;
    const S = viz.strands;
    this.uniforms = {
      uWave: { value: 0 },
      uFrill: { value: 0 },
      uWidth: { value: 0.32 * viz.sizeScale },
    };
    const material = shapedMaterial(viz, {
      key: 'helix-corridor-ribbon',
      side: THREE.DoubleSide,
      // Broad faces turned to the headlight; keep them from glaring.
      roughness: 0.7,
      uniforms: this.uniforms,
      vertexHead: /* glsl */ `
        attribute vec2 aRibbon;   // strand; place in its fan, -1 0 or 1
        uniform float uWave;
        uniform float uFrill;
        uniform float uWidth;
        varying vec3 vBack;
        varying vec3 vFine;
        varying float vInward;
        varying float vEdge;

        // How far rolled and widened: spread over most of the unfolding, so
        // each beat visibly turns the ribbons toward you and back.
        float ribbonOpen(float u) {
          return smoothstep(0.1, 0.85, u);
        }

        // The ribbon's sideways direction here, before any ruffle.
        vec3 ribbonAcross(float ahead, float u, vec3 n, vec3 t) {
          float open = ribbonOpen(u);
          float roll = 1.5708 * open + (0.4 - 0.25 * open) * sin(0.5 * ahead + uWave + 1.7 * aRibbon.x + aRibbon.y);
          return n * cos(roll) + cross(t, n) * sin(roll);
        }

        vec3 ribbonPoint(float ahead, float v) {
          float u = unfoldAt(ahead);
          float open = ribbonOpen(u);
          float fan = smoothstep(0.5, 0.9, u);
          float frill = smoothstep(0.75, 1.0, u);
          float k = aRibbon.y;
          float th = PI2 * aRibbon.x / uStrands + turnAt(ahead) + k * 0.3 * fan;
          float r = radiusAt(u) - abs(k) * 0.06;
          vec3 n = vec3(cos(th), sin(th), 0.0);
          float tw = twistAt(ahead);
          vec3 t = normalize(vec3(-n.y * r * tw, n.x * r * tw, -1.0));
          // Shut, the ribbon is a fin edge-on to the flight line; opening,
          // it rolls face-on. A ripple runs along it either way.
          vec3 across = ribbonAcross(ahead, u, n, t);
          float w = uWidth * mix(0.06, 1.0, open) * (k == 0.0 ? 1.0 : 0.75 * fan) + 1e-4;
          float ruffle = frill * 0.3 * w * v * v * sin(6.0 * ahead + uFrill + 2.0 * k);
          return vec3(n.xy * r, -ahead) + across * (v * w) + cross(t, across) * ruffle;
        }
      `,
      vertex: /* glsl */ `
        float ahead = aheadOf(position.x);
        float v = position.y;
        vec3 shaped = ribbonPoint(ahead, v);
        // Across × along: the grid's front face.
        vec3 objectNormal = normalize(cross(
          ribbonPoint(ahead, v + 0.05) - shaped,
          ribbonPoint(ahead + 0.03, v) - shaped
        ) + vec3(0.0, 0.0, 1e-7));
        float u = unfoldAt(ahead);
        // How far the front face, unruffled, looks toward the axis.
        float th = PI2 * aRibbon.x / uStrands + turnAt(ahead) + aRibbon.y * 0.3 * smoothstep(0.5, 0.9, u);
        vec3 n = vec3(cos(th), sin(th), 0.0);
        float tw = twistAt(ahead);
        vec3 t = normalize(vec3(-n.y * uRadius * tw, n.x * uRadius * tw, -1.0));
        vInward = smoothstep(-0.25, 0.25, -dot(cross(ribbonAcross(ahead, u, n, t), t), n));
        vTint = mix(uC0, uC1, ribbonOpen(u));
        vBack = uC0;
        vFine = fineColor(heatAt(ahead));
        vEdge = smoothstep(0.75, 1.0, u) * smoothstep(0.5, 1.0, abs(v));
        vLift = u;
        vFront = frontLight(ahead);
      `,
      fragmentHead: /* glsl */ `
        varying vec3 vBack;
        varying vec3 vFine;
        varying float vInward;
        varying float vEdge;
      `,
      // The side toward the axis wears the unfolding colour, the back the
      // first; the frill's edges the finest.
      color: /* glsl */ `
        float inward = gl_FrontFacing ? vInward : 1.0 - vInward;
        vec3 face = mix(vBack, vTint, inward);
        face = mix(face, vFine, vEdge);
        diffuseColor.rgb *= face;
      `,
      glow: /* glsl */ `
        totalEmissiveRadiance += face * (uGlow * (0.1 + 0.5 * vLift) + ${f(FRONT_GLOW)} * 0.7 * vFront);
      `,
    });
    const ids = new Float32Array(S * 3 * 2);
    for (let n = 0; n < S * 3; n++) ids.set([Math.floor(n / 3), (n % 3) - 1], n * 2);
    this.mesh = instanced(viz, grid(THREE, Ribbons.SEGMENTS, 4, -1, 1), material, S * 3, {
      aRibbon: [2, ids],
    });
    this.wave = 0;
    this.frill = 0;
  }

  update(dt, { spinIn }) {
    const { viz } = this;
    const t = dt * viz.tempo;
    this.wave = (this.wave + t * (0.8 + spinIn)) % TAU;
    this.frill = (this.frill + t * 2.5) % TAU;
    // The ripple is fixed to the corridor as well as running along it.
    this.uniforms.uWave.value = ((0.5 * viz.travel) % TAU) + this.wave;
    this.uniforms.uFrill.value = ((6 * viz.travel) % TAU) + this.frill;
  }
}
