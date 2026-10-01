import { createNoise3D } from '../noise.js';
import { approach } from '../util.js';
import { interpret, INTERPRETATIONS } from './glyph-interpret.js';

/**
 * Evolution — keeping a structure read from a drawing alive.
 *
 * glyph-interpret.js reads a drawing into elements once; an Evolver turns
 * that reading into a living one, rewriting `live` every frame. `live` always
 * holds the same number of elements, so whatever is built from it — a map per
 * element, a petal per element — keeps a fixed shape and only the elements
 * change. An element that is "absent" has zero size.
 *
 *   drift  every element wanders on its own slow noise path — moving,
 *          turning, stretching and swelling a little — so the structure
 *          mutates continuously and never repeats. Hits jolt a few elements
 *          at random, so the beat leaves visible mutations that heal slowly.
 *   grow   the structure assembles itself element by element along the
 *          reading, each one sprouting out of the one before it; once most
 *          are grown the oldest start withering as new ones sprout, so a
 *          growth front travels round it forever. Each regrowth is a
 *          mutation — a new turn and stretch — so it is never the same twice.
 *          Hits sprout the next element at once.
 *   morph  the structure flows between the three readings in turn —
 *          contour, clusters, rosette — holding each a while, elements
 *          sliding, turning and resizing into their new places, extras
 *          sprouting from or shrinking into their neighbours. Hits hurry the
 *          next change along.
 *   still  the reading as it is.
 *
 * `rate` (0–1, from the music) sets how fast each of them moves.
 */

export const BEHAVIORS = Object.freeze(['drift', 'grow', 'morph', 'still']);

/** The `evolve` option, with a per-visualization default. */
export const evolveOption = (value) => Object.freeze({
  kind: 'enum', values: BEHAVIORS, default: value,
});

const MAX_SCALE = 0.6;   // keep every copy a contraction, as interpret() does
const TAU = Math.PI * 2;

// drift
const DRIFT_RATE = [0.05, 0.3];   // noise time per second: [idle, added at full rate]
const WANDER = 0.12;              // position, in figure radii
const TURN = 0.8;                 // rad
const STRETCH = 0.45;             // log of the stretch ratio
const SWELL = 0.2;                // log of the size
const JOLT_DECAY = 0.7;

// grow
const SPROUT_RATE = [0.6, 1.4];   // sprouts per second: [idle, added at full rate]
const ALIVE = 0.7;                // fraction of the elements grown at once
const GROW_TAU = 0.5;             // s
const WITHER_TAU = 0.9;           // s

// morph
const HOLD = 5;                   // s holding each reading, at idle rate
const MOVE = 3;                   // s flowing into the next
const MORPH_RATE = [0.6, 1.2];    // clock speed: [idle, added at full rate]

const absent = (e) => ({ ...e, sx: 0, sy: 0 });
const byAngle = (elements) => [...elements].sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
const smooth = (t) => t * t * (3 - 2 * t);
/** Shortest signed turn from a to b. */
const turnTo = (a, b) => ((((b - a) % TAU) + TAU * 1.5) % TAU) - Math.PI;

/**
 * `elements` stretched to `n` slots, in order: each element keeps the first
 * of its slots and the rest are absent copies of it, so in a morph the extras
 * sprout from (or shrink into) a neighbour rather than from nowhere.
 */
function pad(elements, n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const i = Math.floor((k * elements.length) / n);
    const first = k === 0 || Math.floor(((k - 1) * elements.length) / n) !== i;
    out.push(first ? elements[i] : absent(elements[i]));
  }
  return out;
}

function clampScale(e) {
  const big = Math.max(e.sx, e.sy);
  if (big > MAX_SCALE) {
    e.sx *= MAX_SCALE / big;
    e.sy *= MAX_SCALE / big;
  }
}

export class Evolver {
  /** `glyph` read by `reading` (see glyph-interpret.js), evolving by `behavior`. */
  constructor(glyph, reading, behavior) {
    if (!BEHAVIORS.includes(behavior)) {
      console.warn(`GloamingKit: glyph evolve '${behavior}'; expected ${BEHAVIORS.join('|')}`);
      behavior = 'drift';
    }
    this.behavior = behavior;
    // A morph visits every reading, starting from the chosen one; elements
    // are ordered round the centre so each pairs with its nearest likely
    // counterpart in the next.
    this.readings = behavior === 'morph'
      ? [reading, ...INTERPRETATIONS.filter((r) => r !== reading)].map((r) => byAngle(interpret(glyph, r)))
      : [interpret(glyph, reading)];
    this.count = Math.max(...this.readings.map((r) => r.length));
    this.base = pad(this.readings[0], this.count);
    this.live = this.base.map((e) => ({ ...e }));
    this.random = Math.random;

    if (behavior === 'drift') {
      this.noise = createNoise3D(Math.floor(Math.random() * 1e9));
      this.t = Math.random() * 100;
      this.jolts = new Float32Array(this.count * 4);   // (dx, dy, turn, stretch)
    } else if (behavior === 'grow') {
      this.growth = new Float32Array(this.count);
      this.target = new Float32Array(this.count);
      // Each element's current mutation, re-rolled whenever it regrows.
      this.mutations = this.base.map(() => ({ dx: 0, dy: 0, turn: 0, stretch: 1 }));
      this.window = Math.max(1, Math.min(this.count - 1, Math.round(this.count * ALIVE)));
      this.cursor = 0;
      this.timer = 0;
      // A seedling rather than a seed: one copy alone is a single point, so
      // start with a few, already partly grown.
      for (let k = 0; k < Math.min(3, this.window); k++) {
        this.sprout();
        this.growth[k] = 0.4 - k * 0.15;
      }
    } else if (behavior === 'morph') {
      this.stage = 0;
      this.clock = 0;
      this.pairUp();
    }
    this.update(0, 0);
  }

