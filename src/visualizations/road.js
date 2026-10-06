import { Visualization, approach } from './base.js';
import { CATEGORY } from './categories.js';
import { sampleTrace, sampleEnvelope, expandEnvelope, signsOf } from './shape.js';

/**
 * Road — perspective motion visualization. Transverse "rungs" spawn at the
 * horizon carrying a snapshot of the waveform at that moment, then fly
 * toward the viewer, so the road surface is the song's recent history
 * rendered as stacked oscilloscope traces.
 *
 * Every LIVE_EVERY'th rung is *live*: instead of keeping its birth snapshot
 * it keeps tracking the music for its whole flight, easing toward the current
 * envelope on a slow time constant. The road reads as history with a few
 * threads still moving through it, rather than a conveyor of frozen frames.
 *
 * The slowness is the point. A line that follows the audio frame-for-frame
 * (see the `waveform` visualization) reads as jumpy, so live rungs are
 * deliberately damped — see LIVE_TAU.
 *
 * Travel speed is deliberately constant: tying it to the audio makes the
 * perspective motion stutter, since loudness swings frame to frame. The
 * song shows up in the shape of each rung, not in how fast it approaches.
 */
export class Road extends Visualization {
  static id = 'road';
  static label = 'Road';
  static description = 'Rungs captured from the waveform fly toward the viewer from the horizon.';
  static category = CATEGORY.MOTION;

  static inputs = {
    // Mostly loudness, so a quiet passage lays down a low road, with enough
    // of the beat on top that hits still stand out as taller rungs in it.
    swell: { kind: 'level', default: {
      sum: [{ intensity: 'rms', gain: 0.6 }, { relative: 'rms', gain: 0.4 }],
    } },
  };

  static Z_NEAR = 1.5;
  static Z_FAR = 30;
  static SPACING = 1.2;
  static SEGMENTS = 64;
  static SPEED = 9;     // world units per second
  static HORIZON = 0.42;   // of the height, from the top

  static options = {
    speed:    { kind: 'number', default: Road.SPEED, min: 1, max: 30, step: 0.5 },
    spacing:  { kind: 'number', default: Road.SPACING, min: 0.3, max: 4, step: 0.1 },
    segments: { kind: 'number', default: Road.SEGMENTS, min: 16, max: 256, step: 8 },
    horizon:  { kind: 'number', default: Road.HORIZON, min: 0.2, max: 0.7, step: 0.01 },
  };

  // --- live rungs (tune these by eye) ---
  static LIVE_EVERY = 3;    // 1 rung in N keeps tracking the music; 0 disables
  static LIVE_TAU = 0.15;   // seconds to cover most of the way to the current
                            // envelope. Larger = smoother and lazier; below
                            // ~0.15 it starts to look like the jumpy waveform.
  static LIVE_GAIN = 0.8;   // envelope → trace-sized displacement, so live
                            // rungs sit at the same scale as frozen ones.
  static LIVE_FLOOR = 0.06; // envelope below this reads as silence, so the
                            // line has something to fall back to. Raise until
                            // quiet passages flatten; too high and only the
                            // loudest peaks move the line at all.

  constructor(opts) {
    super(opts);
    this.speed = this.option('speed');
    this.spacing = this.option('spacing');
    this.segments = this.option('segments');
    this.horizon = this.option('horizon');
    this.rungs = [];      // { z, shape: Float32Array, level, signs|null }
    this.sinceSpawn = this.spacing;   // spawn one immediately
    this.spawned = 0;     // counts every rung ever spawned, for the live stride
  }

  /**
   * Ease every live rung toward the current envelope. One envelope is sampled
   * per frame and shared: they're all reading the same instant, and they
   * differ because each keeps its own silhouette and its own lag.
   */
  updateLive(dt) {
    const { LIVE_TAU, LIVE_GAIN, LIVE_FLOOR } = Road;
    const SEGMENTS = this.segments;
    if (!this.rungs.some((r) => r.signs)) return;
    // Expanded once here, not per rung — every live rung reads the same instant.
    const env = expandEnvelope(sampleEnvelope(this.frame?.waveform, SEGMENTS), LIVE_FLOOR);
    for (const rung of this.rungs) {
      if (!rung.signs) continue;
      for (let i = 0; i < SEGMENTS; i++) {
        const target = rung.signs[i] * env[i] * LIVE_GAIN;
        rung.shape[i] = approach(rung.shape[i], target, LIVE_TAU, dt);
      }
    }
  }

  draw(ctx, dt) {
    const { Z_NEAR, Z_FAR, LIVE_EVERY } = Road;
    const { spacing: SPACING, segments: SEGMENTS, speed: SPEED } = this;
    const w = this.width;
    const h = this.height;
    const cx = w / 2;
    const horizonY = h * this.horizon;
    const K = (h - horizonY) * Z_NEAR;   // projection: y = horizonY + K/z
    const W = w * 0.9 * Z_NEAR;         // road half-width in world units

    const level = this.in('swell');

    // Advance and spawn rungs.
    for (const r of this.rungs) r.z -= SPEED * dt;
    this.rungs = this.rungs.filter((r) => r.z > Z_NEAR * 0.75);
    this.sinceSpawn += SPEED * dt;
    while (this.sinceSpawn >= SPACING) {
      this.sinceSpawn -= SPACING;
      const shape = sampleTrace(this.frame?.waveform, SEGMENTS);
      const live = LIVE_EVERY > 0 && this.spawned % LIVE_EVERY === 0;
      this.spawned++;
      // Back-date the spawn by however far past the interval we landed, so
      // rungs stay exactly SPACING apart no matter where frame edges fall.
      this.rungs.push({
        z: Z_FAR - this.sinceSpawn,
        shape,
        level,
        signs: live ? signsOf(shape) : null,
      });
    }

    this.updateLive(dt);
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

      // A rung captured at an extreme keeps the peak colour, like its size.
      ctx.strokeStyle = this.peak(this.style.lineColor, rung.level);
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
