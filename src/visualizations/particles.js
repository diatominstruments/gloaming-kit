import { Visualization } from './base.js';
import { TRIGGER } from '../analyzer.js';

/**
 * ParticleField — a field of motes the music shoves around. Bass hits blow
 * every mote outward from the centre; each one then springs back to the point
 * it was quietly drifting toward, so the field breathes with the beat instead
 * of dispersing. Treble makes them shimmer and swell.
 *
 * Two things make or break this one.
 *
 * The shove needs somewhere to return to. A pure outward impulse over a
 * wrapping field has a nasty steady state: the force at any point aims away
 * from the centre, so each axis gets driven to its extreme, and wrapping drops
 * the mote at the opposite extreme where the force immediately pushes it out
 * again. Every mote ends up pinned near an x edge *and* a y edge — the corners
 * — with nothing to pull it back. Anchoring each mote to a slowly drifting
 * home point and springing it back is what keeps the field spread out while
 * still letting a hit throw it a long way.
 *
 * And the motion has to be drawn, not merely happen. A mote is stroked as a
 * short streak along its own velocity, so a bass hit turns the field into a
 * burst of radiating lines that settles back into still dots. A dot that moves
 * and returns within a few frames reads as almost nothing; the streak is what
 * makes the hit legible.
 */
export class ParticleField extends Visualization {
  static id = 'particles';

  static inputs = {
    shove:   { kind: 'event', default: TRIGGER.BASS },
    twinkle: { kind: 'level', default: 'treble' },
  };

  static COUNT = 110;
  // A critically damped spring absorbs an impulse in roughly 1/OMEGA seconds
  // and lets it travel about v/(e*OMEGA) px, so OMEGA sets both how far a hit
  // throws the field and how long it takes to settle. Stiff values swallow
  // the shove before the eye catches it; this is soft enough that the field
  // is still moving when the next beat lands.
  static OMEGA = 3.2;        // spring rate back to the drift point, rad/s
  static SHOVE = 460;        // px/s of outward impulse at full strength
  static SWIRL = 0.35;       // of the shove applied tangentially, so a hit
                             // blooms rather than detonating in a clean ring
  static DRIFT = 16;         // px/s of slow wandering
  static TRAIL = 0.07;       // seconds of motion drawn behind each mote
  static MAX_TRAIL = 110;    // px, so a heavy hit can't streak across the page
  static HEAT_SPEED = 400;   // px/s that counts as "fully lit"; brightness
                             // rides speed so the hit itself is what flashes
  static HOT = 0.45;         // heat above which a mote burns accent-coloured
  static MIN_TRAIL = 0.5;    // px; a round-capped stub is how a still mote
                             // renders as a dot, and zero-length subpaths are
                             // not reliably drawn

  constructor(opts) {
    super(opts);
    this.particles = Array.from({ length: ParticleField.COUNT }, () => this.spawn());
  }

  spawn() {
    const { DRIFT } = ParticleField;
    const x = Math.random() * this.width;
    const y = Math.random() * this.height;
    return {
      x, y,                // live position
      hx: x, hy: y,        // home: where it drifts, and springs back to
      hvx: (Math.random() - 0.5) * DRIFT * 2,
      hvy: (Math.random() - 0.5) * DRIFT * 2,
      vx: 0, vy: 0,
      size: 1 + Math.random() * 2.5,
      phase: Math.random() * Math.PI * 2,
      // Per-mote gain and swirl direction, so a hit scatters the field
      // unevenly instead of moving it as one rigid shell.
      respond: 0.55 + Math.random() * 0.9,
      swirl: Math.random() < 0.5 ? -1 : 1,
      ax: x, ay: y, alpha: 0, lw: 1,   // streak tail + per-mote draw state
    };
  }

  onInput(slot, { strength }) {
    if (slot !== 'shove') return;
    const { SHOVE, SWIRL } = ParticleField;
    const cx = this.width / 2;
    const cy = this.height / 2;

    for (const p of this.particles) {
      const dx = p.x - cx;
      const dy = p.y - cy;
      const d = Math.hypot(dx, dy) || 1;
      const kick = SHOVE * (0.3 + strength * 0.7) * p.respond;
      // Radial, plus a tangential component (the perpendicular of the radial
      // unit vector) to give the burst some rotation.
      p.vx += ((dx / d) + (-dy / d) * SWIRL * p.swirl) * kick;
      p.vy += ((dy / d) + (dx / d) * SWIRL * p.swirl) * kick;
    }
  }

