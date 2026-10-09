import { approach, clamp01, impact } from './base.js';
import { TreatmentVisualization } from './treatment-base.js';
import { TRIGGER } from '../analyzer.js';
import { rgba } from '../style.js';

/**
 * ReflectingPool — a waterline across the screen with everything above it
 * reflected below, in strips that ripple. The pool lies over the lower part
 * of the frame (this is an overlay), so the figure stands at the water's
 * edge and its upside-down twin wavers beneath it.
 *
 *   reveal   how solid the water is — at silence the figure's lower half
 *            shows through it, at full it is all reflection
 *   current  how fast the ripples travel
 *   tide     the waterline rises with the bass and settles back
 *   glow     the surface line shimmers and the water takes the tint colour
 *   splash   a hit drops a ring of ripples that runs away from the
 *            waterline, and flashes the surface toward the peak colour
 *
 * Options:
 *   waterline   where the surface sits, of the height from the top (default 0.6)
 *   strips      how many bands the reflection is cut into (default 64)
 *   ripple      ripple amplitude (default 1)
 *   wavelength  of the height (default 0.1)
 *   squash      vertical compression of the reflection (default 0.9)
 *   fade        how dark the water gets toward the bottom (default 0.6)
 *   tide        how far the waterline rises at full `tide`, of the height
 *   splash      ring strength (default 1)
 *   shimmer     surface line brightness (default 0.6)
 *   floor/depth, tint, tintColor
 */
export class ReflectingPool extends TreatmentVisualization {
  static id = 'reflecting-pool';
  static label = 'Reflecting Pool';
  static description = 'A waterline with everything above it reflected below in rippling strips; the tide rises on the bass and hits drop rings.';
  static inputs = {
    reveal:  { kind: 'level', default: { intensity: 'rms' } },
    current: { kind: 'level', default: 'mid' },
    tide:    { kind: 'level', default: { relative: 'bass' } },
    glow:    { kind: 'level', default: { relative: 'treble' } },
    splash:  { kind: 'event', default: TRIGGER.BASS },
  };
  static options = {
    waterline:  { kind: 'number', default: 0.6, min: 0.2, max: 0.9, step: 0.01 },
    strips:     { kind: 'number', default: 64, min: 8, max: 240, step: 1 },
    ripple:     { kind: 'number', default: 1, min: 0, max: 3, step: 0.05 },
    wavelength: { kind: 'number', default: 0.1, min: 0.02, max: 0.5, step: 0.01 },
    squash:     { kind: 'number', default: 0.9, min: 0.4, max: 1, step: 0.02 },
    fade:       { kind: 'number', default: 0.6, min: 0, max: 1, step: 0.05 },
    tide:       { kind: 'number', default: 0.08, min: 0, max: 0.3, step: 0.01 },
    splash:     { kind: 'number', default: 1, min: 0, max: 3, step: 0.1 },
    shimmer:    { kind: 'number', default: 0.6, min: 0, max: 1, step: 0.05 },
    floor:      { kind: 'number', default: 0.45, min: 0, max: 1, step: 0.05 },
    depth:      { kind: 'number', default: 0.55, min: 0, max: 1, step: 0.05 },
    tint:       { kind: 'number', default: 0.5, min: 0, max: 1, step: 0.05 },
    tintColor:  { kind: 'enum', values: ['accent', 'line'], default: 'accent' },
  };

  static REVEAL_TAU = 0.3;
  static CURRENT_TAU = 0.4;
  static TIDE_ATTACK = 0.08;
  static TIDE_RELEASE = 0.6;
  static GLOW_TAU = 0.1;
  static SPEED_BASE = 0.6;       // ripple travel, cycles per second at silence
  static SPEED_GAIN = 2.4;       // extra at full `current`
  static AMP = 0.006;            // base amplitude, of the height, growing with depth
  static AMP_DEPTH = 2.5;        // amplitude multiplier at the bottom
  static RING_SPEED = 0.5;       // heights per second a splash ring travels
  static RING_WIDTH = 0.06;      // of the height
  static RING_DECAY = 1.6;       // per second
  static RING_AMP = 0.03;        // of the height at full impact
  static FLASH_DECAY = 5;
  static SURFACE = 3;            // px, surface line

  constructor(opts) {
    super(opts);
    this.waterline = this.option('waterline');
    this.strips = this.option('strips');
    this.ripple = this.option('ripple');
    this.wavelength = this.option('wavelength');
    this.squash = this.option('squash');
    this.fade = this.option('fade');
    this.tideGain = this.option('tide');
    this.splashGain = this.option('splash');
    this.shimmer = this.option('shimmer');
    this.floor = this.option('floor');
    this.depth = Math.min(this.option('depth'), 1 - this.floor);
    this.tintGain = this.option('tint');
    this.tintColor = this.option('tintColor');
    this.reveal = 0;
    this.flow = 0;        // smoothed `current` (the name is the snapshot canvas)
    this.tide = 0;
    this.glow = 0;
    this.flash = 0;
    this.phase = 0;
    this.rings = [];      // { r (of height, from the waterline), strength }
  }

