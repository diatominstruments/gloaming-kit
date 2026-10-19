/**
 * Placement — where on the canvas a timeline entry draws, through what
 * shape, and how it combines with what is already there.
 *
 *   { id: 'tunnel',
 *     place: { x: 0.5, y: 0, w: 0.5, h: 1, rotate: 0, flip: 'x' },
 *     clip:  'circle',
 *     blend: 'lighter',
 *     opacity: 0.8 }
 *
 * `place` is a region in fractions of the canvas (defaults: the whole of
 * it). The visualization is created at the region's size, so bars and grids
 * lay out to it rather than being squeezed. `rotate` (degrees) turns the
 * region about its centre and `flip` ('x', 'y' or 'xy') mirrors it. Both are
 * fixed: placement is a camera, and the camera stays still.
 *
 * `clip` is a shape in the region's own frame — after rotation, before the
 * flip, so 'left' is always the half that shows on the left:
 *
 *   'rect' | 'circle' | 'ellipse'            the region, or its inscribed circle or ellipse
 *   'left' | 'right' | 'top' | 'bottom'      half of it
 *   { x, y, w, h, shape }                    a sub-rectangle in fractions of the region,
 *                                            shape 'rect' (default), 'ellipse' or 'circle'
 *   'none'                                   no clip, even for a placed entry
 *
 * A placed entry clips to 'rect' unless it says otherwise.
 *
 * `blend` is any canvas globalCompositeOperation. An entry with one draws
 * into a layer of its own, which is then composited whole, so the mode
 * applies to the visualization as a picture rather than stroke by stroke
 * (and a visualization's own internal blending can't override it).
 *
 * `opacity` multiplies the entry's crossfade: a number (eased between
 * windows like style), or any level spec from signals.js, so presence can
 * follow the music.
 */

/** Every value `blend` accepts. */
export const BLENDS = [
  'source-over', 'source-in', 'source-out', 'source-atop',
  'destination-over', 'destination-in', 'destination-out', 'destination-atop',
  'lighter', 'copy', 'xor', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion',
  'hue', 'saturation', 'color', 'luminosity',
];

/** The named shapes `clip` accepts; it also takes an object, see above. */
export const CLIPS = ['rect', 'circle', 'ellipse', 'left', 'right', 'top', 'bottom', 'none'];

/**
 * How an entry comes and goes, over its `fade` seconds:
 *
 *   'fade'                       crossfade by alpha (the default)
 *   'cut'                        on and off within one frame; `fade` is ignored
 *   'wipe-left' | 'wipe-right'   a hard edge sweeps across the region in that
 *   'wipe-up' | 'wipe-down'      direction, revealing it on the way in and
 *                                hiding it on the way out
 *   'iris'                       a circle opens from the region's centre to
 *                                reveal it; on the way out a hole opens there
 *                                instead, eating it from the centre outward
 *
 * An entry leaves with the transition it came in with, or the one its last
 * window gave it. The way out is the complement of the way in, eased the
 * same, so an entry leaving and the next arriving with the same transition
 * over the same time share one edge, with nothing showing between them.
 */
export const TRANSITIONS = ['fade', 'cut', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down', 'iris'];

const FLIPS = { x: [-1, 1], y: [1, -1], xy: [-1, -1] };

/**
 * The fields every timeline entry accepts whatever its visualization, in the
 * shape describe() uses for options, so an editor can offer them alongside.
 */
export const UNIVERSAL = [
  {
    name: 'place', kind: 'place', default: null,
    fields: [
      { name: 'x', kind: 'number', default: 0, step: 0.01 },
      { name: 'y', kind: 'number', default: 0, step: 0.01 },
      { name: 'w', kind: 'number', default: 1, min: 0, step: 0.01 },
      { name: 'h', kind: 'number', default: 1, min: 0, step: 0.01 },
      { name: 'rotate', kind: 'number', default: 0, min: -180, max: 180, step: 1 },
      { name: 'flip', kind: 'enum', values: ['none', 'x', 'y', 'xy'], default: 'none' },
    ],
  },
  { name: 'clip', kind: 'enum', values: CLIPS, default: 'none' },
  { name: 'blend', kind: 'enum', values: BLENDS, default: 'source-over' },
  { name: 'opacity', kind: 'number', default: 1, min: 0, max: 1, step: 0.01, signal: true },
  { name: 'style', kind: 'style', default: null },
  { name: 'transition', kind: 'enum', values: TRANSITIONS, default: 'fade' },
  { name: 'fade', kind: 'number', default: 0.6, min: 0, max: 10, step: 0.05 },
];

const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);

/**
 * An entry's region on a canvas of CSS size `width` × `height` at `dpr`.
 * Placed regions are snapped to whole device pixels, so a region's copy of
 * the frame lines up pixel for pixel and a feedback loop doesn't blur
 * itself. Unplaced, it is the canvas exactly as before placement existed.
 *
 *   { x, y, w, h }      CSS px, the unrotated rectangle
 *   rotate              radians
 *   fx, fy              ±1, the flip
 *   placed              false for the whole canvas, untransformed
 *   view                what the frame-reading bases copy (see frame-utils grab())
 */
