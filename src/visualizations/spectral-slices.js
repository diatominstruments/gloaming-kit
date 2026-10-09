import { approach, clamp01, impact } from './base.js';
import { TreatmentVisualization } from './treatment-base.js';
import { logSpectrum } from './three-shared.js';
import { TRIGGER } from '../analyzer.js';
import { rgba } from '../style.js';

/**
 * SpectralSlices — the frame cut into strips, one per band of the spectrum
 * from bass to treble, each pushed sideways by its band's energy. The whole
 * picture becomes an equalizer: a kick shoves the bottom strips, a hi-hat
 * flicks the top ones, and a chord spreads the middle. Strips wrap around,
 * so nothing is lost off the edge.
 *
 * Each strip reads its band against that band's own recent range (as
 * glyph-dendrite does), so the treble strips move as much as the bass ones
 * however the mix is tilted.
 *
 *   reveal  how far the strips move, overall
 *   tint    how far the loud strips take the tint colour
 *   jolt    a hit throws every strip a random extra distance, which springs back
 *
 * Options:
 *   strips       bands, bass to treble (default 24)
 *   orientation  'horizontal' strips stacked bottom to top, or 'vertical'
 *                side by side
 *   bass         which end the bass strip sits at: 'bottom' (left when
 *                vertical) or 'top' (right)
 *   motion       'displace' pushes a strip by its energy and lets it spring
 *                back; 'scroll' slides it at a speed its energy sets, so loud
 *                bands stream past
 *   pattern      which way strips go: 'alternate', 'same', 'centre'
 *                (outward from the middle band) or 'random'
 *   amplitude    full push, of the screen (default 0.2); speed for 'scroll',
 *                screens per second (default 0.6)
 *   curve        energy exponent: higher keeps quiet bands still (default 1.5)
 *   attack/release  seconds a strip takes to follow its band up and down
 *   gap          dark gutter between strips, of a strip (default 0)
 *   edges        brightness of the lines along loud strips' edges (default 0.4)
 *   floor/depth, tint, tintColor, jolt (throw at a full-impact hit, of the screen)
 */
export class SpectralSlices extends TreatmentVisualization {
  static id = 'spectral-slices';
  static label = 'Spectral Slices';
  static description = 'The screen cut into strips, one per band from bass to treble, each shoved sideways by its band; hits throw them all.';
  static inputs = {
    reveal: { kind: 'level', default: { intensity: 'rms' } },
    tint:   { kind: 'level', default: { relative: 'treble' } },
    jolt:   { kind: 'event', default: TRIGGER.SNARE },
  };
  static options = {
    strips:      { kind: 'number', default: 24, min: 4, max: 96, step: 1 },
    orientation: { kind: 'enum', values: ['horizontal', 'vertical'], default: 'horizontal' },
    bass:        { kind: 'enum', values: ['bottom', 'top'], default: 'bottom' },
    motion:      { kind: 'enum', values: ['displace', 'scroll'], default: 'displace' },
    pattern:     { kind: 'enum', values: ['alternate', 'same', 'centre', 'random'], default: 'alternate' },
    amplitude:   { kind: 'number', default: 0.2, min: 0, max: 1, step: 0.01 },
    speed:       { kind: 'number', default: 0.6, min: 0, max: 3, step: 0.05 },
    curve:       { kind: 'number', default: 1.5, min: 0.5, max: 4, step: 0.1 },
    attack:      { kind: 'number', default: 0.03, min: 0.01, max: 0.5, step: 0.01 },
    release:     { kind: 'number', default: 0.18, min: 0.02, max: 2, step: 0.01 },
    gap:         { kind: 'number', default: 0, min: 0, max: 0.4, step: 0.02 },
    edges:       { kind: 'number', default: 0.4, min: 0, max: 1, step: 0.05 },
    floor:       { kind: 'number', default: 0.25, min: 0, max: 1, step: 0.05 },
    depth:       { kind: 'number', default: 0.75, min: 0, max: 1, step: 0.05 },
    tint:        { kind: 'number', default: 0.7, min: 0, max: 1, step: 0.05 },
    tintColor:   { kind: 'enum', values: ['accent', 'line'], default: 'accent' },
    jolt:        { kind: 'number', default: 0.15, min: 0, max: 0.5, step: 0.01 },
  };

  static REVEAL_TAU = 0.25;
  static TINT_TAU = 0.1;
  static JOLT_DECAY = 7;
  static FLASH_DECAY = 5;
  static AVG_TAU = 1.5;          // a band's running average, for its relative level
  static TOP_TAU = 2;            // how fast its ceiling settles back to the average

