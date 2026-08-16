import { Visualization } from './base.js';
import { TRIGGER } from '../analyzer.js';

/**
 * RadialBurst — trigger-driven. Bass hits launch expanding rings from the
 * center; hihat hits scatter short radial ticks around the rim. Ring size
 * and tick count scale with hit strength.
 */
export class RadialBurst extends Visualization {
  static id = 'radial-burst';
  static inputs = {
    ring:    { kind: 'event', default: TRIGGER.BASS },
    scatter: { kind: 'event', default: TRIGGER.HIHAT },
    core:    { kind: 'level', default: 'bass' },
  };

  constructor(opts) {
    super(opts);
    this.rings = []; // { r, speed, life }
    this.ticks = []; // { angle, dist, life }
  }

  onInput(slot, { strength }) {
    if (slot === 'ring') {
      this.rings.push({ r: 10, speed: 220 + strength * 380, life: 1 });
    } else if (slot === 'scatter') {
      const count = 6 + Math.round(strength * 10);
      for (let i = 0; i < count; i++) {
        this.ticks.push({
          angle: Math.random() * Math.PI * 2,
          dist: Math.min(this.width, this.height) * (0.28 + Math.random() * 0.14),
          life: 1,
        });
      }
    }
  }

  draw(ctx, dt) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    this.applyStyle(ctx);

    // Steady center circle that breathes with bass energy.
    const baseR = Math.min(this.width, this.height) * (0.06 + this.in('core') * 0.08);
    ctx.beginPath();
    ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
    ctx.stroke();

    for (const ring of this.rings) {
      ring.r += ring.speed * dt;
      ring.life -= dt * 1.4;
      if (ring.life <= 0) continue;
      ctx.globalAlpha *= Math.max(0, ring.life);
      ctx.beginPath();
      ctx.arc(cx, cy, ring.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha /= Math.max(0, ring.life);
    }
    this.rings = this.rings.filter((r) => r.life > 0);

    ctx.strokeStyle = this.style.accentColor ?? this.style.lineColor;
    for (const tick of this.ticks) {
      tick.life -= dt * 5;
      if (tick.life <= 0) continue;
      const len = 10 + tick.life * 14;
      const x1 = cx + Math.cos(tick.angle) * tick.dist;
      const y1 = cy + Math.sin(tick.angle) * tick.dist;
      ctx.globalAlpha *= Math.max(0, tick.life);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 + Math.cos(tick.angle) * len, y1 + Math.sin(tick.angle) * len);
      ctx.stroke();
      ctx.globalAlpha /= Math.max(0, tick.life);
    }
    this.ticks = this.ticks.filter((t) => t.life > 0);
  }
}
