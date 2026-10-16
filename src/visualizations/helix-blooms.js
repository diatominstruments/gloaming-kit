import { instanceGlow, fogToAlpha } from './three-shared.js';

/**
 * Flowers for helix-corridor: buds that unfold petal by petal, bent open in
 * the vertex shader of a stock lit material. The corridor's structures place
 * them where their own unfolding is furthest along, so a bud only appears,
 * and opens, at the height of the music.
 */

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
export const BLOOM_SHAPES = Object.keys(FORMS);

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

const WHITE = [1, 1, 1];

/**
 * A pool of buds, refilled every frame: begin(), add() each bud that should
 * show, end(). Only the buds added are drawn.
 */
export class Blooms {
  constructor(viz, { capacity, shape }) {
    const THREE = viz.THREE;
    this.viz = viz;
    this.form = FORMS[shape] ?? FORMS[BLOOM_SHAPES[0]];
    this.capacity = capacity;
    this.n = 0;

    this.glow = { value: 0.25 };
    this.peak = { value: new THREE.Color() };
    const material = new THREE.MeshStandardMaterial({
      metalness: 0.1, roughness: 0.5, side: THREE.DoubleSide, flatShading: !!this.form.flat,
    });
    // Transparent double-sided materials otherwise draw twice, back then front.
    material.forceSinglePass = true;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uGlow = this.glow;
      shader.uniforms.uPeak = this.peak;
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
    this.inner = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.state = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    this.inner.setUsage(THREE.DynamicDrawUsage);
    this.state.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aInner', this.inner);
    geometry.setAttribute('aState', this.state);
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, new THREE.Color());   // creates instanceColor before the first compile
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    viz.scene.add(this.mesh);

    // Hearts: the glowing cores an opening bud reveals.
    const heartMaterial = new THREE.MeshStandardMaterial({ metalness: 0, roughness: 0.3 });
    this.heartGlow = instanceGlow(heartMaterial, 0.4);
    fogToAlpha(heartMaterial);
    heartMaterial.customProgramCacheKey = () => 'helix-corridor-heart';
    this.hearts = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), heartMaterial, capacity);
    this.hearts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.hearts.frustumCulled = false;
    this.hearts.setColorAt(0, new THREE.Color());
    this.hearts.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.hearts.count = 0;
    viz.scene.add(this.hearts);
  }

  begin() {
    this.n = 0;
  }

  /**
   * Show a bud at `p` ([x, y, z]), facing along the unit vector `axis`, with
   * `across` a unit vector perpendicular to it. `turn` revolves it about its
   * axis; `bloom` (0–1) is how far open; `heat` (0–1) how far its tips and
   * heart reach the peak colour. `outer` and `inner` are THREE.Colors for the
   * outsides and insides of its petals.
   */
  add(p, axis, across, turn, scale, bloom, heat, outer, inner) {
    if (this.n >= this.capacity || scale <= 0) return;
    const i = this.n++;
    const [ax, ay, az] = axis;
    const [tx, ty, tz] = across;
    // The third axis, axis × across.
    const bx = ay * tz - az * ty;
    const by = az * tx - ax * tz;
    const bz = ax * ty - ay * tx;
    const cr = Math.cos(turn);
    const sr = Math.sin(turn);
    const s = scale * (0.85 + 0.3 * Math.min(bloom, 1.2));
    const M = this.mesh.instanceMatrix.array;
    const o = i * 16;
    M[o] = (tx * cr + bx * sr) * s;
    M[o + 1] = (ty * cr + by * sr) * s;
    M[o + 2] = (tz * cr + bz * sr) * s;
    M[o + 3] = 0;
    M[o + 4] = (bx * cr - tx * sr) * s;
    M[o + 5] = (by * cr - ty * sr) * s;
    M[o + 6] = (bz * cr - tz * sr) * s;
    M[o + 7] = 0;
    M[o + 8] = ax * s;
    M[o + 9] = ay * s;
    M[o + 10] = az * s;
    M[o + 11] = 0;
    M[o + 12] = p[0];
    M[o + 13] = p[1];
    M[o + 14] = p[2];
    M[o + 15] = 1;

    // The heart swells as the bud opens round it.
    const [heartRadius, heartHeight] = this.form.heart;
    const open = Math.min(1, Math.max(0, (bloom - 0.1) / 0.75));
    const hs = s * heartRadius * (0.3 + 0.7 * open * open * (3 - 2 * open));
    const hz = s * heartHeight;
    const H = this.hearts.instanceMatrix.array;
    H.fill(0, o, o + 15);
    H[o] = hs;
    H[o + 5] = hs;
    H[o + 10] = hs;
    H[o + 12] = p[0] + ax * hz;
    H[o + 13] = p[1] + ay * hz;
    H[o + 14] = p[2] + az * hz;
    H[o + 15] = 1;

    const outerArr = this.mesh.instanceColor.array;
    const innerArr = this.inner.array;
    const heartArr = this.hearts.instanceColor.array;
    const peak = this.peak.value;
    for (let c = 0; c < 3; c++) {
      const key = 'rgb'[c];
      outerArr[i * 3 + c] = outer[key];
      innerArr[i * 3 + c] = inner[key];
      // Heart: the inside colour lifted toward white, then the peak.
      const lifted = inner[key] + (WHITE[c] - inner[key]) * 0.25;
      heartArr[i * 3 + c] = lifted + (peak[key] - lifted) * heat;
    }
    this.state.array[i * 2] = bloom;
    this.state.array[i * 2 + 1] = heat;
  }

  /** Upload what was added. `glow` is the visualization's glow level, 0–1. */
  end(glow) {
    const { viz } = this;
    if (viz.style.peakColor != null) this.peak.value.copy(viz.color(viz.style.peakColor));
    this.glow.value = 0.12 + glow * 0.45;
    this.heartGlow.value = 0.3 + glow * 0.6;
    this.mesh.count = this.n;
    this.hearts.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    this.hearts.instanceMatrix.needsUpdate = true;
    this.hearts.instanceColor.needsUpdate = true;
    this.inner.needsUpdate = true;
    this.state.needsUpdate = true;
  }
}
