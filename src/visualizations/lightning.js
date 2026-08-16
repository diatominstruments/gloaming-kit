import { Visualization } from './base.js';
import { TRIGGER } from '../analyzer.js';

/**
 * Lightning — branching bolts that strike on the beat and grow outward from
 * the point of impact. Bass fires a full-height strike, snare a shorter
 * offshoot, and hihats flicker whatever is still burning. Mid energy widens
 * the wander of each channel; high-mid energy makes it fork more.
 *
 * Growth is the whole effect: a bolt's geometry is generated in one shot at
 * strike time, then revealed by an advancing distance frontier, so the fork
 * points light up in the order the charge would actually reach them.
 *
 * Performance note — the shape this replaced walked a recursive tree every
 * frame and issued a stroke per limb (~500 blurred strokes/frame). Here the
 * geometry is built once per strike and drawn as one batched path per tier,
 * with glow confined to the main channel: a handful of strokes per frame
 * regardless of how intricate the bolt is.
 */
export class Lightning extends Visualization {
  static id = 'lightning';
  static inputs = {
    strike:   { kind: 'event', default: TRIGGER.BASS },
    offshoot: { kind: 'event', default: TRIGGER.SNARE },
    flicker:  { kind: 'event', default: TRIGGER.HIHAT },
    wander:   { kind: 'level', default: 'mid' },
    fork:     { kind: 'level', default: 'highMid' },
  };

  static MAX_BOLTS = 6;
  static TIERS = 3;               // main channel, fork, twig
  static GROW_SECONDS = 0.12;     // strike-to-full time; short is what sells it
  static FADE_SECONDS = 0.5;
  static MAX_SEGMENTS = 240;      // per bolt, guards against fork blowup
  static IDLE_STRIKE_SECONDS = 1.6;

  constructor(opts) {
    super(opts);
    this.bolts = [];
    this.flicker = 0;
    this.flash = 0;
    this.sinceStrike = 0;
  }

  onInput(slot, { strength }) {
    if (slot === 'strike') {
      this.strike(strength, 1);
      this.flash = Math.max(this.flash, 0.5 + strength * 0.5);
    } else if (slot === 'offshoot') {
      this.strike(strength, 0.55);
    } else if (slot === 'flicker') {
      // Too frequent to spawn geometry for — brighten what's already lit.
      this.flicker = Math.max(this.flicker, 0.5 + strength * 0.5);
    }
  }

  /** Generate one bolt's full geometry and push it onto the live list. */
  strike(strength, reach) {
    const { MAX_BOLTS, TIERS, MAX_SEGMENTS } = Lightning;
    const w = this.width;
    const h = this.height;

    const wander = 0.22 + this.in('wander') * 0.5;
    const forkChance = 0.14 + this.in('fork') * 0.22;

    // Bucketed by tier so drawing never has to filter, and sorted by
    // distance-from-origin so the growth frontier is a break, not a scan.
    const byTier = Array.from({ length: TIERS }, () => []);
    let count = 0;
    let maxDist = 0;

    const walk = (x0, y0, heading, length, tier, startDist) => {
      const steps = tier === 0 ? 24 : 9;
      const stepLen = length / steps;
      let x = x0;
      let y = y0;
      let angle = heading;
      let dist = startDist;

      for (let i = 0; i < steps; i++) {
        if (count >= MAX_SEGMENTS) return;
        // Random walk, pulled back toward the channel's heading so a bolt
        // jitters hard without ever losing its overall direction.
        angle += (Math.random() * 2 - 1) * (tier === 0 ? wander : wander * 1.6);
        angle += (heading - angle) * 0.3;

        const nx = x + Math.cos(angle) * stepLen;
        const ny = y + Math.sin(angle) * stepLen;
        dist += Math.hypot(nx - x, ny - y);

        byTier[tier].push({ x1: x, y1: y, x2: nx, y2: ny, dist });
        count++;
        if (dist > maxDist) maxDist = dist;
        x = nx;
        y = ny;

        const forks = tier === 0 ? forkChance : forkChance * 0.4;
        if (tier < TIERS - 1 && Math.random() < forks) {
          const off = (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.7);
          walk(x, y, angle + off, length * (0.28 + Math.random() * 0.24), tier + 1, dist);
        }
      }
    };

    walk(w * (0.12 + Math.random() * 0.76), -h * 0.03, Math.PI / 2, h * reach * 1.05, 0, 0);
    for (const tier of byTier) tier.sort((a, b) => a.dist - b.dist);

    this.bolts.push({ byTier, maxDist, progress: 0, life: 1, strength });
    if (this.bolts.length > MAX_BOLTS) this.bolts.shift();
    this.sinceStrike = 0;
  }

