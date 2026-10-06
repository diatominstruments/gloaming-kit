import { compileLevel } from '../signals.js';
import { peakMix, peakAmount } from '../style.js';

export { approach, clamp01, impact } from '../util.js';

/**
 * Visualization — base class for everything in the library.
 *
 * A visualization declares named *input slots* rather than reading the
 * analyzer directly, so a timeline window can rewire what feeds each one
 * without the visualization knowing:
 *
 *   static inputs = {
 *     punch:  { kind: 'event', default: TRIGGER.BASS },
 *     spread: { kind: 'level', default: 'mid' },
 *   };
 *
 * Two kinds, because they answer different questions:
 *
 *   'level'  a continuous number, read during draw with `this.in('spread')`.
 *            Bound to any signal spec (see signals.js) — a band, an envelope
 *            on a trigger, a sum of both, shaped by gain/curve/smoothing.
 *   'event'  a discrete hit, delivered to `onInput('punch', data)`. For
 *            responses that must happen once at an instant rather than
 *            tracking a level.
 *
 * Every slot has a default, so an unbound visualization behaves exactly as
 * if the routing layer weren't there.
 *
 * A timeline entry may also carry `options` — plain per-instance settings that
 * have nothing to do with audio, reachable as `this.options`:
 *
 *   { id: 'thomas', options: { distance: 'near' } }
 *
 * Unlike a binding, nothing compiles or validates these; a visualization reads
 * the keys it knows and falls back to its own static defaults. It declares
 * the ones it reads so an editor can offer them. An array lists the allowed
 * values (shorthand for `kind: 'enum'` with no declared default); an object
 * describes the value in full:
 *
 *   static options = {
 *     distance:  { kind: 'enum', values: ['near', 'med', 'far'], default: 'med' },
 *     text:      { kind: 'string', default: 'GLOAMING', maxLength: 32 },
 *     threshold: { kind: 'number', default: 0.6, min: 0, max: 1, step: 0.01 },
 *   };
 *
 * A fourth kind, 'grid', is a drawing for an editor to offer as a canvas of
 * cells; see glyph.js.
 *
 * Read a declared option with `this.option(name)`, which validates the value
 * against its declaration and falls back to the default. Reading them once
 * in the constructor is the norm: a changed option is a new instance (the
 * timeline keys entries by their options), so nothing has to track changes.
 *
 * Colour at extremes: the style carries a `peakColor` that shows only when
 * the sound peaks — a hit's `impact()` near 1, a level near 1. Draw it with
 * `this.peak(base, level)`, which pushes `base` toward it as `level` rises
 * past `style.peakAbove`, and leaves `base` alone below. With no `peakColor`
 * set (the default) it returns `base` unchanged, so nothing looks different
 * until an app opts in.
 *
 * Descriptive metadata, all optional, for pickers and editors (see describe()
 * and catalog() in index.js, which read it):
 *
 *   static label       = 'Radial Burst';   // display name; derived from id if unset
 *   static description = 'One line on what it looks like and reacts to.';
 *   static category    = CATEGORY.CLASSIC; // see categories.js
 *
 * Subclasses implement:
 *
 *   onFrame(frame)          per-tick analysis data (bands, spectrum, level…)
 *   onInput(slot, data)     an event slot fired
 *   draw(ctx, dt)           render; ctx is pre-styled, dt is seconds elapsed
 *   afterFrame(ctx)         optional; the whole frame, every layer, has been
 *                           drawn — for effects that feed it into the next
 *   dispose()               optional; the window ended and the fade finished —
 *                           release anything the garbage collector can't
 *                           (GPU buffers, see three-base.js)
 *
 * The engine owns the lifecycle: instances are created when their timeline
 * window starts and disposed when it ends, with an alpha fade in between.
 *
 * `static triggers = [...]` with `onTrigger(name, data)` still works for
 * visualizations that don't declare slots, but it can't be rerouted.
 */
export class Visualization {
  static triggers = [];
  static inputs = {};
  static options = {};

  constructor({ width, height, style, bind = null, options = null }) {
    this.width = width;
    this.height = height;
    this.style = style;
    this.options = options ?? {};
    this.frame = null; // latest analyzer frame, kept by default onFrame

    // Compile one signal per level slot, from the window's binding if it has
    // one and the declared default otherwise.
    this.levels = {};
    this.signals = [];
    for (const [slot, def] of Object.entries(this.constructor.inputs)) {
      if (def.kind !== 'level') continue;
      const spec = bind && bind[slot] !== undefined ? bind[slot] : def.default;
      this.signals.push([slot, compileLevel(spec, `${this.constructor.id}.${slot}`)]);
      this.levels[slot] = 0;
    }
  }

  onFrame(frame) {
    this.frame = frame;
  }

  /** Called by the engine each tick, before draw. */
  updateInputs(frame, dt, events) {
    for (const [slot, signal] of this.signals) {
      this.levels[slot] = signal(frame, dt, events);
    }
  }

  /** Current value of a level input slot. */
  in(slot) {
    return this.levels[slot] ?? 0;
  }

  /**
   * A declared option's value: the instance's if it is valid for the
   * declaration, else the declared default. Numbers are clamped to
   * `min`/`max` and snapped to an integer `step`; enums must be one of
   * `values`; strings are cut to `maxLength`. Undeclared names read as given.
   */
  option(name) {
    const spec = this.constructor.options?.[name];
    const value = this.options[name];
    if (!spec) return value;
    if (Array.isArray(spec)) return spec.includes(value) ? value : spec[0];
    switch (spec.kind) {
      case 'number': {
        let n = Number(value);
        if (value == null || value === '' || !Number.isFinite(n)) n = spec.default;
        if (spec.min !== undefined) n = Math.max(spec.min, n);
        if (spec.max !== undefined) n = Math.min(spec.max, n);
        if (Number.isInteger(spec.step) && spec.step > 0) n = Math.round(n / spec.step) * spec.step;
        return n;
      }
      case 'enum':
        return spec.values?.includes(value) ? value : (spec.default ?? spec.values?.[0]);
      case 'string': {
        const str = value == null ? spec.default : String(value);
        return spec.maxLength ? String(str).slice(0, spec.maxLength) : str;
      }
      default:
        return value === undefined ? spec.default : value;
    }
  }

  /**
   * `base` pushed toward the style's peak colour as `level` (0..1) rises past
   * `style.peakAbove`; `base` itself below that. For the extremes: a hit's
   * `impact()`, a level near 1.
   */
  peak(base, level) {
    return peakMix(this.style, base, level);
  }

  /** How far toward the peak colour `level` reaches, 0..1; see peak(). */
  peakAmount(level) {
    return peakAmount(this.style, level);
  }

  onInput(slot, data) {}

  onTrigger(name, data) {}

  draw(ctx, dt) {}

  afterFrame(ctx) {}

  dispose() {}

  resize(width, height) {
    this.width = width;
    this.height = height;
  }

  /** Apply the shared style object to a canvas context. */
  applyStyle(ctx) {
    const s = this.style;
    ctx.strokeStyle = s.lineColor;
    ctx.fillStyle = s.lineColor;
    ctx.lineWidth = s.lineWidth ?? 2;
    ctx.shadowBlur = s.shadowBlur ?? 0;
    ctx.shadowColor = s.shadowColor ?? s.lineColor;
  }
}
