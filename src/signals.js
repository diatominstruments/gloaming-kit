import { BANDS } from './analyzer.js';
import { approach, clamp01, impact } from './util.js';
import { mulberry32 } from './noise.js';

/**
 * Signals — the routing layer behind input slots.
 *
 * A signal is just `(frame, dt, events) => number`, with any state it needs
 * captured in a closure. Two decisions keep this small:
 *
 *  - Everything is continuous. Triggers are discrete, so they pass through an
 *    envelope at the boundary: a hit jumps the value to its impact, which
 *    then decays. Downstream there is only one kind of thing, so combining a
 *    bass hit with a treble level is ordinary arithmetic.
 *
 *  - Nothing is shared. Every slot compiles its own chain, so two slots
 *    listening to the same trigger get two independent envelopes. That costs
 *    a few extra closures and buys the absence of a dependency graph: no
 *    evaluation order, no per-frame memoization, no cache invalidation.
 *
 * Specs are plain data so they can live in timeline config and be edited by
 * a UI. `compileLevel` turns one into a signal:
 *
 *   'mid'                                  a band, by name
 *   'rms'                                  overall loudness
 *   { relative: 'bass' }                   band (or 'rms') against its recent
 *                                          floor and peaks: hits read high in
 *                                          quiet passages and loud alike
 *   { intensity: 'bass' }                  slow absolute loudness of a band
 *                                          (or 'rms'): how big to react
 *   0.5                                    a constant
 *   { band: 'treble', gain: 1.4 }          shaped
 *   { trigger: 'bass', decay: 4 }          envelope on a trigger
 *   { sum: ['bass', { band: 'mid', gain: 0.5 }] }
 *   { max: [...] }                         loudest wins
 *   { min: [...] }                         quietest wins: both must be live
 *   { mul: [a, b] }                        product: one gates the other
 *   [a, b]                                 shorthand for { sum: [a, b] }
 *
 * Three sources move on their own rather than following the sound, so a
 * mapping can evolve or change state:
 *
 *   { lfo: 0.05, shape: 'sine' }           a slow oscillator, `lfo` in Hz on
 *                                          song time; shape 'sine', 'triangle',
 *                                          'saw' or 'square'. Its phase comes
 *                                          from `phase` (0..1), else `seed`,
 *                                          else the visualization's own seed
 *   { progress: true }                     song position, 0 at the start to 1
 *                                          at the end (0 for a live source)
 *   { hold: 'snare', pick: 'random' }      sample-and-hold: each hit of the
 *                                          trigger picks a new value and keeps
 *                                          it until the next. `pick` is
 *                                          'random' (seeded by `seed` if given),
 *                                          'impact' (the hit's), 'cycle'
 *                                          (`steps` evenly spaced levels in
 *                                          turn, default 4), 'toggle' (0, 1, 0…),
 *                                          or any level spec, read at the hit.
 *                                          `initial` is the value before the
 *                                          first hit
 *
 * Modifiers apply to any spec object, in this order: `invert` (1 − x),
 * `smooth` (seconds), `curve` (exponent), `gain` (multiplier), `offset`
 * (added), `quantize` (snapped to steps of 1/n), `clamp` (to 0..1).
 *
 * The set of primitives is deliberately closed — no expressions, no eval.
 * Config that can compute is a language, and a language is where this stops
 * being a page of closures. New sources are primitives, not operators.
 */

const warn = (path, message) => console.warn(`GloamingKit routing (${path}): ${message}`);

const constant = (k) => () => k;

const band = (name, path) => {
  if (!(name in BANDS)) {
    warn(path, `unknown band '${name}' — expected one of ${Object.keys(BANDS).join(', ')}`);
    return constant(0);
  }
  return (frame) => frame?.bands?.[name] ?? 0;
};

const rms = () => (frame) => frame?.level ?? 0;

/** A per-band field of the frame that also carries 'rms' (relative, intensity). */
const dynamic = (field, name, path) => {
  if (!(name in BANDS) && name !== 'rms') {
    warn(path, `unknown band '${name}' — expected 'rms' or one of ${Object.keys(BANDS).join(', ')}`);
    return constant(0);
  }
  return (frame) => frame?.[field]?.[name] ?? 0;
};

