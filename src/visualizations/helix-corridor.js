import { ThreeVisualization } from './three-base.js';
import { approach, clamp01, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';
import { mulberry32 } from '../noise.js';
import {
  PALETTE_OPTION, paletteColor, peakTint, isPsychedelic, instanceGlow, fogToAlpha,
} from './three-shared.js';

const TAU = Math.PI * 2;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * `count` petals spaced evenly round the flower from `phase`; the rest of
 * `petal` is shared. Fields, all in the flower's own frame (axis +z, a petal
 * about one unit long):
 *
 *   phi      azimuth round the axis
 *   r0, z0   where its base is hinged: distance out from the axis, height
 *   len      base-to-tip length
 *   width    greatest half-width
 *   closed   [lean, curl] in the bud: lean is the base's angle off the axis
 *            (outward positive), curl the bend from base to tip (negative
 *            curves the tip in toward the axis, positive recurves it out)
 *   open     [lean, curl] in full bloom
 *   cup      [closed, open] how far the edges cup inward, × width
 *   swirl    radians the tip is wound round the axis in the bud, unwinding
 *            as it opens, so buds are twisted shut like real ones
 *   stage    [from, to] the part of the flower's bloom over which this petal
 *            opens: outer petals first, inner ones only on the bigger hits
 *   mirror   -1 hinges the petal downward, for the lower half of a solid
 *   taper    0 a pointed leaf, 1 a straight-sided triangle (a solid's face)
 */
const whorl = (count, petal, phase = 0) =>
  Array.from({ length: count }, (_, i) => ({ ...petal, phi: phase + (i / count) * TAU }));

/**
 * Every shape is a bud that unfolds. `heart` is the glowing core revealed as
 * it opens: [radius, height] in the flower's frame. `flat` facets it.
 */
const FORMS = {
  // Three whorls, each opening after the one outside it.
  lotus: {
    heart: [0.13, 0.1],
    petals: [
      ...whorl(8, {
        r0: 0.08, len: 1, width: 0.24, closed: [0.35, -0.95], open: [1.25, 0.8],
        cup: [0.6, 0.3], swirl: 0.7, stage: [0, 0.7],
      }),
      ...whorl(8, {
        r0: 0.06, z0: 0.02, len: 0.78, width: 0.2, closed: [0.3, -0.9], open: [0.9, 0.4],
        cup: [0.6, 0.4], swirl: 0.9, stage: [0.25, 0.9],
      }, TAU / 16),
      ...whorl(5, {
        r0: 0.04, z0: 0.04, len: 0.5, width: 0.16, closed: [0.2, -0.8], open: [0.5, 0.1],
        cup: [0.6, 0.5], swirl: 1.1, stage: [0.5, 1],
      }),
    ],
  },
  // Thirty narrow petals on the golden angle, the longest outside: it
  // unfolds from the rim inward, one petal after the next.
  dahlia: {
    heart: [0.1, 0.06],
    petals: Array.from({ length: 30 }, (_, i) => {
      const f = i / 29;
      return {
        phi: i * GOLDEN, r0: 0.05 * (1 - f), z0: 0.06 * f, len: 1 - 0.55 * f, width: 0.11,
        closed: [0.3 - 0.15 * f, -0.9], open: [1.5 - 1.05 * f, 0.6 - 0.7 * f],
        cup: [0.7, 0.45], swirl: 0.5, stage: [0.55 * f, 0.45 + 0.55 * f],
      };
    }),
  },
  // Six long petals that recurve right back, round six fine stamens.
  lily: {
    heart: [0.07, 0.06],
    petals: [
      ...whorl(3, {
        r0: 0.05, len: 1.25, width: 0.17, closed: [0.25, -0.75], open: [1.15, 2.2],
        cup: [0.6, 0.35], swirl: 0.8, stage: [0, 0.8],
      }),
      ...whorl(3, {
        r0: 0.04, z0: 0.02, len: 1.15, width: 0.15, closed: [0.2, -0.72], open: [1.05, 2],
        cup: [0.6, 0.35], swirl: 0.8, stage: [0.12, 0.9],
      }, TAU / 6),
      ...whorl(6, {
        r0: 0.02, z0: 0.03, len: 0.75, width: 0.02, closed: [0.05, -0.1], open: [0.42, -0.4],
        cup: [0, 0], stage: [0.3, 1],
      }, TAU / 12),
    ],
  },
  // An octahedron whose faces hinge open at its equator: shut, it is the
  // solid; open, an eight-pointed star round a glowing core.
  crystal: {
    flat: true,
    heart: [0.3, 0],
    petals: [false, true].flatMap((lower) => whorl(4, {
      r0: Math.SQRT1_2, len: Math.sqrt(1.5), width: Math.SQRT1_2, taper: 1,
      closed: [-Math.atan(Math.SQRT1_2), 0], open: lower ? [0.8, 0.15] : [1.1, 0.2],
      cup: [0, 0], stage: lower ? [0.3, 1] : [0, 0.75], mirror: lower ? -1 : 1,
    }, TAU / 8)),
  },
};
const SHAPES = Object.keys(FORMS);

/**
 * The petal, bent in the vertex shader. Each vertex carries where it sits on
 * its petal (position.xy: u from base to tip, v across) and the petal's
 * description; the instance carries how far the flower has bloomed. The
 * centreline is an arc of constant curvature, so changing the curl unrolls
 * the petal rather than swinging it stiffly on its hinge.
 */
const PETAL_VERTEX = /* glsl */ `
attribute vec4 aPetalA;   // azimuth, hinge radius, hinge height, length
attribute vec4 aPetalB;   // closed lean, closed curl, open lean, open curl
attribute vec4 aPetalC;   // half-width, closed cup, open cup, swirl
attribute vec4 aPetalD;   // opens from, opens to, mirror, taper
attribute vec3 aInner;    // per flower: inner face colour
attribute vec2 aState;    // per flower: bloom, heat
varying vec3 vInner;
varying vec2 vState;
varying float vU;

float petalWidth(float u) {
  float leaf = pow(max(sin(3.14159 * (0.12 + 0.88 * u)), 0.0), 0.7);
  return aPetalC.x * mix(leaf, 1.0 - u, aPetalD.w);
}

vec3 petalPoint(float u, float v, float o) {
  float len = aPetalA.w;
  float lean = mix(aPetalB.x, aPetalB.z, o);
  float curl = mix(aPetalB.y, aPetalB.w, o);
  float a = lean + curl * u;
  // (out from the axis, along it)
  vec2 c = abs(curl) < 1e-3
    ? len * u * vec2(sin(lean), cos(lean))
    : len / curl * vec2(cos(lean) - cos(a), sin(a) - sin(lean));
  float w = petalWidth(u);
  // Bow the middle outward of the edges, so the inner face is cupped.
  c += vec2(cos(a), -sin(a)) * mix(aPetalC.y, aPetalC.z, o) * w * (1.0 - v * v);
  float phi = aPetalA.x + aPetalC.w * u * (1.0 - o);
  float m = aPetalD.z;
  return vec3(cos(phi), sin(phi), 0.0) * (aPetalA.y + c.x)
    + vec3(-sin(phi), cos(phi), 0.0) * (v * m * w)
    + vec3(0.0, 0.0, m * (aPetalA.z + c.y));
}
`;

// Replaces beginnormal_vertex, which runs before begin_vertex: work out the
// bent position here and hand it on.
const PETAL_NORMAL = /* glsl */ `
float bloomed = smoothstep(aPetalD.x, aPetalD.y, aState.x);
vec3 petal = petalPoint(position.x, position.y, bloomed);
// The width vanishes at the tip, so take the sideways slope just short of it.
float uSide = min(position.x, 0.96);
vec3 side = uSide < position.x ? petalPoint(uSide, position.y, bloomed) : petal;
vec3 objectNormal = normalize(cross(
  petalPoint(position.x + 0.01, position.y, bloomed) - petal,
  petalPoint(uSide, position.y + 0.02, bloomed) - side
));
vInner = aInner;
vState = aState;
vU = position.x;
`;

const PETAL_FRAGMENT_HEAD = /* glsl */ `
uniform float uGlow;
uniform vec3 uPeak;
varying vec3 vInner;
varying vec2 vState;
varying float vU;
`;

// The front face is the inside of the petal. Outside: the instance colour,
// shading darker toward the base. Inside: the inner colour, brightest at the
// heart, its tips reaching for the peak colour on the hardest hits.
const PETAL_COLOR = /* glsl */ `
vec3 face = vColor.rgb * mix(0.55, 1.05, vU);
if (gl_FrontFacing) {
  face = vInner * mix(1.3, 1.0, smoothstep(0.0, 0.55, vU));
  face = mix(face, uPeak, vState.y * smoothstep(0.5, 1.0, vU));
}
diffuseColor.rgb *= face;
`;

// The inside glows more the further the flower has opened.
const PETAL_GLOW = /* glsl */ `
totalEmissiveRadiance += face * uGlow * (gl_FrontFacing ? 0.35 + vState.x : 0.2);
`;

/** All of a form's petals as one geometry, for instancing. */
function petalGeometry(THREE, petals) {
  const U = 8;   // segments from base to tip
  const V = 4;   // segments across
  const per = (U + 1) * (V + 1);
  const n = petals.length * per;
  const position = new Float32Array(n * 3);
  const attrs = { aPetalA: new Float32Array(n * 4), aPetalB: new Float32Array(n * 4),
    aPetalC: new Float32Array(n * 4), aPetalD: new Float32Array(n * 4) };
  const index = [];
  petals.forEach((p, k) => {
    const A = [p.phi, p.r0 ?? 0, p.z0 ?? 0, p.len];
    const B = [...p.closed, ...p.open];
    const C = [p.width, ...p.cup, p.swirl ?? 0];
    const D = [...p.stage, p.mirror ?? 1, p.taper ?? 0];
    for (let i = 0; i <= U; i++) {
      for (let j = 0; j <= V; j++) {
        const at = k * per + i * (V + 1) + j;
        position.set([i / U, (j / V) * 2 - 1, 0], at * 3);
        attrs.aPetalA.set(A, at * 4);
        attrs.aPetalB.set(B, at * 4);
        attrs.aPetalC.set(C, at * 4);
        attrs.aPetalD.set(D, at * 4);
      }
    }
    // Wound so the front face is the one toward the axis: the inside.
    for (let i = 0; i < U; i++) {
      for (let j = 0; j < V; j++) {
        const q = k * per + i * (V + 1) + j;
        index.push(q, q + V + 1, q + 1, q + V + 1, q + V + 2, q + 1);
      }
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  for (const [name, array] of Object.entries(attrs)) {
    geometry.setAttribute(name, new THREE.BufferAttribute(array, 4));
  }
  geometry.setIndex(index);
  return geometry;
}

/** A helix strand as a curve, for the vine the flowers grow on. */
const helixCurve = (THREE, { radius, twist, length, offset }) => {
  const curve = new THREE.Curve();
  curve.getPoint = (t, out = new THREE.Vector3()) => {
    const s = t * length;
    const a = offset + s * twist;
    return out.set(Math.cos(a) * radius, Math.sin(a) * radius, -s);
  };
  return curve;
};

/**
 * HelixCorridor — flying down the axis of a spiral of unfolding buds.
 *
 * A few intertwined helical vines wind round the flight line, budded along
 * their length; the camera glides along it and the buds stream past on all
 * sides, the near ones huge, the far ones a spiral vanishing into the
 * distance. Every bud faces in toward the flight line and a little toward
 * the camera, so it opens toward you.
 *
 * The music unfolds them. Shut, a bud shows only the outside of its petals,
 * in the style's lineColor. A hit sends a wave of blooming racing away down
 * the corridor; each bud it passes uncurls its petals one whorl at a time,
 * outer first, revealing their insides in accentColor and a glowing heart,
 * then slowly folds shut again. A small hit only parts the outer petals; a
 * big one opens the whole flower, and the very hardest push the petal tips
 * and the heart to the peakColor. Loud passages hold every bud half open, so
 * a quiet corridor is a spiral of closed buds and a dense one is in flower:
 * the balance of the three colours is the music's.
 *
 * Nothing moves by jumps. Each bud's bloom follows its target on a damped
 * spring, so it opens over a few tenths of a second and settles rather than
 * snapping; the helix turns, buds slowly revolve and nod, and every rate is
 * integrated rather than multiplied by the clock, so changing one never
 * makes anything leap.
 *
 * Each bud keeps its angle round the helix as it approaches — the twist is
 * fixed to its position along the corridor, not to time — so what turns is
 * the whole spiral, by `spin`, and the strands read as solid structure you
 * are flying through rather than things orbiting you.
 *
 * Reactions:
 *
 *   ripple   a hit sends a wave of blooming down the corridor, opening the
 *            buds it passes as far as the hit was hard
 *   open     how far every bud stands open between hits, and how wide the
 *            corridor breathes
 *   spin     how fast the helix turns, and the buds revolve
 *   glow     how brightly the opened insides and hearts shine
 *
 * Distant buds fade to transparent rather than into a fog colour, so a
 * background layer shows through the far end of the corridor.
 *
 * Buds are placed on the CPU each frame — a few thousand matrices, which is
 * cheap — and bent open in the vertex shader of a stock lit material.
 */
export class HelixCorridor extends ThreeVisualization {
  static id = 'helix-corridor';
  static label = 'Helix Corridor';
  static description = 'Flight down a spiral vine of buds; hits send waves of blooming down the corridor, unfolding them into colour.';
  static category = CATEGORY.SPACES;
  static fallback = 'tunnel';

  static inputs = {
    ripple: { kind: 'event', default: TRIGGER.BASS },
    open:   { kind: 'level', default: { intensity: 'rms', smooth: 1.2 } },
    spin:   { kind: 'level', default: { intensity: 'mid', smooth: 0.6 } },
    glow:   { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
      smooth: 0.1,
    } },
  };

  static options = {
    palette: PALETTE_OPTION,
    shape: { kind: 'enum', values: SHAPES, default: 'lotus' },
    strands: { kind: 'number', default: 4, min: 1, max: 8, step: 1 },
    density: { kind: 'number', default: 150, min: 30, max: 400, step: 10 },
    radius: { kind: 'number', default: 2.4, min: 0.8, max: 6, step: 0.1 },
    twist: { kind: 'number', default: 0.32, min: 0, max: 1.5, step: 0.02 },
    size: { kind: 'number', default: 0.24, min: 0.05, max: 0.8, step: 0.01 },
    speed: { kind: 'number', default: 9, min: 1, max: 30, step: 0.5 },
  };

  static SPACING = 0.6;      // world units between buds along a strand
  static SPIN = [0.15, 0.9]; // helix turn rate: [idle, added at full spin]
  static WAVE_SPEED = 20;    // world units per second
  static WAVE_FADE = 0.3;    // per second, as the wave travels
  static LINGER = 0.6;       // seconds a hit holds a bud open before it starts to close
  static HOLD = 1.3;         // seconds, then, for it to fall most of the way shut
  static SPRING = 6.5;       // natural frequency of a bud's bloom, rad/s
  static DAMPING = 0.78;     // its damping ratio: settles with a breath of overshoot
  static TILT = 0.5;         // radians a bud faces toward the camera
  static VINE = 0.028;       // the vines' thickness (radius)

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    const { SPACING } = HelixCorridor;
    this.psychedelic = isPsychedelic(this);

    this.form = FORMS[this.option('shape')];
    this.strands = this.option('strands');
    this.perStrand = this.option('density');
    this.radius = this.option('radius');
    this.twist = this.option('twist');
    this.size = this.option('size');
    this.speed = this.option('speed');
    this.count = this.strands * this.perStrand;
    this.length = this.perStrand * SPACING;   // corridor length before it wraps
    const n = this.count;

    // Petals: bent open in the vertex shader, two-faced in the fragment.
    this.petalGlow = { value: 0.25 };
    this.peakUniform = { value: new THREE.Color() };
    const material = new THREE.MeshStandardMaterial({
      metalness: 0.1, roughness: 0.5, side: THREE.DoubleSide, flatShading: !!this.form.flat,
    });
    // Transparent double-sided materials otherwise draw twice, back then front.
    material.forceSinglePass = true;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uGlow = this.petalGlow;
      shader.uniforms.uPeak = this.peakUniform;
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', `${PETAL_VERTEX}\nvoid main() {`)
        .replace('#include <beginnormal_vertex>', PETAL_NORMAL)
        .replace('#include <begin_vertex>', 'vec3 transformed = petal;');
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', `${PETAL_FRAGMENT_HEAD}\nvoid main() {`)
        .replace('#include <color_fragment>', PETAL_COLOR)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${PETAL_GLOW}`);
    };
    fogToAlpha(material);
    // Programs are cached by onBeforeCompile's source, which these patch
    // wrappers share with other visualizations'; key this one apart.
    material.customProgramCacheKey = () => 'helix-corridor-petal';

    const geometry = petalGeometry(THREE, this.form.petals);
    this.inner = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.state = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2);
    this.inner.setUsage(THREE.DynamicDrawUsage);
    this.state.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aInner', this.inner);
    geometry.setAttribute('aState', this.state);
    this.mesh = new THREE.InstancedMesh(geometry, material, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.c = new THREE.Color();
    this.mesh.setColorAt(0, this.c);   // creates instanceColor before the first compile
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.mesh);

    // Hearts: the glowing cores an opening bud reveals.
    const heartMaterial = new THREE.MeshStandardMaterial({ metalness: 0, roughness: 0.3 });
    this.heartGlow = instanceGlow(heartMaterial, 0.4);
    fogToAlpha(heartMaterial);
    heartMaterial.customProgramCacheKey = () => 'helix-corridor-heart';
    this.hearts = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), heartMaterial, n);
    this.hearts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.hearts.frustumCulled = false;
    this.hearts.setColorAt(0, this.c);
    this.hearts.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.hearts);

    // Vines: one tube per strand, built once in the helix's own frame and
    // turned as a whole — travelling along a helix is the same as turning it.
    this.vineMaterial = new THREE.MeshStandardMaterial({ metalness: 0, roughness: 0.6 });
    fogToAlpha(this.vineMaterial);
    this.vines = Array.from({ length: this.strands }, (_, strand) => {
      const curve = helixCurve(THREE, {
        radius: this.radius, twist: this.twist, length: this.length,
        offset: (strand / this.strands) * TAU,
      });
      const tube = new THREE.TubeGeometry(curve, Math.ceil(this.length / 0.25), HelixCorridor.VINE, 5, false);
      const vine = new THREE.Mesh(tube, this.vineMaterial);
      vine.frustumCulled = false;
      this.scene.add(vine);
      return vine;
    });

    // Per bud, all it needs to move smoothly: its bloom and that bloom's
    // velocity (the spring), the hit holding it open and for how much
    // longer, where it was last frame, and how it revolves and nods.
    const rand = mulberry32(Math.floor(Math.random() * 1e9));
    this.bloom = new Float32Array(n);
    this.velocity = new Float32Array(n);
    this.held = new Float32Array(n);
    this.linger = new Float32Array(n);
    this.lastAhead = new Float32Array(n);
    this.turn = Float32Array.from({ length: n }, () => rand() * TAU);
    this.turnRate = Float32Array.from({ length: n }, () => (rand() - 0.5) * 0.6);
    this.seed = Float32Array.from({ length: n }, () => rand() * TAU);

    this.scene.fog = new THREE.Fog(0x000000, this.length * 0.35, this.length * 0.95);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    this.headlight = new THREE.PointLight(0xffffff, 9, 0, 0.6);
    this.scene.add(this.headlight);
    this.lamps = [0, 1].map(() => {
      const lamp = new THREE.PointLight(0xffffff, 14, 0, 1);
      this.scene.add(lamp);
      return lamp;
    });

    this.camera.fov = 75;
    this.camera.near = 0.05;
    this.camera.far = this.length + 10;
    this.camera.position.set(0, 0, 0);

    this.travel = 0;
    this.phase = 0;    // the helix's turn: twist × travel, plus spin
    this.spin = 0;
    this.spinRate = HelixCorridor.SPIN[0];
    this.time = 0;
    this.hue = rand();
    this.waves = [];   // { dist, prev, strength }

    this.white = new THREE.Color(1, 1, 1);
    this.outerColor = new THREE.Color();
    this.innerColor = new THREE.Color();
  }

  onInput(slot, data) {
    if (slot !== 'ripple') return;
    this.waves.push({ dist: 0, prev: 0, strength: impact(data) });
    if (this.waves.length > 6) this.waves.shift();
  }

  /** The outside and inside colours of a bud at palette position `t`. */
  budColors(t, outer, inner) {
    if (this.psychedelic) {
      paletteColor(this, t, outer);
      paletteColor(this, t + 0.45, inner);
      return;
    }
    // Style: outsides in lineColor, insides in accentColor, each drifting a
    // little toward the other along the corridor so the spiral isn't flat.
    const line = this.color(this.style.lineColor);
    const accent = this.color(this.style.accentColor ?? this.style.lineColor);
    const k = 0.5 + 0.5 * Math.sin(TAU * t);
    outer.copy(line).lerp(accent, 0.2 * k);
    inner.copy(accent).lerp(line, 0.2 * (1 - k));
  }

  draw(ctx, dt) {
    const {
      SPACING, SPIN, WAVE_SPEED, WAVE_FADE, LINGER, HOLD, SPRING, DAMPING, TILT, VINE,
    } = HelixCorridor;
    const { perStrand, twist, size, length: L } = this;
    const spinIn = this.in('spin');
    const openIn = clamp01(this.in('open'));
    this.time += dt;
    const step = this.speed * dt;
    this.travel += step;
    this.spinRate = approach(this.spinRate, SPIN[0] + spinIn * SPIN[1], 0.6, dt);
    this.spin += this.spinRate * dt;
    this.phase += step * twist + this.spinRate * dt;
    this.hue += dt * 0.03;
    for (const w of this.waves) {
      w.prev = w.dist;
      w.dist += WAVE_SPEED * dt;
      w.strength *= Math.exp(-dt * WAVE_FADE);
    }
    this.waves = this.waves.filter((w) => w.dist < L && w.strength > 0.03);

    const radius = this.radius * (1 + 0.12 * openIn);
    const resting = 0.03 + 0.3 * openIn;
    const settle = Math.exp(-dt / HOLD);
    const h = Math.min(dt, 1 / 30);   // spring step; a long frame just lags
    const turnBy = dt * (0.3 + spinIn * 1.5);
    const { heart } = this.form;
    const peakOn = this.style.peakColor != null;
    if (peakOn) this.peakUniform.value.copy(this.color(this.style.peakColor));

    const M = this.mesh.instanceMatrix.array;
    const H = this.hearts.instanceMatrix.array;
    const outerArr = this.mesh.instanceColor.array;
    const heartArr = this.hearts.instanceColor.array;
    const innerArr = this.inner.array;
    const stateArr = this.state.array;
    const { outerColor: outer, innerColor: inner, c } = this;

    for (let strand = 0; strand < this.strands; strand++) {
      const offset = (strand / this.strands) * TAU;
      for (let k = 0; k < perStrand; k++) {
        const i = strand * perStrand + k;
        // Distance ahead of the camera, wrapping so buds that pass behind
        // reappear at the far end.
        const ahead = ((k * SPACING - this.travel) % L + L) % L;

        let held = this.held[i];
        if (ahead > this.lastAhead[i] + 1) {
          // Wrapped round to the far end: a fresh bud.
          held = 0;
          this.bloom[i] = resting;
          this.velocity[i] = 0;
        } else {
          // Hold open a moment, so the petals finish unfolding, then close.
          if (this.linger[i] > 0) this.linger[i] -= dt;
          else held *= settle;
          for (const w of this.waves) {
            // The front passed this bud since last frame.
            if (w.dist >= ahead && w.prev < this.lastAhead[i] && w.strength > held) {
              held = w.strength;
              this.linger[i] = LINGER;
            }
          }
        }
        this.held[i] = held;
        this.lastAhead[i] = ahead;

        // Rest at the corridor's openness, breathing a little on its own;
        // a hit carries it toward fully open by as much as the hit was hard.
        const idle = resting + 0.06 * (0.5 + 0.5 * Math.sin(this.time * 0.4 + this.seed[i]));
        const target = idle + (1 - idle) * Math.min(1, held);
        let v = this.velocity[i];
        let b = this.bloom[i];
        v += (SPRING * SPRING * (target - b) - 2 * DAMPING * SPRING * v) * h;
        b += v * h;
        this.velocity[i] = v;
        this.bloom[i] = b;
        const heat = peakOn ? this.peakAmount(held) : 0;

        // The bud's frame: its axis points in toward the flight line and
        // tilted toward the camera, nodding slowly; it revolves about it.
        const angle = offset + ahead * twist + this.phase;
        const ca = Math.cos(angle);
        const sa = Math.sin(angle);
        const tilt = TILT + 0.15 * Math.sin(this.time * 0.3 + this.seed[i] * 1.7);
        const ct = Math.cos(tilt);
        const st = Math.sin(tilt);
        const ax = -ca * ct;
        const ay = -sa * ct;
        const az = st;
        // Across the helix, and the axis × that.
        const tx = -sa;
        const ty = ca;
        const bx = -az * ty;
        const by = az * tx;
        const bz = ax * ty - ay * tx;
        this.turn[i] += turnBy * this.turnRate[i];
        const cr = Math.cos(this.turn[i]);
        const sr = Math.sin(this.turn[i]);
        const s = size * (0.85 + 0.3 * Math.min(b, 1.2));
        // Seated on the vine's inner side, not threaded on it.
        const px = ca * radius + ax * VINE;
        const py = sa * radius + ay * VINE;
        const pz = -ahead + az * VINE;
        const o = i * 16;
        M[o] = (tx * cr + bx * sr) * s;
        M[o + 1] = (ty * cr + by * sr) * s;
        M[o + 2] = bz * sr * s;
        M[o + 3] = 0;
        M[o + 4] = (bx * cr - tx * sr) * s;
        M[o + 5] = (by * cr - ty * sr) * s;
        M[o + 6] = bz * cr * s;
        M[o + 7] = 0;
        M[o + 8] = ax * s;
        M[o + 9] = ay * s;
        M[o + 10] = az * s;
        M[o + 11] = 0;
        M[o + 12] = px;
        M[o + 13] = py;
        M[o + 14] = pz;
        M[o + 15] = 1;

        // The heart swells as the bud opens round it.
        const open = Math.min(1, Math.max(0, (b - 0.1) / 0.75));
        const hs = s * heart[0] * (0.3 + 0.7 * open * open * (3 - 2 * open));
        const hz = s * heart[1];
        H.fill(0, o, o + 15);
        H[o] = hs;
        H[o + 5] = hs;
        H[o + 10] = hs;
        H[o + 12] = px + ax * hz;
        H[o + 13] = py + ay * hz;
        H[o + 14] = pz + az * hz;
        H[o + 15] = 1;

        this.budColors(strand / this.strands * 0.5 + (ahead + this.travel) * 0.012 + this.hue, outer, inner);
        outerArr[i * 3] = outer.r;
        outerArr[i * 3 + 1] = outer.g;
        outerArr[i * 3 + 2] = outer.b;
        innerArr[i * 3] = inner.r;
        innerArr[i * 3 + 1] = inner.g;
        innerArr[i * 3 + 2] = inner.b;
        stateArr[i * 2] = b;
        stateArr[i * 2 + 1] = heat;
        // Heart: the inside colour lifted toward white, then the peak.
        c.copy(inner).lerp(this.white, 0.25);
        peakTint(this, c, held);
        heartArr[i * 3] = c.r;
        heartArr[i * 3 + 1] = c.g;
        heartArr[i * 3 + 2] = c.b;
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    this.hearts.instanceMatrix.needsUpdate = true;
    this.hearts.instanceColor.needsUpdate = true;
    this.inner.needsUpdate = true;
    this.state.needsUpdate = true;

    const glow = this.in('glow');
    this.petalGlow.value = 0.12 + glow * 0.45;
    this.heartGlow.value = 0.3 + glow * 0.6;

    // The vines turn with the helix and breathe with it.
    if (this.psychedelic) paletteColor(this, this.hue, this.vineMaterial.color);
    else this.vineMaterial.color.copy(this.color(this.style.lineColor));
    this.vineMaterial.color.multiplyScalar(0.45);
    for (const vine of this.vines) {
      vine.rotation.z = this.phase;
      vine.scale.set(radius / this.radius, radius / this.radius, 1);
    }

    // Two lamps drifting down the corridor ahead, and back, tinted toward
    // the two style colours — only tinted, since a saturated light on a
    // complementary petal would turn it black.
    this.lamps.forEach((lamp, n) => {
      const a = this.time * (0.5 + n * 0.23) + n * Math.PI;
      lamp.position.set(Math.cos(a) * 1.2, Math.sin(a) * 1.2, -(6 + (Math.sin(this.time * 0.3 + n * 2) * 0.5 + 0.5) * 20));
      paletteColor(this, this.hue + n * 0.5, c);
      lamp.color.copy(this.white).lerp(c, 0.45);
    });

    // Bank gently into the helix's turn.
    this.camera.rotation.z = Math.sin(this.spin * 0.5) * 0.25;
    if (this.camera.aspect !== this.width / this.height) {
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
    }
    this.present(ctx);
  }
}
