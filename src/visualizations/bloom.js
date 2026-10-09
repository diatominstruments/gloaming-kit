import { approach, clamp01, impact } from './base.js';
import { TreatmentVisualization } from './treatment-base.js';
import { downsample, fit, scaleInto, scratchCanvas, subtract, tint } from './frame-utils.js';
import { TRIGGER } from '../analyzer.js';

/**
 * Bloom — the frame blurred and added back over itself, so everything on
 * screen glows. With `trail` the glow also lingers: each frame's light is
 * kept, spread a little further and dimmed, so a moving figure leaves a
 * diffusing wake like ink in water.
 *
 * The blur is a chain of halvings (each averages four pixels into one)
 * scaled back up with smoothing on — no filters, so it runs everywhere.
 * The trail is kept on that small canvas, so it costs almost nothing.
 *
 *   reveal  how bright the glow is
 *   spread  how wide the blur reaches; rises fast and falls slowly, so a
 *           kick throws a halo that drains back
 *   tint    how far the glow takes the tint colour, so the halo flushes
 *           with the treble while the figure keeps its own colour
 *   flare   a hit flashes the glow brighter and wider and toward the peak colour
 *
 * Options:
 *   radius     blur, in device pixels, at silence (default 12)
 *   gain       extra at full `spread` (default 36)
 *   boost      brightness of the blurred light (default 2): a thin line's
 *              light spread over its blur is faint, and this lifts it
 *   threshold  passes that square the image before the blur, so only the
 *              brightest parts bloom; thin lines lose out (default 0)
 *   trail      how much of the glow carries to the next frame, 0..0.95
 *              (default 0.5): a wake that diffuses and fades
 *   blend      'lighter' adds the glow, 'screen' adds softly, 'source-over'
 *              lays it over
 *   zoom       scale of the glow against the frame (default 1)
 *   floor/depth, tint, tintColor, flare (how hard a hit flashes)
 */
export class Bloom extends TreatmentVisualization {
  static id = 'bloom';
  static label = 'Bloom';
  static description = 'Everything on screen glowing, with a wake that diffuses like ink in water; kicks throw halos and the treble colours them.';
  static inputs = {
    reveal: { kind: 'level', default: { intensity: 'rms' } },
    spread: { kind: 'level', default: { relative: 'bass' } },
    tint:   { kind: 'level', default: { relative: 'treble' } },
    flare:  { kind: 'event', default: TRIGGER.BASS },
  };
  static options = {
    radius:    { kind: 'number', default: 12, min: 2, max: 96, step: 1 },
    gain:      { kind: 'number', default: 36, min: 0, max: 160, step: 2 },
    boost:     { kind: 'number', default: 2, min: 1, max: 8, step: 0.5 },
    threshold: { kind: 'number', default: 0, min: 0, max: 3, step: 1 },
    trail:     { kind: 'number', default: 0.5, min: 0, max: 0.95, step: 0.05 },
    blend:     { kind: 'enum', values: ['lighter', 'screen', 'source-over'], default: 'lighter' },
    zoom:      { kind: 'number', default: 1, min: 0.95, max: 1.1, step: 0.005 },
    floor:     { kind: 'number', default: 0.4, min: 0, max: 1, step: 0.05 },
    depth:     { kind: 'number', default: 0.6, min: 0, max: 1, step: 0.05 },
    tint:      { kind: 'number', default: 0.6, min: 0, max: 1, step: 0.05 },
    tintColor: { kind: 'enum', values: ['accent', 'line'], default: 'accent' },
    flare:     { kind: 'number', default: 0.5, min: 0, max: 1, step: 0.05 },
  };

  static REVEAL_TAU = 0.25;
  static SPREAD_ATTACK = 0.03;
  static SPREAD_RELEASE = 0.5;
  static TINT_TAU = 0.12;
  static TINT_BASE = 0.1;
  static FLASH_DECAY = 4;
  static FLASH_SPREAD = 0.6;     // of `gain`, at a full-impact flare
  static FLASH_BOOST = 1;        // extra brightness at a full-impact flare

  constructor(opts) {
    super(opts);
    this.radius = this.option('radius');
    this.gain = this.option('gain');
    this.boost = this.option('boost');
    this.threshold = this.option('threshold');
    this.trail = this.option('trail');
    this.blend = this.option('blend');
    this.zoom = this.option('zoom');
    this.floor = this.option('floor');
    this.depth = Math.min(this.option('depth'), 1 - this.floor);
    this.tintGain = this.option('tint');
    this.tintColor = this.option('tintColor');
    this.flareGain = this.option('flare');
    this.reveal = 0;
    this.spread = 0;
    this.tint = 0;
    this.flash = 0;
    this.wake = null;      // the small canvas carrying the trail
  }

