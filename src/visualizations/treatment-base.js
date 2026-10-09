import { Visualization } from './base.js';
import { CATEGORY } from './categories.js';
import { LAYER } from './layers.js';
import { fit, scratchCanvas, tint } from './frame-utils.js';

/**
 * TreatmentVisualization — shared plumbing for overlays that redraw the
 * current frame over itself (reflecting pool, spectral slices, mosaic,
 * bloom).
 *
 * An overlay draws last, so when draw() runs the canvas already holds the
 * finished frame beneath it. `this.snapshot(ctx)` copies it into
 * `this.current` at device resolution; a subclass then paints that copy
 * back transformed, and whatever it paints covers the frame it came from.
 * Unlike a feedback background, nothing recurses: each frame is treated
 * once, and the live figure itself is what bends.
 *
 * The engine's crossfade alpha blends the treated frame over the untreated
 * one, so a treatment that draws at full alpha replaces the picture and one
 * that draws at less lets the original show through.
 */
export class TreatmentVisualization extends Visualization {
  static category = CATEGORY.OVERLAYS;
  static layer = LAYER.OVERLAY;

  constructor(opts) {
    super(opts);
    this.current = document.createElement('canvas');
    this.currentCtx = this.current.getContext('2d');
    this.scratches = new Map();
  }

  /** Copy the frame as drawn so far into `this.current` and return it. */
  snapshot(ctx) {
    const { canvas } = ctx;
    fit(this.current, canvas.width, canvas.height);
    this.currentCtx.globalCompositeOperation = 'copy';
    this.currentCtx.drawImage(canvas, 0, 0);
    return this.current;
  }

  /** Device pixels per CSS pixel of the snapshot. */
  get dpr() {
    return this.current.width / this.width || 1;
  }

  drawCurrent(ctx, x = 0, y = 0, w = this.width, h = this.height) {
    ctx.drawImage(this.current, x, y, w, h);
  }

  scratch(name) {
    return scratchCanvas(this.scratches, name);
  }

  /** The snapshot pushed toward `color` by `amount`; the snapshot itself at 0. */
  tinted(color, amount, op = 'color') {
    if (!(amount > 0.002)) return this.current;
    return tint(this.scratch('tint'), this.current, color, amount, op);
  }
}