  /** Advance by `dt` seconds; `rate` 0–1 sets how fast. Rewrites `live`. */
  update(dt, rate) {
    if (this.behavior === 'drift') this.drift(dt, rate);
    else if (this.behavior === 'grow') this.grow(dt, rate);
    else if (this.behavior === 'morph') this.morph(dt, rate);
  }

  /** A hit of `strength` 0–1. */
  hit(strength) {
    if (this.behavior === 'drift') {
      // Jolt one to three elements: a mutation on the beat that heals slowly.
      const n = 1 + Math.round(strength * 2);
      for (let k = 0; k < n; k++) {
        const j = Math.floor(this.random() * this.count) * 4;
        this.jolts[j] += (this.random() * 2 - 1) * 0.15 * strength;
        this.jolts[j + 1] += (this.random() * 2 - 1) * 0.15 * strength;
        this.jolts[j + 2] += (this.random() * 2 - 1) * 1.2 * strength;
        this.jolts[j + 3] += (this.random() * 2 - 1) * 0.6 * strength;
      }
    } else if (this.behavior === 'grow' && strength > 0.3) {
      this.sprout();
      this.timer = 0;
    } else if (this.behavior === 'morph') {
      this.clock += strength * 0.8;
    }
  }

  drift(dt, rate) {
    this.t += dt * (DRIFT_RATE[0] + rate * DRIFT_RATE[1]);
    const decay = Math.exp(-dt * JOLT_DECAY);
    const { noise, t, jolts } = this;
    for (let i = 0; i < this.count; i++) {
      const b = this.base[i];
      const e = this.live[i];
      // Perlin noise mostly stays within ±0.6; scale it up to use the range.
      const n = (c) => noise(i * 5.3 + c * 31.7, t, c * 0.37) * 1.6;
      const j = i * 4;
      for (let c = 0; c < 4; c++) jolts[j + c] *= decay;
      e.x = b.x + n(0) * WANDER + jolts[j];
      e.y = b.y + n(1) * WANDER + jolts[j + 1];
      e.angle = b.angle + n(2) * TURN + jolts[j + 2];
      const stretch = Math.exp(n(3) * STRETCH + jolts[j + 3]);
      const size = Math.exp(n(4) * SWELL);
      e.sx = b.sx * size * Math.sqrt(stretch);
      e.sy = b.sy * size / Math.sqrt(stretch);
      clampScale(e);
    }
  }

  /** Grow the next element in the reading, withering the oldest grown one. */
  sprout() {
    const i = this.cursor % this.count;
    if (this.cursor >= this.window) this.target[(this.cursor - this.window) % this.count] = 0;
    this.target[i] = 1;
    const m = this.mutations[i];
    // Regrowth is never quite the same: a fresh turn, stretch and nudge.
    if (this.cursor >= this.count) {
      m.turn = (this.random() * 2 - 1) * 0.7;
      m.stretch = Math.exp((this.random() * 2 - 1) * 0.4);
      m.dx = (this.random() * 2 - 1) * 0.06;
      m.dy = (this.random() * 2 - 1) * 0.06;
    }
    this.cursor++;
  }

  grow(dt, rate) {
    this.timer += dt * (SPROUT_RATE[0] + rate * SPROUT_RATE[1]);
    if (this.timer >= 1) {
      this.timer -= 1;
      this.sprout();
    }
    for (let i = 0; i < this.count; i++) {
      const up = this.target[i] > this.growth[i];
      this.growth[i] = approach(this.growth[i], this.target[i], up ? GROW_TAU : WITHER_TAU, dt);
      const g = smooth(Math.min(1, this.growth[i]));
      const b = this.base[i];
      // Sprouting out of the element before it in the reading.
      const from = this.base[(i - 1 + this.count) % this.count];
      const m = this.mutations[i];
      const e = this.live[i];
      e.x = from.x + (b.x + m.dx - from.x) * g;
      e.y = from.y + (b.y + m.dy - from.y) * g;
      e.angle = b.angle + m.turn;
      e.sx = b.sx * Math.sqrt(m.stretch) * g;
      e.sy = b.sy / Math.sqrt(m.stretch) * g;
      clampScale(e);
    }
  }

  /** Pair the current reading's elements with the next one's, slot by slot. */
  pairUp() {
    const n = this.readings.length;
    this.from = pad(this.readings[this.stage % n], this.count);
    this.to = pad(this.readings[(this.stage + 1) % n], this.count);
  }

  morph(dt, rate) {
    this.clock += dt * (MORPH_RATE[0] + rate * MORPH_RATE[1]);
    while (this.clock >= HOLD + MOVE) {
      this.clock -= HOLD + MOVE;
      this.stage++;
      this.pairUp();
    }
    const t = smooth(Math.max(0, Math.min(1, (this.clock - HOLD) / MOVE)));
    for (let i = 0; i < this.count; i++) {
      const a = this.from[i];
      const b = this.to[i];
      const e = this.live[i];
      e.x = a.x + (b.x - a.x) * t;
      e.y = a.y + (b.y - a.y) * t;
      e.angle = a.angle + turnTo(a.angle, b.angle) * t;
      e.sx = a.sx + (b.sx - a.sx) * t;
      e.sy = a.sy + (b.sy - a.sy) * t;
      e.weight = a.weight + (b.weight - a.weight) * t;
      e.hue = a.hue + (b.hue - a.hue) * t;
    }
  }
}
