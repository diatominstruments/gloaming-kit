import { Visualization } from './base.js';

/**
 * Tunnel — rings rush toward the viewer. Each ring is extruded from the
 * waveform at the moment it spawned, so the tunnel walls are a rolling
 * record of the sound. The whole tunnel slowly rotates, faster when the
 * high end is busy.
 *
 * Travel speed is deliberately constant — driving it from the audio makes
 * the approach stutter. The song shows up in the ring shapes and in the
 * rotation, whose rate is smoothed so it glides rather than jitters.
 */
export class Tunnel extends Visualization {
  static id = 'tunnel';

  static inputs = {
    spin: { kind: 'level', default: 'treble' },
  };

  static Z_NEAR = 0.14;
  static Z_FAR = 4;
  static SPACING = 0.34;
  static SEGMENTS = 48;
  static SPEED = 0.75;   // world units per second
  static SPIN_SMOOTHING = 3;   // higher = rotation tracks treble more tightly

  constructor(opts) {
    super(opts);
    this.rings = [];       // { z, shape: Float32Array }
    this.sinceSpawn = Tunnel.SPACING;   // spawn one immediately
    this.rotation = 0;
    this.spinRate = 0;
  }

  captureShape() {
    const { SEGMENTS } = Tunnel;
    const shape = new Float32Array(SEGMENTS);
    const wf = this.frame?.waveform;
    if (!wf) return shape;
    const stride = wf.length / SEGMENTS;
    for (let i = 0; i < SEGMENTS; i++) {
      let sum = 0;
      const s0 = Math.floor(i * stride);
      const s1 = Math.floor((i + 1) * stride);
      for (let j = s0; j < s1; j++) sum += wf[j] - 128;
      shape[i] = sum / ((s1 - s0) * 128);
    }
    // Crossfade the tail into the head so the ring closes without a seam.
    const blend = 8;
    for (let i = 0; i < blend; i++) {
      const t = i / blend;
      shape[SEGMENTS - blend + i] = shape[SEGMENTS - blend + i] * (1 - t) + shape[0] * t;
    }
    return shape;
  }

  draw(ctx, dt) {
    const { Z_NEAR, Z_FAR, SPACING, SEGMENTS, SPEED, SPIN_SMOOTHING } = Tunnel;
    const cx = this.width / 2;
    const cy = this.height / 2;
    const focal = Math.min(this.width, this.height) * 0.14;

    const target = 0.15 + this.in('spin') * 1.2;
    this.spinRate += (target - this.spinRate) * Math.min(1, dt * SPIN_SMOOTHING);
    this.rotation += dt * this.spinRate;

    for (const r of this.rings) r.z -= SPEED * dt;
    this.rings = this.rings.filter((r) => r.z > Z_NEAR);
    this.sinceSpawn += SPEED * dt;
    while (this.sinceSpawn >= SPACING) {
      this.sinceSpawn -= SPACING;
      // Back-date by the overshoot so ring spacing is independent of where
      // frame boundaries happen to fall.
      this.rings.push({ z: Z_FAR - this.sinceSpawn, shape: this.captureShape() });
    }

    this.applyStyle(ctx);
    const sorted = [...this.rings].sort((a, b) => b.z - a.z);
    for (const ring of sorted) {
      const radius = focal / ring.z;
      const depth = 1 - (ring.z - Z_NEAR) / (Z_FAR - Z_NEAR); // 0 far → 1 near
      const alpha = Math.pow(depth, 1.6);

      ctx.globalAlpha *= alpha;
      ctx.strokeStyle = depth > 0.82 ? (this.style.accentColor ?? this.style.lineColor) : this.style.lineColor;
      ctx.beginPath();
      for (let i = 0; i <= SEGMENTS; i++) {
        const idx = i % SEGMENTS;
        const a = this.rotation + (idx / SEGMENTS) * Math.PI * 2;
        const r = radius * (1 + ring.shape[idx] * 0.45);
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha /= alpha;
    }
  }
}
