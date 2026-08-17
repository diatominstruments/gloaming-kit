import { BANDS } from './analyzer.js';
import { approach, clamp01 } from './util.js';

/**
 * Signals — the routing layer behind input slots.
 *
 * A signal is just `(frame, dt, events) => number`, with any state it needs
 * captured in a closure. Two decisions keep this small:
 *
 *  - Everything is continuous. Triggers are discrete, so they pass through an
 *    envelope at the boundary: a hit jumps the value to its strength, which
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
 *   0.5                                    a constant
 *   { band: 'treble', gain: 1.4 }          shaped
 *   { trigger: 'bass', decay: 4 }          envelope on a trigger
 *   { sum: ['bass', { band: 'mid', gain: 0.5 }] }
 *   { max: [...] }                         loudest wins
 *   [a, b]                                 shorthand for { sum: [a, b] }
 *
 * Modifiers apply to any spec object, in this order: `smooth` (seconds),
 * `curve` (exponent), `gain` (multiplier), `clamp` (to 0..1).
 *
 * The set of primitives is deliberately closed — no expressions, no eval.
 * Config that can compute is a language, and a language is where this stops
 * being 150 lines.
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

/**
 * Envelope follower on a trigger: rises instantly to the strength of a hit,
 * falls at `decay` per second. This is what makes a discrete event usable
 * anywhere a continuous level is.
 */
const envelope = (name, decay) => {
  let value = 0;
  return (frame, dt, events) => {
    const hit = events?.get(name);
    if (hit) value = Math.max(value, hit.strength);
    value = Math.max(0, value - dt * decay);
    return value;
  };
};

const combine = (specs, path, reducer, seed) => {
  const parts = specs.map((s, i) => compileLevel(s, `${path}[${i}]`));
  return (frame, dt, events) => {
    let acc = seed;
    for (const part of parts) acc = reducer(acc, part(frame, dt, events));
    return acc;
  };
};

/** Compile a level spec into a signal. Never throws; warns and yields 0. */
export function compileLevel(spec, path = 'input') {
  let signal;

  if (spec == null) {
    signal = constant(0);
  } else if (typeof spec === 'number') {
    signal = constant(spec);
  } else if (typeof spec === 'string') {
    signal = spec === 'rms' ? rms() : band(spec, path);
  } else if (Array.isArray(spec)) {
    return combine(spec, path, (a, b) => a + b, 0);
  } else if (typeof spec === 'object') {
    if (spec.band !== undefined) {
      signal = band(spec.band, path);
    } else if (spec.trigger !== undefined) {
      signal = envelope(spec.trigger, spec.decay ?? 3);
    } else if (spec.const !== undefined) {
      signal = constant(spec.const);
    } else if (spec.sum !== undefined) {
      signal = combine(spec.sum, path, (a, b) => a + b, 0);
    } else if (spec.max !== undefined) {
      signal = combine(spec.max, path, Math.max, 0);
    } else {
      warn(path, `no source in spec (expected band, trigger, const, sum or max)`);
      signal = constant(0);
    }

    // Modifiers, innermost first.
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
 * sum/max nests. Exists for validation: the compiler itself never sees the
 * analyzer, so it can't know whether an envelope's trigger is configured —
 * the engine collects the names and checks at spawn time.
 */
export function referencedTriggers(spec, into = []) {
  if (Array.isArray(spec)) {
    for (const s of spec) referencedTriggers(s, into);
  } else if (spec && typeof spec === 'object') {
    if (typeof spec.trigger === 'string') into.push(spec.trigger);
    if (Array.isArray(spec.sum)) referencedTriggers(spec.sum, into);
    if (Array.isArray(spec.max)) referencedTriggers(spec.max, into);
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
