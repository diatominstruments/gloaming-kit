import { Visualization } from './base.js';
import { CATEGORY } from './categories.js';

/**
 * Waveform — oscilloscope trace of the time-domain signal, with the trace
 * gaining vertical scale as the overall level rises.
 */
export class Waveform extends Visualization {
  static id = 'waveform';
  static label = 'Waveform';
  static description = 'Oscilloscope trace that grows taller with loudness.';
  static category = CATEGORY.CLASSIC;

  static inputs = {
    amplitude: { kind: 'level', default: 'rms' },
  };

  static options = {
    gain: { kind: 'number', default: 1, min: 0.25, max: 3, step: 0.05 },
  };

  constructor(opts) {
    super(opts);
    this.gain = this.option('gain');
  }

  draw(ctx, dt) {
    if (!this.frame) return;
    const { waveform } = this.frame;
    const midY = this.height / 2;
    const level = Math.min(1, this.in('amplitude'));
    const amp = this.height * (0.2 + level * 0.6) * this.gain;

    this.applyStyle(ctx);
    // The trace takes the peak colour when the level is near the top.
    ctx.strokeStyle = this.peak(this.style.lineColor, level);
    ctx.beginPath();
    for (let i = 0; i < waveform.length; i++) {
      const x = (i / (waveform.length - 1)) * this.width;
      const y = midY + ((waveform[i] - 128) / 128) * amp;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}