/**
 * Envelope follower on a trigger: rises instantly to the impact of a hit
 * (its strength scaled by the band's intensity, see util.js), falls at
 * `decay` per second. This is what makes a discrete event usable
 * anywhere a continuous level is.
 */
const envelope = (name, decay) => {
  let value = 0;
  return (frame, dt, events) => {
    const hit = events?.get(name);
    if (hit) value = Math.max(value, impact(hit));
    value = Math.max(0, value - dt * decay);
    return value;
  };
};

const combine = (specs, path, reducer, seed, random) => {
  if (!Array.isArray(specs)) {
    warn(path, 'expected a list of specs to combine');
    return constant(0);
  }
  const parts = specs.map((s, i) => compileLevel(s, `${path}[${i}]`, random));
  if (!parts.length) return constant(0);
  return (frame, dt, events) => {
    let acc = seed;
    for (const part of parts) acc = reducer(acc, part(frame, dt, events));
    return acc;
  };
};

const SHAPES = {
  sine: (x) => 0.5 - 0.5 * Math.cos(2 * Math.PI * x),
  triangle: (x) => 1 - Math.abs(1 - 2 * x),
  saw: (x) => x,
  square: (x) => (x < 0.5 ? 0 : 1),
};

/**
 * A random source: seeded when the spec gives a seed, else the caller's
 * (a visualization passes its own seeded one), else Math.random.
 */
const rngOf = (seed, random = Math.random) => (Number.isFinite(seed) ? mulberry32(seed) : random);

/**
 * Oscillator on song time, so it is where it should be after a seek and
 * holds still while paused.
 */
const lfo = (spec, path, random) => {
  const rate = Number(spec.lfo);
  if (!Number.isFinite(rate) || rate < 0) {
    warn(path, `lfo rate must be a number of Hz, got ${JSON.stringify(spec.lfo)}`);
    return constant(0);
  }
  let wave = SHAPES[spec.shape ?? 'sine'];
  if (!wave) {
    warn(path, `unknown lfo shape '${spec.shape}' — expected one of ${Object.keys(SHAPES).join(', ')}`);
    wave = SHAPES.sine;
  }
  const phase = Number.isFinite(spec.phase) ? spec.phase : rngOf(spec.seed, random)();
  return (frame) => {
    const x = (frame?.time ?? 0) * rate + phase;
    return wave(x - Math.floor(x));
  };
};

const progress = () => (frame) => {
  const d = frame?.duration;
  return d > 0 && Number.isFinite(d) ? clamp01((frame.time ?? 0) / d) : 0;
};

const PICKS = ['random', 'impact', 'cycle', 'toggle'];

/** Sample-and-hold on a trigger; see the header for `pick`. */
const hold = (spec, path, random) => {
  const name = spec.hold;
  if (typeof name !== 'string') {
    warn(path, 'hold takes a trigger name');
    return constant(0);
  }
  const pick = spec.pick ?? 'random';
  const rng = rngOf(spec.seed, random);
  const steps = Math.max(2, Math.round(spec.steps ?? 4));
  const sampled = PICKS.includes(pick) ? null : compileLevel(pick, `${path}.pick`, random);
  let count = 0;
  let held = Number.isFinite(spec.initial) ? spec.initial : null;

  const next = (hit, current) => {
    count += 1;
    switch (pick) {
      case 'impact': return impact(hit);
      case 'cycle': return (count % steps) / (steps - 1);
      case 'toggle': return count % 2;
      case 'random': return rng();
      default: return current;
    }
  };

  return (frame, dt, events) => {
    // A sampled spec runs every frame, so its smoothing and envelopes keep time.
    const current = sampled ? sampled(frame, dt, events) : 0;
    if (held === null) held = pick === 'random' ? rng() : sampled ? current : 0;
    const hit = events?.get(name);
    if (hit) held = next(hit, current);
    return held;
  };
};

