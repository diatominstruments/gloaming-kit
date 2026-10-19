import { Visualization } from './base.js';
import { CATEGORY } from './categories.js';

/**
 * Waveform — oscilloscope trace of the time-domain signal, with the trace
 * gaining scale as the overall level rises.
 *
 * Options:
 *   gain     multiplier on the trace's size
 *   layout   'line'       left to right across the middle (default)
 *            'circle'     wrapped round a ring, the signal pushing it in and out
 *            'lissajous'  the signal against itself a moment later, as an
 *                         X–Y scope draws it: a tone is an ellipse, a chord a
 *                         knot, noise a scribble
 *   mirror   'off' | 'on': a reflected second copy — upside down for a
 *            line, so the pair is a ribbon; a circle made symmetric left to
 *            right; a lissajous joined by its mirror image
 */
export class Waveform extends Visualization {
  static id = 'waveform';
  static label = 'Waveform';
  static description = 'Oscilloscope trace that grows with loudness, as a line, a ring or an X–Y scope figure.';
  static category = CATEGORY.CLASSIC;

  static inputs = {
    amplitude: { kind: 'level', default: 'rms' },
  };

  static LAG = 48;   // lissajous: samples between x and y (~1 ms at 44.1 kHz)

  static options = {
    gain:   { kind: 'number', default: 1, min: 0.25, max: 3, step: 0.05 },
    layout: { kind: 'enum', values: ['line', 'circle', 'lissajous'], default: 'line' },
    mirror: { kind: 'enum', values: ['off', 'on'], default: 'off' },
  };

  constructor(opts) {
    super(opts);
    this.gain = this.option('gain');
    this.layout = this.option('layout');
    this.mirror = this.option('mirror') === 'on';
  }

  draw(ctx, dt) {
    if (!this.frame) return;
    const { waveform } = this.frame;
    const level = Math.min(1, this.in('amplitude'));
    const grow = (0.2 + level * 0.6) * this.gain;

    this.applyStyle(ctx);
    ctx.lineJoin = 'round';
    // The trace takes the peak colour when the level is near the top.
    ctx.strokeStyle = this.peak(this.style.lineColor, level);
    ctx.beginPath();
    if (this.layout === 'circle') this.traceCircle(ctx, waveform, grow);
    else if (this.layout === 'lissajous') this.traceLissajous(ctx, waveform, grow);
    else this.traceLine(ctx, waveform, grow);
    ctx.stroke();
  }

  traceLine(ctx, waveform, grow) {
    const midY = this.height / 2;
    const amp = this.height * grow;
    const n = waveform.length;
    for (const sign of this.mirror ? [1, -1] : [1]) {
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * this.width;
        const y = midY + sign * ((waveform[i] - 128) / 128) * amp;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
    }
  }

  traceCircle(ctx, waveform, grow) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    const short = Math.min(this.width, this.height);
    const r0 = short * 0.28;
    const amp = short * 0.35 * grow;
    // Mirrored, each half of the ring carries the first half of the samples,
    // reflected, so the ring is symmetric about the vertical axis.
    const n = this.mirror ? waveform.length >> 1 : waveform.length;
    const point = (i, side) => {
      const t = this.mirror ? (i / (n - 1)) * 0.5 : i / n;
      const a = -Math.PI / 2 + side * t * Math.PI * 2;
      const r = r0 + ((waveform[i] - 128) / 128) * amp;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    };
    for (const side of this.mirror ? [1, -1] : [1]) {
      for (let i = 0; i < n; i++) {
        const [x, y] = point(i, side);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      if (!this.mirror) ctx.closePath();
    }
  }

  traceLissajous(ctx, waveform, grow) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    const amp = Math.min(this.width, this.height) * grow;
    const lag = Waveform.LAG;
    for (const sign of this.mirror ? [1, -1] : [1]) {
      for (let i = 0; i + lag < waveform.length; i++) {
        const x = cx + sign * ((waveform[i] - 128) / 128) * amp;
        const y = cy - ((waveform[i + lag] - 128) / 128) * amp;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
    }
  }
}
