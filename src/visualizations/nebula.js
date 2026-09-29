import { ThreeVisualization } from './three-base.js';
import { impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';
import { mulberry32 } from '../noise.js';
import {
  PALETTE_OPTION, PALETTE_GLSL, paletteUniforms, updatePalette, isPsychedelic,
} from './three-shared.js';

const SHOCKS = 4;

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
 * fine dust, and the orbit swings the camera from outside the cloud to just
 * inside its rim.
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
    swirl:   { kind: 'level', default: { intensity: 'mid', smooth: 0.8 } },
    twinkle: { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
      smooth: 0.08,
    } },
  };

  static options = {
    palette: PALETTE_OPTION,
    count: { kind: 'number', default: 150000, min: 10000, max: 400000, step: 10000 },
  };

  static RADIUS = 10;          // world units
  static ARMS = 3;
  static WIND = 5.5;           // radians of arm twist from core to rim
  static SWIRL = [0.05, 0.25]; // arm turn rate: [idle, added at full swirl]
  static ORBIT = [0.03, 0.08]; // camera orbit rate, rad/s
  static SHOCK_SPEED = 9;      // world units/s
  static SHOCK_DECAY = 0.7;

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    const { ARMS, WIND } = Nebula;
    this.psychedelic = isPsychedelic(this);

    const count = Math.round(this.options.count ?? Nebula.options.count.default);
    const rand = mulberry32(Math.floor(Math.random() * 1e9));
    const gauss = () => {
      // Box–Muller; good enough for scattering motes.
      const u = Math.max(1e-6, rand());
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    };

    // (radius 0–1, angle, height, random): everything the shader needs.
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      let r;
      let angle;
      let height;
      const kind = rand();
      if (kind < 0.1) {
        // Halo: a loose sphere around everything.
        r = 0.3 + rand() * 0.9;
        angle = rand() * Math.PI * 2;
        height = gauss() * 0.45;
      } else if (kind < 0.2) {
        // Bulge: a round glow at the core. Its own population, because
        // thickening the arms near the centre makes a tall thin column
        // instead — lots of height on almost no radius.
        const x = gauss() * 0.1;
        const z = gauss() * 0.1;
        r = Math.hypot(x, z);
        angle = Math.atan2(z, x);
        height = gauss() * 0.08;
      } else {
        // Arms: wound further with radius, spread wider toward the core.
        r = Math.pow(rand(), 0.75);
        const arm = Math.floor(rand() * ARMS);
        angle = (arm / ARMS) * Math.PI * 2 + r * WIND + gauss() * (0.1 + 0.25 * (1 - r));
        height = gauss() * (0.02 + 0.04 * (1 - r));
      }
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
      uTwinkle: { value: 0 },
      uPixels: { value: 1 },
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
    this.hue = rand();
    this.shocks = [];   // { radius, strength }
    this.camera.fov = 60;
    this.camera.near = 0.05;
    this.camera.far = 200;
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
    this.swirl += dt * (SWIRL[0] + swirl * SWIRL[1]);
    this.orbit += dt * (ORBIT[0] + swirl * ORBIT[1]);
    this.hue += dt * 0.02;

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

    // Swing in toward the rim and back out, rising high over the disc and
    // sinking toward it — but staying above it, since edge-on the arms
    // collapse into a line. Closer than about 1.5 radii the near motes blur
    // over everything and the arms leave the frame.
    const dist = RADIUS * (2.0 + 0.5 * Math.sin(this.orbit * 0.9 + 1));
    const lift = 0.45 + 0.75 * (0.5 + 0.5 * Math.sin(this.orbit * 0.63));   // 26°–69° above the disc
    const cam = this.camera;
    cam.position.set(
      Math.cos(this.orbit) * dist * Math.cos(lift),
      Math.sin(lift) * dist,
      Math.sin(this.orbit) * dist * Math.cos(lift),
    );
    cam.lookAt(0, 0, 0);
    if (cam.aspect !== this.width / this.height) {
      cam.aspect = this.width / this.height;
      cam.updateProjectionMatrix();
    }

    updatePalette(this, u);
    u.uTime.value = this.time;
    u.uSwirl.value = this.swirl;
    u.uHue.value = this.hue;
    u.uTwinkle.value = this.in('twinkle');
    // World size → device pixels at unit distance, for gl_PointSize.
    const fov = (cam.fov * Math.PI) / 180;
    u.uPixels.value = (this.height * this.pixelScale()) / (2 * Math.tan(fov / 2));
    this.present(ctx);
  }
}

const VERTEX = /* glsl */ `
${PALETTE_GLSL}
attribute vec4 seed;   // (radius 0–1, angle, height, random)

uniform float uRadius;
uniform float uTime;
uniform float uSwirl;
uniform float uHue;
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

  float size = 0.09 * (0.4 + seed.w * 1.2) * (1.0 + lit * 1.5);
  float px = size * uPixels / max(-mv.z, 0.05);
  gl_PointSize = clamp(px, 1.5, 90.0);

  // Brighter toward the core; sparkling with the treble.
  float twinkle = 1.0 - uTwinkle * 0.7 * (0.5 + 0.5 * sin(uTime * 9.0 + seed.w * 400.0));
  float bright = (0.5 + 2.5 * exp(-r * 3.0)) * twinkle * (1.0 + lit * 2.0);
  // Spread a big close mote's light over its area, as defocus would.
  bright *= min(1.0, 9.0 / (px * px));
  vec3 base = palette(r * 0.7 + seed.w * 0.12 + uHue);
  vColor = base * bright;
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
