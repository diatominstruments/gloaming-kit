import { approach, clamp01, impact } from './base.js';
import { FeedbackVisualization } from './feedback-base.js';
import { canvasFilterSupported } from './frame-utils.js';
import { TRIGGER } from '../analyzer.js';

/**
 * HueDrift — the previous frame drawn back a little larger and turned
 * through the colour wheel, so every echo sits a few degrees further round
 * than the one before. Alone, the figure trails a rainbow of ghosts that
 * spread outward; under another feedback background it recolours that one's
 * copies as well, so an infinity mirror's tunnel or a kaleidoscope's rings
 * become a colour wheel.
 *
 *   reveal  how strongly the echo comes through
 *   drift   how fast the hue turns — degrees per second of an echo's age
 *   swell   echoes zoom out further and turn faster, so the ghosts flare
 *           on the beat
 *   jump    a hit turns the hue a whole step at once, which recurses as a
 *           band of new colour down every echo; with direction 'flip' it
 *           also reverses which way round the wheel the drift goes
 *
 * Options:
 *   mode       'rotate' turns every pixel's own hue (needs canvas filters;
 *              falls back to 'colourise' without them), 'colourise' pushes
 *              the echo toward one cycling colour
 *   rate       degrees per second at silence (default 180)
 *   gain       extra at full `drift` (default 360)
 *   jump       degrees a hit turns the hue (default 60)
 *   zoom       scale of each echo against the last (default 1.012)
 *   swell      extra zoom at full `swell`
 *   spin       radians per second each echo turns (default 0)
 *   saturate   saturation of each echo against the last, 'rotate' mode; it
 *              compounds down the echoes, so keep it near 1 (default 1)
 *   strength   how far 'colourise' pushes toward the colour
 *   direction  'forward', 'backward' or 'flip'
 *   floor/depth
 */
export class HueDrift extends FeedbackVisualization {
  static id = 'hue-drift';
  static label = 'Hue Drift';
  static description = 'The screen echoing outward behind itself through the colour wheel; hits step the colour, and other feedback backgrounds inherit the rainbow.';
  static inputs = {
    reveal: { kind: 'level', default: { intensity: 'rms' } },
    drift:  { kind: 'level', default: 'mid' },
    swell:  { kind: 'level', default: { relative: 'bass' } },
    jump:   { kind: 'event', default: TRIGGER.SNARE },
  };
  static options = {
    mode:      { kind: 'enum', values: ['rotate', 'colourise'], default: 'rotate' },
    rate:      { kind: 'number', default: 180, min: 0, max: 720, step: 5 },
    gain:      { kind: 'number', default: 360, min: 0, max: 1440, step: 10 },
    jump:      { kind: 'number', default: 60, min: 0, max: 180, step: 5 },
    zoom:      { kind: 'number', default: 1.012, min: 0.95, max: 1.08, step: 0.002 },
    swell:     { kind: 'number', default: 0.03, min: 0, max: 0.15, step: 0.005 },
    spin:      { kind: 'number', default: 0, min: -0.5, max: 0.5, step: 0.01 },
    saturate:  { kind: 'number', default: 1, min: 0.5, max: 1.5, step: 0.02 },
    strength:  { kind: 'number', default: 0.6, min: 0, max: 1, step: 0.05 },
    direction: { kind: 'enum', values: ['forward', 'backward', 'flip'], default: 'forward' },
    floor:     { kind: 'number', default: 0.4, min: 0, max: 1, step: 0.05 },
    depth:     { kind: 'number', default: 0.45, min: 0, max: 1, step: 0.05 },
  };

  static REVEAL_TAU = 0.3;
  static DRIFT_TAU = 0.4;
  static SWELL_ATTACK = 0.03;
  static SWELL_RELEASE = 0.4;
  static FLASH_DECAY = 4;
  static FLASH_ALPHA = 0.1;
  static ALPHA_CAP = 0.92;      // the echo must fade: at 1 it never does
  static SWELL_SPIN = 2;        // spin multiplier at full `swell`

  constructor(opts) {
    super(opts);
    this.mode = this.option('mode');
    if (this.mode === 'rotate' && !canvasFilterSupported()) this.mode = 'colourise';
    this.rate = this.option('rate');
    this.gain = this.option('gain');
    this.jump = this.option('jump');
    this.zoom = this.option('zoom');
    this.swellGain = this.option('swell');
    this.spin = this.option('spin');
    this.saturate = this.option('saturate');
    this.strength = this.option('strength');
    this.direction = this.option('direction');
    this.dir = this.direction === 'backward' ? -1 : 1;
    this.floor = this.option('floor');
    this.depth = Math.min(this.option('depth'), HueDrift.ALPHA_CAP - this.floor);
    this.reveal = 0;
    this.drift = 0;
    this.swell = 0;
    this.flash = 0;
    this.pending = 0;     // degrees a hit asked for, applied on the next echo
    this.hue = 0;         // the cycling colour's hue, 'colourise' mode
    this.angle = 0;
  }

  onInput(slot, data) {
    if (slot !== 'jump') return;
    this.flash = Math.max(this.flash, impact(data));
    if (this.direction === 'flip') this.dir = -this.dir;
    this.pending += this.jump * this.dir;
  }

  draw(ctx, dt) {
    const H = HueDrift;
    this.reveal = approach(this.reveal, clamp01(this.in('reveal')), H.REVEAL_TAU, dt);
    this.drift = approach(this.drift, clamp01(this.in('drift')), H.DRIFT_TAU, dt);
    const swell = clamp01(this.in('swell'));
    this.swell = approach(this.swell, swell, swell > this.swell ? H.SWELL_ATTACK : H.SWELL_RELEASE, dt);
    this.flash *= Math.exp(-H.FLASH_DECAY * dt);
    // Degrees this echo turns: the drift over one frame, plus any hit.
    const turn = this.dir * (this.rate + this.gain * this.drift) * dt + this.pending;
    this.pending = 0;
    this.hue = (this.hue + turn) % 360;
    this.angle += dt * this.spin * (1 + H.SWELL_SPIN * this.swell);
    if (!this.hasPrevious) return;

    const zoom = this.zoom + this.swellGain * this.swell;
    const alpha = Math.min(H.ALPHA_CAP, this.floor + this.depth * this.reveal + H.FLASH_ALPHA * this.flash);
    const cx = this.width / 2;
    const cy = this.height / 2;

    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(cx, cy);
    ctx.rotate(this.angle);
    ctx.scale(zoom, zoom);
    if (this.mode === 'rotate') {
      ctx.filter = `hue-rotate(${turn.toFixed(2)}deg) saturate(${this.saturate})`;
      ctx.drawImage(this.previous, -cx, -cy, this.width, this.height);
      ctx.filter = 'none';
    } else {
      const color = `hsl(${((this.hue % 360) + 360) % 360}, 100%, 55%)`;
      ctx.drawImage(this.tinted(color, this.strength, 'hue'), -cx, -cy, this.width, this.height);
    }
    ctx.restore();
  }
}
