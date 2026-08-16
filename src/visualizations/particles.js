import { Visualization } from './base.js';
import { TRIGGER } from '../analyzer.js';

/**
 * ParticleField — drifting particles whose brightness twinkles with treble
 * energy. Bass hits shove every particle outward from the center.
 */
export class ParticleField extends Visualization {
  static id = 'particles';

  static inputs = {
    shove:   { kind: 'event', default: TRIGGER.BASS },
    twinkle: { kind: 'level', default: 'treble' },
  };

  constructor(opts) {
    super(opts);
    this.particles = Array.from({ length: 90 }, () => this.spawn());
  }

  spawn() {
    return {
      x: Math.random() * this.width,
      y: Math.random() * this.height,
      vx: (Math.random() - 0.5) * 12,
      vy: (Math.random() - 0.5) * 12,
      size: 1 + Math.random() * 2.5,
      phase: Math.random() * Math.PI * 2,
    };
  }

  onInput(slot, { strength }) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    for (const p of this.particles) {
      const dx = p.x - cx;
      const dy = p.y - cy;
      const d = Math.hypot(dx, dy) || 1;
      const kick = 60 + strength * 160;
      p.vx += (dx / d) * kick;
      p.vy += (dy / d) * kick;
    }
  }

  draw(ctx, dt) {
    const treble = this.in('twinkle');
    this.applyStyle(ctx);

    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // Drag back toward drift speed after bass kicks.
      p.vx -= p.vx * dt * 1.8;
      p.vy -= p.vy * dt * 1.8;

      // Wrap at edges.
      if (p.x < 0) p.x += this.width;
      if (p.x > this.width) p.x -= this.width;
      if (p.y < 0) p.y += this.height;
      if (p.y > this.height) p.y -= this.height;

      p.phase += dt * (1 + treble * 12);
      const twinkle = 0.45 + 0.55 * Math.sin(p.phase);
      ctx.globalAlpha *= 0.25 + twinkle * (0.3 + treble * 0.45);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (1 + treble), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha /= 0.25 + twinkle * (0.3 + treble * 0.45);
    }
  }
}
