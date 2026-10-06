import { ThreeVisualization } from './three-base.js';
import { impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';
import { mulberry32 } from '../noise.js';
import {
  PALETTE_OPTION, PALETTE_GLSL, paletteUniforms, updatePalette, isPsychedelic,
  DISTANCE_OPTION, Swoop,
} from './three-shared.js';

const SHOCKS = 4;
const TAU = Math.PI * 2;

/*
 * Shapes. Each places one mote, returning [radius, angle, height] in
 * cylindrical coordinates about the spin axis, in units of RADIUS. The
 * shader turns everything about that axis, so every shape swirls, flows and
 * takes shockwaves the same way; only where the motes start differs.
 *
 * `g` carries the random sources and the `arms` option.
 */

// A loose sphere around everything.
const halo = (g) => [0.3 + g.rand() * 0.9, g.rand() * TAU, g.gauss() * 0.45];

// A round glow at the centre. Its own population, because thickening a disc
// toward its centre makes a tall thin column instead — lots of height on
// almost no radius.
const bulge = (g, size = 0.1) => {
  const x = g.gauss() * size;
  const z = g.gauss() * size;
  return [Math.hypot(x, z), Math.atan2(z, x), g.gauss() * size * 0.8];
};

// One mote on a spiral arm, wound further with radius and spread wider
// toward the core; arms begin at `from` (a bar's end, or the centre).
const arm = (g, from = 0, wind = 5.5) => {
  const r = from + (1 - from) * Math.pow(g.rand(), 0.75);
  const k = Math.floor(g.rand() * g.arms);
  const along = r - from;
  return [
    r,
    (k / g.arms) * TAU + along * wind + g.gauss() * (0.1 + 0.25 * (1 - along)),
    g.gauss() * (0.02 + 0.04 * (1 - r)),
  ];
};

const SHAPES = {
  // Arms wound out from a round core.
  spiral: (g) => {
    const k = g.rand();
    if (k < 0.1) return halo(g);
    if (k < 0.2) return bulge(g);
    return arm(g);
  },

  // A straight bar through the core, with the arms trailing from its ends.
  // Reads best with two arms.
  barred: (g) => {
    const k = g.rand();
    if (k < 0.08) return halo(g);
    if (k < 0.16) return bulge(g, 0.07);
    if (k < 0.36) {
      const x = (g.rand() * 2 - 1) * 0.32;
      return [Math.abs(x) + Math.abs(g.gauss()) * 0.02, x < 0 ? Math.PI : 0, g.gauss() * 0.03];
    }
    return arm(g, 0.32, 4.5);
  },

  // A bright core inside a detached ring, with a faint disc between them —
  // Hoag's Object.
  ring: (g) => {
    const k = g.rand();
    if (k < 0.08) return halo(g);
    if (k < 0.22) return bulge(g, 0.08);
    if (k < 0.35) return [Math.pow(g.rand(), 0.5) * 0.55, g.rand() * TAU, g.gauss() * 0.02];
    return [0.75 + g.gauss() * 0.05, g.rand() * TAU, g.gauss() * 0.03];
  },

  // A whirlpool: arms spiralling down a funnel that narrows into a drain
  // falling away below it.
  vortex: (g) => {
    const k = g.rand();
    if (k < 0.1) {
      return [Math.abs(g.gauss()) * 0.03, g.rand() * TAU, -0.3 - Math.pow(g.rand(), 0.7) * 0.9];
    }
    const [r, angle] = arm(g, 0.03, 7);
    return [r, angle, 0.45 - 0.75 * Math.pow(1 - r, 2.2) + g.gauss() * 0.015];
  },

  // A thin disc round a blazing core, firing two twisting jets out of its
  // poles — a quasar.
  quasar: (g) => {
    const k = g.rand();
    if (k < 0.08) return halo(g);
    if (k < 0.18) return bulge(g, 0.05);
    if (k < 0.55) return [0.08 + Math.pow(g.rand(), 0.6) * 0.62, g.rand() * TAU, g.gauss() * 0.01];
    // Jets: two strands each, corkscrewing and widening as they go.
    const side = g.rand() < 0.5 ? -1 : 1;
    const along = Math.pow(g.rand(), 0.7) * 1.3;
    const strand = g.rand() < 0.5 ? 0 : Math.PI;
    return [
      0.015 + along * 0.07 + Math.abs(g.gauss()) * 0.015,
      strand + along * 9 + g.gauss() * 0.25,
      side * (0.04 + along),
    ];
  },

  // A planetary nebula: a hollow hourglass shell thrown off by a small hot
  // star, pinched at the waist and swelling into two lobes.
  shell: (g) => {
    const k = g.rand();
    if (k < 0.07) return bulge(g, 0.03);
    if (k < 0.17) return halo(g);
    const cos = g.rand() * 2 - 1;
    const sin = Math.sqrt(1 - cos * cos);
    const rho = 0.38 * (1 + 1.4 * cos * cos) * (1 + g.gauss() * 0.04);
    return [rho * sin, g.rand() * TAU, rho * cos];
  },
};

/**
 * Nebula — a swirling cloud of light the camera drifts around and through.
 *
 * A hundred and fifty thousand motes in spiral arms around a bright core,
 * wrapped in a thin halo. Nothing about their motion is simulated on the
 * CPU: each mote is a fixed seed, and the vertex shader turns seed and time
 * into a position — orbiting faster near the core, so the arms wind — plus a
 * flowing displacement that combs the arms into filaments. That is what lets
 * the count be this high; a frame only uploads a few numbers.
 *
 * Depth is the point of it. Motes are sized by distance, so the ones the
 * camera passes near swell into soft out-of-focus discs (dimmed to keep
 * their total light constant, like bokeh) while the far side of the cloud is
 * fine dust.
 *
 * Option `distance` sets where the camera watches from: `near`, `med` or
 * `far` circle the cloud at a fixed range, and `orbit` (the default) flies a
 * loop — hanging far back with the whole galaxy small in frame, then diving
 * in over the disc and sweeping across it close enough to fly through the
 * outer arms, before climbing away again. See Swoop in three-shared.js.
 *
 * Reactions:
 *
 *   shock    a hit launches a shell outward from the core that shoves and
 *            lights every mote it passes through
 *   swirl    how fast the arms turn and the camera orbits
 *   twinkle  per-mote sparkle
 *
 * Motes are drawn additively, so dense regions bloom into light on their own
 * without a post-process pass.
 */
export class Nebula extends ThreeVisualization {
  static id = 'nebula';
  static label = 'Nebula';
  static description = 'A spiral cloud of 150k motes the camera drifts through; hits send glowing shockwaves out from the core.';
  static category = CATEGORY.SPACES;
  static fallback = 'particles';

  static inputs = {
    shock:   { kind: 'event', default: TRIGGER.BASS },
    // Drives the colour: waves of colour flow outward through the cloud at a
    // rate set by this band, and the accent spreads further when it's loud.
    // Rebind to follow another band: `bind: { color: { intensity: 'bass' } }`.
    color:   { kind: 'level', default: {
      sum: [{ intensity: 'highMid', gain: 0.6 }, { relative: 'highMid', gain: 0.4 }],
      smooth: 0.2,
    } },
    swirl:   { kind: 'level', default: { intensity: 'mid', smooth: 0.8 } },
    twinkle: { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
      smooth: 0.08,
    } },
  };

  static options = {
    palette: PALETTE_OPTION,
    distance: DISTANCE_OPTION,
    shape: { kind: 'enum', values: Object.keys(SHAPES), default: 'spiral' },
    arms: { kind: 'number', default: 3, min: 1, max: 6, step: 1 },
    count: { kind: 'number', default: 150000, min: 10000, max: 400000, step: 10000 },
    size: { kind: 'number', default: 1, min: 0.3, max: 3, step: 0.1 },
    swirl: { kind: 'number', default: 1, min: 0, max: 3, step: 0.1 },
  };

  static RADIUS = 10;          // world units
  static SWIRL = [0.05, 0.25]; // arm turn rate: [idle, added at full swirl]
  static ORBIT = [0.03, 0.08]; // camera orbit rate at `med`, rad/s
  static VIEW = 2;             // camera distance at `med`, in radii
  // Colour waves flowing outward, in palette cycles per second: [idle,
  // added at full `color`].
  static COLOR_FLOW = [0.04, 0.5];
  static SHOCK_SPEED = 9;      // world units/s
  static SHOCK_DECAY = 0.7;

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    this.psychedelic = isPsychedelic(this);

    const count = this.option('count');
    this.swirlRate = this.option('swirl');
    const rand = mulberry32(Math.floor(Math.random() * 1e9));
    const g = {
      rand,
      // Box–Muller; good enough for scattering motes.
      gauss: () => Math.sqrt(-2 * Math.log(Math.max(1e-6, rand()))) * Math.cos(TAU * rand()),
      arms: this.option('arms'),
    };
    const shapeName = this.options.shape ?? Nebula.options.shape.default;
    if (!(shapeName in SHAPES)) {
      console.warn(`GloamingKit: nebula shape '${shapeName}'; expected ${Object.keys(SHAPES).join('|')}`);
    }
    const place = SHAPES[shapeName] ?? SHAPES.spiral;

    // (radius, angle, height, random): everything the shader needs.
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const [r, angle, height] = place(g);
      seeds.set([r, angle, height, rand()], i * 4);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('seed', new THREE.Float32BufferAttribute(seeds, 4));
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));

    this.uniforms = {
      ...paletteUniforms(THREE),
      uRadius: { value: Nebula.RADIUS },
      uTime: { value: 0 },
      uSwirl: { value: 0 },
      uHue: { value: 0 },
      uColor: { value: 0 },
      uTwinkle: { value: 0 },
      uPixels: { value: 1 },
      uMote: { value: this.option('size') },
      uShocks: { value: Array.from({ length: SHOCKS }, () => new THREE.Vector2(-1e3, 0)) },
    };
    const points = new THREE.Points(geometry, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // Premultiplied additive: the shader has already scaled colour by
      // coverage, so add it straight in. Alpha accumulates too, so dense
      // regions cover what's beneath a little rather than only brightening it.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    }));
    points.frustumCulled = false;
    this.scene.add(points);

    this.time = 0;
    this.swirl = 0;
    this.orbit = rand() * Math.PI * 2;
    // Down to 0.35 × 2 radii: over the disc, inside the outer arms.
    this.swoop = new Swoop(this.options.distance, { near: 0.35, far: 2.3, period: 28 });
    this.hue = rand();
    this.shocks = [];   // { radius, strength }
    this.camera.fov = 60;
    this.camera.near = 0.05;
    this.camera.far = 200;
    this.center = new THREE.Vector3();
  }

  onInput(slot, data) {
    if (slot !== 'shock') return;
    this.shocks.push({ radius: 0, strength: impact(data) });
    if (this.shocks.length > SHOCKS) this.shocks.shift();
  }

  draw(ctx, dt) {
    const { RADIUS, SWIRL, ORBIT, SHOCK_SPEED, SHOCK_DECAY } = Nebula;
    const swirl = this.in('swirl');
    this.time += dt;
    this.swirl += dt * (SWIRL[0] + swirl * SWIRL[1]) * this.swirlRate;
    this.orbit += dt * (ORBIT[0] + swirl * ORBIT[1]);
    this.swoop.update(dt, ORBIT[0] + swirl * ORBIT[1]);
    // Colour phase, integrated: the band sets how fast the colour waves flow
    // outward, never where they are, so a loud frame speeds them rather
    // than jumping them.
    const color = this.in('color');
    this.hue += dt * (Nebula.COLOR_FLOW[0] + color * Nebula.COLOR_FLOW[1]);

    const u = this.uniforms;
    for (let i = 0; i < SHOCKS; i++) {
      const s = this.shocks[i];
      if (s) {
        s.radius += SHOCK_SPEED * dt;
        s.strength *= Math.exp(-dt * SHOCK_DECAY);
        u.uShocks.value[i].set(s.radius, s.strength);
      } else {
        u.uShocks.value[i].set(-1e3, 0);
      }
    }
    this.shocks = this.shocks.filter((s) => s.radius < RADIUS * 2.5);

    // Rising high over the disc and sinking toward it — but staying above it,
    // since edge-on the arms collapse into a line. On a close pass it sinks
    // lower still, so the sweep skims across the arms.
    const { scale, angle, close } = this.swoop;
    const dist = RADIUS * Nebula.VIEW * scale * (1 + 0.12 * Math.sin(this.orbit * 0.9 + 1));
    const lift = (0.45 + 0.75 * (0.5 + 0.5 * Math.sin(this.orbit * 0.63))) * (1 - 0.45 * close);
    const cam = this.camera;
    cam.position.set(
      Math.cos(angle) * dist * Math.cos(lift),
      Math.sin(lift) * dist,
      Math.sin(angle) * dist * Math.cos(lift),
    );
    this.swoop.aim(cam, this.center);
    if (cam.aspect !== this.width / this.height) {
      cam.aspect = this.width / this.height;
      cam.updateProjectionMatrix();
    }

    updatePalette(this, u);
    u.uTime.value = this.time;
    u.uSwirl.value = this.swirl;
    u.uHue.value = this.hue;
    u.uColor.value = color;
    u.uTwinkle.value = this.in('twinkle');
    // World size → device pixels at unit distance, for gl_PointSize.
    const fov = (cam.fov * Math.PI) / 180;
    u.uPixels.value = (this.height * this.pixelScale()) / (2 * Math.tan(fov / 2));
    this.present(ctx);
  }
}

