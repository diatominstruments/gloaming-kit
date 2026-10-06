import { Visualization, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';

/**
 * RadialBurst — trigger-driven. Bass hits launch expanding rings from the
 * center; hihat hits scatter short radial ticks around the rim. Ring speed
 * and tick count scale with each hit's impact — how prominent it is, scaled
 * by how loud the band is — so a quiet passage still rings, just smaller.
 */
export class RadialBurst extends Visualization {
  static id = 'radial-burst';
  static label = 'Radial Burst';
  static description = 'Hits launch expanding rings and scatter ticks around a breathing core.';
  static category = CATEGORY.CLASSIC;
  static inputs = {
    ring:    { kind: 'event', default: TRIGGER.BASS },
    scatter: { kind: 'event', default: TRIGGER.HIHAT },
    core:    { kind: 'level', default: { relative: 'bass' } },
  };

  static TICKS = 6;        // ticks per scatter hit, before impact adds more
  static FADE = 1.4;       // ring fade, per second
  static options = {
    speed: { kind: 'number', default: 1, min: 0.25, max: 3, step: 0.05 },
    ticks: { kind: 'number', default: RadialBurst.TICKS, min: 0, max: 30, step: 1 },
    fade:  { kind: 'number', default: RadialBurst.FADE, min: 0.3, max: 5, step: 0.1 },
  };

  constructor(opts) {
    super(opts);
    this.speed = this.option('speed');
    this.tickCount = this.option('ticks');
    this.fade = this.option('fade');
    this.rings = []; // { r, speed, life, k }
    this.ticks = []; // { angle, dist, life }
  }

  onInput(slot, data) {
    const strength = impact(data);
    if (slot === 'ring') {
      this.rings.push({ r: 10, speed: (220 + strength * 380) * this.speed, life: 1, k: strength });
    } else if (slot === 'scatter') {
      const count = this.tickCount + Math.round(strength * 10);
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
      ring.life -= dt * this.fade;
      if (ring.life <= 0) continue;
      // A ring from a hard hit is drawn in the peak colour.
      ctx.strokeStyle = this.peak(this.style.lineColor, ring.k);
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
