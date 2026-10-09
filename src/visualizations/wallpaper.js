import { approach, clamp01, impact } from './base.js';
import { FeedbackVisualization } from './feedback-base.js';
import { TRIGGER } from '../analyzer.js';

/**
 * Wallpaper — the previous frame shrunk into a grid of tiles behind the
 * foreground, every other tile mirrored so the seams meet. Each tile holds
 * the whole screen, grid and all, so the lattice recurses into ever-finer
 * copies of itself.
 *
 *   reveal   how strongly the lattice comes through
 *   breathe  tiles zoom in from their centres and ease back — the lattice
 *            swells on every beat
 *   slide    how fast the whole sheet of tiles drifts, along a direction
 *            that wanders slowly
 *   tint     how far the tinted tiles (see `tintPattern`) take the tint
 *            colour, so the lattice flushes with the treble
 *   shift    a hit walks the column count up or down one, within `walk` of
 *            the base count, and flashes the tiles toward the peak colour
 *
 * Options:
 *   columns      tiles across (default 3)
 *   rows         tiles down; 0 keeps tiles square (default 0)
 *   mirror       which axes alternate tiles flip on (default 'both')
 *   gap          dark gutter between tiles, of a tile (default 0)
 *   walk         how far hits may walk the column count from `columns`
 *   floor/depth  lattice strength at silence, and extra at full `reveal`
 *   breathe      tile zoom at full `breathe`
 *   slide        tiles per second at full `slide`
 *   tint         tint strength at full `tint`
 *   tintColor    'accent' or 'line'
 *   tintPattern  'checker' (every other tile), 'odd' (odd columns), 'all'
 */
export class Wallpaper extends FeedbackVisualization {
  static id = 'wallpaper';
  static label = 'Wallpaper';
  static description = 'The screen tiled into a mirrored lattice behind itself that breathes, slides and flushes with the music; hits change the tile count.';
  static inputs = {
    reveal:  { kind: 'level', default: { intensity: 'rms' } },
    breathe: { kind: 'level', default: { relative: 'bass' } },
    slide:   { kind: 'level', default: 'mid' },
    tint:    { kind: 'level', default: { relative: 'treble' } },
    shift:   { kind: 'event', default: TRIGGER.SNARE },
  };
  static options = {
    columns:     { kind: 'number', default: 3, min: 1, max: 8, step: 1 },
    rows:        { kind: 'number', default: 0, min: 0, max: 8, step: 1 },
    mirror:      { kind: 'enum', values: ['both', 'horizontal', 'vertical', 'none'], default: 'both' },
    gap:         { kind: 'number', default: 0, min: 0, max: 0.3, step: 0.01 },
    walk:        { kind: 'number', default: 2, min: 0, max: 6, step: 1 },
    floor:       { kind: 'number', default: 0.3, min: 0, max: 1, step: 0.05 },
    depth:       { kind: 'number', default: 0.6, min: 0, max: 1, step: 0.05 },
    breathe:     { kind: 'number', default: 0.12, min: 0, max: 0.5, step: 0.01 },
    slide:       { kind: 'number', default: 0.3, min: 0, max: 2, step: 0.05 },
    tint:        { kind: 'number', default: 0.7, min: 0, max: 1, step: 0.05 },
    tintColor:   { kind: 'enum', values: ['accent', 'line'], default: 'accent' },
    tintPattern: { kind: 'enum', values: ['checker', 'odd', 'all'], default: 'checker' },
  };

  static REVEAL_TAU = 0.3;
  static BREATHE_ATTACK = 0.04;
  static BREATHE_RELEASE = 0.45;
  static SLIDE_TAU = 0.5;
  static SLIDE_BASE = 0.08;      // of the `slide` option's rate, at silence
  static TINT_TAU = 0.12;
  static TINT_BASE = 0.15;       // of the `tint` option, at silence
  static WANDER = [0.11, 0.07];  // direction wander, cycles per second
  static FLASH_DECAY = 4;
  static FLASH_ALPHA = 0.25;     // extra lattice strength at a full-impact hit
  static ALPHA_CAP = 0.95;       // tiles of tiles must fade