  constructor(opts) {
    super(opts);
    this.n = this.option('strips');
    this.orientation = this.option('orientation');
    this.bassAt = this.option('bass');
    this.motion = this.option('motion');
    this.pattern = this.option('pattern');
    this.amplitude = this.option('amplitude');
    this.speed = this.option('speed');
    this.curve = this.option('curve');
    this.attack = this.option('attack');
    this.release = this.option('release');
    this.gap = this.option('gap');
    this.edges = this.option('edges');
    this.floor = this.option('floor');
    this.depth = Math.min(this.option('depth'), 1 - this.floor);
    this.tintGain = this.option('tint');
    this.tintColor = this.option('tintColor');
    this.joltGain = this.option('jolt');
    const n = this.n;
    this.raw = new Float32Array(n);
    this.avg = new Float32Array(n);
    this.top = new Float32Array(n);
    this.spec = new Float32Array(n);     // 0..1 per band, bass first
    this.pos = new Float32Array(n);      // scroll position, of the screen
    this.jolts = new Float32Array(n);    // of the screen
    this.sign = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      switch (this.pattern) {
        case 'same': this.sign[i] = 1; break;
        case 'centre': this.sign[i] = i < n / 2 ? -1 : 1; break;
        case 'random': this.sign[i] = ((i * 7919 + 13) % 17) < 8.5 ? -1 : 1; break;
        default: this.sign[i] = i % 2 ? 1 : -1;
      }
    }
    this.reveal = 0;
    this.tint = 0;
    this.flash = 0;
  }

  onInput(slot, data) {
    if (slot !== 'jolt') return;
    const hit = impact(data);
    this.flash = Math.max(this.flash, hit);
    for (let i = 0; i < this.n; i++) {
      this.jolts[i] += (Math.random() * 2 - 1) * hit * this.joltGain;
    }
  }

  /** Each band against its own recent range: snaps up, eases down. */
  listen(dt) {
    const S = SpectralSlices;
    logSpectrum(this.frame?.spectrum, this.raw);
    for (let i = 0; i < this.n; i++) {
      const x = this.raw[i];
      this.avg[i] = approach(this.avg[i], x, S.AVG_TAU, dt);
      this.top[i] = Math.max(x, approach(this.top[i], this.avg[i], S.TOP_TAU, dt));
      const rel = clamp01((x - this.avg[i]) / Math.max(0.06, this.top[i] - this.avg[i]));
      const target = Math.pow(clamp01(0.35 * x * x + 0.8 * rel), this.curve);
      this.spec[i] = approach(this.spec[i], target, target > this.spec[i] ? this.attack : this.release, dt);
    }
  }

  draw(ctx, dt) {
    const S = SpectralSlices;
    this.reveal = approach(this.reveal, clamp01(this.in('reveal')), S.REVEAL_TAU, dt);
    this.tint = approach(this.tint, clamp01(this.in('tint')), S.TINT_TAU, dt);
    this.flash *= Math.exp(-S.FLASH_DECAY * dt);
    this.listen(dt);
    const decay = Math.exp(-S.JOLT_DECAY * dt);
    const gain = this.floor + this.depth * this.reveal;
    const n = this.n;
    for (let i = 0; i < n; i++) {
      this.jolts[i] *= decay;
      if (this.motion === 'scroll') {
        this.pos[i] = (this.pos[i] + dt * this.speed * gain * this.spec[i] * this.sign[i]) % 1;
      }
    }

    const src = this.snapshot(ctx);
    const horizontal = this.orientation === 'horizontal';
    const W = this.width;
    const H = this.height;
    const along = horizontal ? W : H;      // the direction strips move
    const across = horizontal ? H : W;     // the direction they stack
    const thick = across / n;
    const dpr = this.dpr;

    const accent = this.tintColor === 'line' ? this.style.lineColor : (this.style.accentColor ?? this.style.lineColor);
    const color = this.peak(accent, this.flash);
    const tintAmount = this.tintGain * (0.3 + 0.7 * this.tint);
    const tinted = tintAmount > 0.002 ? this.tinted(color, 1) : null;
    const line = this.peak(this.style.lineColor, this.flash);
    const base = ctx.globalAlpha;
    const inset = (this.gap * thick) / 2;
    if (this.gap > 0) {
      ctx.fillStyle = this.style.background;
      ctx.fillRect(0, 0, W, H);
    }

    for (let i = 0; i < n; i++) {
      // Band i sits at position p across the screen, bass at the chosen end.
      const p = this.bassAt === 'bottom'
        ? (horizontal ? n - 1 - i : i)
        : (horizontal ? i : n - 1 - i);
      const start = p * thick;
      const offset = (this.motion === 'scroll'
        ? this.pos[i]
        : this.amplitude * gain * this.spec[i] * this.sign[i]) + this.jolts[i];
      let shift = (offset % 1) * along;
      if (shift < 0) shift += along;

      ctx.save();
      ctx.beginPath();
      if (horizontal) ctx.rect(0, start + inset, W, thick - 2 * inset);
      else ctx.rect(start + inset, 0, thick - 2 * inset, H);
      ctx.clip();
      // The strip, and its wrap-around tail from the other edge.
      const draw = (image, alpha) => {
        ctx.globalAlpha = base * alpha;
        if (horizontal) {
          ctx.drawImage(image, 0, start * dpr, src.width, thick * dpr, shift, start, W, thick);
          ctx.drawImage(image, 0, start * dpr, src.width, thick * dpr, shift - along, start, W, thick);
        } else {
          ctx.drawImage(image, start * dpr, 0, thick * dpr, src.height, start, shift, thick, H);
          ctx.drawImage(image, start * dpr, 0, thick * dpr, src.height, start, shift - along, thick, H);
        }
      };
      draw(src, 1);
      const t = tinted ? tintAmount * this.spec[i] : 0;
      if (t > 0.01) draw(tinted, t);
      if (this.edges > 0) {
        const a = this.edges * this.spec[i];
        if (a > 0.02) {
          ctx.globalAlpha = base * a;
          ctx.fillStyle = rgba(line, 1);
          if (horizontal) ctx.fillRect(0, start + inset, W, 1);
          else ctx.fillRect(start + inset, 0, 1, H);
        }
      }
      ctx.restore();
    }
  }
}
