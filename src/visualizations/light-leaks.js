import { Visualization, approach, clamp01, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { LAYER } from './layers.js';
import { TRIGGER } from '../analyzer.js';
import { createNoise3D } from '../noise.js';
import { rgba } from '../style.js';

/**
 * LightLeaks — the look of film: large out-of-focus discs of light (bokeh)
 * drifting across the frame, and warm glows bleeding in from off-screen
 * edges. Everything is added with 'lighter', so overlaps brighten.
 *
 *   warmth  how strongly the edge leaks glow, and a little of every disc
 *   drift   how fast the discs wander
 *   bloom   a hit lights up a few discs at once and flares the leaks
 *
 * Discs alternate lineColor and accentColor; leaks use accentColor.
 */
export class LightLeaks extends Visualization {
  static id = 'light-leaks';
  static label = 'Light Leaks';
  static description = 'Drifting bokeh and edge glows, as if shot through a lens; hits bloom a few discs at once.';
  static category = CATEGORY.BACKGROUNDS;
  static layer = LAYER.BACKGROUND;
  static inputs = {
    warmth: { kind: 'level', default: { intensity: 'rms' } },
    drift:  { kind: 'level', default: 'mid' },
    bloom:  { kind: 'event', default: TRIGGER.BASS },
  };

  static DISCS = 14;
  static DISC_R = [0.04, 0.14];  // radius range, of the smaller dimension
  static DISC_ALPHA = 0.06;      // disc opacity at silence
  static DISC_WARMTH = 0.08;     // extra at full `warmth`
  static DISC_FLASH = 0.35;      // extra at a full-impact bloom
  static FLASH_DECAY = 1.6;      // per second
  static FLASH_SWELL = 0.3;      // discs grow by this much at full flash
  static BLOOM_COUNT = 3;        // discs lit per hit
  static BASE_DRIFT = 0.015;     // of the smaller dimension per second
  static DRIFT_GAIN = 0.06;
  static DRIFT_TAU = 0.8;
  static WARMTH_TAU = 0.6;
  static LEAKS = 2;
  static LEAK_R = 0.8;           // of the larger dimension
  static LEAK_ALPHA = 0.05;
  static LEAK_WARMTH = 0.22;
  static LEAK_FLARE = 0.15;
  static LEAK_RATE = 0.02;       // how fast leaks slide around the edge, per second

  constructor(opts) {
    super(opts);
    this.noise = createNoise3D(5);
    const [lo, hi] = LightLeaks.DISC_R;
    this.discs = Array.from({ length: LightLeaks.DISCS }, (_, i) => ({
      u: Math.random(),
      v: Math.random(),
      r: lo + Math.random() * (hi - lo),
      accent: i % 2 === 1,
      flash: 0,
    }));
    // Leaks sit at a position along the screen's perimeter, 0..1.
    this.leaks = Array.from({ length: LightLeaks.LEAKS }, (_, i) => ({
      at: i / LightLeaks.LEAKS + Math.random() * 0.2,
      dir: i % 2 ? 1 : -1,
    }));
    this.t = 0;
    this.warmth = 0;
    this.drift = 0;
    this.flare = 0;
  }

  onInput(slot, data) {
    if (slot !== 'bloom') return;
    const k = impact(data);
    this.flare = Math.max(this.flare, k);
    for (let i = 0; i < LightLeaks.BLOOM_COUNT; i++) {
      const d = this.discs[(Math.random() * this.discs.length) | 0];
      if (d) d.flash = Math.max(d.flash, k);
    }
  }

  /** A point just outside the screen, `at` of the way round its perimeter. */
  edgePoint(at) {
    const w = this.width;
    const h = this.height;
    const p = (((at % 1) + 1) % 1) * 2 * (w + h);
    const out = Math.min(w, h) * 0.1;
    if (p < w) return [p, -out];
    if (p < w + h) return [w + out, p - w];
    if (p < 2 * w + h) return [w - (p - w - h), h + out];
    return [-out, h - (p - 2 * w - h)];
  }

  glow(ctx, x, y, r, color, alpha, rim) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(color, alpha * (rim ? 0.6 : 1)));
    // A bokeh disc is flat with a slightly brighter edge, then falls off.
    if (rim) g.addColorStop(0.82, rgba(color, alpha));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  draw(ctx, dt) {
    const L = LightLeaks;
    this.t += dt;
    this.warmth = approach(this.warmth, clamp01(this.in('warmth')), L.WARMTH_TAU, dt);
    this.drift = approach(this.drift, this.in('drift'), L.DRIFT_TAU, dt);
    const flareDecay = Math.exp(-L.FLASH_DECAY * dt);
    this.flare *= flareDecay;

    const min = Math.min(this.width, this.height);
    const max = Math.max(this.width, this.height);
    const step = (L.BASE_DRIFT + L.DRIFT_GAIN * this.drift) * dt * min;
    const { style } = this;
    const accent = style.accentColor ?? style.lineColor;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowBlur = 0;

    for (const leak of this.leaks) {
      leak.at += leak.dir * L.LEAK_RATE * dt;
      const [x, y] = this.edgePoint(leak.at);
      const a = L.LEAK_ALPHA + L.LEAK_WARMTH * this.warmth + L.LEAK_FLARE * this.flare;
      this.glow(ctx, x, y, max * L.LEAK_R, accent, a, false);
    }

    this.discs.forEach((d, i) => {
      d.flash *= flareDecay;
      const heading = this.noise(d.u * 2, d.v * 2, this.t * 0.05 + i) * Math.PI * 2;
      d.u += (Math.cos(heading) * step) / this.width;
      d.v += (Math.sin(heading) * step) / this.height;
      // Wrap with a margin so a disc leaves entirely before reappearing.
      const mu = (d.r * min) / this.width;
      const mv = (d.r * min) / this.height;
      if (d.u < -mu) d.u = 1 + mu;
      if (d.u > 1 + mu) d.u = -mu;
      if (d.v < -mv) d.v = 1 + mv;
      if (d.v > 1 + mv) d.v = -mv;

      const r = d.r * min * (1 + L.FLASH_SWELL * d.flash);
      const a = L.DISC_ALPHA + L.DISC_WARMTH * this.warmth + L.DISC_FLASH * d.flash;
      this.glow(ctx, d.u * this.width, d.v * this.height, r, d.accent ? accent : style.lineColor, a, true);
    });
    ctx.restore();
  }
}