export function regionOf(place, width, height, dpr, canvas) {
  if (!place) {
    return {
      x: 0, y: 0, w: width, h: height, rotate: 0, fx: 1, fy: 1, placed: false,
      view: { canvas, matrix: null, width: canvas.width, height: canvas.height },
    };
  }
  const X = Math.round(num(place.x, 0) * width * dpr);
  const Y = Math.round(num(place.y, 0) * height * dpr);
  const W = Math.max(1, Math.round(num(place.w, 1) * width * dpr));
  const H = Math.max(1, Math.round(num(place.h, 1) * height * dpr));
  const rotate = (num(place.rotate, 0) * Math.PI) / 180;
  const [fx, fy] = FLIPS[place.flip] ?? [1, 1];

  // Canvas device px → the region's own device px: the inverse of the
  // placement, built directly rather than inverted so an unrotated region
  // stays an exact whole-pixel translate.
  const matrix = new DOMMatrix()
    .translateSelf(W / 2, H / 2)
    .scaleSelf(fx, fy);
  if (rotate) matrix.rotateSelf((-rotate * 180) / Math.PI);
  matrix.translateSelf(-(X + W / 2), -(Y + H / 2));

  return {
    x: X / dpr, y: Y / dpr, w: W / dpr, h: H / dpr, rotate, fx, fy, placed: true,
    view: { canvas, matrix, width: W, height: H },
  };
}

/**
 * Trace `clip` into `ctx` as a path about the origin, for a w × h region.
 * An object clip with `invert` (used by transitions) keeps everything in the
 * region outside its shape; clip it with the 'evenodd' rule.
 */
function clipPath(ctx, clip, w, h) {
  const hw = w / 2;
  const hh = h / 2;
  ctx.beginPath();
  if (clip && typeof clip === 'object') {
    if (clip.invert) ctx.rect(-hw, -hh, w, h);
    const x = -hw + num(clip.x, 0) * w;
    const y = -hh + num(clip.y, 0) * h;
    const cw = num(clip.w, 1) * w;
    const ch = num(clip.h, 1) * h;
    if (clip.shape === 'ellipse') ctx.ellipse(x + cw / 2, y + ch / 2, Math.abs(cw / 2), Math.abs(ch / 2), 0, 0, Math.PI * 2);
    else if (clip.shape === 'circle') ctx.arc(x + cw / 2, y + ch / 2, Math.min(Math.abs(cw), Math.abs(ch)) / 2, 0, Math.PI * 2);
    else ctx.rect(x, y, cw, ch);
    return;
  }
  switch (clip) {
    case 'circle': ctx.arc(0, 0, Math.min(hw, hh), 0, Math.PI * 2); break;
    case 'ellipse': ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2); break;
    case 'left': ctx.rect(-hw, -hh, hw, h); break;
    case 'right': ctx.rect(0, -hh, hw, h); break;
    case 'top': ctx.rect(-hw, -hh, w, hh); break;
    case 'bottom': ctx.rect(-hw, 0, w, hh); break;
    default: ctx.rect(-hw, -hh, w, h);
  }
}

const smoothstep = (t) => t * t * (3 - 2 * t);

/**
 * What a transition shows at `progress` (0 = gone, 1 = fully on): the alpha
 * to draw at, and a clip (in the same form as `clip`) to draw through, or
 * null. `leaving` flips which side of a wipe's edge is kept, so that the
 * edge travels the same way in both directions.
 */
export function revealOf(transition, progress, leaving, w, h) {
  if (transition === 'fade') return { alpha: progress, clip: null };
  if (progress >= 1 || transition === 'cut') return { alpha: 1, clip: null };
  const p = smoothstep(progress);
  switch (transition) {
    case 'wipe-left': return { alpha: 1, clip: leaving ? { w: p } : { x: 1 - p, w: p } };
    case 'wipe-right': return { alpha: 1, clip: leaving ? { x: 1 - p, w: p } : { w: p } };
    case 'wipe-up': return { alpha: 1, clip: leaving ? { h: p } : { y: 1 - p, h: p } };
    case 'wipe-down': return { alpha: 1, clip: leaving ? { y: 1 - p, h: p } : { h: p } };
    case 'iris': {
      // Large enough at 1 to cover the corners.
      const d = (leaving ? 1 - p : p) * Math.hypot(w, h);
      return {
        alpha: 1,
        clip: { x: 0.5 - d / w / 2, y: 0.5 - d / h / 2, w: d / w, h: d / h, shape: 'ellipse', invert: leaving },
      };
    }
    default: return { alpha: progress, clip: null };
  }
}

/**
 * Set `ctx` up so drawing at (0, 0)–(r.w, r.h) lands in the region, clipped
 * to `clip` and, if given, to a transition's `reveal` as well. Wrap in
 * save()/restore().
 */
export function enterRegion(ctx, r, clip, reveal = null) {
  if (!r.placed && !clip && !reveal) return;
  ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
  if (r.rotate) ctx.rotate(r.rotate);
  for (const c of [clip, reveal]) {
    if (!c) continue;
    clipPath(ctx, c, r.w, r.h);
    ctx.clip(c.invert ? 'evenodd' : 'nonzero');
  }
  if (r.fx !== 1 || r.fy !== 1) ctx.scale(r.fx, r.fy);
  ctx.translate(-r.w / 2, -r.h / 2);
}

/** The clip an entry draws through: its own, 'rect' if placed, else none. */
export function clipOf(spec) {
  if (spec.clip === 'none') return null;
  if (spec.clip != null) return spec.clip;
  return spec.place ? 'rect' : null;
}

/** The entry's transition if it is a known one, else 'fade' (with a warning). */
export function transitionOf(spec, warn) {
  const { transition } = spec;
  if (transition == null || TRANSITIONS.includes(transition)) return transition ?? 'fade';
  warn(`GloamingKit: '${spec.id}' has unknown transition '${transition}' — fading it instead`);
  return 'fade';
}

/** The entry's blend if it is one canvas knows, else null (with a warning). */
export function blendOf(spec, warn) {
  const { blend } = spec;
  if (blend == null || blend === 'source-over') return null;
  if (BLENDS.includes(blend)) return blend;
  warn(`GloamingKit: '${spec.id}' has unknown blend '${blend}' — drawing it normally`);
  return null;
}
