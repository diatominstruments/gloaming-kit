import { Visualization } from './base.js';
import { TRIGGER } from '../analyzer.js';

/**
 * Starfield — classic fly-through. Stars stream past the viewer with
 * motion streaks; bass hits make the stars swell.
 *
 * Cruise speed is deliberately constant. Reacting to loudness made the
 * field surge and stall frame to frame, which reads as jerky rather than
 * energetic; the audio drives star size instead.
 */
export class Starfield extends Visualization {
  static id = 'starfield';

  static inputs = {
    swell: { kind: 'event', default: TRIGGER.BASS },
  };

  static SPEED = 0.5;   // depth units per second

  constructor(opts) {
    super(opts);
    this.stars = Array.from({ length: 240 }, () => this.spawn(Math.random()));
    this.sizeBoost = 0;
  }

  spawn(z = 1) {
    return {
      x: (Math.random() * 2 - 1),
      y: (Math.random() * 2 - 1),
      z,
    };
  }

  onInput(slot, { strength }) {
    if (slot === 'swell') this.sizeBoost = Math.max(this.sizeBoost, strength);
  }

  draw(ctx, dt) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    const focal = Math.min(this.width, this.height) * 0.5;

    this.sizeBoost = Math.max(0, this.sizeBoost - dt * 2.2);

    this.applyStyle(ctx);
    ctx.shadowBlur = 0; // hundreds of dots — glow here costs too much

    for (const s of this.stars) {
      const prevZ = s.z;
      s.z -= Starfield.SPEED * dt;
      if (s.z <= 0.03) {
        Object.assign(s, this.spawn(1));
        continue;
      }

      const sx = cx + (s.x * focal) / s.z;
      const sy = cy + (s.y * focal) / s.z;
      if (sx < 0 || sx > this.width || sy < 0 || sy > this.height) {
        Object.assign(s, this.spawn(1));
        continue;
      }

      const depth = 1 - s.z;                       // 0 far → 1 near
      const size = (0.4 + depth * 2.6) * (1 + this.sizeBoost * 5.4);
      ctx.globalAlpha *= Math.min(1, 0.15 + depth * 1.1);

      // Motion streak from previous position; longer when moving fast.
      const px = cx + (s.x * focal) / prevZ;
      const py = cy + (s.y * focal) / prevZ;
      ctx.lineWidth = size;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(sx, sy);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(sx, sy, size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha /= Math.min(1, 0.15 + depth * 1.1);
    }
    ctx.lineWidth = this.style.lineWidth ?? 2;
  }
}