  onInput(slot, data) {
    if (slot === 'flare') this.flash = Math.max(this.flash, impact(data) * this.flareGain);
  }

  /** `small` multiplied by itself `times` times, on alternating canvases. */
  square(small, times) {
    for (let i = 0; i < times; i++) {
      const out = scratchCanvas(this.scratches, 'sq' + (i % 2));
      fit(out, small.width, small.height);
      const c = out.getContext('2d');
      c.globalCompositeOperation = 'copy';
      c.globalAlpha = 1;
      c.drawImage(small, 0, 0);
      c.globalCompositeOperation = 'multiply';
      c.drawImage(small, 0, 0);
      c.globalCompositeOperation = 'source-over';
      small = out;
    }
    return small;
  }

  /** `small` brightened by `factor`, adding it to itself in passes. */
  lift(small, factor) {
    let pass = 0;
    while (factor > 1.001) {
      const out = scratchCanvas(this.scratches, 'lift' + (pass++ % 2));
      fit(out, small.width, small.height);
      const c = out.getContext('2d');
      c.globalCompositeOperation = 'copy';
      c.globalAlpha = 1;
      c.drawImage(small, 0, 0);
      c.globalCompositeOperation = 'lighter';
      const add = Math.min(1, factor - 1);
      c.globalAlpha = add;
      c.drawImage(small, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      factor /= 1 + add;
      small = out;
    }
    return small;
  }

  draw(ctx, dt) {
    const B = Bloom;
    this.reveal = approach(this.reveal, clamp01(this.in('reveal')), B.REVEAL_TAU, dt);
    const spread = clamp01(this.in('spread'));
    this.spread = approach(this.spread, spread, spread > this.spread ? B.SPREAD_ATTACK : B.SPREAD_RELEASE, dt);
    this.tint = approach(this.tint, clamp01(this.in('tint')), B.TINT_TAU, dt);
    this.flash *= Math.exp(-B.FLASH_DECAY * dt);

    const src = this.snapshot(ctx);
    const radius = this.radius + this.gain * (this.spread + B.FLASH_SPREAD * this.flash);

    // One halving first, then the threshold, then the rest of the blur: a
    // thin line blurred wide is faint everywhere, and squaring it after
    // would lose it; squaring it while it is still nearly sharp keeps it.
    let small = scaleInto(this.scratch('half'), src, src.width / 2, src.height / 2);
    // Only the figure's light should bloom, not the background's colour.
    subtract(small, this.style.background);
    if (this.threshold > 0) small = this.square(small, this.threshold);
    small = downsample(this.scratches, 'down', small, Math.max(1, radius / 2));

    if (this.trail > 0) {
      // The wake: last frame's light, spread one step further (a halving
      // and back), dimmed by `trail`, under this frame's. Resampled if the
      // blur size changed. The gain is under 1, so it settles rather than runs away.
      const wake = this.scratch('wake');
      const blurred = this.scratch('wakeBlur');
      if (this.wake && wake.width > 0) {
        scaleInto(blurred, wake, wake.width / 2, wake.height / 2);
      }
      const out = this.scratch('wakeOut');
      fit(out, small.width, small.height);
      const c = out.getContext('2d');
      c.imageSmoothingEnabled = true;
      c.globalCompositeOperation = 'copy';
      c.globalAlpha = 1;
      c.drawImage(small, 0, 0);
      if (this.wake && wake.width > 0) {
        c.globalCompositeOperation = 'lighter';
        c.globalAlpha = this.trail;
        c.drawImage(blurred, 0, 0, out.width, out.height);
        c.globalAlpha = 1;
        c.globalCompositeOperation = 'source-over';
      }
      // Keep it for next frame.
      fit(wake, out.width, out.height);
      const w = wake.getContext('2d');
      w.globalCompositeOperation = 'copy';
      w.drawImage(out, 0, 0);
      this.wake = wake;
      small = out;
    }

    const accent = this.tintColor === 'line' ? this.style.lineColor : (this.style.accentColor ?? this.style.lineColor);
    const color = this.peak(accent, this.flash);
    const amount = this.tintGain * (B.TINT_BASE + (1 - B.TINT_BASE) * this.tint);
    if (amount > 0.002) small = tint(this.scratch('tint'), small, color, amount);
    small = this.lift(small, this.boost * (1 + B.FLASH_BOOST * this.flash));

    const alpha = clamp01(this.floor + this.depth * this.reveal + this.flash);
    const cx = this.width / 2;
    const cy = this.height / 2;
    const zoom = this.zoom + 0.02 * this.flash;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.globalCompositeOperation = this.blend;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(cx, cy);
    ctx.scale(zoom, zoom);
    ctx.drawImage(small, -cx, -cy, this.width, this.height);
    ctx.restore();
  }
}
