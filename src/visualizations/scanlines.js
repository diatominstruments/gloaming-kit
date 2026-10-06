import { Visualization, approach, clamp01, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { LAYER } from './layers.js';
import { TRIGGER } from '../analyzer.js';
import { rgba } from '../style.js';

/**
 * Scanlines — a CRT treatment laid over everything else: slowly crawling
 * scanlines, a vignette, and red/cyan channel separation that opens with
 * the music. A `roll` hit sends a bright bar down the screen and tears the
 * channels wider while it passes.
 *
 * It draws in the overlay layer, so when it draws the canvas already holds
 * the finished frame beneath it. The channel split reads that back: the
 * frame is copied twice, tinted red and cyan by multiplying, and the two
 * are added back together offset sideways — which, with no offset, is the
 * original frame exactly. That runs at device resolution in offscreen
 * canvases and lands on screen in one draw, so the engine's crossfade
 * alpha blends the treated frame over the untreated one.
 *
 * Options:
 *   strength  overall intensity of every effect, 0..1 (default 0.5)
 */
export class Scanlines extends Visualization {
  static id = 'scanlines';
  static label = 'Scanlines';
  static description = 'CRT scanlines, vignette and red/cyan channel split over everything; hits send a roll bar down the screen.';
  static category = CATEGORY.OVERLAYS;
  static layer = LAYER.OVERLAY;
  static inputs = {
    split: { kind: 'level', default: { relative: 'bass' } },
    roll:  { kind: 'event', default: TRIGGER.SNARE },
  };
  static options = {
    strength: { kind: 'number', default: 0.5, min: 0, max: 1, step: 0.05 },
    pitch:    { kind: 'number', default: 3, min: 2, max: 10, step: 1 },
    vignette: { kind: 'number', default: 0.7, min: 0, max: 1, step: 0.05 },
  };

  static PITCH = 3;           // px per scanline
  static LINE_DARK = 0.55;    // scanline darkness at full strength
  static CRAWL = 6;           // px per second the scanlines creep down
  static VIGNETTE = 0.7;      // edge darkness at full strength
  static SPLIT_BASE = 0.5;    // px of channel offset at silence, at full strength
  static SPLIT_GAIN = 6;      // extra at full `split`
  static SPLIT_TAU = 0.08;
  static ROLL_SPLIT = 8;      // extra px while a full-impact roll passes
  static ROLL_SPEED = 0.9;    // screen heights per second
  static ROLL_HEIGHT = 0.12;  // of the screen height
  static ROLL_ALPHA = 0.12;

  constructor(opts) {
    super(opts);
    this.strength = this.option('strength');
    this.pitch = this.option('pitch');         // px per scanline
    this.vignette = this.option('vignette');   // edge darkness at full strength
    this.split = 0;
    this.crawl = 0;
    this.rolls = [];          // { y (0..1 of height, bar centre), strength }
    this.red = document.createElement('canvas');
    this.cyan = document.createElement('canvas');
    this.mixed = document.createElement('canvas');
    this.pattern = null;
    this.patternCtx = null;
  }

  onInput(slot, data) {
    if (slot === 'roll') this.rolls.push({ y: -Scanlines.ROLL_HEIGHT, strength: impact(data) });
  }

  /** One scanline period as a repeating pattern, rebuilt if the context changes. */
  linePattern(ctx) {
    if (this.patternCtx === ctx) return this.pattern;
    const tile = document.createElement('canvas');
    tile.width = 1;
    tile.height = this.pitch;
    const t = tile.getContext('2d');
    t.fillStyle = '#000';
    t.fillRect(0, 0, 1, 1);
    this.pattern = ctx.createPattern(tile, 'repeat');
    this.patternCtx = ctx;
    return this.pattern;
  }

  /** Copy the frame into `canvas`, keeping only the channels in `tint`. */
  channel(canvas, source, tint) {
    if (canvas.width !== source.width || canvas.height !== source.height) {
      canvas.width = source.width;
      canvas.height = source.height;
    }
    const c = canvas.getContext('2d');
    c.globalCompositeOperation = 'copy';
    c.drawImage(source, 0, 0);
    c.globalCompositeOperation = 'multiply';
    c.fillStyle = tint;
    c.fillRect(0, 0, canvas.width, canvas.height);
    return canvas;
  }

  splitChannels(ctx, px) {
    const src = ctx.canvas;
    const dpr = src.width / this.width;
    const d = px * dpr;
    const red = this.channel(this.red, src, '#ff0000');
    const cyan = this.channel(this.cyan, src, '#00ffff');
    const out = this.mixed;
    if (out.width !== src.width || out.height !== src.height) {
      out.width = src.width;
      out.height = src.height;
    }
    const o = out.getContext('2d');
    o.globalCompositeOperation = 'copy';
    o.fillStyle = '#000';
    o.fillRect(0, 0, out.width, out.height);
    o.globalCompositeOperation = 'lighter';
    o.drawImage(red, d, 0);
    o.drawImage(cyan, -d, 0);
    ctx.drawImage(out, 0, 0, this.width, this.height);
  }

  draw(ctx, dt) {
    const S = Scanlines;
    const k = this.strength;
    if (k <= 0) return;
    this.split = approach(this.split, clamp01(this.in('split')), S.SPLIT_TAU, dt);
    this.crawl = (this.crawl + S.CRAWL * dt) % this.pitch;
    for (const r of this.rolls) r.y += S.ROLL_SPEED * dt;
    this.rolls = this.rolls.filter((r) => r.y < 1 + S.ROLL_HEIGHT);
    const roll = this.rolls.reduce((m, r) => Math.max(m, r.strength), 0);

    ctx.shadowBlur = 0;

    const px = k * (S.SPLIT_BASE + S.SPLIT_GAIN * this.split + S.ROLL_SPLIT * roll);
    if (px * (ctx.canvas.width / this.width) >= 0.5) this.splitChannels(ctx, px);

    const base = ctx.globalAlpha;
    for (const r of this.rolls) {
      const y = r.y * this.height;
      const half = (S.ROLL_HEIGHT * this.height) / 2;
      const g = ctx.createLinearGradient(0, y - half, 0, y + half);
      const color = this.peak(this.style.lineColor, r.strength);
      g.addColorStop(0, rgba(color, 0));
      g.addColorStop(0.5, rgba(color, S.ROLL_ALPHA * r.strength * (0.5 + k)));
      g.addColorStop(1, rgba(color, 0));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g;
      ctx.fillRect(0, y - half, this.width, half * 2);
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = base * S.LINE_DARK * k;
    ctx.translate(0, this.crawl);
    ctx.fillStyle = this.linePattern(ctx);
    ctx.fillRect(0, -this.pitch, this.width, this.height + this.pitch);
    ctx.restore();

    const cx = this.width / 2;
    const cy = this.height / 2;
    const v = ctx.createRadialGradient(cx, cy, Math.min(cx, cy) * 0.6, cx, cy, Math.hypot(cx, cy));
    v.addColorStop(0, 'rgba(0, 0, 0, 0)');
    v.addColorStop(1, `rgba(0, 0, 0, ${this.vignette * k})`);
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, this.width, this.height);
  }
}
