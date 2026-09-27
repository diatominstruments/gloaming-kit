import { Visualization } from './base.js';
import { CATEGORY } from './categories.js';
import { LAYER } from './layers.js';

/**
 * FeedbackVisualization — shared plumbing for backgrounds that redraw the
 * previous frame into the current one (infinity mirror, kaleidoscope).
 *
 * The engine clears the canvas before drawing, so the last frame is gone by
 * the time a background draws. Instead each frame is captured in
 * afterFrame(), once every layer has drawn, into `this.previous` — a canvas
 * at device resolution. A subclass draws it back, transformed, in draw();
 * because the capture includes the foreground, the foreground is what echoes.
 *
 * Draw it at CSS size with `this.drawPrevious(ctx, x, y, w, h)`; the context's
 * dpr transform maps it back onto device pixels.
 */
export class FeedbackVisualization extends Visualization {
  static category = CATEGORY.BACKGROUNDS;
  static layer = LAYER.BACKGROUND;

  constructor(opts) {
    super(opts);
    this.previous = document.createElement('canvas');
    this.previousCtx = this.previous.getContext('2d');
    this.hasPrevious = false;
  }

  afterFrame(ctx) {
    const { canvas } = ctx;
    if (this.previous.width !== canvas.width || this.previous.height !== canvas.height) {
      // Resizing clears it, which is also right: an old frame at the old size
      // would echo in the wrong place.
      this.previous.width = canvas.width;
      this.previous.height = canvas.height;
    }
    this.previousCtx.drawImage(canvas, 0, 0);
    this.hasPrevious = true;
  }

  drawPrevious(ctx, x = 0, y = 0, w = this.width, h = this.height) {
    if (this.hasPrevious) ctx.drawImage(this.previous, x, y, w, h);
  }
}