  draw(ctx, dt) {
    const { TIERS, GROW_SECONDS, FADE_SECONDS, IDLE_STRIKE_SECONDS } = Lightning;

    this.flicker = Math.max(0, this.flicker - dt * 4);
    this.flash = Math.max(0, this.flash - dt * 3.5);
    this.sinceStrike += dt;

    // Keep the sky alive through quiet passages.
    if (this.sinceStrike > IDLE_STRIKE_SECONDS) this.strike(0.3, 0.7);

    for (const b of this.bolts) {
      if (b.progress < 1) b.progress = Math.min(1, b.progress + dt / GROW_SECONDS);
      else b.life -= dt / FADE_SECONDS;
    }
    this.bolts = this.bolts.filter((b) => b.life > 0);

    const baseAlpha = ctx.globalAlpha;   // engine crossfade
    const lineColor = this.style.lineColor;
    const accent = this.style.accentColor ?? lineColor;
    const glow = this.style.shadowBlur ?? 0;

    // Full-frame flash on the heaviest hits.
    if (this.flash > 0) {
      ctx.globalAlpha = baseAlpha * this.flash * 0.14;
      ctx.fillStyle = accent;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    this.applyStyle(ctx);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const b of this.bolts) {
      const frontier = b.progress * b.maxDist;
      const bright = (b.progress < 1 ? 1 : b.life) * (0.7 + this.flicker * 0.3);
      let headX = 0;
      let headY = 0;

      for (let tier = 0; tier < TIERS; tier++) {
        const segs = b.byTier[tier];
        ctx.beginPath();
        let drawn = 0;
        for (const s of segs) {
          if (s.dist > frontier) break;   // sorted: everything after is unborn
          ctx.moveTo(s.x1, s.y1);
          ctx.lineTo(s.x2, s.y2);
          if (tier === 0) { headX = s.x2; headY = s.y2; }
          drawn++;
        }
        if (drawn === 0) continue;

        const taper = 1 - tier / TIERS;
        const width = Math.max(0.5, (this.style.lineWidth ?? 2) * taper * 1.4);

        // Glow only on the main channel — a blurred stroke costs a full pass
        // over its bounding box, so the twigs pay flat cost instead.
        ctx.shadowBlur = tier === 0 ? glow : 0;
        ctx.strokeStyle = lineColor;
        ctx.globalAlpha = baseAlpha * bright * (0.35 + taper * 0.65);
        ctx.lineWidth = width;
        ctx.stroke();

        // stroke() keeps the current path, so the hot core is a restyled
        // re-stroke rather than a second path build.
        if (tier === 0) {
          ctx.shadowBlur = 0;
          ctx.strokeStyle = accent;
          ctx.globalAlpha = baseAlpha * bright;
          ctx.lineWidth = Math.max(0.5, width * 0.4);
          ctx.stroke();
        }
      }

      // Bright head while the bolt is still travelling.
      if (b.progress < 1) {
        ctx.shadowBlur = glow;
        ctx.shadowColor = accent;
        ctx.fillStyle = accent;
        ctx.globalAlpha = baseAlpha * bright;
        ctx.beginPath();
        ctx.arc(headX, headY, 2 + b.strength * 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.shadowBlur = 0;
    ctx.globalAlpha = baseAlpha;
  }
}
