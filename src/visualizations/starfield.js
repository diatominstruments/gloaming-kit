import { Visualization, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';

/**
 * Starfield — classic fly-through. Stars stream past the viewer with
 * motion streaks; hits (onsets by default) make the stars swell.
 *
 * Cruise speed is deliberately constant. Reacting to loudness made the
 * field surge and stall frame to frame, which reads as jerky rather than
 * energetic; the audio drives star size instead.
 *
 * Options:
 *   count, speed   how many stars, and how fast the field flies
 *   streak         how long each star's motion streak is, as a multiple of
 *                  one frame's travel; 0 draws bare dots (default 1)
 *   spread         how far the stars scatter from the line of flight; small
 *                  is a narrow stream straight ahead, large a wide field
 *                  that mostly flashes past the edges (default 1)
 */
export class Starfield extends Visualization {
  static id = 'starfield';
  static label = 'Starfield';
  static description = 'Fly-through with motion streaks; hits swell the stars.';
  static category = CATEGORY.MOTION;

  static inputs = {
    swell: { kind: 'event', default: TRIGGER.ONSET },
  };

  static SPEED = 0.5;   // depth units per second
  static COUNT = 240;

  static options = {
    count: { kind: 'number', default: Starfield.COUNT, min: 50, max: 1500, step: 10 },
    speed: { kind: 'number', default: Starfield.SPEED, min: 0.1, max: 3, step: 0.05 },
    streak: { kind: 'number', default: 1, min: 0, max: 12, step: 0.5 },
    spread: { kind: 'number', default: 1, min: 0.1, max: 3, step: 0.05 },
  };

  constructor(opts) {
    super(opts);
    this.speed = this.option('speed');
    this.streak = this.option('streak');
    this.spread = this.option('spread');
    this.stars = Array.from({ length: this.option('count') }, () => this.spawn(this.random()));
    this.sizeBoost = 0;
  }

  spawn(z = 1) {
    return {
      x: (this.random() * 2 - 1) * this.spread,
      y: (this.random() * 2 - 1) * this.spread,
      z,
    };
  }

  onInput(slot, data) {
    if (slot === 'swell') this.sizeBoost = Math.max(this.sizeBoost, impact(data));
  }

  draw(ctx, dt) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    const focal = Math.min(this.width, this.height) * 0.5;

    this.sizeBoost = Math.max(0, this.sizeBoost - dt * 2.2);

    this.applyStyle(ctx);
    ctx.shadowBlur = 0; // hundreds of dots — glow here costs too much
    // The whole field takes the peak colour while a hard hit's swell lasts.
    ctx.strokeStyle = ctx.fillStyle = this.peak(this.style.lineColor, this.sizeBoost);

    for (const s of this.stars) {
      const prevZ = s.z;
      s.z -= this.speed * dt;
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

      // Motion streak back toward where it was `streak` frames ago; longer
      // the nearer and faster the star.
      if (this.streak > 0) {
        const tailZ = s.z + (prevZ - s.z) * this.streak;
        const px = cx + (s.x * focal) / tailZ;
        const py = cy + (s.y * focal) / tailZ;
        ctx.lineWidth = size;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(sx, sy);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(sx, sy, size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha /= Math.min(1, 0.15 + depth * 1.1);
    }
    ctx.lineWidth = this.style.lineWidth ?? 2;
  }
}
