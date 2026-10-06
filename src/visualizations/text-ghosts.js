import { Visualization, approach, clamp01, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { LAYER } from './layers.js';
import { TRIGGER } from '../analyzer.js';
import { createNoise3D } from '../noise.js';
import { rgba } from '../style.js';

/** Wrap a normalized coordinate into -0.1..1.1, so ghosts leave fully before re-entering. */
const wrap = (u) => ((((u + 0.1) % 1.2) + 1.2) % 1.2) - 0.1;

/**
 * TextGhosts — a background of one word. Each hit stamps a bright copy of
 * the text somewhere on screen, which swells and fades; when it has faded
 * it stays behind as a ghost. Ghosts drift on a noise flow field and come
 * and go in slow patches where a second noise field runs high, so the
 * screen is haunted unevenly rather than sprinkled.
 *
 *   stamp  a hit prints a new bright copy
 *   haze   how visible the ghosts are overall
 *   drift  how fast the ghosts are carried along
 *
 * Options:
 *   text   the string (default 'GLOAMING')
 *   count  how many ghosts linger (default 24)
 *   seed   which flow field (default 1); share a seed with perlin-glow to
 *          drift through the same currents it shows
 */
export class TextGhosts extends Visualization {
  static id = 'text-ghosts';
  static label = 'Text Ghosts';
  static description = 'Hits stamp the text around the screen; faded ghosts of it drift in patches on a flow field.';
  static category = CATEGORY.BACKGROUNDS;
  static layer = LAYER.BACKGROUND;
  static inputs = {
    stamp: { kind: 'event', default: TRIGGER.BASS },
    haze:  { kind: 'level', default: { intensity: 'rms' } },
    drift: { kind: 'level', default: 'mid' },
  };
  static TEXT = 'GLOAMING';
  static options = {
    text:  { kind: 'string', default: TextGhosts.TEXT, maxLength: 32 },
    count: { kind: 'number', default: 24, min: 0, max: 80, step: 1 },
    seed:  { kind: 'number', default: 1, min: 0, max: 9999, step: 1 },
    size:  { kind: 'number', default: 0.09, min: 0.03, max: 0.3, step: 0.01 },
    field: { kind: 'number', default: 2.2, min: 0.5, max: 6, step: 0.1 },
  };

  static SIZE = 0.09;         // ghost font size, of the smaller dimension
  static SIZE_SPREAD = [0.5, 1.6]; // ghost size range, as a multiple of SIZE
  static STAMP_SIZE = 0.16;   // stamp font size, of the smaller dimension
  static STAMP_LIFE = 1.1;    // seconds a stamp takes to fade
  static STAMP_SWELL = 0.25;  // how much a stamp grows while it fades
  static MAX_STAMPS = 6;

  static FIELD = 2.2;         // noise units across the smaller dimension
  static BASE_DRIFT = 0.02;   // of the smaller dimension per second
  static DRIFT_GAIN = 0.08;   // extra at full `drift`
  static DRIFT_TAU = 0.6;
  static HAZE_FLOOR = 0.05;   // ghost opacity ceiling at silence
  static HAZE_GAIN = 0.2;     // extra at full `haze`
  static HAZE_TAU = 0.5;
  static PATCH = 0.1;         // noise level above which ghosts show at all
  static PATCH_RATE = 0.07;   // how fast the patches move, per second

  constructor(opts) {
    super(opts);
    this.text = this.option('text');
    this.noise = createNoise3D(this.option('seed'));
    this.size = this.option('size');     // ghost font size, of the smaller dimension
    this.field = this.option('field');   // drift-field noise scale: larger, smaller eddies
    const count = this.option('count');
    const [lo, hi] = TextGhosts.SIZE_SPREAD;
    // Normalized positions, so a resize keeps the layout.
    this.ghosts = Array.from({ length: count }, () => ({
      u: Math.random(),
      v: Math.random(),
      size: lo + Math.random() * (hi - lo),
      outline: Math.random() < 0.4,
      tilt: (Math.random() - 0.5) * 0.3,
    }));
    this.stamps = [];
    this.recycle = 0;          // next ghost a faded stamp replaces
    this.t = 0;
    this.haze = 0;
    this.drift = 0;
  }

  onInput(slot, data) {
    if (slot !== 'stamp') return;
    if (this.stamps.length >= TextGhosts.MAX_STAMPS) this.settle(this.stamps.shift());
    this.stamps.push({
      u: 0.1 + Math.random() * 0.8,
      v: 0.1 + Math.random() * 0.8,
      tilt: (Math.random() - 0.5) * 0.25,
      strength: Math.max(0.35, impact(data)),
      life: 1,
    });
  }

  font(size) {
    return `bold ${size}px ${this.style.fontFamily ?? 'sans-serif'}`;
  }

  /** A faded stamp stays on as a ghost, taking the oldest slot. */
  settle(stamp) {
    if (!this.ghosts.length) return;
    const g = this.ghosts[this.recycle];
    this.recycle = (this.recycle + 1) % this.ghosts.length;
    Object.assign(g, {
      u: stamp.u,
      v: stamp.v,
      tilt: stamp.tilt,
      size: TextGhosts.STAMP_SIZE / this.size * (1 + TextGhosts.STAMP_SWELL),
      outline: false,
    });
  }

  draw(ctx, dt) {
    const T = TextGhosts;
    this.t += dt;
    this.haze = approach(this.haze, clamp01(this.in('haze')), T.HAZE_TAU, dt);
    this.drift = approach(this.drift, this.in('drift'), T.DRIFT_TAU, dt);

    const min = Math.min(this.width, this.height);
    const aspect = this.width / min;
    const bspect = this.height / min;
    const speed = (T.BASE_DRIFT + T.DRIFT_GAIN * this.drift) * dt;
    const pt = this.t * T.PATCH_RATE;
    const ceiling = T.HAZE_FLOOR + T.HAZE_GAIN * this.haze;
    const { noise } = this;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowBlur = 0;
    const base = ctx.globalAlpha;

    for (const g of this.ghosts) {
      // Flow field: noise picks a heading at the ghost's position. Moving in
      // the smaller dimension's units keeps the speed even on wide screens.
      const nx = g.u * aspect * this.field;
      const ny = g.v * bspect * this.field;
      const heading = noise(nx, ny, pt) * Math.PI * 2;
      g.u = wrap(g.u + (Math.cos(heading) * speed) / aspect);
      g.v = wrap(g.v + (Math.sin(heading) * speed) / bspect);

      // Patches: a second, offset field decides whether this spot is haunted.
      const patch = noise(nx + 31.4, ny + 12.7, pt * 0.7);
      const alpha = ceiling * clamp01((patch - T.PATCH) / (0.5 - T.PATCH));
      if (alpha < 0.005) continue;

      ctx.save();
      ctx.translate(g.u * this.width, g.v * this.height);
      ctx.rotate(g.tilt);
      ctx.font = this.font(min * this.size * g.size);
      ctx.globalAlpha = base * alpha;
      if (g.outline) {
        ctx.strokeStyle = this.style.lineColor;
        ctx.lineWidth = 1;
        ctx.strokeText(this.text, 0, 0);
      } else {
        ctx.fillStyle = this.style.lineColor;
        ctx.fillText(this.text, 0, 0);
      }
      ctx.restore();
    }

    for (const s of this.stamps) {
      s.life -= dt / T.STAMP_LIFE;
      if (s.life <= 0) {
        this.settle(s);
        continue;
      }
      const k = s.life * s.life; // fast out, long tail
      ctx.save();
      ctx.translate(s.u * this.width, s.v * this.height);
      ctx.rotate(s.tilt);
      const size = min * T.STAMP_SIZE * (1 + T.STAMP_SWELL * (1 - s.life));
      ctx.font = this.font(size);
      ctx.globalAlpha = base * k * s.strength;
      ctx.shadowBlur = (this.style.shadowBlur ?? 0) * k;
      ctx.shadowColor = this.style.shadowColor ?? this.style.lineColor;
      ctx.fillStyle = this.style.lineColor;
      ctx.fillText(this.text, 0, 0);
      ctx.strokeStyle = rgba(this.peak(this.style.accentColor ?? this.style.lineColor, s.strength), k);
      ctx.lineWidth = 1.5;
      ctx.strokeText(this.text, 0, 0);
      ctx.restore();
    }
    this.stamps = this.stamps.filter((s) => s.life > 0);
  }
}