  constructor(opts) {
    super(opts);
    this.columns = this.option('columns');
    this.rows = this.option('rows');
    this.mirror = this.option('mirror');
    this.gap = this.option('gap');
    this.walk = this.option('walk');
    this.floor = this.option('floor');
    this.depth = Math.min(this.option('depth'), Wallpaper.ALPHA_CAP - this.floor);
    this.breatheGain = this.option('breathe');
    this.slideRate = this.option('slide');
    this.tintGain = this.option('tint');
    this.tintColor = this.option('tintColor');
    this.tintPattern = this.option('tintPattern');
    this.cols = this.columns;
    this.reveal = 0;
    this.breathe = 0;
    this.slide = 0;
    this.tint = 0;
    this.flash = 0;
    this.time = 0;
    this.ox = 0;      // sheet offset, in tiles
    this.oy = 0;
  }

  onInput(slot, data) {
    if (slot !== 'shift') return;
    this.flash = Math.max(this.flash, impact(data));
    if (this.walk === 0) return;
    const lo = Math.max(1, this.columns - this.walk);
    const hi = Math.min(8, this.columns + this.walk);
    // A random walk that turns back at either end of its range.
    const up = this.cols <= lo || (this.cols < hi && Math.random() < 0.5);
    this.cols += up ? 1 : -1;
  }

  draw(ctx, dt) {
    const W = Wallpaper;
    this.time += dt;
    this.reveal = approach(this.reveal, clamp01(this.in('reveal')), W.REVEAL_TAU, dt);
    const breathe = clamp01(this.in('breathe'));
    this.breathe = approach(this.breathe, breathe, breathe > this.breathe ? W.BREATHE_ATTACK : W.BREATHE_RELEASE, dt);
    this.slide = approach(this.slide, clamp01(this.in('slide')), W.SLIDE_TAU, dt);
    this.tint = approach(this.tint, clamp01(this.in('tint')), W.TINT_TAU, dt);
    this.flash *= Math.exp(-W.FLASH_DECAY * dt);

    const cols = this.cols;
    const rows = this.rows || Math.max(1, Math.round(cols * this.height / this.width));
    const cw = this.width / cols;
    const ch = this.height / rows;
    const flipX = this.mirror === 'both' || this.mirror === 'horizontal';
    const flipY = this.mirror === 'both' || this.mirror === 'vertical';

    // The sheet slides at a rate the music sets, along a wandering heading.
    const heading = Math.PI * 2 * (0.3 * Math.sin(this.time * W.WANDER[0] * Math.PI * 2)
      + 0.2 * Math.cos(this.time * W.WANDER[1] * Math.PI * 2));
    const rate = this.slideRate * (W.SLIDE_BASE + (1 - W.SLIDE_BASE) * this.slide);
    const periodX = flipX ? 2 : 1;
    const periodY = flipY ? 2 : 1;
    this.ox = (this.ox + dt * rate * Math.cos(heading)) % periodX;
    this.oy = (this.oy + dt * rate * Math.sin(heading)) % periodY;
    if (this.ox < 0) this.ox += periodX;
    if (this.oy < 0) this.oy += periodY;

    if (!this.hasPrevious) return;

    const zoom = 1 + this.breatheGain * this.breathe;
    const accent = this.tintColor === 'line' ? this.style.lineColor : (this.style.accentColor ?? this.style.lineColor);
    const color = this.peak(accent, this.flash);
    const tintAmount = this.tintGain * (W.TINT_BASE + (1 - W.TINT_BASE) * this.tint);
    const tinted = this.tinted(color, tintAmount);
    const plain = this.previous;

    const alpha = ctx.globalAlpha * Math.min(W.ALPHA_CAP, this.floor + this.depth * this.reveal + W.FLASH_ALPHA * this.flash);
    const inset = this.gap / 2;
    const tw = cw * (1 - this.gap);
    const th = ch * (1 - this.gap);

    for (let j = -2; j <= rows + 1; j++) {
      const y = (j + this.oy) * ch;
      if (y >= this.height || y + ch <= 0) continue;
      for (let i = -2; i <= cols + 1; i++) {
        const x = (i + this.ox) * cw;
        if (x >= this.width || x + cw <= 0) continue;
        const oddX = ((i % 2) + 2) % 2 === 1;
        const oddY = ((j % 2) + 2) % 2 === 1;
        const tintThis = this.tintPattern === 'all'
          || (this.tintPattern === 'odd' ? oddX : oddX !== oddY);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.rect(x + inset * cw, y + inset * ch, tw, th);
        ctx.clip();
        ctx.translate(x + cw / 2, y + ch / 2);
        ctx.scale((flipX && oddX ? -1 : 1) * zoom, (flipY && oddY ? -1 : 1) * zoom);
        ctx.drawImage(tintThis ? tinted : plain, -cw / 2, -ch / 2, cw, ch);
        ctx.restore();
      }
    }
  }
}