const VERTEX = /* glsl */ `
${PALETTE_GLSL}
uniform float uMote;   // mote size multiplier (the size option)
attribute vec4 seed;   // (radius 0–1, angle, height, random)

uniform float uRadius;
uniform float uTime;
uniform float uSwirl;
uniform float uHue;      // colour phase; advancing it moves the waves outward
uniform float uColor;    // the colour band's level
uniform float uTwinkle;
uniform float uPixels;
uniform vec2 uShocks[${SHOCKS}];   // (radius, strength)

varying vec3 vColor;

// A cheap divergence-ish flow: sums of sines on crossed axes, so neighbouring
// motes drift together and the arms comb into filaments.
vec3 flow(vec3 p, float t) {
  return vec3(
    sin(p.y * 1.7 + t) + sin(p.z * 2.3 - t * 0.7),
    sin(p.z * 1.9 + t * 0.8) + sin(p.x * 2.1 + t * 0.5),
    sin(p.x * 1.5 - t * 0.6) + sin(p.y * 2.7 + t * 0.9)
  );
}

void main() {
  float r = seed.x;
  // The arms turn rigidly, plus a twist that winds and unwinds. True
  // differential rotation (core faster than rim) never stops winding, and
  // within a minute the arms would smear into a featureless disc.
  float angle = seed.y + uSwirl + sin(uSwirl * 0.8) * 0.6 * (1.0 - r);
  vec3 p = vec3(cos(angle) * r, seed.z, sin(angle) * r) * uRadius;
  p += flow(p * 0.35, uTime * 0.25) * (0.1 + 0.25 * r);

  // Shock shells: a band around each radius shoves motes outward and lights them.
  float lit = 0.0;
  float dist = length(p);
  vec3 outward = p / max(dist, 1e-3);
  for (int k = 0; k < ${SHOCKS}; k++) {
    float band = dist - uShocks[k].x;
    float hitBy = exp(-band * band * 1.2) * uShocks[k].y;
    p += outward * hitBy * 0.7;
    lit += hitBy;
  }

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float size = 0.09 * uMote * (0.4 + seed.w * 1.2) * (1.0 + lit * 1.5);
  float px = size * uPixels / max(-mv.z, 0.05);
  gl_PointSize = clamp(px, 1.5, 90.0);

  // Brighter toward the core; sparkling with the treble.
  float twinkle = 1.0 - uTwinkle * 0.7 * (0.5 + 0.5 * sin(uTime * 9.0 + seed.w * 400.0));
  // Distance from the centre — not the spin axis, or a quasar's jets would
  // all shine as bright as its core. Measured after the shocks, so the
  // motes a shell shoves outward carry their colour with them.
  float along = length(p) / uRadius;
  float bright = (0.5 + 2.5 * exp(-along * 3.0)) * twinkle * (1.0 + lit * 2.0);
  // Spread a big close mote's light over its area, as defocus would.
  bright *= min(1.0, 9.0 / (px * px));
  // Colour by distance from the centre minus the phase, so bands of colour
  // ripple outward through every shape.
  vec3 base = palette(along * 1.3 - uHue + seed.w * 0.08 + lit * 0.3);
  base *= 0.75 + uColor * 0.7;
  // Motes a strong shock passes through flare toward the peak colour.
  vColor = peak(base, lit) * bright;
}
`;

const FRAGMENT = /* glsl */ `
varying vec3 vColor;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.0, 1.0, d);
  gl_FragColor = vec4(vColor * a * a, a * a * 0.35);
}
`;
