import { approach, clamp01, impact } from './base.js';
import { FeedbackVisualization } from './feedback-base.js';
import { TRIGGER } from '../analyzer.js';
import { rgba } from '../style.js';

/**
 * InfinityMirror — a glowing rim whose inside reflects the previous frame,
 * shrunk and turned a little, so the rim and everything on screen recede
 * into a spiralling tunnel of copies.
 *
 * `reveal` sets how strongly the reflection comes through, which is what
 * makes the mirror appear and vanish with the music: with it low, only the
 * rim and one faint echo remain; with it high, the copies run deep before
 * they fade. It rises fast and falls slowly so a hit opens the tunnel and
 * lets it drain rather than blinking.
 *
 * `turn` sets how far each reflection is rotated from the last — the mirror
 * angle — and `flip` reverses the twist, easing through straight rather than
 * snapping. The vanishing point wanders slowly off centre, like a mirror
 * tilting, so the tunnel bends.
 *
 * Options:
 *   shape  'rect' or 'circle' rim (default 'rect')
 */
export class InfinityMirror extends FeedbackVisualization {
  static id = 'infinity-mirror';
  static label = 'Infinity Mirror';
  static description = 'A rim reflecting the screen into a receding, twisting tunnel that opens up with the music.';
  static inputs = {
    reveal: { kind: 'level', default: { relative: 'bass' } },
    turn:   { kind: 'level', default: 'mid' },
    flip:   { kind: 'event', default: TRIGGER.SNARE },
  };
  static options = {
    shape: { kind: 'enum', values: ['rect', 'circle'], default: 'rect' },
  };

  static MARGIN = 0.06;       // rim inset, of the smaller screen dimension
  static SHRINK = 0.9;        // scale of each reflection against the last
  static FLOOR = 0.25;        // reflection strength at silence
  static DEPTH = 0.68;        // extra at full `reveal`; keep FLOOR + DEPTH < 1
  static ATTACK = 0.05;       // seconds; reveal rise
  static RELEASE = 0.7;       // seconds; reveal fall
  static BASE_TURN = 0.01;    // radians per reflection, at silence
  static TURN_GAIN = 0.07;    // extra at full `turn`
  static TURN_TAU = 0.4;
  static FLIP_TAU = 0.35;     // how long a flip takes to swing through
  static TILT = 0.035;        // vanishing point wander, of the smaller dimension
  static TILT_RATE = [0.13, 0.09]; // Lissajous rates, cycles per second
  static RIM_ALPHA = 0.35;    // rim opacity at silence
  static RIM_GAIN = 0.65;     // extra at full `reveal` or a flip
  static FLASH_DECAY = 3;

  constructor(opts) {
    super(opts);
    this.shape = this.options.shape === 'circle' ? 'circle' : 'rect';
    this.reveal = 0;
    this.turn = 0;
    this.dir = 1;             // eased toward ±1
    this.dirTarget = 1;
    this.flash = 0;
    this.time = 0;
  }

  onInput(slot, data) {
    if (slot !== 'flip') return;
    this.dirTarget = -this.dirTarget;
    this.flash = Math.max(this.flash, impact(data));
  }

  /** Trace the rim, centred on the screen. */
  rimPath(ctx) {
    const m = Math.min(this.width, this.height) * InfinityMirror.MARGIN;
    ctx.beginPath();
    if (this.shape === 'circle') {
      ctx.arc(this.width / 2, this.height / 2, Math.min(this.width, this.height) / 2 - m, 0, Math.PI * 2);
    } else {
      ctx.rect(m, m, this.width - 2 * m, this.height - 2 * m);
    }
  }

  draw(ctx, dt) {
    const M = InfinityMirror;
    this.time += dt;
    const target = clamp01(this.in('reveal'));
    this.reveal = approach(this.reveal, target, target > this.reveal ? M.ATTACK : M.RELEASE, dt);
    this.turn = approach(this.turn, this.in('turn'), M.TURN_TAU, dt);
    this.dir = approach(this.dir, this.dirTarget, M.FLIP_TAU, dt);
    this.flash *= Math.exp(-M.FLASH_DECAY * dt);

    const min = Math.min(this.width, this.height);
    const tilt = min * M.TILT * (0.4 + this.turn);
    const vx = this.width / 2 + tilt * Math.sin(this.time * M.TILT_RATE[0] * Math.PI * 2);
    const vy = this.height / 2 + tilt * Math.cos(this.time * M.TILT_RATE[1] * Math.PI * 2);
    const angle = this.dir * (M.BASE_TURN + M.TURN_GAIN * this.turn);

    // The reflection: last frame, inside the rim, shrunk toward the
    // vanishing point and turned. Each frame repeats it, so copies nest.
    const base = ctx.globalAlpha;
    ctx.save();
    this.rimPath(ctx);
    ctx.clip();
    ctx.globalAlpha = base * (M.FLOOR + M.DEPTH * this.reveal);
    ctx.translate(vx, vy);
    ctx.rotate(angle);
    ctx.scale(M.SHRINK, M.SHRINK);
    ctx.translate(-this.width / 2, -this.height / 2);
    this.drawPrevious(ctx);
    ctx.restore();

    // The rim itself, which the next frames carry down the tunnel.
    this.applyStyle(ctx);
    const glow = clamp01(M.RIM_ALPHA + M.RIM_GAIN * Math.max(this.reveal, this.flash));
    ctx.strokeStyle = rgba(this.flash > 0.3 ? this.style.accentColor : this.style.lineColor, glow)
      ?? this.style.lineColor;
    ctx.lineWidth = (this.style.lineWidth ?? 2) * (1 + this.flash);
    this.rimPath(ctx);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}