  onInput(slot, data) {
    if (slot !== 'splash') return;
    const hit = impact(data);
    this.flash = Math.max(this.flash, hit);
    if (this.splashGain > 0) this.rings.push({ r: 0, strength: hit * this.splashGain });
  }

  draw(ctx, dt) {
    const P = ReflectingPool;
    this.reveal = approach(this.reveal, clamp01(this.in('reveal')), P.REVEAL_TAU, dt);
    this.flow = approach(this.flow, clamp01(this.in('current')), P.CURRENT_TAU, dt);
    const tide = clamp01(this.in('tide'));
    this.tide = approach(this.tide, tide, tide > this.tide ? P.TIDE_ATTACK : P.TIDE_RELEASE, dt);
    this.glow = approach(this.glow, clamp01(this.in('glow')), P.GLOW_TAU, dt);
    this.flash *= Math.exp(-P.FLASH_DECAY * dt);
    this.phase += dt * (P.SPEED_BASE + P.SPEED_GAIN * this.flow) * Math.PI * 2;
    for (const ring of this.rings) {
      ring.r += dt * P.RING_SPEED;
      ring.strength *= Math.exp(-P.RING_DECAY * dt);
    }
    this.rings = this.rings.filter((ring) => ring.strength > 0.02 && ring.r < 1.5);

    const H = this.height;
    const W = this.width;
    const y0 = H * (this.waterline - this.tideGain * this.tide);
    const pool = H - y0;
    if (pool <= 1) return;

    const src = this.snapshot(ctx);
    const dpr = this.dpr;
    const accent = this.tintColor === 'line' ? this.style.lineColor : (this.style.accentColor ?? this.style.lineColor);
    const color = this.peak(accent, Math.max(this.flash, this.glow));
    const water = this.tinted(color, this.tintGain * (0.2 + 0.8 * this.glow));

    const base = ctx.globalAlpha;
    const alpha = base * clamp01(this.floor + this.depth * this.reveal);
    const n = this.strips;
    const sh = pool / n;
    const lambda = this.wavelength * H;
    const ringWidth = P.RING_WIDTH * H;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y0, W, pool);
    ctx.clip();
    ctx.globalAlpha = alpha;
    for (let k = 0; k < n; k++) {
      const d = (k + 0.5) * sh;            // depth below the waterline
      const u = d / pool;
      const amp = this.ripple * P.AMP * H * (1 + P.AMP_DEPTH * u);
      let dx = amp * (0.6 * Math.sin((d / lambda) * Math.PI * 2 - this.phase)
        + 0.4 * Math.sin((d / (lambda * 0.53)) * Math.PI * 2 + this.phase * 1.3 + 1.7));
      let dy = amp * 0.5 * Math.cos((d / lambda) * Math.PI * 2 - this.phase * 0.8);
      for (const ring of this.rings) {
        const gap = d - ring.r * H;
        const env = Math.exp(-(gap * gap) / (ringWidth * ringWidth));
        if (env < 0.01) continue;
        const wave = ring.strength * P.RING_AMP * H * env * Math.sin(gap / ringWidth * 3);
        dy += wave;
        dx += wave * 0.5;
      }
      const top = y0 + k * sh;
      // Source rows run upward from the waterline, so the strip is drawn
      // flipped: its bottom edge is the row nearest the surface.
      const ys = y0 - ((k + 1) * sh) / this.squash - dy;
      const srcH = sh / this.squash;
      if (ys < 0) {
        // Nothing above the screen to reflect: deep water.
        ctx.fillStyle = this.style.background;
        ctx.fillRect(0, top, W, sh + 1);
        continue;
      }
      ctx.save();
      ctx.translate(dx, top + sh);
      ctx.scale(1, -1);
      ctx.drawImage(water, 0, ys * dpr, src.width, srcH * dpr, 0, 0, W, sh);
      if (dx !== 0) {
        // Keep the strip's edge filled where it slid off.
        ctx.drawImage(water, 0, ys * dpr, src.width, srcH * dpr, dx > 0 ? -W : W, 0, W, sh);
      }
      ctx.restore();
    }

    // Depth: the water darkens toward the bottom.
    if (this.fade > 0) {
      const g = ctx.createLinearGradient(0, y0, 0, H);
      g.addColorStop(0, rgba(this.style.background, 0));
      g.addColorStop(1, rgba(this.style.background, this.fade));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = g;
      ctx.fillRect(0, y0, W, pool);
    }
    ctx.restore();

    // The surface: a bright line that shimmers with the glow and flashes on a splash.
    const shine = this.shimmer * (0.25 + 0.75 * Math.max(this.glow, this.flash));
    if (shine > 0.01) {
      ctx.save();
      ctx.globalAlpha = base;
      const line = this.peak(this.style.lineColor, this.flash);
      const g = ctx.createLinearGradient(0, y0 - P.SURFACE, 0, y0 + P.SURFACE * 4);
      g.addColorStop(0, rgba(line, 0));
      g.addColorStop(0.2, rgba(line, shine));
      g.addColorStop(1, rgba(line, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, y0 - P.SURFACE, W, P.SURFACE * 5);
      ctx.restore();
    }
  }
}
