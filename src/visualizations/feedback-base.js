import { Visualization } from './base.js';
import { CATEGORY } from './categories.js';
import { LAYER } from './layers.js';
import { fit, scratchCanvas, tint } from './frame-utils.js';

/**
 * FeedbackVisualization — shared plumbing for backgrounds that redraw the
 * previous frame into the current one (infinity mirror, kaleidoscope,
 * wallpaper, zoom burst, hue drift).
 *
 * The engine clears the canvas before drawing, so the last frame is gone by
 * the time a background draws. Instead each frame is captured in
 * afterFrame(), once every layer has drawn, into `this.previous` — a canvas
 * at device resolution. A subclass draws it back, transformed, in draw();
 * because the capture includes the foreground, the foreground is what echoes.
 *
 * Draw it at CSS size with `this.drawPrevious(ctx, x, y, w, h)`; the context's
 * dpr transform maps it back onto device pixels. `this.tinted(color, amount)`
 * is the previous frame pushed toward a colour, for echoes that change
 * colour as they recede; `this.scratch(name)` is a spare canvas for anything
 * else that has to be built offscreen.
 *
 * Because the capture also holds what every feedback background drew, they
 * compound: a hue drift under an infinity mirror turns the tunnel into a
 * colour wheel, a zoom burst under a kaleidoscope streaks the rosette.
 */
export class FeedbackVisualization extends Visualization {
  static category = CATEGORY.BACKGROUNDS;
  static layer = LAYER.BACKGROUND;

  constructor(opts) {
    super(opts);
    this.previous = document.createElement('canvas');
    this.previousCtx = this.previous.getContext('2d');
    this.hasPrevious = false;
    this.scratches = new Map();
  }

  afterFrame(ctx) {
    const { canvas } = ctx;
    // Resizing clears it, which is also right: an old frame at the old size
    // would echo in the wrong place.
    fit(this.previous, canvas.width, canvas.height);
    this.previousCtx.drawImage(canvas, 0, 0);
    this.hasPrevious = true;
  }

  drawPrevious(ctx, x = 0, y = 0, w = this.width, h = this.height) {
    if (this.hasPrevious) ctx.drawImage(this.previous, x, y, w, h);
  }

  /** Device pixels per CSS pixel of the captured frame. */
  get dpr() {
    return this.previous.width / this.width || 1;
  }

  /** A named offscreen canvas, created on first use; size it as you draw into it. */
  scratch(name) {
    return scratchCanvas(this.scratches, name);
  }

  /**
   * The previous frame pushed toward `color` by `amount` (0..1), through
   * `op` (see tint() in frame-utils.js). The frame itself when the amount
   * is nothing, so callers can draw from it either way.
   */
  tinted(color, amount, op = 'color') {
    if (!(amount > 0.002)) return this.previous;
    return tint(this.scratch('tint'), this.previous, color, amount, op);
  }
}
