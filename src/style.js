import { approach, clamp01 } from './util.js';

/**
 * Style interpolation.
 *
 * Visualizations cross-fade by alpha, but a style change wants the values
 * themselves to travel — a colour sliding from teal to amber rather than one
 * canvas dissolving into another. So window styles ease per key: numbers
 * interpolate, hex colours interpolate channel-wise, and anything this can't
 * read (a gradient, `rgba(…)`, a keyword) snaps instead of producing garbage
 * halfway between.
 */

const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const SNAP = 1e-3;

/** Parse `#rgb` / `#rrggbb` into [r, g, b], or null if it isn't one. */
export function parseColor(value) {
  if (typeof value !== 'string') return null;
  const six = HEX6.exec(value);
  if (six) return [parseInt(six[1], 16), parseInt(six[2], 16), parseInt(six[3], 16)];
  const three = HEX3.exec(value);
  if (three) {
    return [
      parseInt(three[1] + three[1], 16),
      parseInt(three[2] + three[2], 16),
      parseInt(three[3] + three[3], 16),
    ];
  }
  return null;
}

const channel = (n) =>
  Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');

export const formatColor = ([r, g, b]) => `#${channel(r)}${channel(g)}${channel(b)}`;

/**
 * `a` blended toward `b` by `t` (0–1), as hex. Anything parseColor can't read
 * snaps at the halfway point instead, as easeStyle does.
 */
export function mixColor(a, b, t) {
  const from = parseColor(a);
  const to = parseColor(b);
  if (!from || !to) return t < 0.5 ? a : b;
  return formatColor(from.map((c, i) => c + (to[i] - c) * t));
}

/**
 * One colour channel's step. Colours are stored as hex, so every step is
 * rounded to a whole channel value — and near the target a frame's step is
 * under half a unit, which rounds straight back to where it started. Left
 * alone, a colour stalls several units short of its target forever; so when
 * rounding would stall, move one unit instead.
 */
function easeChannel(from, to, tau, dt) {
  const next = approach(from, to, tau, dt);
  if (from !== to && Math.round(next) === from) return from + Math.sign(to - from);
  return next;
}

/**
 * Ease `current` toward `target` in place, one key at a time. Mutates rather
 * than replacing because every active visualization holds a reference to the
 * live style object.
 */
export function easeStyle(current, target, tau, dt) {
  for (const key of Object.keys(target)) {
    const to = target[key];
    const from = current[key];

    if (typeof to === 'number' && typeof from === 'number') {
      const next = approach(from, to, tau, dt);
      // Settle exactly, so a width doesn't sit at 1.9999 forever.
      current[key] = Math.abs(to - next) < SNAP ? to : next;
      continue;
    }

    const toRGB = parseColor(to);
    const fromRGB = parseColor(from);
    if (toRGB && fromRGB) {
      current[key] = formatColor(fromRGB.map((c, i) => easeChannel(c, toRGB[i], tau, dt)));
      continue;
    }

    current[key] = to;
  }
}

/**
 * A style colour at the given opacity, as `rgba(…)`. Anything parseColor
 * can't read comes back unchanged, so a keyword or gradient still draws —
 * just at whatever opacity it carries itself.
 */
export function rgba(value, alpha) {
  const c = parseColor(value);
  return c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})` : value;
}

/** Where the peak colour starts to show, when the style doesn't say. */
export const PEAK_ABOVE = 0.8;

/**
 * How far toward the peak colour to draw, 0..1, for a `level` (a hit's
 * impact, or a level slot): 0 up to the knee (`style.peakAbove`), rising to 1
 * at a level of 1. Always 0 when the style has no `peakColor`, so a
 * visualization that uses it looks exactly as it did before there was one.
 */
export function peakAmount(style, level, knee = style.peakAbove ?? PEAK_ABOVE) {
  if (style.peakColor == null || !(level > knee)) return 0;
  return knee >= 1 ? 1 : clamp01((level - knee) / (1 - knee));
}

/**
 * `base` pushed toward the style's peak colour — its third colour, for the
 * extremes — by peakAmount(). `base` itself below the knee, or when no peak
 * colour is set.
 */
export function peakMix(style, base, level, knee) {
  const t = peakAmount(style, level, knee);
  return t > 0 ? mixColor(base, style.peakColor, t) : base;
}
