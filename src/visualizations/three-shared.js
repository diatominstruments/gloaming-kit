/**
 * Pieces the native 3D visualizations share: a colour palette that works in
 * shaders and in JS alike, two material patches, and spectrum sampling.
 */

/**
 * The `palette` option every native 3D visualization takes.
 *
 *   'style'        (default) cycles between the style's lineColor and
 *                  accentColor, so the scene wears the window's palette like
 *                  everything else
 *   'psychedelic'  a full cycling rainbow, independent of the style colours
 */
export const PALETTE_OPTION = Object.freeze({
  kind: 'enum', values: ['style', 'psychedelic'], default: 'style',
});

/**
 * The `distance` option for visualizations that look at an object rather
 * than flying through a space (nebula, tesseract). The first three hold the
 * camera at a fixed distance, as multiples of the visualization's own; the
 * last is a flight path — see Swoop.
 */
export const DISTANCE_OPTION = Object.freeze({
  kind: 'enum', values: ['near', 'med', 'far', 'orbit'], default: 'orbit',
});
const DISTANCES = { near: 0.6, med: 1, far: 1.6 };

/**
 * Where the camera is relative to the object it watches, advanced each frame.
 *
 * At a fixed distance it circles slowly. On `orbit` it flies a true
 * elliptical orbit with the object at one focus, moving as a planet does
 * (Kepler's equation): it drifts slowly along the far end of the ellipse,
 * accelerates as it falls in, whips round the object at the closest point
 * and climbs away out the other side. The close pass is a fly-by that keeps
 * going, not a dive that reverses back out the way it came — which is what
 * varying only the distance gives, however it is eased. The ellipse's axis
 * turns a little every loop, so passes come in from different directions.
 *
 * During the pass, aim() turns the camera partway toward where it is
 * heading, so the object sweeps across the frame rather than staying pinned
 * to the centre while the background spins behind it.
 *
 *   const swoop = new Swoop(this.options.distance, { near: 0.35, far: 2.4 });
 *   swoop.update(dt, rate);   // rate: radians/s round the object when circling
 *   swoop.scale      // distance, as a multiple of the visualization's own
 *   swoop.angle      // heading round the object
 *   swoop.close      // 0 far off → 1 at the closest point of the pass
 *   swoop.aim(camera, target)
 */
export class Swoop {
  /**
   * `near` and `far` are the orbit's closest and farthest distance, as
   * multiples of the visualization's own; `period` is seconds per loop.
   */
  constructor(mode, { near = 0.35, far = 2.4, period = 26 } = {}) {
    if (mode !== undefined && !DISTANCE_OPTION.values.includes(mode)) {
      console.warn(`GloamingKit: distance '${mode}'; expected ${DISTANCE_OPTION.values.join('|')}`);
    }
    this.mode = DISTANCE_OPTION.values.includes(mode) ? mode : DISTANCE_OPTION.default;
    this.a = (far + near) / 2;                  // semi-major axis
    this.e = (far - near) / (far + near);       // eccentricity
    this.b = this.a * Math.sqrt(1 - this.e * this.e);
    this.near = near;
    this.far = far;
    this.n = (Math.PI * 2) / period;            // mean motion
    // Eccentric anomaly: 0 at the closest point. Start on the way in, so the
    // first pass comes early.
    this.E = -2.2;
    this.axis = Math.random() * Math.PI * 2;    // heading of the ellipse's axis
    this.angle = Math.random() * Math.PI * 2;
    this.scale = DISTANCES[this.mode] ?? 1;
    this.close = 0;
    this.last = null;                           // camera position last frame
  }

  update(dt, rate) {
    if (this.mode !== 'orbit') {
      this.angle += dt * rate;
      return;
    }
    // dE/dt = n·a/r is Kepler's equation differentiated: fast when close.
    const r = this.a * (1 - this.e * Math.cos(this.E));
    this.E += dt * this.n * (this.a / r);
    this.axis += dt * rate * 0.3;
    // Position relative to the focus, in the orbit's plane.
    const x = this.a * (Math.cos(this.E) - this.e);
    const y = this.b * Math.sin(this.E);
    this.scale = Math.hypot(x, y);
    this.angle = this.axis + Math.atan2(y, x);
    this.close = (this.far - this.scale) / (this.far - this.near);
  }

