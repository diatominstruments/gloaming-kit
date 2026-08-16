import { Visualization, approach } from './base.js';
import { TRIGGER } from '../analyzer.js';

/**
 * Harmonograph — a damped Lissajous figure, like a pendulum drawing
 * machine. The frequency ratio snaps between musical intervals on snare
 * hits, bass swells the amplitude, and mid energy decides which way the
 * figure twists.
 *
 * Phase is integrated, never assigned. Adding a band level straight into
 * the phase makes the figure lurch forward on a loud frame and snap back
 * on the next quiet one, because the offset is absolute rather than
 * accumulated. Here mid energy sets a signed twist *rate*, so the figure
 * winds, slows, and unwinds continuously.
 */
export class Harmonograph extends Visualization {
  static id = 'harmonograph';
  static inputs = {
    snap:  { kind: 'event', default: TRIGGER.SNARE },
    swell: { kind: 'event', default: TRIGGER.BASS },
    twist: { kind: 'level', default: 'mid' },
    // Smoothing lives in the binding rather than in draw(): the raw band
    // would jitter the figure's scale frame to frame.
    size:  { kind: 'level', default: { band: 'bass', smooth: 0.12 } },
  };

  static RATIOS = [[1, 2], [2, 3], [3, 4], [3, 5], [4, 5], [5, 6]];
  static STEPS = 900;

  static BASE_TWIST = 0.35;    // rad/s of drift when mid sits at its average
  static TWIST_GAIN = 4.5;     // how hard mid deviation pushes the twist rate
  static TWIST_TAU = 0.25;     // seconds for the rate to reach a new target

  constructor(opts) {
    super(opts);
    this.phase = 0;
    this.twist = Harmonograph.BASE_TWIST;
    this.midFast = 0;          // mid, denoised
    this.midSlow = 0;          // mid, slow average it gets compared against
    this.ratioIndex = 1;
    this.morph = 1;            // 0→1 blend into the current ratio after a snap
    this.prevRatio = Harmonograph.RATIOS[0];
    this.swell = 0;
    this.rotation = 0;
  }

  onInput(slot, { strength }) {
    if (slot === 'snap') {
      this.prevRatio = this.currentRatio();
      this.ratioIndex = (this.ratioIndex + 1 + Math.floor(Math.random() * (Harmonograph.RATIOS.length - 1))) % Harmonograph.RATIOS.length;
      this.morph = 0;
    }
    if (slot === 'swell') this.swell = Math.max(this.swell, strength);
  }

  currentRatio() {
    const [p, q] = Harmonograph.RATIOS[this.ratioIndex];
    const m = 1 - Math.pow(1 - this.morph, 3); // ease out
    return [
      this.prevRatio[0] + (p - this.prevRatio[0]) * m,
      this.prevRatio[1] + (q - this.prevRatio[1]) * m,
    ];
  }

  draw(ctx, dt) {
    const { BASE_TWIST, TWIST_GAIN, TWIST_TAU, STEPS } = Harmonograph;

    this.morph = Math.min(1, this.morph + dt * 1.6);
    this.swell = Math.max(0, this.swell - dt * 2);
    this.rotation += dt * 0.1;

    // Mid energy judged against its own recent average: busier-than-usual
    // mids wind the figure forward, quieter-than-usual unwind it. Comparing
    // against a moving average is what lets the twist reverse rather than
    // just varying in speed, and keeps it responsive across loud and quiet
    // sections instead of pinning to one direction in a dense mix.
    const mid = this.in('twist');
    this.midFast = approach(this.midFast, mid, 0.08, dt);
    this.midSlow = approach(this.midSlow, mid, 2.5, dt);
    const targetTwist = BASE_TWIST + (this.midFast - this.midSlow) * TWIST_GAIN;

    // Easing the rate (not the phase) means direction changes arrive as a
    // slowdown and reversal, never as a jump.
    this.twist = approach(this.twist, targetTwist, TWIST_TAU, dt);
    this.phase += this.twist * dt;

    const [p, q] = this.currentRatio();
    const damping = 0.12;
    const cx = this.width / 2;
    const cy = this.height / 2;
    const A = Math.min(this.width, this.height) * (0.3 + this.swell * 0.12 + this.in('size') * 0.06);

    this.applyStyle(ctx);
    const cos = Math.cos(this.rotation);
    const sin = Math.sin(this.rotation);

    ctx.beginPath();
    for (let i = 0; i <= STEPS; i++) {
      const tau = (i / STEPS) * Math.PI * 5;
      const decay = Math.exp(-damping * tau);
      const x = Math.sin(p * tau + this.phase) * decay;
      const y = Math.sin(q * tau) * decay;
      const sx = cx + (x * cos - y * sin) * A;
      const sy = cy + (x * sin + y * cos) * A;
      i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }
}
