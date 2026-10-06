import { withThree } from './three-base.js';

/**
 * pointCloud3D — the 3D renderer for a PointCloudAttractor subclass.
 *
 *   export class DeJong3D extends pointCloud3D(DeJong) { static id = 'attractor-3d'; … }
 *
 * Like flowRibbon, the result *is* the 2D class — same map, parameters,
 * lift into depth, rotation options and PointCloudAttractor.advance() — with
 * only draw() replaced, so the two turn identically. What the GPU adds:
 * points size and dim with depth, the near side leans toward the accent
 * colour, and many more of them.
 *
 * Because points are cheap on the GPU, the cloud keeps the last CLOUD points
 * rather than only this frame's, iterating PER_FRAME each frame; older points
 * fade, so a morph dissolves into the new shape instead of popping. The
 * `points` option scales both by the same factor it scales the 2D cloud, and
 * `dot` scales the point size.
 */
export const pointCloud3D = (Base) => class extends withThree(Base) {
  static fallback = Base;

  static PER_FRAME = 12000;   // orbit iterations per frame
  static CLOUD = 60000;       // points retained; ~5 frames of history
  static SIZE = 1.6;          // point diameter in CSS px at the figure's centre
  static POINT_ALPHA = 0.55;  // per-point alpha before additive blending
  static DEPTH_FADE = 0.6;    // as flowRibbon: how much the far side dims

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    const { DEPTH_FADE, POINT_ALPHA, PER_FRAME, CLOUD, POINTS, DOT } = this.constructor;
    // The `points` option is in 2D terms; the GPU cloud scales with it.
    const density = this.pointCount / POINTS;
    this.perFrame = Math.round(PER_FRAME * density);
    this.cloudSize = Math.round(CLOUD * density);
    this.size = this.constructor.SIZE * (this.dot / DOT);

    this.write = 0;   // next ring-buffer slot
    this.filled = 0;

    this.cloud = new Float32Array(this.cloudSize * 3);
    this.attribute = new THREE.BufferAttribute(this.cloud, 3).setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.attribute);
    geometry.setDrawRange(0, 0);

    this.uniforms = {
      uYaw: { value: new THREE.Vector2(1, 0) },
      uPitch: { value: new THREE.Vector2(1, 0) },
      uSwell: { value: 1 },
      uFocal: { value: this.constructor.FOCAL },
      uSize: { value: 1 },
      uHead: { value: 0 },
      uCount: { value: 1 },
      uAlpha: { value: POINT_ALPHA },
      uDepthFade: { value: DEPTH_FADE },
      uLine: { value: new THREE.Color() },
      uAccent: { value: new THREE.Color() },
      uAccentMix: { value: 0 },
      uPeak: { value: new THREE.Color() },
      uPeakMix: { value: 0 },
    };

    const points = new THREE.Points(geometry, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // Premultiplied additive, as nebula: dense regions brighten, the way
      // the 2D cloud's overlapping dots do, with nothing to sort.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    }));
    points.frustumCulled = false;   // positions are moved by the shader
    this.points = points;
    this.scene.add(points);
  }

  /** Run the map PER_FRAME times into the ring buffer. */
  iterate() {
    const { SEED, LIMIT } = this.constructor;
    const { perFrame: PER_FRAME, cloudSize: CLOUD } = this;
    const p = this.params;
    const out = this.out;
    const cloud = this.cloud;
    let x = this.x;
    let y = this.y;
    let px = this.px;
    let py = this.py;
    let w = this.write;
    for (let i = 0; i < PER_FRAME; i++) {
      this.step(x, y, p, out);
      px = x;
      py = y;
      x = out[0];
      y = out[1];
      // As the 2D loop: a failed `<` so NaN reseeds too.
      if (!(Math.abs(x) < LIMIT && Math.abs(y) < LIMIT)) {
        x = px = SEED[0];
        y = py = SEED[1];
        continue;
      }
      const j = w * 3;
      cloud[j] = x;
      cloud[j + 1] = y;
      cloud[j + 2] = this.depth(px, py, x, y) * this.lift;
      w = (w + 1) % CLOUD;
    }
    this.filled = Math.min(CLOUD, this.filled + PER_FRAME);
    this.x = x;
    this.y = y;
    this.px = px;
    this.py = py;
    this.write = w;
    this.attribute.needsUpdate = true;
  }

  draw(ctx, dt) {
    const { FOCAL } = this.constructor;
    const { scale: SCALE, size: SIZE } = this;
    const { width: w, height: h } = this;
    this.advance(dt);
    if (!w || !h) return;
    this.iterate();

    // Same fov derivation as flowRibbon, so face-on the figure is the size
    // SCALE gives it in 2D.
    const scale = Math.min(w, h) * SCALE;
    const fov = (2 * Math.atan(h / (2 * scale * FOCAL)) * 180) / Math.PI;
    const cam = this.camera;
    if (cam.fov !== fov || cam.aspect !== w / h) {
      cam.fov = fov;
      cam.aspect = w / h;
      cam.near = FOCAL * 0.1;
      cam.far = FOCAL * 10;
      cam.updateProjectionMatrix();
    }

    const u = this.uniforms;
    u.uYaw.value.set(Math.cos(this.yaw), Math.sin(this.yaw));
    u.uPitch.value.set(Math.cos(this.pitch), Math.sin(this.pitch));
    u.uSwell.value = this.swell;
    u.uSize.value = SIZE * this.pixelScale();
    u.uHead.value = this.write;
    u.uCount.value = this.filled;
    u.uLine.value.copy(this.color(this.style.lineColor));
    u.uAccent.value.copy(this.color(this.style.accentColor ?? this.style.lineColor));
    u.uAccentMix.value = this.accentMix();
    // As the 2D cloud: the hardest hits push it on to the peak colour.
    u.uPeakMix.value = this.peakAmount(u.uAccentMix.value);
    if (u.uPeakMix.value > 0) u.uPeak.value.copy(this.color(this.style.peakColor));
    this.points.geometry.setDrawRange(0, this.filled);

    const baseAlpha = ctx.globalAlpha;
    ctx.globalAlpha = baseAlpha * this.brightness();
    this.present(ctx);
    ctx.globalAlpha = baseAlpha;
  }
};

