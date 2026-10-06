import { withThree } from './three-base.js';

/**
 * flowRibbon — the 3D renderer for a FlowAttractor subclass.
 *
 *   export class Thomas3D extends flowRibbon(Thomas) { static id = 'thomas-3d'; … }
 *
 * The result *is* the 2D class — same equation, parameters, inputs, options
 * and FlowAttractor.advance() — with only draw() replaced, so a 3D attractor
 * and its 2D fallback move identically and differ only in how they look.
 *
 * The camera transform is the 2D one ported to a vertex shader rather than
 * rebuilt from three.js objects, so framing, SCALE, FOCAL and the distance
 * presets all carry over unchanged. What the GPU adds is real depth:
 *
 *   - Line width follows perspective. A strand passing the camera at `near`
 *     swells to several times the style's lineWidth; the far side thins.
 *     WIDTH_RANGE bounds the multiplier.
 *   - The far side dims with distance (DEPTH_FADE), so the figure reads as a
 *     solid with a front and back rather than a flat tangle.
 *   - The near plane clips each segment exactly instead of dropping every
 *     segment that touches it, so strands run to the edge of the frame
 *     instead of stopping short.
 *   - The tail fades continuously, not in the 2D renderer's CHUNKS steps.
 *
 * Each segment of the trail is one instanced quad, expanded to the line width
 * in screen space. WebGL's own lines are fixed at one device pixel, which is
 * why this doesn't use them.
 */
export const flowRibbon = (Base) => class extends withThree(Base) {
  static fallback = Base;

  // Perspective width multiplier, [min, max]. 1 is the style's lineWidth, at
  // the depth of the figure's centre.
  static WIDTH_RANGE = [0.5, 4];
  // 0 = no depth dimming; 1 = alpha falls off with perspective (a strand at
  // twice the centre's distance is drawn at half the alpha).
  static DEPTH_FADE = 0.7;

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    const { CHUNKS, CENTER, WIDTH_RANGE, DEPTH_FADE } = this.constructor;
    const TRAIL = this.trailLength;

    // The ring buffer unrolled tail → head each frame, so instance i is the
    // segment from sample i to sample i + 1: two views on one buffer, offset
    // by one sample.
    this.points = new Float32Array(TRAIL * 3);
    this.pointBuffer = new THREE.InstancedInterleavedBuffer(this.points, 3, 1)
      .setUsage(THREE.DynamicDrawUsage);

    const geometry = new THREE.InstancedBufferGeometry();
    // A unit quad: x picks the segment's start (0) or end (1), y the side.
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(
      [0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0], 3,
    ));
    geometry.setIndex([0, 2, 1, 2, 3, 1]);
    geometry.setAttribute('instanceStart', new THREE.InterleavedBufferAttribute(this.pointBuffer, 3, 0));
    geometry.setAttribute('instanceEnd', new THREE.InterleavedBufferAttribute(this.pointBuffer, 3, 3));
    geometry.instanceCount = 0;

    this.uniforms = {
      uCenter: { value: new THREE.Vector3(...CENTER) },
      uYaw: { value: new THREE.Vector2(1, 0) },     // (cos, sin)
      uPitch: { value: new THREE.Vector2(1, 0) },
      uTwist: { value: 0 },
      uSwell: { value: 1 },
      uFocal: { value: this.focal },
      uNear: { value: this.focal * this.constructor.NEAR },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uWidth: { value: 2 },
      uWidthRange: { value: new THREE.Vector2(...WIDTH_RANGE) },
      uSegments: { value: 1 },
      uRange: { value: new THREE.Vector2(0, 1) },
      // Same split as the 2D renderer: its last chunk is the accent-coloured,
      // glowing head.
      uHeadFrom: { value: 1 - 1 / CHUNKS },
      uDepthFade: { value: DEPTH_FADE },
      uLine: { value: new THREE.Color() },
      uAccent: { value: new THREE.Color() },
      // The head leans toward the peak colour while a hard hit's kick lasts.
      uPeak: { value: new THREE.Color() },
      uPeakMix: { value: 0 },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      // Painter's order, tail to head, like the 2D stroke; nothing to sort.
      depthTest: false,
      depthWrite: false,
    });

    this.ribbon = new THREE.Mesh(geometry, material);
    // Positions are moved by the shader, so the geometry's bounds mean nothing.
    this.ribbon.frustumCulled = false;
    this.scene.add(this.ribbon);
  }

  /** Copy the ring buffer into `points`, oldest first. At most two copies. */
  unroll() {
    const TRAIL = this.trailLength;
    const start = (this.head - this.count + TRAIL) % TRAIL;
    const first = Math.min(this.count, TRAIL - start);
    this.points.set(this.trail.subarray(start * 3, (start + first) * 3), 0);
    if (first < this.count) {
      this.points.set(this.trail.subarray(0, (this.count - first) * 3), first * 3);
    }
    this.pointBuffer.needsUpdate = true;
  }

  draw(ctx, dt) {
    this.advance(dt);
    const { width: w, height: h } = this;
    if (this.count < 2 || !w || !h) return;
    this.unroll();

    // The 2D projection is screen = centre + view * scale * focal / depth;
    // a perspective camera gives screen = view * (h / 2) / tan(fov / 2) / depth.
    // Equating them fixes the field of view.
    const { NEAR } = this.constructor;
    const scale = Math.min(w, h) * this.scale;
    const fov = (2 * Math.atan(h / (2 * scale * this.focal)) * 180) / Math.PI;
    const cam = this.camera;
    if (cam.fov !== fov || cam.aspect !== w / h) {
      cam.fov = fov;
      cam.aspect = w / h;
      // Under the shader's own clip, so it never cuts first.
      cam.near = this.focal * NEAR * 0.5;
      cam.far = this.focal * 20;
      cam.updateProjectionMatrix();
    }

    const u = this.uniforms;
    u.uYaw.value.set(Math.cos(this.yaw), Math.sin(this.yaw));
    u.uPitch.value.set(Math.cos(this.pitch), Math.sin(this.pitch));
    u.uTwist.value = this.twist;
    u.uSwell.value = this.swell;
    u.uResolution.value.set(w, h);
    u.uWidth.value = this.style.lineWidth ?? 2;
    u.uSegments.value = this.count - 1;
    u.uLine.value.copy(this.color(this.style.lineColor));
    u.uAccent.value.copy(this.color(this.style.accentColor ?? this.style.lineColor));
    u.uPeakMix.value = this.peakAmount(this.kick);
    if (u.uPeakMix.value > 0) u.uPeak.value.copy(this.color(this.style.peakColor));
    this.ribbon.geometry.instanceCount = this.count - 1;

    const baseAlpha = ctx.globalAlpha;
    ctx.globalAlpha = baseAlpha * this.brightness();
    const glow = this.style.shadowBlur ?? 0;
    if (glow > 0) {
      // Two passes so only the head glows, as in 2D: a blur over the whole
      // ribbon would cost the same and wash the body out.
      u.uRange.value.set(0, u.uHeadFrom.value);
      this.present(ctx);
      u.uRange.value.set(u.uHeadFrom.value, 1);
      this.present(ctx, { glow });
    } else {
      u.uRange.value.set(0, 1);
      this.present(ctx);
    }
    ctx.globalAlpha = baseAlpha;
  }
};

