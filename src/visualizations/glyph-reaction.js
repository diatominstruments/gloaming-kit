import { Visualization, approach, clamp01, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { LAYER } from './layers.js';
import { TRIGGER } from '../analyzer.js';
import { mulberry32 } from '../noise.js';
import { parseColor } from '../style.js';
import { glyphOption, readGlyph, glyphField, BLOTS } from './glyph.js';

/**
 * GlyphReaction — the drawing as a map of chemistry. Two substances react
 * and diffuse across the screen (Gray–Scott reaction–diffusion), and the
 * texture that grows — spots, worms, coral, a maze — depends on two rates.
 * The drawing, tiled and softened into a smooth map, sets those rates: where
 * it is empty one texture grows, where it is black another, and grey is the
 * country between, where the two kinds fight. So the drawing shows only as
 * the weather of the texture: the shapes of the regions where the growth
 * changes character, several copies across the screen, turning slowly.
 *
 *   bloom  a hit: drops of the second substance land and start new growth,
 *          and the field flares
 *   flow   how fast the chemistry runs
 *   glow   how brightly the growth is lit
 *
 * Options:
 *   glyph    the drawing
 *   regime   which two textures the empty and black cells grow:
 *            'coral' (spots → coral), 'maze' (holes → mazes),
 *            'worms' (dividing spots → worms), 'spots' (drifting spots → holes)
 *   scale    size of one copy of the drawing, of the smaller dimension
 *            (default 1 = 0.9 of it)
 */
export class GlyphReaction extends Visualization {
  static id = 'glyph-reaction';
  static label = 'Glyph Reaction';
  static description = 'A reaction–diffusion texture whose character changes across the screen as the drawing, tiled and softened, directs; hits seed new growth.';
  static category = CATEGORY.GLYPHS;
  static layer = LAYER.BACKGROUND;
  static inputs = {
    bloom: { kind: 'event', default: TRIGGER.BASS },
    flow:  { kind: 'level', default: { intensity: 'mid' } },
    glow:  { kind: 'level', default: { intensity: 'rms' } },
  };
  // Feed and kill rates for empty cells and for black cells; grey interpolates.
  static REGIMES = {
    coral: { empty: [0.030, 0.062], full: [0.0545, 0.062] },   // spots and short worms → coral labyrinth
    maze:  { empty: [0.039, 0.058], full: [0.029, 0.057] },    // a solid pierced by holes → a thick maze
    worms: { empty: [0.0367, 0.0649], full: [0.078, 0.061] }, // dividing spots → long worms
    spots: { empty: [0.014, 0.054], full: [0.039, 0.058] },    // sparse drifting spots → a solid pierced by holes
  };
  static options = {
    glyph:  glyphOption({ width: 9, height: 9, value: BLOTS }),
    regime: { kind: 'enum', values: Object.keys(GlyphReaction.REGIMES), default: 'coral' },
    scale:  { kind: 'number', default: 1, min: 0.4, max: 3, step: 0.05 },
    seeds:  { kind: 'number', default: 10, min: 1, max: 40, step: 1 },
  };

  static CELL = 6;            // px per simulation cell
  static MAX_COLS = 200;
  static TILE = 0.9;          // one copy of the drawing, of the smaller dimension
  static MAP_BLUR = 0.8;      // cells; how soft the drawing is in the map
  static MAP_GAIN = 1.5;      // so a drawn cell's whole neighbourhood reaches the black regime
  static DU = 1.0;
  static DV = 0.5;
  static WARM = 220;          // steps run before the first frame
  static BASE_STEPS = 5;      // steps per frame at silence
  static STEP_GAIN = 9;       // extra at full flow
  static FLOW_TAU = 0.4;
  static TURN = 0.012;        // radians per second the map turns
  static DRIFT = 0.006;       // tiles per second it slides
  static MAP_EVERY = 5;       // frames between map refreshes
  static SEEDS = 10;          // initial drops
  static DROP = [2, 5];       // drop radius, cells
  static LOW = 0.06;          // v at which the texture starts to show
  static HIGH = 0.36;         // v at full brightness
  static BASE = 0.45;         // brightness at silence
  static GLOW_GAIN = 0.55;
  static GLOW_TAU = 0.4;
  static FLASH = 0.35;
  static FLASH_DECAY = 3;
  static LINE_KNEE = 0.6;     // ramp position where lineColor peaks
  static ACCENT_PEAK = 0.7;   // how far the brightest growth leans to accent
  static PEAK_GAIN = 0.85;    // how far the brightest pixels go to peakColor on an extreme hit

  constructor(opts) {
    super(opts);
    const G = GlyphReaction;
    this.glyph = readGlyph(this);
    this.field = glyphField(this.glyph, { blur: G.MAP_BLUR });
    this.regime = G.REGIMES[this.option('regime')];
    this.scale = this.option('scale');
    this.seeds = this.option('seeds');   // drops of growth the screen starts with
    this.rand = mulberry32(((Date.now() % 100000) + 3) | 0);
    this.theta = this.rand() * Math.PI * 2;
    this.du = this.rand();
    this.dv = this.rand();
    this.flow = 0;
    this.glow = 0;
    this.flash = 0;
    this.frames = 0;
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

  allocate() {
    const G = GlyphReaction;
    this.cell = Math.max(G.CELL, this.width / G.MAX_COLS);
    this.cols = Math.ceil(this.width / this.cell) + 1;
    this.rows = Math.ceil(this.height / this.cell) + 1;
    const n = this.cols * this.rows;
    this.u = new Float32Array(n).fill(1);
    this.v = new Float32Array(n);
    this.u2 = new Float32Array(n);
    this.v2 = new Float32Array(n);
    this.f = new Float32Array(n);
    this.k = new Float32Array(n);
    this.buffer.width = this.cols;
    this.buffer.height = this.rows;
    this.image = this.bufferCtx.createImageData(this.cols, this.rows);
    this.image.data.fill(255);
    this.updateMap();
    for (let i = 0; i < this.seeds; i++) this.drop(this.rand() * this.cols, this.rand() * this.rows);
    for (let i = 0; i < G.WARM; i++) this.step();
  }

  /** The feed/kill map: the drawing, tiled, turned and softened. */
  updateMap() {
    const G = GlyphReaction;
    const tile = Math.min(this.width, this.height) * G.TILE * this.scale / this.cell; // cells per copy
    const cos = Math.cos(this.theta);
    const sin = Math.sin(this.theta);
    const [f0, k0] = this.regime.empty;
    const [f1, k1] = this.regime.full;
    const cx = this.cols / 2;
    const cy = this.rows / 2;
    let i = 0;
    for (let y = 0; y < this.rows; y++) {
      const ry = (y - cy) / tile;
      for (let x = 0; x < this.cols; x++, i++) {
        const rx = (x - cx) / tile;
        const w = Math.min(1, this.field(rx * cos - ry * sin + this.du, rx * sin + ry * cos + this.dv) * G.MAP_GAIN);
        this.f[i] = f0 + (f1 - f0) * w;
        this.k[i] = k0 + (k1 - k0) * w;
      }
    }
  }

  /** A drop of the second substance, radius r cells, at (x, y) cells. */
  drop(x, y, r = GlyphReaction.DROP[0] + this.rand() * (GlyphReaction.DROP[1] - GlyphReaction.DROP[0])) {
    const { cols, rows } = this;
    const x0 = Math.max(0, Math.floor(x - r));
    const x1 = Math.min(cols - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r));
    const y1 = Math.min(rows - 1, Math.ceil(y + r));
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        if (Math.hypot(i - x, j - y) > r) continue;
        const idx = j * cols + i;
        this.v[idx] = 0.9;
        this.u[idx] = 0.3;
      }
    }
  }

  onInput(slot, data) {
    if (slot === 'bloom') {
      const k = impact(data);
      this.flash = Math.max(this.flash, k);
      const n = 1 + Math.round(3 * k);
      for (let i = 0; i < n; i++) this.drop(this.rand() * this.cols, this.rand() * this.rows);
    }
  }

  /** One Gray–Scott step with a nine-point Laplacian on a torus. */
  step() {
    const G = GlyphReaction;
    const { cols, rows, u, v, u2, v2, f, k } = this;
    const DU = G.DU;
    const DV = G.DV;
    for (let y = 0; y < rows; y++) {
      const yu = (y === 0 ? rows - 1 : y - 1) * cols;
      const yd = (y === rows - 1 ? 0 : y + 1) * cols;
      const yc = y * cols;
      for (let x = 0; x < cols; x++) {
        const xl = x === 0 ? cols - 1 : x - 1;
        const xr = x === cols - 1 ? 0 : x + 1;
        const i = yc + x;
        const uc = u[i];
        const vc = v[i];
        const lu = 0.2 * (u[yc + xl] + u[yc + xr] + u[yu + x] + u[yd + x])
          + 0.05 * (u[yu + xl] + u[yu + xr] + u[yd + xl] + u[yd + xr]) - uc;
        const lv = 0.2 * (v[yc + xl] + v[yc + xr] + v[yu + x] + v[yd + x])
          + 0.05 * (v[yu + xl] + v[yu + xr] + v[yd + xl] + v[yd + xr]) - vc;
        const uvv = uc * vc * vc;
        const fi = f[i];
        let nu = uc + DU * lu - uvv + fi * (1 - uc);
        let nv = vc + DV * lv + uvv - (fi + k[i]) * vc;
        u2[i] = nu < 0 ? 0 : nu > 1 ? 1 : nu;
        v2[i] = nv < 0 ? 0 : nv > 1 ? 1 : nv;
      }
    }
    this.u = u2; this.u2 = u;
    this.v = v2; this.v2 = v;
  }

  updateRamp() {
    const s = this.style;
    const key = `${s.background}|${s.lineColor}|${s.accentColor}`;
    if (key === this.lutKey) return;
    this.lutKey = key;
    const G = GlyphReaction;
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
    const G = GlyphReaction;
    this.flow = approach(this.flow, clamp01(this.in('flow')), G.FLOW_TAU, dt);
    this.glow = approach(this.glow, clamp01(this.in('glow')), G.GLOW_TAU, dt);
    this.flash *= Math.exp(-G.FLASH_DECAY * dt);
    this.theta += dt * G.TURN;
    this.du += dt * G.DRIFT;
    this.dv += dt * G.DRIFT * 0.41;
    if (++this.frames % G.MAP_EVERY === 0) this.updateMap();

    const steps = Math.round(G.BASE_STEPS + G.STEP_GAIN * this.flow);
    for (let i = 0; i < steps; i++) this.step();

    this.updateRamp();
    const bright = (G.BASE + G.GLOW_GAIN * this.glow + G.FLASH * this.flash) * 255;
    const span = 1 / (G.HIGH - G.LOW);
    const { v, lut } = this;
    const data = this.image.data;
    // On an extreme hit the densest growth flares toward the peak colour.
    const pk = this.peakAmount(this.flash) * G.PEAK_GAIN;
    const [pr, pg, pb] = pk > 0 ? parseColor(this.style.peakColor) ?? [255, 255, 255] : [0, 0, 0];
    for (let i = 0, o = 0; i < v.length; i++, o += 4) {
      let t = (v[i] - G.LOW) * span;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      let idx = (Math.sqrt(t) * bright) | 0;
      if (idx > 255) idx = 255;
      if (pk > 0) {
        const w = pk * t;
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
