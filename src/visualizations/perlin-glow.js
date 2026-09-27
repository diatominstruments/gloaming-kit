import { Visualization, approach, clamp01, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { LAYER } from './layers.js';
import { TRIGGER } from '../analyzer.js';
import { createNoise3D, fbm } from '../noise.js';
import { parseColor } from '../style.js';

/**
 * PerlinGlow — a full-screen background of slowly morphing light. A
 * domain-warped noise field is shaded from the style's background colour,
 * through a dimmed lineColor, up to accentColor on its brightest ridges.
 *
 * The field is evaluated on a coarse grid (one sample per CELL px) and
 * stretched to the screen with smoothing on. That is what keeps it cheap in
 * Canvas 2D, and the bilinear upscale is also what gives it its soft glow —
 * finer sampling would only look harsher.
 *
 * Its darkest value is exactly `style.background`, so it replaces the
 * engine's flat fill seamlessly and fades in over it without a seam.
 *
 * Reactions:
 *   glow   how lit the field is — slow passage loudness by default, so a
 *          quiet verse sits dim and a chorus fills the screen
 *   flow   how fast the field morphs
 *   flare  a hit brightens the whole field, swells its shapes outward and
 *          surges the morph forward, all decaying together
 *
 * Options:
 *   scale  feature size; 2 is twice as broad, 0.5 twice as fine (default 1)
 *   seed   which noise field (default 1)
 */
export class PerlinGlow extends Visualization {
  static id = 'perlin-glow';
  static label = 'Perlin Glow';
  static description = 'A background of drifting, domain-warped light that brightens with the mix and flares on hits.';
  static category = CATEGORY.BACKGROUNDS;
  static layer = LAYER.BACKGROUND;
  static inputs = {
    glow:  { kind: 'level', default: { intensity: 'rms' } },
    flow:  { kind: 'level', default: 'mid' },
    flare: { kind: 'event', default: TRIGGER.BASS },
  };
  static options = {
    scale: { kind: 'number', default: 1, min: 0.25, max: 4, step: 0.05 },
    seed:  { kind: 'number', default: 1, min: 0, max: 9999, step: 1 },
  };

  static CELL = 8;           // px per noise sample
  static MAX_COLS = 240;     // cap on samples across; CELL grows past it
  static FEATURE = 0.35;     // noise unit, of the smaller screen dimension
  static OCTAVES = { octaves: 3 };
  static WARP = 0.9;         // how far the warp field bends the main one
  static SPREAD = 1.3;       // stretches fbm's narrow output toward 0..1
  static EXPOSURE = 1.0;     // ramp position per unit of (value² × brightness)

  static BASE = 0.35;        // brightness at silence
  static GLOW_GAIN = 0.55;   // extra at full `glow`
  static GLOW_TAU = 0.35;
  static FLARE_GAIN = 0.35;  // extra brightness at a full-impact flare
  static FLARE_DECAY = 2.5;  // per second
  static BREATH = 0.12;      // shapes swell by this fraction on a full flare

  static BASE_FLOW = 0.05;   // noise units per second along time, at silence
  static FLOW_GAIN = 0.25;   // extra at full `flow`
  static FLOW_TAU = 0.6;
  static SURGE = 0.6;        // extra flow at a full flare

  static LINE_KNEE = 0.7;    // ramp position where lineColor peaks
  static LINE_PEAK = 0.35;   // how much of lineColor the field ever shows
  static ACCENT_PEAK = 0.4;  // how far the brightest ridges lean to accent

  constructor(opts) {
    super(opts);
    this.scale = Number(this.options.scale ?? 1) || 1;
    this.noise = createNoise3D(Number(this.options.seed ?? 1) | 0);
    this.t = 0;
    this.glow = 0;
    this.flow = 0;
    this.flare = 0;
    this.lut = new Uint8ClampedArray(256 * 3);
    this.lutKey = '';
    this.buffer = document.createElement('canvas');
    this.bufferCtx = this.buffer.getContext('2d');
    this.allocate();
  }

  resize(width, height) {
    super.resize(width, height);
    this.allocate();
  }

  /** Size the sample grid to the screen. */
  allocate() {
    const G = PerlinGlow;
    this.cell = Math.max(G.CELL, this.width / G.MAX_COLS);
    this.cols = Math.ceil(this.width / this.cell) + 1;
    this.rows = Math.ceil(this.height / this.cell) + 1;
    this.buffer.width = this.cols;
    this.buffer.height = this.rows;
    this.image = this.bufferCtx.createImageData(this.cols, this.rows);
    this.image.data.fill(255); // alpha channel stays opaque
  }

  onInput(slot, data) {
    if (slot === 'flare') this.flare = Math.max(this.flare, impact(data));
  }

  /** Rebuild the 256-step colour ramp when the (easing) style has moved. */
  updateRamp() {
    const s = this.style;
    const key = `${s.background}|${s.lineColor}|${s.accentColor}`;
    if (key === this.lutKey) return;
    this.lutKey = key;

    const G = PerlinGlow;
    const bg = parseColor(s.background) ?? [10, 10, 18];
    const line = parseColor(s.lineColor) ?? [127, 255, 212];
    const accent = parseColor(s.accentColor) ?? line;
    const peak = bg.map((c, i) => c + (line[i] - c) * G.LINE_PEAK);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      for (let c = 0; c < 3; c++) {
        let v;
        if (t < G.LINE_KNEE) {
          // Eased so most of the field stays near the background.
          const k = t / G.LINE_KNEE;
          v = bg[c] + (peak[c] - bg[c]) * k * k;
        } else {
          const k = (t - G.LINE_KNEE) / (1 - G.LINE_KNEE);
          v = peak[c] + (accent[c] - peak[c]) * k * G.ACCENT_PEAK;
        }
        this.lut[i * 3 + c] = v;
      }
    }
  }

  draw(ctx, dt) {
    const G = PerlinGlow;
    this.glow = approach(this.glow, this.in('glow'), G.GLOW_TAU, dt);
    this.flow = approach(this.flow, this.in('flow'), G.FLOW_TAU, dt);
    this.flare *= Math.exp(-G.FLARE_DECAY * dt);
    this.t += dt * (G.BASE_FLOW + G.FLOW_GAIN * this.flow + G.SURGE * this.flare);
    this.updateRamp();

    const bright = G.BASE + G.GLOW_GAIN * clamp01(this.glow) + G.FLARE_GAIN * this.flare;
    // Noise units per sample; a flare shrinks it so shapes swell outward.
    const unit = Math.min(this.width, this.height) * G.FEATURE * this.scale;
    const step = (this.cell / unit) * (1 - G.BREATH * this.flare);
    const x0 = -(this.cols / 2) * step;
    const y0 = -(this.rows / 2) * step;

    const { noise, lut, t } = this;
    const warpT = t * 0.6;
    const data = this.image.data;
    let o = 0;
    for (let j = 0; j < this.rows; j++) {
      const ny = y0 + j * step;
      for (let i = 0; i < this.cols; i++) {
        const nx = x0 + i * step;
        // Warp: bend the sample point by a second, slower field, which
        // turns plain noise blobs into curling smoke-like shapes.
        const qx = noise(nx + 1.7, ny + 9.2, warpT);
        const qy = noise(nx + 8.3, ny + 2.8, warpT);
        const n = fbm(noise, nx + G.WARP * qx, ny + G.WARP * qy, t, G.OCTAVES);
        const v = clamp01(0.5 + n * G.SPREAD);
        const idx = (clamp01(v * v * bright * G.EXPOSURE) * 255) | 0;
        data[o] = lut[idx * 3];
        data[o + 1] = lut[idx * 3 + 1];
        data[o + 2] = lut[idx * 3 + 2];
        o += 4;
      }
    }
    this.bufferCtx.putImageData(this.image, 0, 0);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.buffer, 0, 0, this.cols * this.cell, this.rows * this.cell);
  }
}
