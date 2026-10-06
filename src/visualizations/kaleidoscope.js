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
 *   shift   a hit steps the wedge count up or down one notch
 *
 * Options:
 *   segments  starting wedge count, even so the mirroring closes (default 8)
 */
export class Kaleidoscope extends FeedbackVisualization {
  static id = 'kaleidoscope';
  static label = 'Kaleidoscope';
  static description = 'The screen mirrored into a turning rosette behind itself; hits change the number of wedges.';
  static inputs = {
    reveal: { kind: 'level', default: { intensity: 'rms' } },
    spin:   { kind: 'level', default: 'mid' },
    shift:  { kind: 'event', default: TRIGGER.SNARE },
  };
  static SEGMENTS = [4, 6, 8, 10, 12, 16];
  static options = {
    segments: { kind: 'enum', values: Kaleidoscope.SEGMENTS, default: 8 },
    zoom: { kind: 'number', default: 0.94, min: 0.8, max: 1.05, step: 0.005 },
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
    const i = Kaleidoscope.SEGMENTS.indexOf(Number(this.options.segments));
    this.index = i === -1 ? Kaleidoscope.SEGMENTS.indexOf(8) : i;
    this.reveal = 0;
    this.spinRate = 0;
    this.angle = 0;
  }

  onInput(slot) {
    if (slot !== 'shift') return;
    const last = Kaleidoscope.SEGMENTS.length - 1;
    // A random walk that turns back at either end of the list.
    const up = this.index === 0 || (this.index < last && Math.random() < 0.5);
    this.index += up ? 1 : -1;
  }

  draw(ctx, dt) {
    const K = Kaleidoscope;
    this.reveal = approach(this.reveal, clamp01(this.in('reveal')), K.REVEAL_TAU, dt);
    this.spinRate = approach(this.spinRate, this.in('spin'), K.SPIN_TAU, dt);
    this.angle += dt * (K.BASE_SPIN + K.SPIN_GAIN * this.spinRate);
    if (!this.hasPrevious) return;

    const n = K.SEGMENTS[this.index];
    const seg = (Math.PI * 2) / n;
    const cx = this.width / 2;
    const cy = this.height / 2;
    const radius = Math.hypot(cx, cy) + 2;

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