  /**
   * Point `camera` at `target` (a THREE.Vector3) — or, during a close pass,
   * partway toward where the camera is heading. Call after positioning it.
   */
  aim(camera, target) {
    const pos = camera.position;
    const last = this.last;
    this.last = pos.clone();
    const lead = this.mode === 'orbit' ? 0.55 * this.close * this.close : 0;
    if (!last || lead < 1e-3) {
      camera.lookAt(target);
      return;
    }
    const heading = pos.clone().sub(last);
    if (heading.lengthSq() < 1e-12) {
      camera.lookAt(target);
      return;
    }
    const ahead = pos.clone().add(heading.normalize().multiplyScalar(pos.distanceTo(target)));
    camera.lookAt(target.clone().lerp(ahead, lead));
  }
}

/**
 * GLSL for the palette: `palette(t)` is periodic in t with period 1. Declares
 * the uniforms paletteUniforms() creates.
 */
export const PALETTE_GLSL = /* glsl */ `
uniform float uPsy;
uniform vec3 uLine;
uniform vec3 uAccent;
uniform vec3 uBg;

vec3 palette(float t) {
  vec3 psy = 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
  vec3 sty = mix(uLine, uAccent, 0.5 + 0.5 * sin(6.28318 * t));
  return mix(sty, psy, uPsy);
}
`;

export const paletteUniforms = (THREE) => ({
  uPsy: { value: 1 },
  uLine: { value: new THREE.Color() },
  uAccent: { value: new THREE.Color() },
  uBg: { value: new THREE.Color() },
});

/** Resolve the `palette` option once, at construction. */
export const isPsychedelic = (viz) => (viz.options.palette ?? PALETTE_OPTION.default) !== 'style';

/** Copy the live style into palette uniforms; call once per frame. */
export function updatePalette(viz, u) {
  const s = viz.style;
  u.uPsy.value = viz.psychedelic ? 1 : 0;
  u.uLine.value.copy(viz.color(s.lineColor));
  u.uAccent.value.copy(viz.color(s.accentColor ?? s.lineColor));
  u.uBg.value.copy(viz.color(s.background));
}

/** palette(t) in JS, into the THREE.Color `out` — for instance colours. */
export function paletteColor(viz, t, out) {
  const TAU = Math.PI * 2;
  if (viz.psychedelic) {
    return out.setRGB(
      0.5 + 0.5 * Math.cos(TAU * t),
      0.5 + 0.5 * Math.cos(TAU * (t + 0.33)),
      0.5 + 0.5 * Math.cos(TAU * (t + 0.67)),
    );
  }
  const k = 0.5 + 0.5 * Math.sin(TAU * t);
  return out.copy(viz.color(viz.style.lineColor))
    .lerp(viz.color(viz.style.accentColor ?? viz.style.lineColor), k);
}

/**
 * Make a lit material glow in each instance's own colour: adds
 * `instanceColor × uGlow.value` to its emission. Lit materials otherwise have
 * one emissive colour for the whole mesh. The uniform is returned so the
 * caller can drive it (e.g. brighter on hits).
 */
export function instanceGlow(material, initial = 0.3) {
  const uGlow = { value: initial };
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.uniforms.uGlow = uGlow;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uGlow;\nvoid main() {')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n#ifdef USE_COLOR\n  totalEmissiveRadiance += vColor.rgb * uGlow;\n#endif',
      );
  };
  return uGlow;
}

/**
 * Replace a material's fog with a fade to transparent. Ordinary fog blends
 * toward a fixed colour, which paints a wall of that colour over whatever 2D
 * layer is underneath; fading alpha instead lets distant geometry dissolve
 * into it. Uses the scene's Fog near/far. Makes the material transparent.
 */
export function fogToAlpha(material) {
  material.transparent = true;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_fragment>',
      '#ifdef USE_FOG\n  gl_FragColor.a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);\n#endif',
    );
  };
}

/** Vertex shader for a full-screen quad (a 2×2 PlaneGeometry); passes vUv. */
export const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Average the spectrum into `out.length` log-spaced bins, 0–1 each, as
 * eq-bars does: each bin starts where the last ended and takes at least one
 * FFT bin, so the low end isn't all one value.
 */
export function logSpectrum(spectrum, out) {
  const n = out.length;
  if (!spectrum) return out.fill(0);
  // The top of an analyser's range is mostly empty; stop at ~16 kHz.
  const top = Math.floor(spectrum.length * 0.75);
  let lo = 1;   // skip the DC bin
  for (let i = 0; i < n; i++) {
    const hi = Math.min(top, Math.max(lo + 1, Math.floor(Math.pow(top, (i + 1) / n))));
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += spectrum[j];
    out[i] = hi > lo ? sum / ((hi - lo) * 255) : 0;
    lo = hi;
  }
  return out;
}
