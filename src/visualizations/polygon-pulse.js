import { Visualization, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';

/**
 * PolygonPulse — a rotating polygon whose radius pulses with the bass and
 * whose side count follows how loud the mids are. Snare hits kick the
 * rotation. `energy` — overall loudness — sets how hard all of it goes: the
 * idle spin and the depth of the pulse, so a quiet passage still pulses on
 * the beat, just gently.
 */
export class PolygonPulse extends Visualization {
  static id = 'polygon-pulse';
  static label = 'Polygon Pulse';
  static description = 'Rotating polygon whose radius pulses and side count morphs; hits kick the spin.';
  static category = CATEGORY.CLASSIC;
  static inputs = {
    kick:   { kind: 'event', default: TRIGGER.SNARE },
    punch:  { kind: 'event', default: TRIGGER.BASS },
    sides:  { kind: 'level', default: { intensity: 'mid' } },
    swell:  { kind: 'level', default: { relative: 'bass' } },
    energy: { kind: 'level', default: { intensity: 'rms' } },
  };

  constructor(opts) {
    super(opts);
    this.rotation = 0;
    this.spin = 0.3;     // rad/s, decays back to base after snare kicks
    this.punch = 0;      // extra radius from bass hits, decays fast
  }

  onInput(slot, data) {
    const strength = impact(data);
    if (slot === 'kick') this.spin += (Math.random() < 0.5 ? -1 : 1) * (2 + strength * 4);
    if (slot === 'punch') this.punch = Math.max(this.punch, strength);
  }

  draw(ctx, dt) {
    const cx = this.width / 2;
    const cy = this.height / 2;

    const energy = this.in('energy');
    const idleSpin = 0.15 + energy * 0.5;
    this.spin += (idleSpin - this.spin) * dt * 2;
    this.rotation += this.spin * dt;
    this.punch = Math.max(0, this.punch - dt * 3);

    const sides = 3 + Math.round(this.in('sides') * 6);
    const base = Math.min(this.width, this.height) * 0.22;
    const depth = 0.4 + energy * 0.6;
    const r = base * (1 + this.in('swell') * 0.35 * depth + this.punch * 0.5);

    this.applyStyle(ctx);
    // Concentric copies for depth: outline, then a smaller accent echo.
    for (const [radius, color] of [[r, this.style.lineColor], [r * 0.62, this.style.accentColor ?? this.style.lineColor]]) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let i = 0; i <= sides; i++) {
        const a = this.rotation + (i / sides) * Math.PI * 2;
        const x = cx + Math.cos(a) * radius;
        const y = cy + Math.sin(a) * radius;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
}
