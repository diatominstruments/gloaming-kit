import { Visualization, approach, clamp01, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { LAYER } from './layers.js';
import { TRIGGER } from '../analyzer.js';
import { createNoise3D } from '../noise.js';
import { rgba } from '../style.js';

/**
 * DotGrid — a halftone screen of evenly spaced dots whose sizes carry the
 * sound. Visually quiet, since nothing moves but dot radius.
 *
 * In 'noise' mode, sizes follow a drifting noise field, swollen overall by
 * `swell`. In 'spectrum' mode the spectrum is laid out radially — bass at
 * the centre, treble at the corners — so the grid reads as a round EQ.
 *
 * Each `ripple` hit sends a ring of enlarged, accent-coloured dots out from
 * the centre across the grid.
 *
 * Options:
 *   mode     'noise' or 'spectrum' (default 'noise')
 *   spacing  px between dot centres (default 26)
 */
export class DotGrid extends Visualization {
  static id = 'dot-grid';
  static label = 'Dot Grid';
  static description = 'A halftone grid of dots sized by a noise field or the spectrum; hits ripple across it.';
  static category = CATEGORY.BACKGROUNDS;
  static layer = LAYER.BACKGROUND;
  static inputs = {
    swell:  { kind: 'level', default: { intensity: 'rms' } },
    flow:   { kind: 'level', default: 'mid' },
    ripple: { kind: 'event', default: TRIGGER.BASS },
  };
  static options = {
    mode:    { kind: 'enum', values: ['noise', 'spectrum'], default: 'noise' },
    spacing: { kind: 'number', default: 26, min: 10, max: 80, step: 1 },
  };

  static MAX_R = 0.42;        // largest dot radius, of the spacing
  static MIN_R = 0.04;        // smallest drawn; below this a dot is skipped
  static BASE = 0.35;         // size scale at silence
  static SWELL_GAIN = 0.65;   // extra at full `swell`
  static SWELL_TAU = 0.3;
  static FIELD = 3;           // noise units across the smaller dimension
  static BASE_FLOW = 0.04;    // noise time units per second, at silence
  static FLOW_GAIN = 0.3;
  static FLOW_TAU = 0.5;
  static ALPHA = 0.35;        // dot opacity
  static RIPPLE_SPEED = 0.7;  // of the screen half-diagonal per second
  static RIPPLE_WIDTH = 0.08; // ring width, of the half-diagonal
  static RIPPLE_BOOST = 0.8;  // extra size on the ring, at full impact
  static SPECTRUM_DECAY = 2;  // per second; fast attack, this decay

  constructor(opts) {
    super(opts);
    this.mode = this.options.mode === 'spectrum' ? 'spectrum' : 'noise';
    this.spacing = Math.max(6, Number(this.options.spacing ?? 26) || 26);
    this.noise = createNoise3D(3);
    this.ripples = [];        // { r (0..1+ of half-diagonal), strength }
    this.t = 0;
    this.swell = 0;
    this.flow = 0;
    this.bins = new Float32Array(64); // smoothed radial spectrum
  }

  onInput(slot, data) {
    if (slot === 'ripple') this.ripples.push({ r: 0, strength: impact(data) });
  }

  /** Smoothed spectrum, log-resampled into this.bins (index 0 = bass). */
  updateBins(dt) {
    const spectrum = this.frame?.spectrum;
    if (!spectrum) return;
    const n = this.bins.length;
    let lo = 1;
    for (let i = 0; i < n; i++) {
      const hi = Math.max(lo + 1, Math.floor(Math.pow(spectrum.length * 0.7, (i + 1) / n)));
      let sum = 0;
      for (let j = lo; j < hi; j++) sum += spectrum[j];
      const v = sum / ((hi - lo) * 255);
      this.bins[i] = v > this.bins[i] ? v : Math.max(v, this.bins[i] - dt * DotGrid.SPECTRUM_DECAY);
      lo = hi;
    }
  }

  draw(ctx, dt) {
    const D = DotGrid;
    this.swell = approach(this.swell, clamp01(this.in('swell')), D.SWELL_TAU, dt);
    this.flow = approach(this.flow, this.in('flow'), D.FLOW_TAU, dt);
    this.t += dt * (D.BASE_FLOW + D.FLOW_GAIN * this.flow);
    if (this.mode === 'spectrum') this.updateBins(dt);

    for (const r of this.ripples) r.r += dt * D.RIPPLE_SPEED;
    this.ripples = this.ripples.filter((r) => r.r < 1 + D.RIPPLE_WIDTH * 3);

    const gap = this.spacing;
    const cx = this.width / 2;
    const cy = this.height / 2;
    const half = Math.hypot(cx, cy);
    const unit = D.FIELD / Math.min(this.width, this.height);
    const scale = D.BASE + D.SWELL_GAIN * this.swell;
    const maxR = gap * D.MAX_R;
    const minR = gap * D.MIN_R;
    // Centre the grid so the pattern stays symmetric about the middle.
    const x0 = cx - Math.floor(cx / gap) * gap;
    const y0 = cy - Math.floor(cy / gap) * gap;
    const nBins = this.bins.length;

    const plain = new Path2D();
    const lit = new Path2D();
    for (let y = y0; y < this.height + gap; y += gap) {
      for (let x = x0; x < this.width + gap; x += gap) {
        const d = Math.hypot(x - cx, y - cy) / half;
        let v;
        if (this.mode === 'spectrum') {
          v = this.bins[Math.min(nBins - 1, (d * nBins) | 0)] * (0.4 + 0.6 * scale) * 1.3;
        } else {
          v = (0.5 + 0.8 * this.noise(x * unit, y * unit, this.t)) * scale;
        }
        let ring = 0;
        for (const rp of this.ripples) {
          const k = (d - rp.r) / D.RIPPLE_WIDTH;
          ring = Math.max(ring, rp.strength * Math.exp(-k * k) * (1 - rp.r * 0.6));
        }
        const r = Math.min(1, clamp01(v) + ring * D.RIPPLE_BOOST) * maxR;
        if (r < minR) continue;
        const path = ring > 0.25 ? lit : plain;
        path.moveTo(x + r, y);
        path.arc(x, y, r, 0, Math.PI * 2);
      }
    }

    ctx.shadowBlur = 0;
    ctx.fillStyle = rgba(this.style.lineColor, D.ALPHA);
    ctx.fill(plain);
    ctx.fillStyle = rgba(this.style.accentColor ?? this.style.lineColor, Math.min(1, D.ALPHA * 1.8));
    ctx.fill(lit);
  }
}
