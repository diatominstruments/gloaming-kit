import { approach, clamp01, impact } from './base.js';
import { TreatmentVisualization } from './treatment-base.js';
import { fit, subtract, tint } from './frame-utils.js';
import { TRIGGER } from '../analyzer.js';
import { rgba } from '../style.js';

/**
 * Mosaic — the frame rebuilt from blocks. The frame is drawn tiny, one
 * pixel per block, and blown back up with smoothing off, so the picture
 * resolves into a grid that coarsens as the music swells and sharpens as
 * it rests. The grid itself creeps, so the blocks shimmer even over a
 * still figure.
 *
 *   swell  how coarse the blocks get; rises fast and falls slowly, so a
 *          kick shatters the picture and lets it resolve
 *   glow   how solid the mosaic is over the frame, and how hard it is lit
 *   tint   how far the blocks take the tint colour
 *   pulse  a hit throws the block size up a step and flashes toward the
 *          peak colour
 *
 * Options:
 *   block    block size in CSS px at silence (default 8)
 *   gain     extra at full `swell` (default 28)
 *   style    'blocks' (solid), 'tiles' (blocks with dark grout) or 'dots'
 *            (a round LED per block, sized by its brightness)
 *   gutter   grout width or dot inset, of a block (default 0.2)
 *   boost    brightness of the blocks (default 3): a thin line averaged
 *            over a block is dim, and this lifts it; rises with `glow`
 *   drift    how fast the grid creeps, blocks per second (default 0.3)
 *   pulse    extra px a full-impact hit adds (default 16)
 *   floor/depth, tint, tintColor
 */
export class Mosaic extends TreatmentVisualization {
  static id = 'mosaic';
  static label = 'Mosaic';
  static description = 'The screen rebuilt from blocks that coarsen as the music swells and resolve as it rests; hits shatter it a step further.';
  static inputs = {
    swell: { kind: 'level', default: { relative: 'bass' } },
    glow:  { kind: 'level', default: { intensity: 'rms' } },
    tint:  { kind: 'level', default: { relative: 'treble' } },
    pulse: { kind: 'event', default: TRIGGER.SNARE },
  };
  static options = {
    block:     { kind: 'number', default: 8, min: 2, max: 64, step: 1 },
    gain:      { kind: 'number', default: 28, min: 0, max: 128, step: 1 },
    style:     { kind: 'enum', values: ['blocks', 'tiles', 'dots'], default: 'blocks' },
    gutter:    { kind: 'number', default: 0.2, min: 0, max: 0.6, step: 0.05 },
    boost:     { kind: 'number', default: 3, min: 1, max: 8, step: 0.5 },
    drift:     { kind: 'number', default: 0.3, min: 0, max: 3, step: 0.05 },
    pulse:     { kind: 'number', default: 16, min: 0, max: 64, step: 1 },
    floor:     { kind: 'number', default: 0.7, min: 0, max: 1, step: 0.05 },
    depth:     { kind: 'number', default: 0.3, min: 0, max: 1, step: 0.05 },
    tint:      { kind: 'number', default: 0.5, min: 0, max: 1, step: 0.05 },
    tintColor: { kind: 'enum', values: ['accent', 'line'], default: 'accent' },
  };

  static SWELL_ATTACK = 0.03;
  static SWELL_RELEASE = 0.4;
  static GLOW_TAU = 0.25;
  static TINT_TAU = 0.12;
  static TINT_BASE = 0.1;
  static PULSE_DECAY = 5;
  static MAX_DOTS = 5000;        // dots are drawn one by one; coarsen rather than exceed this
  static MIN_GROUT = 4;          // px block below which grout and dots give way to blocks

  constructor(opts) {
    super(opts);
    this.block = this.option('block');
    this.gain = this.option('gain');
    this.style_ = this.option('style');
    this.gutter = this.option('gutter');
    this.boost = this.option('boost');
    this.drift = this.option('drift');
    this.pulseGain = this.option('pulse');
    this.floor = this.option('floor');
    this.depth = Math.min(this.option('depth'), 1 - this.floor);
    this.tintGain = this.option('tint');
    this.tintColor = this.option('tintColor');
    this.swell = 0;
    this.glow = 0;
    this.tint = 0;
    this.pulse = 0;
    this.flash = 0;
    this.time = 0;
    this.ox = 0;       // grid phase, in blocks
    this.oy = 0;
    this.small = document.createElement('canvas');
    this.lit = document.createElement('canvas');
    this.lit2 = document.createElement('canvas');
  }

  onInput(slot, data) {
    if (slot !== 'pulse') return;
    const hit = impact(data);
    this.pulse = Math.max(this.pulse, hit);
    this.flash = Math.max(this.flash, hit);
  }

