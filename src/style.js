import { approach } from './util.js';

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
      current[key] = formatColor([
        approach(fromRGB[0], toRGB[0], tau, dt),
        approach(fromRGB[1], toRGB[1], tau, dt),
        approach(fromRGB[2], toRGB[2], tau, dt),
      ]);
      continue;
    }

    current[key] = to;
  }
}
