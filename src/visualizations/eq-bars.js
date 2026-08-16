import { Visualization } from './base.js';

/**
 * EQBars — classic EQ display. Log-spaced bars across the spectrum so the
 * low end doesn't hog the width. Purely frame-driven (no triggers).
 */
export class EQBars extends Visualization {
  static id = 'eq-bars';

  constructor(opts) {
    super(opts);
    this.barCount = 28;
    this.values = new Float32Array(this.barCount); // smoothed heights
  }

  draw(ctx, dt) {
    if (!this.frame) return;
    const { spectrum } = this.frame;
    const n = this.barCount;
    const gap = 4;
    const barW = (this.width - gap * (n + 1)) / n;
    const maxH = this.height * 0.75;

    this.applyStyle(ctx);
    for (let i = 0; i < n; i++) {
      // Log-spaced slice of the spectrum for this bar.
      const lo = Math.floor(Math.pow(spectrum.length, i / n));
      const hi = Math.max(lo + 1, Math.floor(Math.pow(spectrum.length, (i + 1) / n)));
      let sum = 0;
      for (let j = lo; j < hi; j++) sum += spectrum[j];
      const target = sum / ((hi - lo) * 255);

      // Fast attack, slow decay.
      this.values[i] = target > this.values[i]
        ? target
        : Math.max(target, this.values[i] - dt * 1.5);

      const h = this.values[i] * maxH;
      const x = gap + i * (barW + gap);
      const y = (this.height + maxH) / 2 - h;
      ctx.globalAlpha *= 0.9;
      ctx.fillRect(x, y, barW, h);
      ctx.globalAlpha /= 0.9;
    }
  }
}