  draw(ctx, dt) {
    const M = Mosaic;
    this.time += dt;
    const swell = clamp01(this.in('swell'));
    this.swell = approach(this.swell, swell, swell > this.swell ? M.SWELL_ATTACK : M.SWELL_RELEASE, dt);
    this.glow = approach(this.glow, clamp01(this.in('glow')), M.GLOW_TAU, dt);
    this.tint = approach(this.tint, clamp01(this.in('tint')), M.TINT_TAU, dt);
    this.pulse *= Math.exp(-M.PULSE_DECAY * dt);
    this.flash *= Math.exp(-M.PULSE_DECAY * dt);
    const heading = this.time * 0.17;
    this.ox = (this.ox + dt * this.drift * Math.cos(heading)) % 1;
    this.oy = (this.oy + dt * this.drift * Math.sin(heading)) % 1;

    const W = this.width;
    const H = this.height;
    let b = this.block + this.gain * this.swell + this.pulseGain * this.pulse;
    const style = (this.style_ !== 'blocks' && b < M.MIN_GROUT) ? 'blocks' : this.style_;
    if (style === 'dots') b = Math.max(b, Math.sqrt((W * H) / M.MAX_DOTS));
    const cols = Math.ceil(W / b) + 2;
    const rows = Math.ceil(H / b) + 2;
    const ox = (this.ox < 0 ? this.ox + 1 : this.ox) * b;   // grid origin, left/above the screen
    const oy = (this.oy < 0 ? this.oy + 1 : this.oy) * b;

    const src = this.snapshot(ctx);
    // One block per pixel: the frame scaled down with smoothing averages
    // each block's area into its pixel.
    fit(this.small, cols, rows);
    const s = this.small.getContext('2d');
    s.imageSmoothingEnabled = true;
    s.imageSmoothingQuality = 'high';
    s.globalCompositeOperation = 'copy';
    s.globalAlpha = 1;
    s.drawImage(src, ox / b, oy / b, W / b, H / b);
    s.globalCompositeOperation = 'source-over';

    // The blocks' light above the background, which is what gets tinted
    // and lifted; the background goes back under them at the end.
    subtract(this.small, this.style.background);
    let image = this.small;
    const accent = this.tintColor === 'line' ? this.style.lineColor : (this.style.accentColor ?? this.style.lineColor);
    const color = this.peak(accent, this.flash);
    const amount = this.tintGain * (M.TINT_BASE + (1 - M.TINT_BASE) * this.tint);
    if (amount > 0.002) image = tint(this.lit, image, color, amount);
    // Lift: the blocks added to themselves in passes until they are
    // `boost` times brighter, more so as the music swells and on a hit.
    let lift = 1 + (this.boost - 1) * (0.5 + 0.5 * this.glow) + this.boost * 0.5 * this.flash;
    const dots = style === 'dots';
    let pass = 0;
    while (!dots && lift > 1.001) {
      const out = fit(pass % 2 ? this.lit : this.lit2, cols, rows);
      const c = out.getContext('2d');
      c.globalCompositeOperation = 'copy';
      c.globalAlpha = 1;
      c.drawImage(image, 0, 0);
      c.globalCompositeOperation = 'lighter';
      const add = Math.min(1, lift - 1);
      c.globalAlpha = add;
      c.drawImage(image, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      lift /= 1 + add;
      image = out;
      pass++;
    }

    const base = ctx.globalAlpha;
    ctx.save();
    ctx.globalAlpha = base * clamp01(this.floor + this.depth * this.glow);
    ctx.fillStyle = this.style.background;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    if (style === 'dots') {
      const data = image.getContext('2d').getImageData(0, 0, cols, rows).data;
      const inset = 1 - this.gutter;
      for (let j = 0; j < rows; j++) {
        const cy = -oy + (j + 0.5) * b;
        if (cy < -b || cy > H + b) continue;
        for (let i = 0; i < cols; i++) {
          const k = (j * cols + i) * 4;
          const r = data[k];
          const g = data[k + 1];
          const bl = data[k + 2];
          const lum = (0.299 * r + 0.587 * g + 0.114 * bl) / 255;
          if (lum < 0.02) continue;
          // Lift each dot toward full brightness without losing its hue.
          const up = Math.min(lift, 0.9 / lum);
          const lit = Math.min(1, lum * up);
          const cx = -ox + (i + 0.5) * b;
          ctx.fillStyle = `rgb(${Math.min(255, r * up)}, ${Math.min(255, g * up)}, ${Math.min(255, bl * up)})`;
          ctx.beginPath();
          ctx.arc(cx, cy, (b / 2) * inset * (0.35 + 0.65 * lit), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 0, 0, cols, rows, -ox, -oy, cols * b, rows * b);
      ctx.imageSmoothingEnabled = true;
      if (style === 'tiles' && this.gutter > 0) {
        const grout = Math.max(1, this.gutter * b * 0.5);
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = rgba(this.style.background, 1);
        for (let i = 0; i < cols; i++) ctx.fillRect(-ox + i * b - grout / 2, 0, grout, H);
        for (let j = 0; j < rows; j++) ctx.fillRect(0, -oy + j * b - grout / 2, W, grout);
      }
    }
    ctx.restore();
  }
}
