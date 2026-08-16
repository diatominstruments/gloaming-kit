import { Visualization, approach } from './base.js';
import { sampleTrace, sampleEnvelope, expandEnvelope, signsOf } from './shape.js';

/** Crossfade the tail into the head so the ring closes without a seam. */
const closeSeam = (shape, blend = 8) => {
  const n = shape.length;
  for (let i = 0; i < blend; i++) {
    const t = i / blend;
    shape[n - blend + i] = shape[n - blend + i] * (1 - t) + shape[0] * t;
  }
  return shape;
};

/**
 * Tunnel — rings rush toward the viewer. Each ring is extruded from the
 * waveform at the moment it spawned, so the tunnel walls are a rolling
 * record of the sound. The whole tunnel slowly rotates, faster when the
 * high end is busy.
 *
 * Every LIVE_EVERY'th ring is *live*: rather than keeping its birth snapshot
 * it goes on tracking the music for its whole flight, easing toward the
 * current envelope on a slow time constant. The wall reads as a record with
 * a few ribs still flexing in it.
 *
 * The slowness is the point. A ring that follows the audio frame-for-frame
 * (see the `waveform` visualization) reads as jumpy, so live rings are
 * deliberately damped — see LIVE_TAU.
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

  // --- live rings (tune these by eye) ---
  static LIVE_EVERY = 3;    // 1 ring in N keeps tracking the music; 0 disables
  static LIVE_TAU = 0.45;   // seconds to cover most of the way to the current
                            // envelope. Larger = smoother and lazier; below
                            // ~0.15 it starts to look like the jumpy waveform.
  static LIVE_GAIN = 0.8;   // envelope → trace-sized displacement, so live
                            // rings sit at the same scale as frozen ones.
  static LIVE_FLOOR = 0.06; // envelope below this reads as silence, so the
                            // ring has something to relax back to. Raise until
                            // quiet passages round the ring out; too high and
                            // only the loudest peaks deform it at all.

  constructor(opts) {
    super(opts);
    this.rings = [];       // { z, shape: Float32Array, signs|null }
    this.sinceSpawn = Tunnel.SPACING;   // spawn one immediately
    this.rotation = 0;
    this.spinRate = 0;
    this.spawned = 0;      // counts every ring ever spawned, for the live stride
  }

  /**
   * Ease every live ring toward the current envelope. One envelope is sampled
   * per frame and shared: they're all reading the same instant, and they
   * differ because each keeps its own silhouette and its own lag.
   */
  updateLive(dt) {
    const { SEGMENTS, LIVE_TAU, LIVE_GAIN, LIVE_FLOOR } = Tunnel;
    if (!this.rings.some((r) => r.signs)) return;
    // Expanded once here, not per ring — every live ring reads the same instant.
    const env = expandEnvelope(sampleEnvelope(this.frame?.waveform, SEGMENTS), LIVE_FLOOR);
    for (const ring of this.rings) {
      if (!ring.signs) continue;
      const target = new Float32Array(SEGMENTS);
      for (let i = 0; i < SEGMENTS; i++) target[i] = ring.signs[i] * env[i] * LIVE_GAIN;
      // The seam has to be re-closed on the *target*, not once at birth —
      // otherwise easing toward an open shape reopens the kink at the top of
      // the ring within a second or so.
      closeSeam(target);
      for (let i = 0; i < SEGMENTS; i++) {
        ring.shape[i] = approach(ring.shape[i], target[i], LIVE_TAU, dt);
      }
    }
  }

  draw(ctx, dt) {
    const { Z_NEAR, Z_FAR, SPACING, SEGMENTS, SPEED, SPIN_SMOOTHING, LIVE_EVERY } = Tunnel;
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
      const shape = closeSeam(sampleTrace(this.frame?.waveform, SEGMENTS));
      const live = LIVE_EVERY > 0 && this.spawned % LIVE_EVERY === 0;
      this.spawned++;
      // Back-date by the overshoot so ring spacing is independent of where
      // frame boundaries happen to fall.
      this.rings.push({
        z: Z_FAR - this.sinceSpawn,
        shape,
        signs: live ? signsOf(shape) : null,
      });
    }

    this.updateLive(dt);
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
