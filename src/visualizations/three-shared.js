/**
 * Pieces the native 3D visualizations share: a colour palette that works in
 * shaders and in JS alike, two material patches, and spectrum sampling.
 */

/**
 * The `palette` option every native 3D visualization takes.
 *
 *   'psychedelic'  a full cycling rainbow, independent of the style colours
 *   'style'        cycles between the style's lineColor and accentColor, so
 *                  the scene wears the window's palette like everything else
 */
export const PALETTE_OPTION = Object.freeze({
  kind: 'enum', values: ['psychedelic', 'style'], default: 'psychedelic',
});

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