/** Compile a level spec into a signal. Never throws; warns and yields 0. */
export function compileLevel(spec, path = 'input', random = Math.random) {
  let signal;

  if (spec == null) {
    signal = constant(0);
  } else if (typeof spec === 'number') {
    signal = constant(spec);
  } else if (typeof spec === 'string') {
    signal = spec === 'rms' ? rms() : band(spec, path);
  } else if (Array.isArray(spec)) {
    return combine(spec, path, (a, b) => a + b, 0, random);
  } else if (typeof spec === 'object') {
    if (spec.band !== undefined) {
      signal = band(spec.band, path);
    } else if (spec.relative !== undefined) {
      signal = dynamic('relative', spec.relative, path);
    } else if (spec.intensity !== undefined) {
      signal = dynamic('intensity', spec.intensity, path);
    } else if (spec.trigger !== undefined) {
      signal = envelope(spec.trigger, spec.decay ?? 3);
    } else if (spec.const !== undefined) {
      signal = constant(spec.const);
    } else if (spec.sum !== undefined) {
      signal = combine(spec.sum, path, (a, b) => a + b, 0, random);
    } else if (spec.max !== undefined) {
      signal = combine(spec.max, path, Math.max, 0, random);
    } else if (spec.min !== undefined) {
      signal = combine(spec.min, path, Math.min, Infinity, random);
    } else if (spec.mul !== undefined) {
      signal = combine(spec.mul, path, (a, b) => a * b, 1, random);
    } else if (spec.lfo !== undefined) {
      signal = lfo(spec, path, random);
    } else if (spec.progress) {
      signal = progress();
    } else if (spec.hold !== undefined) {
      signal = hold(spec, path, random);
    } else {
      warn(path, 'no source in spec (expected band, relative, intensity, trigger, const, sum, max, min, mul, lfo, progress or hold)');
      signal = constant(0);
    }

    // Modifiers, innermost first.
    if (spec.invert) {
      const inner = signal;
      signal = (f, dt, e) => 1 - inner(f, dt, e);
    }
    if (spec.smooth) {
      const inner = signal;
      const tau = spec.smooth;
      let held = 0;
      signal = (f, dt, e) => (held = approach(held, inner(f, dt, e), tau, dt));
    }
    if (spec.curve) {
      const inner = signal;
      const exponent = spec.curve;
      signal = (f, dt, e) => Math.pow(Math.max(0, inner(f, dt, e)), exponent);
    }
    if (spec.gain !== undefined) {
      const inner = signal;
      const gain = spec.gain;
      signal = (f, dt, e) => inner(f, dt, e) * gain;
    }
    if (spec.offset) {
      const inner = signal;
      const offset = spec.offset;
      signal = (f, dt, e) => inner(f, dt, e) + offset;
    }
    if (spec.quantize > 0) {
      const inner = signal;
      const n = spec.quantize;
      signal = (f, dt, e) => Math.round(inner(f, dt, e) * n) / n;
    }
    if (spec.clamp) {
      const inner = signal;
      signal = (f, dt, e) => clamp01(inner(f, dt, e));
    }
  } else {
    warn(path, `cannot route from ${typeof spec}`);
    signal = constant(0);
  }

  return signal;
}

/**
 * Every trigger name referenced anywhere in a level spec, including inside
 * nests and the trigger a `hold` samples on. Exists for validation: the compiler itself never sees the
 * analyzer, so it can't know whether an envelope's trigger is configured —
 * the engine collects the names and checks at spawn time.
 */
export function referencedTriggers(spec, into = []) {
  if (Array.isArray(spec)) {
    for (const s of spec) referencedTriggers(s, into);
  } else if (spec && typeof spec === 'object') {
    if (typeof spec.trigger === 'string') into.push(spec.trigger);
    if (typeof spec.hold === 'string') into.push(spec.hold);
    for (const key of ['sum', 'max', 'min', 'mul']) {
      if (Array.isArray(spec[key])) referencedTriggers(spec[key], into);
    }
    if (spec.pick && typeof spec.pick === 'object') referencedTriggers(spec.pick, into);
  }
  return into;
}

/**
 * Resolve an event spec to a trigger name. Event slots only ever alias one
 * trigger to another — there is nothing to combine, since a response like
 * "snap to a new ratio" has to happen once, on the hit.
 */
export function resolveEvent(spec, path = 'input') {
  if (typeof spec === 'string') return spec;
  if (spec && typeof spec === 'object' && typeof spec.trigger === 'string') return spec.trigger;
  warn(path, 'event slots take a trigger name');
  return null;
}