  draw(ctx, dt) {
    const { OMEGA, TRAIL, MAX_TRAIL, MIN_TRAIL, HEAT_SPEED, HOT } = ParticleField;
    const treble = this.in('twinkle');
    const w = this.width;
    const h = this.height;

    // Critically damped spring, closed form: stable at any dt, which matters
    // because the engine hands us up to 100ms after a stall.
    const decay = Math.exp(-OMEGA * dt);

    const baseAlpha = ctx.globalAlpha;   // engine crossfade
    this.applyStyle(ctx);
    ctx.lineCap = 'round';

    const glow = new Path2D();

    for (const p of this.particles) {
      // Home drifts and bounces off the edges. Bouncing rather than wrapping:
      // a wrap would teleport the anchor and snap the mote across the screen.
      p.hx += p.hvx * dt;
      p.hy += p.hvy * dt;
      if (p.hx < 0) { p.hx = 0; p.hvx = Math.abs(p.hvx); }
      else if (p.hx > w) { p.hx = w; p.hvx = -Math.abs(p.hvx); }
      if (p.hy < 0) { p.hy = 0; p.hvy = Math.abs(p.hvy); }
      else if (p.hy > h) { p.hy = h; p.hvy = -Math.abs(p.hvy); }

      let ch = p.x - p.hx;
      let tmp = (p.vx + OMEGA * ch) * dt;
      p.vx = (p.vx - OMEGA * tmp) * decay;
      p.x = p.hx + (ch + tmp) * decay;

      ch = p.y - p.hy;
      tmp = (p.vy + OMEGA * ch) * dt;
      p.vy = (p.vy - OMEGA * tmp) * decay;
      p.y = p.hy + (ch + tmp) * decay;

      // Streak trailing the mote along its own velocity.
      const speed = Math.hypot(p.vx, p.vy);
      let tx = -p.vx * TRAIL;
      let ty = -p.vy * TRAIL;
      const len = Math.hypot(tx, ty);
      if (len > MAX_TRAIL) {
        tx = (tx / len) * MAX_TRAIL;
        ty = (ty / len) * MAX_TRAIL;
      } else if (len < MIN_TRAIL) {
        tx = MIN_TRAIL;
        ty = 0;
      }
      p.ax = p.x + tx;
      p.ay = p.y + ty;

      // Shimmer runs on its own phase so the field doesn't pulse in unison,
      // but treble sets both its rate and its depth — at silence the field is
      // near-still rather than flickering on its own.
      p.phase += dt * (0.6 + treble * 6);
      const shimmer = 0.5 + 0.5 * Math.sin(p.phase);
      // Speed is the loudest term: a shoved mote lights up and dims as it
      // settles, so the flash and the motion are the same event.
      const heat = Math.min(1, speed / HEAT_SPEED);
      p.hot = heat > HOT;
      p.alpha = Math.min(1, 0.18 + shimmer * (0.22 + treble * 0.5) + heat * 0.55);
      p.lw = p.size * (1 + treble * 0.8 + heat * 0.5);

      glow.moveTo(p.ax, p.ay);
      glow.lineTo(p.x, p.y);
    }

    // One blurred pass for the whole field: a glow bed for the price of a
    // single stroke, instead of a blurred draw per mote.
    ctx.globalAlpha = baseAlpha * (0.10 + treble * 0.18);
    ctx.lineWidth = (this.style.lineWidth ?? 2) * 1.6;
    ctx.stroke(glow);

    // Then the motes themselves, sharp, each at its own brightness. The ones
    // still carrying a hit burn accent-coloured, so a bass beat scatters
    // sparks through the field rather than just nudging it.
    ctx.shadowBlur = 0;
    const accent = this.style.accentColor ?? this.style.lineColor;
    for (const p of this.particles) {
      ctx.strokeStyle = p.hot ? accent : this.style.lineColor;
      ctx.globalAlpha = baseAlpha * p.alpha;
      ctx.lineWidth = p.lw;
      ctx.beginPath();
      ctx.moveTo(p.ax, p.ay);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    ctx.globalAlpha = baseAlpha;
  }
}
