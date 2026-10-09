import { approach, clamp01, impact } from './base.js';
import { FeedbackVisualization } from './feedback-base.js';
import { TRIGGER } from '../analyzer.js';

/**
 * ZoomBurst — the previous frame drawn several times, each a step larger
 * than the last and fainter, so everything on screen streaks outward from
 * a point. The streaks are of copies that themselves streak, so a hit
 * throws the whole picture into a speed-blur that drains back as it fades.
 *
 *   reveal   how strongly the streaks come through
 *   stretch  how far apart the copies sit — the streak length; rises fast
 *            and falls slowly, so a kick flings them out and lets them drain
 *   wander   how fast the vanishing point roams
 *   tint     how far the copies take the tint colour, so the streaks flush
 *            with the treble while the figure keeps its own colours
 *   kick     a hit throws the vanishing point to a new spot, flashes the
 *            copies toward the peak colour, and with direction 'flip'
 *            reverses the burst between outward and inward
 *
 * Options:
 *   copies     how many echoes (default 3)
 *   step       scale step between copies at silence (default 0.04)
 *   gain       extra step at full `stretch` (default 0.12)
 *   falloff    each copy's alpha against the last (default 0.65)
 *   twist      radians each copy turns from the last (default 0)
 *   direction  'out', 'in' or 'flip' (default 'out')
 *   wander     how far the point roams, of the smaller dimension
 *   blend      'source-over' lays copies down; 'lighter' and 'screen' add them
 *   floor/depth, tint, tintColor, kick (how far a hit throws the point)
 */
export class ZoomBurst extends FeedbackVisualization {
  static id = 'zoom-burst';
  static label = 'Zoom Burst';
  static description = 'The screen streaking outward from a roaming point in fading copies; kicks fling the streaks out and throw the point.';
  static inputs = {
    reveal:  { kind: 'level', default: { intensity: 'rms' } },
    stretch: { kind: 'level', default: { relative: 'bass' } },
    wander:  { kind: 'level', default: 'mid' },
    tint:    { kind: 'level', default: { relative: 'treble' } },
    kick:    { kind: 'event', default: TRIGGER.BASS },
  };
  static options = {
    copies:    { kind: 'number', default: 3, min: 1, max: 8, step: 1 },
    step:      { kind: 'number', default: 0.04, min: 0.005, max: 0.15, step: 0.005 },
    gain:      { kind: 'number', default: 0.12, min: 0, max: 0.4, step: 0.01 },
    falloff:   { kind: 'number', default: 0.65, min: 0.2, max: 1, step: 0.05 },
    twist:     { kind: 'number', default: 0, min: -0.2, max: 0.2, step: 0.005 },
    direction: { kind: 'enum', values: ['out', 'in', 'flip'], default: 'out' },
    wander:    { kind: 'number', default: 0.2, min: 0, max: 0.5, step: 0.01 },
    blend:     { kind: 'enum', values: ['source-over', 'lighter', 'screen'], default: 'source-over' },
    floor:     { kind: 'number', default: 0.55, min: 0, max: 1, step: 0.05 },
    depth:     { kind: 'number', default: 0.35, min: 0, max: 1, step: 0.05 },
    tint:      { kind: 'number', default: 0.6, min: 0, max: 1, step: 0.05 },
    tintColor: { kind: 'enum', values: ['accent', 'line'], default: 'accent' },
    kick:      { kind: 'number', default: 0.5, min: 0, max: 1, step: 0.05 },
  };

  static REVEAL_TAU = 0.3;
  static STRETCH_ATTACK = 0.03;
  static STRETCH_RELEASE = 0.5;
  static WANDER_TAU = 0.5;
  static WANDER_BASE = 0.15;     // roam rate at silence, of full
  static WANDER_RATE = [0.09, 0.13]; // Lissajous, cycles per second at full `wander`
  static THROW_TAU = 0.12;       // how fast the point reaches where a hit threw it
  static TINT_TAU = 0.12;
  static TINT_BASE = 0;          // tint compounds down the copies, so none at silence
  static FLASH_DECAY = 4;
  static FLASH_ALPHA = 0.1;
  static COVER_CAP = 0.92;       // combined coverage of all copies: copies of copies must fade
  static ADD_CAP = 0.75;         // summed copy alpha in additive blends, so the recursion can't bloom to white

