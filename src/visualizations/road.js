import { Visualization } from './base.js';

/**
 * Road — perspective motion visualization. Transverse "rungs" spawn at the
 * horizon carrying a snapshot of the waveform at that moment, then fly
 * toward the viewer, so the road surface is the song's recent history
 * rendered as stacked oscilloscope traces.
 *
 * Travel speed is deliberately constant: tying it to the audio makes the
 * perspective motion stutter, since loudness swings frame to frame. The
 * song shows up in the shape of each rung, not in how fast it approaches.
 */
export class Road extends Visualization {
  static id = 'road';

  static inputs = {
    swell: { kind: 'level', default: 'rms' },
  };

  static Z_NEAR = 1.5;
  static Z_FAR = 30;
  static SPACING = 1.2;
  static SEGMENTS = 64;
  static SPEED = 9;     // world units per second

  constructor(opts) {
    super(opts);
    this.rungs = [];      // { z, shape: Float32Array, level }
    this.sinceSpawn = Road.SPACING;   // spawn one immediately
  }

  captureShape() {
    const { SEGMENTS } = Road;
    const shape = new Float32Array(SEGMENTS);
    const wf = this.frame?.waveform;
    if (!wf) return shape;
    const stride = wf.length / SEGMENTS;
    for (let i = 0; i < SEGMENTS; i++) {
      // Average the slice so single-sample spikes don't dominate.
      let sum = 0;
      const s0 = Math.floor(i * stride);
      const s1 = Math.floor((i + 1) * stride);
      for (let j = s0; j < s1; j++) sum += wf[j] - 128;
      shape[i] = sum / ((s1 - s0) * 128);
    }
    return shape;
  }

  draw(ctx, dt) {
    const { Z_NEAR, Z_FAR, SPACING, SEGMENTS, SPEED } = Road;
    const w = this.width;
    const h = this.height;
    const cx = w / 2;
    const horizonY = h * 0.42;
    const K = (h - horizonY) * Z_NEAR;   // projection: y = horizonY + K/z
    const W = w * 0.55 * Z_NEAR;         // road half-width in world units

    const level = this.in('swell');

    // Advance and spawn rungs.
    for (const r of this.rungs) r.z -= SPEED * dt;
    this.rungs = this.rungs.filter((r) => r.z > Z_NEAR * 0.75);
    this.sinceSpawn += SPEED * dt;
    while (this.sinceSpawn >= SPACING) {
      this.sinceSpawn -= SPACING;
      // Back-date the spawn by however far past the interval we landed, so
      // rungs stay exactly SPACING apart no matter where frame edges fall.
      this.rungs.push({ z: Z_FAR - this.sinceSpawn, shape: this.captureShape(), level });
    }

    this.applyStyle(ctx);

    // Converging road edges.
    ctx.globalAlpha *= 0.6;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx, horizonY);
      ctx.lineTo(cx + (side * W) / Z_NEAR, horizonY + K / Z_NEAR);
      ctx.stroke();
    }
    ctx.globalAlpha /= 0.6;

    // Waveform rungs, far to near so near ones draw on top.
    const sorted = [...this.rungs].sort((a, b) => b.z - a.z);
    for (const rung of sorted) {
      const y0 = horizonY + K / rung.z;
      const half = W / rung.z;
      // Loudness captured with the shape, so a rung keeps the size it was
      // born with instead of the whole road breathing on the current frame.
      const amp = h * 0.16 * (Z_NEAR / rung.z) * (0.4 + rung.level * 1.2);
      const fade = Math.min(1, (Z_FAR - rung.z) / (Z_FAR * 0.25));

      ctx.globalAlpha *= fade;
      ctx.beginPath();
      for (let i = 0; i < SEGMENTS; i++) {
        const x = cx - half + (i / (SEGMENTS - 1)) * half * 2;
        const y = y0 - rung.shape[i] * amp;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha /= fade;
    }
  }
}
