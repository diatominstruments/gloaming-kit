import { Visualization } from './base.js';
import { CATEGORY } from './categories.js';

/**
 * EQBars — classic EQ display. Log-spaced bars across the spectrum so the
 * low end doesn't hog the width. Purely frame-driven (no triggers).
 *
 * Options:
 *   bars, gap   how many bars, and the space between them
 *   layout      'linear'   a row along the bottom-centre (default)
 *               'mirrored' lows in the middle, highs out to both edges, each
 *                          bar growing up and down from the centre line
 *               'radial'   bars radiating out from a ring at the centre
 *   shape       'bars'     solid bars (default)
 *               'dots'     each bar a column of dots, like LED segments
 *               'line'     one line through the bar tips (a closed loop
 *                          when radial)
 *
 * Every layout reduces to the same thing: each bar is a segment from a base
 * point along a direction, so every shape works with every layout.
 */
export class EQBars extends Visualization {
  static id = 'eq-bars';
  static label = 'EQ Bars';
  static description = 'Spectrum as log-spaced bars with a fast attack and slow decay, in a row, mirrored or round a ring.';
  static category = CATEGORY.CLASSIC;

  static BARS = 28;
  static GAP = 4;          // px between bars
  static RING = 0.16;      // radial: inner radius, fraction of the short edge
  static REACH = 0.32;     // radial: longest bar, fraction of the short edge
  static options = {
    bars:   { kind: 'number', default: EQBars.BARS, min: 8, max: 96, step: 1 },
    gap:    { kind: 'number', default: EQBars.GAP, min: 0, max: 12, step: 1 },
    layout: { kind: 'enum', values: ['linear', 'mirrored', 'radial'], default: 'linear' },
    shape:  { kind: 'enum', values: ['bars', 'dots', 'line'], default: 'bars' },
  };

  constructor(opts) {
    super(opts);
    this.barCount = this.option('bars');
    this.gap = this.option('gap');
    this.layout = this.option('layout');
    this.shape = this.option('shape');
    this.values = new Float32Array(this.barCount); // smoothed heights
  }

  /** Smoothed level per bar, 0..1, from this frame's spectrum. */
  measure(spectrum, dt) {
    const n = this.barCount;
    let lo = 1;   // skip the DC bin
    for (let i = 0; i < n; i++) {
      // Log-spaced slice of the spectrum for this bar. Each bar starts where
      // the previous one ended and advances at least one bin — the raw log
      // curve floors several low bars onto the same slice otherwise.
      const hi = Math.max(lo + 1, Math.floor(Math.pow(spectrum.length, (i + 1) / n)));
      let sum = 0;
      for (let j = lo; j < hi; j++) sum += spectrum[j];
      const target = sum / ((hi - lo) * 255);
      // Fast attack, slow decay.
      this.values[i] = target > this.values[i]
        ? target
        : Math.max(target, this.values[i] - dt * 1.5);
      lo = hi;
    }
  }

  /**
   * The bars as segments, in groups that a line joins in order:
   * { closed, segs: [{ x, y, ux, uy, len, w, v }] }, where (x, y) is the
   * base, (ux, uy) the unit direction it grows in, `w` its thickness.
   */
  segments() {
    const n = this.barCount;
    const { gap, width: W, height: H, values } = this;
    if (this.layout === 'radial') {
      const short = Math.min(W, H);
      const r0 = short * EQBars.RING;
      const reach = short * EQBars.REACH;
      const w = Math.max(1, (2 * Math.PI * r0) / n - gap);
      const segs = [];
      for (let i = 0; i < n; i++) {
        // Lows at the top, running clockwise.
        const a = -Math.PI / 2 + ((i + 0.5) / n) * Math.PI * 2;
        const ux = Math.cos(a);
        const uy = Math.sin(a);
        segs.push({ x: W / 2 + ux * r0, y: H / 2 + uy * r0, ux, uy, len: values[i] * reach, w, v: values[i] });
      }
      return [{ closed: true, segs }];
    }
    if (this.layout === 'mirrored') {
      const slots = 2 * n;
      const w = Math.max(1, (W - gap * (slots + 1)) / slots);
      const maxH = H * 0.75;
      const up = [];
      const down = [];
      for (let k = 0; k < slots; k++) {
        const i = k < n ? n - 1 - k : k - n;   // lows meet in the middle
        const x = gap + k * (w + gap) + w / 2;
        const len = (values[i] * maxH) / 2;
        up.push({ x, y: H / 2, ux: 0, uy: -1, len, w, v: values[i] });
        down.push({ x, y: H / 2, ux: 0, uy: 1, len, w, v: values[i] });
      }
      return [{ closed: false, segs: up }, { closed: false, segs: down }];
    }
    const w = Math.max(1, (W - gap * (n + 1)) / n);
    const maxH = H * 0.75;
    const base = (H + maxH) / 2;
    const segs = [];
    for (let i = 0; i < n; i++) {
      segs.push({ x: gap + i * (w + gap) + w / 2, y: base, ux: 0, uy: -1, len: values[i] * maxH, w, v: values[i] });
    }
    return [{ closed: false, segs }];
  }

  draw(ctx, dt) {
    if (!this.frame) return;
    this.measure(this.frame.spectrum, dt);
    const groups = this.segments();
    const color = this.style.lineColor;

    this.applyStyle(ctx);
    ctx.globalAlpha *= 0.9;

    if (this.shape === 'line') {
      ctx.lineJoin = 'round';
      for (const { closed, segs } of groups) {
        let top = 0;
        ctx.beginPath();
        segs.forEach((s, i) => {
          top = Math.max(top, s.v);
          const x = s.x + s.ux * s.len;
          const y = s.y + s.uy * s.len;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        if (closed) ctx.closePath();
        // The line takes the peak colour when its loudest bar is near the top.
        ctx.strokeStyle = this.peak(color, top);
        ctx.stroke();
      }
      return;
    }

    for (const { segs } of groups) {
      for (const s of segs) {
        // A bar near the top of its range takes the peak colour.
        const c = this.peak(color, s.v);
        if (this.shape === 'dots') {
          const r = Math.max(0.75, Math.min(s.w, 10) / 2);
          const pitch = r * 2.6;
          ctx.fillStyle = c;
          ctx.beginPath();
          for (let d = r; d <= s.len; d += pitch) {
            ctx.moveTo(s.x + s.ux * d + r, s.y + s.uy * d);
            ctx.arc(s.x + s.ux * d, s.y + s.uy * d, r, 0, Math.PI * 2);
          }
          ctx.fill();
        } else if (s.len > 0) {
          ctx.strokeStyle = c;
          ctx.lineWidth = s.w;
          ctx.lineCap = 'butt';
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(s.x + s.ux * s.len, s.y + s.uy * s.len);
          ctx.stroke();
        }
      }
    }
  }
}