const VERTEX = /* glsl */ `
attribute vec3 instanceStart;
attribute vec3 instanceEnd;

uniform vec3 uCenter;
uniform vec2 uYaw;
uniform vec2 uPitch;
uniform float uTwist;
uniform float uSwell;
uniform float uFocal;
uniform float uNear;
uniform vec2 uResolution;
uniform float uWidth;
uniform vec2 uWidthRange;
uniform float uSegments;
uniform vec2 uRange;

varying float vAge;
varying float vPersp;

// Outside the clip volume, so the whole quad is discarded.
const vec4 CULLED = vec4(2.0, 2.0, 2.0, 1.0);

// FlowAttractor.draw()'s transform, as-is: twist by height, swell, yaw,
// pitch. Returns camera space — camera at the origin looking down -z — with y
// flipped, since the 2D version's screen y points down.
vec3 toView(vec3 p) {
  vec3 q = p - uCenter;
  float ta = uTwist * q.y;
  float tc = cos(ta);
  float ts = sin(ta);
  float x = (q.x * tc - q.z * ts) * uSwell;
  float z = (q.x * ts + q.z * tc) * uSwell;
  float y = q.y * uSwell;
  float rx = x * uYaw.x - z * uYaw.y;
  float rz = x * uYaw.y + z * uYaw.x;
  float ry = y * uPitch.x - rz * uPitch.y;
  float rzp = y * uPitch.y + rz * uPitch.x;
  return vec3(rx, -ry, -(uFocal + rzp));
}

void main() {
  // 0 at the tail, 1 at the head.
  float age = (float(gl_InstanceID) + 1.0) / uSegments;
  vAge = age;
  if (age <= uRange.x || age > uRange.y) {
    gl_Position = CULLED;
    return;
  }

  vec3 a = toView(instanceStart);
  vec3 b = toView(instanceEnd);

  // Clip to the near plane. Past it the perspective divide blows up and then
  // flips sign, so a segment crossing it is cut where it crosses.
  float zn = -uNear;
  if (a.z > zn && b.z > zn) {
    gl_Position = CULLED;
    return;
  }
  if (a.z > zn) a = mix(a, b, (zn - a.z) / (b.z - a.z));
  if (b.z > zn) b = mix(b, a, (zn - b.z) / (a.z - b.z));

  vec4 ca = projectionMatrix * vec4(a, 1.0);
  vec4 cb = projectionMatrix * vec4(b, 1.0);

  // Expand to the line width in screen space (CSS px).
  vec2 halfRes = uResolution * 0.5;
  vec2 dir = cb.xy / cb.w * halfRes - ca.xy / ca.w * halfRes;
  float len = length(dir);
  dir = len > 1e-5 ? dir / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);

  bool isEnd = position.x > 0.5;
  vec4 clip = isEnd ? cb : ca;
  float persp = uFocal / -(isEnd ? b.z : a.z);
  vPersp = persp;
  float width = uWidth * clamp(persp, uWidthRange.x, uWidthRange.y);
  clip.xy += normal * position.y * (width * 0.5) / halfRes * clip.w;
  gl_Position = clip;
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uLine;
uniform vec3 uAccent;
uniform vec3 uPeak;
uniform float uPeakMix;
uniform float uHeadFrom;
uniform float uDepthFade;

varying float vAge;
varying float vPersp;

void main() {
  vec3 color = vAge > uHeadFrom ? mix(uAccent, uPeak, uPeakMix) : uLine;
  // age² matches the 2D ribbon's fade; perspective dims the far side.
  float alpha = vAge * vAge * mix(1.0, clamp(vPersp, 0.0, 1.0), uDepthFade);
  gl_FragColor = vec4(color, alpha);
}
`;