  /** The first copy's alpha so that `copies` copies, each `falloff` of the last, cover `coverage` together. */
  static firstAlpha(coverage, copies, falloff) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      let miss = 1;
      for (let k = 0; k < copies; k++) miss *= 1 - Math.min(1, mid * Math.pow(falloff, k));
      if (1 - miss < coverage) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  constructor(opts) {
    super(opts);
    this.copies = this.option('copies');
    this.step = this.option('step');
    this.gain = this.option('gain');
    this.falloff = this.option('falloff');
    this.twist = this.option('twist');
    this.direction = this.option('direction');
    this.wanderRange = this.option('wander');
    this.blend = this.option('blend');
    this.floor = this.option('floor');
    this.depth = Math.min(this.option('depth'), ZoomBurst.COVER_CAP - this.floor);
    this.tintGain = this.option('tint');
    this.tintColor = this.option('tintColor');
    this.kick = this.option('kick');
    this.dir = this.direction === 'in' ? -1 : 1;
    this.reveal = 0;
    this.stretch = 0;
    this.wander = 0;
    this.tint = 0;
    this.flash = 0;
    this.phase = 0;         // roam phase, advanced at a rate the music sets
    this.thrown = { x: 0, y: 0 };   // where the last hit threw the point, of the roam range
    this.offset = { x: 0, y: 0 };   // eased toward `thrown`
  }

  onInput(slot, data) {
    if (slot !== 'kick') return;
    const hit = impact(data);
    this.flash = Math.max(this.flash, hit);
    const r = this.kick * hit;
    const a = Math.random() * Math.PI * 2;
    this.thrown = { x: r * Math.cos(a), y: r * Math.sin(a) };
    if (this.direction === 'flip') this.dir = -this.dir;
  }

  draw(ctx, dt) {
    const Z = ZoomBurst;
    this.reveal = approach(this.reveal, clamp01(this.in('reveal')), Z.REVEAL_TAU, dt);
    const stretch = clamp01(this.in('stretch'));
    this.stretch = approach(this.stretch, stretch, stretch > this.stretch ? Z.STRETCH_ATTACK : Z.STRETCH_RELEASE, dt);
    this.wander = approach(this.wander, clamp01(this.in('wander')), Z.WANDER_TAU, dt);
    this.tint = approach(this.tint, clamp01(this.in('tint')), Z.TINT_TAU, dt);
    this.flash *= Math.exp(-Z.FLASH_DECAY * dt);
    this.phase += dt * (Z.WANDER_BASE + (1 - Z.WANDER_BASE) * this.wander);
    this.offset.x = approach(this.offset.x, this.thrown.x, Z.THROW_TAU, dt);
    this.offset.y = approach(this.offset.y, this.thrown.y, Z.THROW_TAU, dt);
    // Once thrown, the point drifts home so the next throw reads as one.
    this.thrown.x = approach(this.thrown.x, 0, 1.5, dt);
    this.thrown.y = approach(this.thrown.y, 0, 1.5, dt);
    if (!this.hasPrevious) return;

    const min = Math.min(this.width, this.height);
    const range = min * this.wanderRange;
    const vx = this.width / 2 + range * (0.7 * Math.sin(this.phase * Z.WANDER_RATE[0] * Math.PI * 2) + this.offset.x);
    const vy = this.height / 2 + range * (0.7 * Math.cos(this.phase * Z.WANDER_RATE[1] * Math.PI * 2) + this.offset.y);
    const step = this.step + this.gain * this.stretch;

    const accent = this.tintColor === 'line' ? this.style.lineColor : (this.style.accentColor ?? this.style.lineColor);
    const color = this.peak(accent, this.flash);
    const source = this.tinted(color, this.tintGain * (Z.TINT_BASE + (1 - Z.TINT_BASE) * this.tint));

    // `floor`/`depth` set how much of the screen the copies cover together,
    // which is what has to stay under 1: every copy is of a frame that holds
    // the last copies, so at full coverage nothing ever fades.
    const cover = Math.min(Z.COVER_CAP, this.floor + this.depth * this.reveal + Z.FLASH_ALPHA * this.flash);
    let alpha = Z.firstAlpha(cover, this.copies, this.falloff);
    if (this.blend !== 'source-over') {
      // Additive copies of additive copies grow without bound; cap the sum.
      let total = 0;
      for (let k = 0; k < this.copies; k++) total += alpha * Math.pow(this.falloff, k);
      if (total > Z.ADD_CAP) alpha *= Z.ADD_CAP / total;
    }

    const base = ctx.globalAlpha;
    ctx.globalCompositeOperation = this.blend;
    for (let k = 1; k <= this.copies; k++) {
      const grow = 1 + k * step;
      const s = this.dir > 0 ? grow : 1 / grow;
      ctx.save();
      ctx.globalAlpha = base * alpha * Math.pow(this.falloff, k - 1);
      ctx.translate(vx, vy);
      ctx.rotate(this.twist * k * this.dir);
      ctx.scale(s, s);
      ctx.drawImage(source, -vx, -vy, this.width, this.height);
      ctx.restore();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
