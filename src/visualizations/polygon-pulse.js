import { Visualization, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';
import { glyphOption, readGlyph, radialProfile, profileOutline, BLANK } from './glyph.js';

/**
 * PolygonPulse — a rotating polygon whose radius pulses with the bass and
 * whose side count follows how loud the mids are. Snare hits kick the
 * rotation. `energy` — overall loudness — sets how hard all of it goes: the
 * idle spin and the depth of the pulse, so a quiet passage still pulses on
 * the beat, just gently.
 *
 * Draw a `glyph` and each corner sits on the drawing's silhouette (see
 * radialProfile in glyph.js) instead of a circle, so the polygon is a
 * faceted cut of the drawing that turns and pulses; more sides trace it more
 * closely, so raise `minSides` for a recognisable outline. Left blank (the
 * default), it is a regular polygon.
 */
export class PolygonPulse extends Visualization {
  static id = 'polygon-pulse';
  static label = 'Polygon Pulse';
  static description = 'Rotating polygon whose radius pulses and side count morphs; hits kick the spin.';
  static category = CATEGORY.CLASSIC;
  static inputs = {
    kick:   { kind: 'event', default: TRIGGER.SNARE },
    punch:  { kind: 'event', default: TRIGGER.BASS },
    sides:  { kind: 'level', default: { intensity: 'mid' } },
    swell:  { kind: 'level', default: { relative: 'bass' } },
    energy: { kind: 'level', default: { intensity: 'rms' } },
  };

  static MIN_SIDES = 3;     // sides at silence
  static SIDE_RANGE = 6;    // extra sides at full `sides`
  static SIZE = 0.22;       // base radius, of the smaller screen dimension
  static ECHO = 0.62;       // inner accent copy, as a fraction of the radius
  static options = {
    minSides:  { kind: 'number', default: PolygonPulse.MIN_SIDES, min: 3, max: 48, step: 1 },
    sideRange: { kind: 'number', default: PolygonPulse.SIDE_RANGE, min: 0, max: 48, step: 1 },
    size:      { kind: 'number', default: PolygonPulse.SIZE, min: 0.05, max: 0.45, step: 0.01 },
    echo:      { kind: 'number', default: PolygonPulse.ECHO, min: 0, max: 0.95, step: 0.01 },
    glyph:     glyphOption({ width: 9, height: 9, value: BLANK }),
  };

  constructor(opts) {
    super(opts);
    this.minSides = this.option('minSides');
    this.sideRange = this.option('sideRange');
    this.size = this.option('size');
    this.echo = this.option('echo');
    const glyph = readGlyph(this);
    this.outline = glyph?.count ? profileOutline(radialProfile(glyph)) : null;
    this.rotation = 0;
    this.spin = 0.3;     // rad/s, decays back to base after snare kicks
    this.punch = 0;      // extra radius from bass hits, decays fast
  }

  onInput(slot, data) {
    const strength = impact(data);
    if (slot === 'kick') this.spin += (this.random() < 0.5 ? -1 : 1) * (2 + strength * 4);
    if (slot === 'punch') this.punch = Math.max(this.punch, strength);
  }

  draw(ctx, dt) {
    const cx = this.width / 2;
    const cy = this.height / 2;

    const energy = this.in('energy');
    const idleSpin = 0.15 + energy * 0.5;
    this.spin += (idleSpin - this.spin) * dt * 2;
    this.rotation += this.spin * dt;
    this.punch = Math.max(0, this.punch - dt * 3);

    const sides = this.minSides + Math.round(this.in('sides') * this.sideRange);
    const base = Math.min(this.width, this.height) * this.size;
    const depth = 0.4 + energy * 0.6;
    const r = base * (1 + this.in('swell') * 0.35 * depth + this.punch * 0.5);

    this.applyStyle(ctx);
    // Concentric copies for depth: outline (peak-coloured on a hard hit),
    // then a smaller accent echo.
    const copies = [[r, this.peak(this.style.lineColor, this.punch)]];
    if (this.echo > 0) copies.push([r * this.echo, this.style.accentColor ?? this.style.lineColor]);
    for (const [radius, color] of copies) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let i = 0; i <= sides; i++) {
        const t = (i / sides) * Math.PI * 2;
        const a = this.rotation + t;
        // The silhouette turns with the polygon, so the shape stays upright
        // relative to its own corners.
        const reach = radius * (this.outline ? this.outline(t) : 1);
        const x = cx + Math.cos(a) * reach;
        const y = cy + Math.sin(a) * reach;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
}
