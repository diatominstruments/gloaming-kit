/**
 * Offscreen-canvas helpers shared by the visualizations that redraw the
 * frame itself: the feedback backgrounds (previous frame) and the overlay
 * treatments (current frame). All of them work at device resolution — the
 * canvases they handle are copies of the engine's canvas — and are drawn
 * back at CSS size, which the context's dpr transform maps onto device
 * pixels.
 */

/** Size `canvas` to w×h unless it already is; resizing clears it. */
export function fit(canvas, w, h) {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return canvas;
}

/** An offscreen canvas by name from `map`, created on first use. */
export function scratchCanvas(map, name) {
  let canvas = map.get(name);
  if (!canvas) {
    canvas = document.createElement('canvas');
    map.set(name, canvas);
  }
  return canvas;
}

/**
 * `dst` filled with `src` pushed toward `color` by `amount` (0..1) through
 * the blend `op`. 'color' (the default) gives every pixel the colour's hue
 * and saturation and keeps the frame's own luminosity, so dark stays dark
 * and the figure takes the colour; 'hue' keeps the frame's saturation too,
 * so greys stay grey; 'multiply' darkens through the colour like a gel.
 */
export function tint(dst, src, color, amount, op = 'color') {
  fit(dst, src.width, src.height);
  const c = dst.getContext('2d');
  c.globalCompositeOperation = 'copy';
  c.globalAlpha = 1;
  c.drawImage(src, 0, 0);
  if (amount > 0) {
    c.globalCompositeOperation = op;
    c.globalAlpha = Math.min(1, amount);
    c.fillStyle = color;
    c.fillRect(0, 0, dst.width, dst.height);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }
  return dst;
}

/**
 * `canvas` with `color` subtracted from every pixel (as |pixel − color|, the
 * nearest canvas blending comes), so a frame's own background reads as
 * black. For glows and lifts, which would otherwise brighten the background
 * along with the figure.
 */
export function subtract(canvas, color) {
  const c = canvas.getContext('2d');
  c.globalCompositeOperation = 'difference';
  c.globalAlpha = 1;
  c.fillStyle = color;
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.globalCompositeOperation = 'source-over';
  return canvas;
}

/**
 * `src` scaled into `dst` at w×h with smoothing on. Each halving averages
 * four pixels into one, so a chain of these is a cheap, decent blur; one
 * big step is cheaper but aliases, so `downsample` below takes the chain.
 */
export function scaleInto(dst, src, w, h) {
  fit(dst, Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const c = dst.getContext('2d');
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.globalCompositeOperation = 'copy';
  c.globalAlpha = 1;
  c.drawImage(src, 0, 0, dst.width, dst.height);
  return dst;
}

/**
 * `src` reduced by `factor` (≥ 1) in halving steps, using canvases from
 * `map` (named `prefix0`, `prefix1`, …). Returns the smallest canvas, which
 * is the blurred image: scale it back up with smoothing on.
 */
export function downsample(map, prefix, src, factor) {
  let current = src;
  let scale = 1;
  let i = 0;
  while (scale * 2 <= factor && Math.min(current.width, current.height) > 4) {
    const next = scratchCanvas(map, prefix + i++);
    scaleInto(next, current, current.width / 2, current.height / 2);
    current = next;
    scale *= 2;
  }
  if (scale < factor && Math.min(current.width, current.height) > 4) {
    const next = scratchCanvas(map, prefix + i);
    const rest = factor / scale;
    scaleInto(next, current, current.width / rest, current.height / rest);
    current = next;
  }
  return current;
}

/** Whether this browser applies `ctx.filter` (CSS filters) on canvas drawing. */
export function canvasFilterSupported() {
  return typeof CanvasRenderingContext2D !== 'undefined'
    && 'filter' in CanvasRenderingContext2D.prototype;
}
