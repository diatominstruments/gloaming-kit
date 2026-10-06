import { Visualization, approach, clamp01, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { LAYER } from './layers.js';
import { TRIGGER } from '../analyzer.js';
import { mulberry32 } from '../noise.js';
import { parseColor } from '../style.js';
import { glyphOption, readGlyph, OCTAGON } from './glyph.js';

/**
 * GlyphCymatics — the drawing as a spectrum. Each filled cell is a plane
 * wave: its offset from the drawing's centre is the wave's direction and
 * frequency, its strength the amplitude. The screen shows their sum, as the
 * surface of a plate dusted with sand would — bright along the nodal lines
 * where the waves cancel. Cells on a square make a square lattice of
 * ripples, cells on a hexagon a honeycomb, and cells round a ring at odd
 * angles make a quasicrystal, a pattern that never repeats. A single cell
 * makes plain stripes. Every pattern tessellates the whole screen, and none
 * of them looks like the handful of dots that made it.
 *
 * The waves drift in phase at their own rates, so the pattern breathes and
 * crawls rather than standing still, and the whole spectrum turns slowly.
 *
 *   pulse   a hit: every wave jumps in phase, so the pattern lurches to a
 *           new arrangement and the field flares
 *   glow    how brightly the field is lit
 *   turn    how fast the spectrum turns
 *   detail  how strong the finer waves are, so treble sharpens the pattern
 *
 * Options:
 *   glyph   the drawing
 *   render  'nodes' (default; bright nodal lines), 'relief' (shaded crests
 *           and troughs), 'terraces' (stepped level bands)
 *   scale   wavelength of the drawing's unit frequency, of the smaller
 *           dimension (default 1 = 0.45 of it)
 */
export class GlyphCymatics extends Visualization {
  static id = 'glyph-cymatics';
  static label = 'Glyph Cymatics';
  static description = 'The drawing\'s cells as interfering waves, shown as a plate\'s sand pattern tessellating the screen — a lattice, a honeycomb or a quasicrystal; hits lurch it.';
  static category = CATEGORY.GLYPHS;
  static layer = LAYER.BACKGROUND;
  static inputs = {
    pulse:  { kind: 'event', default: TRIGGER.BASS },
    glow:   { kind: 'level', default: { intensity: 'rms' } },
    turn:   { kind: 'level', default: { intensity: 'mid' } },
    detail: { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
    } },
  };
  static options = {
    glyph:  glyphOption({ width: 9, height: 9, value: OCTAGON }),
    render: { kind: 'enum', values: ['nodes', 'relief', 'terraces'], default: 'nodes' },
    scale:  { kind: 'number', default: 1, min: 0.3, max: 3, step: 0.05 },
    nodeWidth: { kind: 'number', default: 0.16, min: 0.05, max: 0.5, step: 0.01 },
    terraces:  { kind: 'number', default: 5, min: 2, max: 12, step: 1 },
  };

  static CELL = 5;            // px per sample
  static MAX_COLS = 240;
  static WAVELENGTH = 0.45;   // of the smaller dimension, for a cell one step from centre
  static MAX_WAVES = 40;
  static DRIFT = [0.1, 0.45]; // radians per second of phase drift, per wave
  static BASE_TURN = 0.01;    // radians per second
  static TURN_GAIN = 0.1;
  static TURN_TAU = 0.8;
  static KICK = 0.9;          // radians of phase jump at a full hit
  static KICK_DECAY = 6;      // per second; the jump arrives over a few frames
  static DETAIL_GAIN = 1.4;   // amplitude gain on the finer half of the waves at full detail
  static DETAIL_TAU = 0.25;
  static NODE_WIDTH = 0.16;   // of the normalized amplitude
  static TERRACES = 5;
  static RISER = 0.18;        // half-width of a terrace's riser, in levels
  static BASE = 0.4;          // brightness at silence
  static GLOW_GAIN = 0.6;
  static GLOW_TAU = 0.4;
  static FLASH = 0.4;
  static FLASH_DECAY = 3;
  static LINE_KNEE = 0.65;
  static ACCENT_PEAK = 0.75;
  static PEAK_GAIN = 0.85;    // how far the brightest pixels go to peakColor on an extreme hit

  constructor(opts) {
    super(opts);
    const G = GlyphCymatics;
    this.glyph = readGlyph(this);
    this.render = this.option('render');
    this.scale = this.option('scale');
    this.nodeWidth = this.option('nodeWidth');   // how wide the bright nodal lines are
    this.terraces = this.option('terraces');
    this.rand = mulberry32(((Date.now() % 100000) + 5) | 0);
    this.waves = this.readWaves();
    this.theta = this.rand() * Math.PI * 2;
    this.glow = 0;
    this.turn = 0;
    this.detail = 0;
    this.kick = 0;
    this.flash = 0;
    this.lut = new Uint8ClampedArray(256 * 3);
    this.lutKey = '';
    this.buffer = document.createElement('canvas');
    this.bufferCtx = this.buffer.getContext('2d');
    this.allocate();
  }

  /** Filled cells as wave vectors from the centre, ±k merged (cos is even). */
  readWaves() {
    const G = GlyphCymatics;
    const g = this.glyph;
    const cx = (g.width - 1) / 2;
    const cy = (g.height - 1) / 2;
    const merged = new Map();
    for (const { x, y, weight } of g.filled()) {
      let kx = x - cx;
      let ky = y - cy;
      if (Math.abs(kx) < 1e-6 && Math.abs(ky) < 1e-6) continue;
      if (ky < 0 || (Math.abs(ky) < 1e-6 && kx < 0)) { kx = -kx; ky = -ky; }
      const key = `${kx},${ky}`;
      const w = merged.get(key);
      if (w) w.amp += weight; else merged.set(key, { kx, ky, amp: weight, mag: Math.hypot(kx, ky) });
    }
    let waves = [...merged.values()].sort((a, b) => b.amp - a.amp).slice(0, G.MAX_WAVES);
    if (!waves.length) waves = [{ kx: 1, ky: 0, amp: 1, mag: 1 }];
    const mags = waves.map((w) => w.mag).sort((a, b) => a - b);
    const median = mags[(mags.length / 2) | 0];
    const [lo, hi] = G.DRIFT;
    for (const w of waves) {
      w.phase = this.rand() * Math.PI * 2;
      w.rate = (lo + this.rand() * (hi - lo)) * (this.rand() < 0.5 ? -1 : 1);
      w.fine = w.mag > median ? 1 : w.mag === median ? 0.5 : 0;
    }
    return waves;
  }

  resize(width, height) {
    super.resize(width, height);
    this.allocate();
  }

  allocate() {
    const G = GlyphCymatics;
    this.cell = Math.max(G.CELL, this.width / G.MAX_COLS);
    this.cols = Math.ceil(this.width / this.cell) + 1;
    this.rows = Math.ceil(this.height / this.cell) + 1;
    this.buffer.width = this.cols;
    this.buffer.height = this.rows;
    this.image = this.bufferCtx.createImageData(this.cols, this.rows);
    this.image.data.fill(255);
    this.sum = new Float32Array(this.cols * this.rows);
    const n = this.waves.length;
    this.cosX = new Float32Array(n * this.cols);
    this.sinX = new Float32Array(n * this.cols);
    this.cosY = new Float32Array(n * this.rows);
    this.sinY = new Float32Array(n * this.rows);
  }

  onInput(slot, data) {
    if (slot === 'pulse') {
      const k = impact(data);
      this.kick += GlyphCymatics.KICK * k;
      this.flash = Math.max(this.flash, k);
    }
  }

  updateRamp() {
    const s = this.style;
    const key = `${s.background}|${s.lineColor}|${s.accentColor}`;
    if (key === this.lutKey) return;
    this.lutKey = key;
    const G = GlyphCymatics;
    const bg = parseColor(s.background) ?? [10, 10, 18];
    const line = parseColor(s.lineColor) ?? [127, 255, 212];
    const accent = parseColor(s.accentColor) ?? line;
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      for (let c = 0; c < 3; c++) {
        let val;
        if (t < G.LINE_KNEE) {
          const q = t / G.LINE_KNEE;
          val = bg[c] + (line[c] - bg[c]) * q * q;
        } else {
          const q = (t - G.LINE_KNEE) / (1 - G.LINE_KNEE);
          val = line[c] + (accent[c] - line[c]) * q * G.ACCENT_PEAK;
        }
        this.lut[i * 3 + c] = val;
      }
    }
  }

  draw(ctx, dt) {
    const G = GlyphCymatics;
    this.glow = approach(this.glow, clamp01(this.in('glow')), G.GLOW_TAU, dt);
    this.turn = approach(this.turn, clamp01(this.in('turn')), G.TURN_TAU, dt);
    this.detail = approach(this.detail, clamp01(this.in('detail')), G.DETAIL_TAU, dt);
    this.flash *= Math.exp(-G.FLASH_DECAY * dt);
    // The phase jump is paid out over a few frames, so it reads as a lurch
    // rather than a cut.
    const paid = this.kick * (1 - Math.exp(-G.KICK_DECAY * dt));
    this.kick -= paid;
    this.theta += dt * (G.BASE_TURN + G.TURN_GAIN * this.turn);

    const { cols, rows, waves, cosX, sinX, cosY, sinY, sum } = this;
    const n = waves.length;
    const unit = (Math.PI * 2) / (Math.min(this.width, this.height) * G.WAVELENGTH * this.scale); // rad per px per k
    const cos = Math.cos(this.theta);
    const sin = Math.sin(this.theta);
    const cx = (this.width / 2) / this.cell;
    const cy = (this.height / 2) / this.cell;
    let total = 0;
    const amps = new Float32Array(n);
    for (let w = 0; w < n; w++) {
      const wave = waves[w];
      wave.phase += dt * wave.rate + paid * (wave.rate > 0 ? 1 : -1);
      const kx = (wave.kx * cos - wave.ky * sin) * unit * this.cell;
      const ky = (wave.kx * sin + wave.ky * cos) * unit * this.cell;
      amps[w] = wave.amp * (1 + G.DETAIL_GAIN * this.detail * wave.fine);
      total += amps[w];
      for (let x = 0; x < cols; x++) {
        const a = (x - cx) * kx;
        cosX[w * cols + x] = Math.cos(a);
        sinX[w * cols + x] = Math.sin(a);
      }
      for (let y = 0; y < rows; y++) {
        const a = (y - cy) * ky + wave.phase;
        cosY[w * rows + y] = Math.cos(a);
        sinY[w * rows + y] = Math.sin(a);
      }
    }

    // cos(a + b) = cos a cos b − sin a sin b, from the per-row and per-column
    // tables: two multiplies per wave per sample instead of a cosine.
    sum.fill(0);
    for (let w = 0; w < n; w++) {
      const amp = amps[w] / total;
      const cxo = w * cols;
      const cyo = w * rows;
      for (let y = 0, i = 0; y < rows; y++) {
        const cy1 = cosY[cyo + y] * amp;
        const sy1 = sinY[cyo + y] * amp;
        for (let x = 0; x < cols; x++, i++) {
          sum[i] += cosX[cxo + x] * cy1 - sinX[cxo + x] * sy1;
        }
      }
    }

    this.updateRamp();
    const bright = (G.BASE + G.GLOW_GAIN * this.glow + G.FLASH * this.flash) * 255;
    const { lut, render } = this;
    // On an extreme hit the bright nodal lines flare toward the peak colour,
    // the brighter the pixel the further.
    const pk = this.peakAmount(this.flash) * G.PEAK_GAIN;
    const [pr, pg, pb] = pk > 0 ? parseColor(this.style.peakColor) ?? [255, 255, 255] : [0, 0, 0];
    const data = this.image.data;
    const nodeK = 1 / (this.nodeWidth * this.nodeWidth);
    const TERRACES = this.terraces;
    for (let i = 0, o = 0; i < sum.length; i++, o += 4) {
      const s = sum[i];
      let b;
      if (render === 'nodes') {
        b = Math.exp(-s * s * nodeK) * 0.85 + 0.15 * (0.5 + 0.5 * s);
      } else if (render === 'terraces') {
        // Steps with a short ramp between them, so the risers stay clean
        // through the upscale instead of aliasing on the sample grid.
        const lvl = (0.5 + 0.5 * s) * TERRACES;
        const fl = Math.floor(lvl);
        let f = (lvl - fl - 0.5 + G.RISER) / (2 * G.RISER);
        f = f < 0 ? 0 : f > 1 ? 1 : f;
        b = (fl + f * f * (3 - 2 * f)) / TERRACES;
        b = b * b;
      } else {
        b = 0.5 + 0.5 * s;
        b *= b;
      }
      let idx = (b * bright) | 0;
      if (idx > 255) idx = 255;
      if (pk > 0) {
        const w = pk * b * b;
        data[o] = lut[idx * 3] + (pr - lut[idx * 3]) * w;
        data[o + 1] = lut[idx * 3 + 1] + (pg - lut[idx * 3 + 1]) * w;
        data[o + 2] = lut[idx * 3 + 2] + (pb - lut[idx * 3 + 2]) * w;
      } else {
        data[o] = lut[idx * 3];
        data[o + 1] = lut[idx * 3 + 1];
        data[o + 2] = lut[idx * 3 + 2];
      }
    }
    this.bufferCtx.putImageData(this.image, 0, 0);
    ctx.shadowBlur = 0;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.buffer, 0, 0, this.cols * this.cell, this.rows * this.cell);
  }
}