const VERTEX = /* glsl */ `
uniform vec2 uYaw;
uniform vec2 uPitch;
uniform float uSwell;
uniform float uFocal;
uniform float uSize;
uniform float uHead;
uniform float uCount;

varying float vAge;
varying float vPersp;

void main() {
  // 1 for the newest point, falling toward 0 for the oldest. The ring buffer
  // is written forward from uHead, so distance behind it is age.
  float behind = mod(uHead - float(gl_VertexID) - 1.0 + uCount, uCount);
  vAge = 1.0 - behind / uCount;

  vec3 q = position * uSwell;
  float rx = q.x * uYaw.x - q.z * uYaw.y;
  float rz = q.x * uYaw.y + q.z * uYaw.x;
  float ry = q.y * uPitch.x - rz * uPitch.y;
  float rzp = q.y * uPitch.y + rz * uPitch.x;
  // Camera space, y flipped as in flowRibbon: the 2D figure's y points down.
  vec3 view = vec3(rx, -ry, -(uFocal + rzp));

  float persp = uFocal / max(-view.z, 1e-3);
  vPersp = persp;
  gl_Position = projectionMatrix * vec4(view, 1.0);
  gl_PointSize = clamp(uSize * persp, 1.0, 8.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uLine;
uniform vec3 uAccent;
uniform float uAccentMix;
uniform vec3 uPeak;
uniform float uPeakMix;
uniform float uAlpha;
uniform float uDepthFade;

varying float vAge;
varying float vPersp;

void main() {
  // Soft round dot rather than the default square.
  vec2 d = gl_PointCoord - 0.5;
  float cover = 1.0 - smoothstep(0.25, 0.5, length(d));
  // Near side leans toward the accent colour, so depth reads in colour too,
  // and the accent slot pushes the whole cloud further: at full strength
  // the far side is mostly accent and the near side entirely.
  float near = clamp((vPersp - 1.0) * 3.0 + 0.5, 0.0, 1.0);
  vec3 color = mix(uLine, uAccent, clamp(near * 0.6 + uAccentMix * 0.7, 0.0, 1.0));
  color = mix(color, uPeak, uPeakMix);
  float alpha = uAlpha * cover * vAge
    * mix(1.0, clamp(vPersp, 0.0, 1.0), uDepthFade);
  gl_FragColor = vec4(color * alpha, alpha);
}
`;
