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
 * Shape comes from midpoint displacement (see `subdivide`) rather than a
 * step-by-step random walk. A walk that nudges its heading each step traces
 * smooth curves — it reads as a vein, not a bolt. Subdivision instead keeps
 * long straight runs and breaks them with hard corners, which is what makes
 * lightning look like lightning.
 *
 * Not every hit gets a bolt. Strikes are gated on strength and held apart by
 * a refractory period, because a bolt per drum hit reads as a strobe with no
 * relationship to the music; sub-threshold hits flicker the existing bolts
 * instead. See STRIKE_THRESHOLD / REFRACTORY_SECONDS.
 *
 * Performance note — the shape this replaced walked a recursive tree every
 * frame and issued a stroke per limb (~500 blurred strokes/frame). Here the
 * geometry is built once per strike and drawn as one batched path per tier,
 * with glow confined to the main channel: a handful of strokes per frame
 * regardless of how intricate the bolt is.
 */

/**
 * Midpoint displacement. Split every segment, kick each new midpoint out
 * along the segment's perpendicular, then shrink the kick and go again. Each
 * pass doubles the segment count, so `passes` is a detail level, and
 * `roughness` below 0.5 smooths the result while above it keeps the small
 * kinks sharp relative to the large ones.
 */
const subdivide = (pts, displace, passes, roughness) => {
  for (let p = 0; p < passes; p++) {
    const next = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const off = (Math.random() * 2 - 1) * displace;
      next.push({ x: (a.x + b.x) / 2 - (dy / len) * off, y: (a.y + b.y) / 2 + (dx / len) * off });
      next.push(b);
    }
    pts = next;
    displace *= roughness;
  }
  return pts;
};

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
  static ROUGHNESS = 0.55;        // >0.5 keeps fine kinks sharp; 0.5 halves them
  static PASSES = 5;              // main channel detail; 2^PASSES segments

  // --- firing rate (tune these by ear) ---
  static STRIKE_THRESHOLD = 0.35;   // trigger strength needed for a real bolt;
                                    // weaker hits only flicker what's lit
  static REFRACTORY_SECONDS = 0.4;  // hard floor on the gap between bolts, so a
                                    // busy drum pattern can't become a strobe
  static IDLE_STRIKE_SECONDS = 5;   // last-resort strike so a long quiet
                                    // passage isn't an empty screen

  constructor(opts) {
    super(opts);
    this.bolts = [];
    this.flicker = 0;
    this.flash = 0;
    this.sinceStrike = 0;
  }

  onInput(slot, { strength }) {
    if (slot === 'flicker') {
      // Too frequent to spawn geometry for — brighten what's already lit.
      this.flicker = Math.max(this.flicker, 0.5 + strength * 0.5);
      return;
    }
    if (slot !== 'strike' && slot !== 'offshoot') return;

    const { STRIKE_THRESHOLD, REFRACTORY_SECONDS } = Lightning;
    if (strength < STRIKE_THRESHOLD || this.sinceStrike < REFRACTORY_SECONDS) {
      // Rejected hits aren't discarded: they glow the sky instead of adding
      // another bolt, so the small hits still register without the screen
      // filling up and hiding which hits actually mattered.
      this.flicker = Math.max(this.flicker, 0.3 + strength * 0.4);
      return;
    }

    if (slot === 'strike') {
      this.strike(strength, 1);
      this.flash = Math.max(this.flash, 0.5 + strength * 0.5);
    } else {
      this.strike(strength, 0.55);
    }
  }

  /** Generate one bolt's full geometry and push it onto the live list. */
  strike(strength, reach) {
    const { MAX_BOLTS, TIERS, MAX_SEGMENTS, ROUGHNESS, PASSES } = Lightning;
    const w = this.width;
    const h = this.height;

    const jag = 0.10 + this.in('wander') * 0.16;      // displacement / length
    const forkChance = 0.10 + this.in('fork') * 0.16;

    // Bucketed by tier so drawing never has to filter. Each entry is one
    // polyline; points carry cumulative distance from the strike origin, which
    // is what the growth frontier cuts against.
    const byTier = Array.from({ length: TIERS }, () => []);
    let count = 0;
    let maxDist = 0;

    const emit = (x0, y0, heading, length, tier, startDist) => {
      if (tier >= TIERS || count >= MAX_SEGMENTS) return;

      const pts = subdivide(
        [
          { x: x0, y: y0 },
          { x: x0 + Math.cos(heading) * length, y: y0 + Math.sin(heading) * length },
        ],
        length * jag,
        tier === 0 ? PASSES : PASSES - 2,
        ROUGHNESS,
      );

      let dist = startDist;
      pts[0].dist = dist;
      for (let i = 1; i < pts.length; i++) {
        dist += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        pts[i].dist = dist;
      }
      if (dist > maxDist) maxDist = dist;
      count += pts.length - 1;
      byTier[tier].push(pts);

      // Fork off interior vertices, angled away from the local direction of
      // travel so a branch leaves at a corner rather than peeling off a curve.
      const chance = tier === 0 ? forkChance : forkChance * 0.4;
      for (let i = 1; i < pts.length - 1; i++) {
        if (Math.random() >= chance) continue;
        const local = Math.atan2(pts[i + 1].y - pts[i - 1].y, pts[i + 1].x - pts[i - 1].x);
        const off = (Math.random() < 0.5 ? -1 : 1) * (0.45 + Math.random() * 0.75);
        emit(pts[i].x, pts[i].y, local + off, length * (0.25 + Math.random() * 0.25), tier + 1, pts[i].dist);
      }
    };

    emit(w * (0.12 + Math.random() * 0.76), -h * 0.03, Math.PI / 2, h * reach * 1.05, 0, 0);

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
    // Butt caps and mitered joins: round ones bevel every corner off, which is
    // what turned the old bolts into smooth tubes. miterLimit keeps a near
    // doubling-back from throwing a long spike.
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 3;

    for (const b of this.bolts) {
      const frontier = b.progress * b.maxDist;
      const bright = (b.progress < 1 ? 1 : b.life) * (0.7 + this.flicker * 0.3);
      let headX = 0;
      let headY = 0;

      for (let tier = 0; tier < TIERS; tier++) {
        ctx.beginPath();
        let drawn = 0;

        for (const pts of b.byTier[tier]) {
          if (pts[0].dist > frontier) continue;   // charge hasn't reached this fork
          ctx.moveTo(pts[0].x, pts[0].y);
          let lx = pts[0].x;
          let ly = pts[0].y;

          for (let i = 1; i < pts.length; i++) {
            const p = pts[i];
            if (p.dist > frontier) {
              // Cut the segment at the frontier so the tip advances smoothly
              // rather than popping a whole segment into existence.
              const q = pts[i - 1];
              const span = p.dist - q.dist;
              const t = span > 0 ? (frontier - q.dist) / span : 0;
              lx = q.x + (p.x - q.x) * t;
              ly = q.y + (p.y - q.y) * t;
              ctx.lineTo(lx, ly);
              break;
            }
            ctx.lineTo(p.x, p.y);
            lx = p.x;
            ly = p.y;
          }

          if (tier === 0) { headX = lx; headY = ly; }
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
