import { approach, clamp01 } from './base.js';
import { FeedbackVisualization } from './feedback-base.js';
import { TRIGGER } from '../analyzer.js';

/**
 * Kaleidoscope — mirrors a turning wedge of the previous frame around the
 * centre, so whatever is on screen blooms into a symmetric rosette behind
 * itself. Adjacent wedges are reflections of each other, so seams meet.
 *
 * Because each frame mirrors the last, the rosette also mirrors itself: with
 * ZOOM under 1 it recedes inward in rings of ever-finer copies.
 *
 *   reveal  how strongly the rosette comes through
 *   spin    how fast the sampled wedge turns
 *   shift   a hit steps the wedge count up or down by two
 *
 * Options:
 *   segments  starting wedge count, 2–48, rounded to even so the mirroring
 *             closes (default 8)
 *   zoom      scale of the sampled frame; under 1 recedes into rings
 *   originX,  where the rosette is centred, as fractions of the width and
 *   originY   height (default 0.5, 0.5); off centre, the wedges fan out
 *             from there and the sampled frame turns about that point
 */
export class Kaleidoscope extends FeedbackVisualization {
  static id = 'kaleidoscope';
  static label = 'Kaleidoscope';
  static description = 'The screen mirrored into a turning rosette behind itself; hits change the number of wedges.';
  static inputs = {
    reveal: { kind: 'level', default: { intensity: 'rms' } },
    spin:   { kind: 'level', default: 'mid' },
    shift:  { kind: 'event', default: TRIGGER.LULL },
  };
  static SEGMENTS = [2, 48];   // the range a shift walks within
  static options = {
    segments: { kind: 'number', default: 8, min: 2, max: 48, step: 2 },
    zoom: { kind: 'number', default: 0.94, min: 0.8, max: 1.05, step: 0.005 },
    originX: { kind: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
    originY: { kind: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
  };

  static FLOOR = 0.3;         // rosette strength at silence
  static DEPTH = 0.6;         // extra at full `reveal`
  static REVEAL_TAU = 0.3;
  static BASE_SPIN = 0.05;    // radians per second, at silence
  static SPIN_GAIN = 0.6;     // extra at full `spin`
  static SPIN_TAU = 0.5;
  static ZOOM = 0.94;         // scale of the sampled frame; under 1 recedes

  constructor(opts) {
    super(opts);
    this.zoom = this.option('zoom');   // under 1 recedes into rings of copies
    this.segments = this.option('segments');
    this.originX = this.option('originX');
    this.originY = this.option('originY');
    this.reveal = 0;
    this.spinRate = 0;
    this.angle = 0;
  }

  onInput(slot) {
    if (slot !== 'shift') return;
    const [lo, hi] = Kaleidoscope.SEGMENTS;
    // A random walk that turns back at either end of the range.
    const up = this.segments <= lo || (this.segments < hi && this.random() < 0.5);
    this.segments += up ? 2 : -2;
  }

  draw(ctx, dt) {
    const K = Kaleidoscope;
    this.reveal = approach(this.reveal, clamp01(this.in('reveal')), K.REVEAL_TAU, dt);
    this.spinRate = approach(this.spinRate, this.in('spin'), K.SPIN_TAU, dt);
    this.angle += dt * (K.BASE_SPIN + K.SPIN_GAIN * this.spinRate);
    if (!this.hasPrevious) return;

    const n = this.segments;
    const seg = (Math.PI * 2) / n;
    const cx = this.width * this.originX;
    const cy = this.height * this.originY;
    // Far enough to reach the corner furthest from the origin.
    const radius = Math.hypot(Math.max(cx, this.width - cx), Math.max(cy, this.height - cy)) + 2;

    ctx.globalAlpha *= K.FLOOR + K.DEPTH * this.reveal;
    for (let i = 0; i < n; i++) {
      ctx.save();
      ctx.translate(cx, cy);
      // Odd wedges are the even ones reflected, so shared edges match.
      if (i % 2) {
        ctx.rotate((i + 1) * seg);
        ctx.scale(1, -1);
      } else {
        ctx.rotate(i * seg);
      }
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, 0, seg);
      ctx.closePath();
      ctx.clip();
      ctx.rotate(this.angle);
      ctx.scale(this.zoom, this.zoom);
      this.drawPrevious(ctx, -cx, -cy);
      ctx.restore();
    }
  }
}
