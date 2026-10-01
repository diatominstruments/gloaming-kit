import { Visualization, approach, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';
import { mixColor } from '../style.js';
import { glyphOption, readGlyph, FLOWER } from './glyph.js';

/**
 * GlyphMosaic — the drawing, made of copies of itself.
 *
 * Every filled cell of the glyph holds a small copy of the whole glyph, so
 * the figure is the drawing at two scales at once. Each copy turns about its
 * own centre on its own phase, so the mosaic ripples, and the whole figure
 * turns slowly. Grey cells hold fainter copies, in a colour leaning toward
 * the accent.
 *
 * It is the 2D member of the Glyphs family, and what each of the 3D ones
 * draws when 3D is off — they pass it their own `glyph`, so the fallback
 * still shows the viewer's drawing.
 *
 * Reactions:
 *
 *   pulse  a hit swells every copy and flashes it toward the accent
 *   spin   how fast the figure turns and the copies ripple
 *   glow   brightness
 */
export class GlyphMosaic extends Visualization {
  static id = 'glyph-mosaic';
  static label = 'Glyph Mosaic';
  static description = 'The drawing made of copies of itself, rippling as each copy turns; hits swell and flash the copies.';
  static category = CATEGORY.GLYPHS;

  static inputs = {
    pulse: { kind: 'event', default: TRIGGER.BASS },
    spin:  { kind: 'level', default: { intensity: 'mid', smooth: 0.6 } },
    glow:  { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
      smooth: 0.1,
    } },
  };

  static options = {
    glyph: glyphOption({ width: 7, height: 7, value: FLOWER }),
  };

  static SIZE = 0.8;             // figure size, fraction of the short edge
  static SPIN = [0.04, 0.22];    // figure turn rate, rad/s: [idle, at full spin]
  static RIPPLE = [0.4, 1.4];    // copies' phase rate: [idle, at full spin]
  static TWIST = 0.8;            // largest turn of a copy, rad
  static ALPHA = [0.45, 0.55];   // [floor, added at full glow]
  static KICK_DECAY = 3;

  constructor(opts) {
    super(opts);
    this.glyph = readGlyph(this);
    this.cells = this.glyph.filled();
    this.span = Math.max(this.glyph.width, this.glyph.height);

    // The inner copy, as two paths in units of one inner cell, centred: one
    // for full-strength cells and one for the rest, so each copy is two fills
    // rather than a rect per cell.
    const { width, height, levels } = this.glyph;
    this.full = new Path2D();
    this.faint = new Path2D();
    for (const { x, y, level } of this.cells) {
      const path = level === levels ? this.full : this.faint;
      path.rect(x - width / 2 + 0.06, y - height / 2 + 0.06, 0.88, 0.88);
    }

    this.angle = Math.random() * Math.PI * 2;
    this.rate = GlyphMosaic.SPIN[0];
    this.phase = 0;
    this.kick = 0;
  }

  onInput(slot, data) {
    if (slot === 'pulse') this.kick = Math.max(this.kick, impact(data));
  }

  draw(ctx, dt) {
    const { SIZE, SPIN, RIPPLE, TWIST, ALPHA, KICK_DECAY } = GlyphMosaic;
    const spin = this.in('spin');
    this.rate = approach(this.rate, SPIN[0] + spin * SPIN[1], 0.5, dt);
    this.angle += this.rate * dt;
    this.phase += dt * (RIPPLE[0] + spin * RIPPLE[1]);
    this.kick *= Math.exp(-dt * KICK_DECAY);

    const { width, height, levels } = this.glyph;
    const cell = (Math.min(this.width, this.height) * SIZE) / this.span;
    const inner = cell / this.span;
    const line = this.style.lineColor;
    const accent = this.style.accentColor ?? line;
    const base = ctx.globalAlpha * Math.min(1, ALPHA[0] + this.in('glow') * ALPHA[1]);

    ctx.save();
    ctx.shadowBlur = 0;   // hundreds of rects; glow is unaffordable
    ctx.translate(this.width / 2, this.height / 2);
    ctx.rotate(this.angle);
    for (const { x, y, level, weight } of this.cells) {
      ctx.save();
      ctx.translate((x - (width - 1) / 2) * cell, (y - (height - 1) / 2) * cell);
      // Fainter cells turn further: they are the loose, fluttering parts.
      ctx.rotate(Math.sin(this.phase + x * 0.7 + y * 1.1) * TWIST * (1.5 - weight));
      ctx.scale(inner * (0.92 + this.kick * 0.3), inner * (0.92 + this.kick * 0.3));
      const lean = level === levels ? this.kick : 0.55 + this.kick * 0.45;
      ctx.fillStyle = mixColor(line, accent, lean);
      ctx.globalAlpha = base * (0.35 + 0.65 * weight);
      ctx.fill(this.full);
      ctx.globalAlpha *= 0.45;
      ctx.fill(this.faint);
      ctx.restore();
    }
    ctx.restore();
  }
}

/**
 * GlyphMosaic with another visualization's `glyph` option, so it can stand
 * in for that one when 3D is off and still show its default drawing when no
 * drawing was given. Reports the same id, so describe() names it as the
 * mosaic.
 *
 *   static fallback = mosaicOf(this.options.glyph);
 */
export const mosaicOf = (glyph) => class extends GlyphMosaic {
  static options = { ...GlyphMosaic.options, glyph };
};
