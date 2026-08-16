import { Visualization } from './base.js';

/**
 * Waveform — oscilloscope trace of the time-domain signal, with the trace
 * gaining vertical scale as the overall level rises.
 */
export class Waveform extends Visualization {
  static id = 'waveform';

  static inputs = {
    amplitude: { kind: 'level', default: 'rms' },
  };

  draw(ctx, dt) {
    if (!this.frame) return;
    const { waveform } = this.frame;
    const midY = this.height / 2;
    const amp = this.height * (0.2 + this.in('amplitude') * 0.6);

    this.applyStyle(ctx);
    ctx.beginPath();
    for (let i = 0; i < waveform.length; i++) {
      const x = (i / (waveform.length - 1)) * this.width;
      const y = midY + ((waveform[i] - 128) / 128) * amp;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}
