import { Visualization, approach, clamp01, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { LAYER } from './layers.js';
import { TRIGGER } from '../analyzer.js';
import { mulberry32 } from '../noise.js';
import { mixColor, rgba } from '../style.js';
import { glyphOption, readGlyph, radialProfile, STAR } from './glyph.js';

/**
 * GlyphCrystal — the drawing as a crystal habit. Its silhouette, seen from
 * its centre, becomes the speed a crystal grows in each direction: a cross
 * grows as a four-pointed star, a ring as a disc, a diagonal stroke as a
 * long lozenge. Seeds land across the screen and grow outward at that
 * shape, each at its own turn, and where two fronts meet they stop — so the
 * screen tessellates into cells whose every edge is where two of the
 * drawing's shapes collided. Nothing is ever drawn but fronts.
 *
 * Growth is recorded by painting under what is already there: a pixel keeps
 * whichever front reached it first, which is exactly the tessellation rule,
 * and the colour of the moment it was reached stays in it. So each crystal
 * carries rings — a bright nucleus fading outward, hue turning as it grows,
 * and a bright band for every hit that landed while it grew, which every
 * crystal on screen growing at that moment records. When the screen is
 * full, a new generation seeds on top of the old and grows over it.
 *
 *   seed   a hit: new seeds land, and a bright ring is laid in every
 *          growing crystal
 *   grow   how fast the fronts advance
 *   glow   how brightly the live fronts shine
 *
 * Options:
 *   glyph  the drawing
 *   size   'small' | 'med' | 'large' — how many seeds a generation gets, so
 *          how big its cells end up
 *   grain  'rings' (default) or 'flat' (one colour per crystal)
 *   edges  'smooth' (default) or 'faceted' (straight-sided habits)
 */
export class GlyphCrystal extends Visualization {
  static id = 'glyph-crystal';
  static label = 'Glyph Crystal';
  static description = 'Crystals shaped by the drawing\'s silhouette grow from scattered seeds until they meet, tessellating the screen; hits seed more and ring every crystal.';
  static category = CATEGORY.GLYPHS;
  static layer = LAYER.BACKGROUND;
  static inputs = {
    seed: { kind: 'event', default: TRIGGER.BASS },
    grow: { kind: 'level', default: { intensity: 'mid' } },
    glow: { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
    } },
  };
  static SIZES = { small: { cap: 110, rate: 3.2, gap: 0.05, speed: 0.8 },
                   med:   { cap: 42,  rate: 1.5, gap: 0.1,  speed: 1 },
                   large: { cap: 16,  rate: 0.7, gap: 0.18, speed: 1.3 } };
  static options = {
    glyph: glyphOption({ width: 9, height: 9, value: STAR }),
    size:  { kind: 'enum', values: ['small', 'med', 'large'], default: 'med' },
    grain: { kind: 'enum', values: ['rings', 'flat'], default: 'rings' },
    edges: { kind: 'enum', values: ['smooth', 'faceted'], default: 'smooth' },
    nucleus: { kind: 'number', default: 0.12, min: 0.03, max: 0.4, step: 0.01 },
    hueRate: { kind: 'number', default: 0.9, min: 0, max: 3, step: 0.05 },
  };

  static RATE = 0.1;          // front speed, of the smaller dimension per second, at full grow
  static BASE_GROW = 0.35;    // of RATE at silence
  static GROW_TAU = 0.4;
  static HIT_GROW = 0.8;      // extra speed at a full hit, briefly
  static HIT_DECAY = 5;       // per second
  static NUCLEUS = 0.12;      // of the smaller dimension; radius over which the bright core fades
  static CORE = 0.85;         // brightness at the nucleus
  static BODY = 0.15;         // brightness far out
  static HUE_RATE = 0.9;      // radians of hue turn per nucleus radius grown
  static FLASH = 0.5;         // extra brightness of a hit's ring
  static FLASH_DECAY = 14;    // per second; thin rings
  static VEIL = 0.45;         // how far a finished generation sinks toward the background
  static FRONT_ALPHA = 0.1;   // live front stroke at silence
  static FRONT_GAIN = 0.7;
  static GLOW_TAU = 0.3;
  static OVERLAP = 1.5;       // px the annulus reaches back over last frame's edge
  static PROBE = 48;          // coverage probe width, px
  static PROBE_EVERY = 0.4;   // seconds
  static FULL = 0.995;        // coverage at which a generation is finished
  static MAX_AGE = 70;        // seconds before a generation is replaced regardless

  constructor(opts) {
    super(opts);
    const G = GlyphCrystal;
    this.glyph = readGlyph(this);
    this.size = this.option('size');
    this.nucleus = this.option('nucleus');   // radius over which the bright core fades
    this.hueRate = this.option('hueRate');   // hue turn per nucleus radius grown
    this.rings = this.options.grain !== 'flat';
    const faceted = this.options.edges === 'faceted';
    this.profile = radialProfile(this.glyph, faceted ? { n: 14, kappa: 10 } : { n: 72, kappa: 14 });
    this.rand = mulberry32(((Date.now() % 100000) + 1) | 0);
    this.generations = [];
    this.probe = document.createElement('canvas');
    this.probeCtx = this.probe.getContext('2d', { willReadFrequently: true });
    this.sinceProbe = 0;
    this.spawnDebt = 0;
    this.grow = 0;
    this.glow = 0;
    this.kick = 0;
    this.flash = 0;
    this.allocate();
  }

  resize(width, height) {
    super.resize(width, height);
    this.allocate();
  }

  allocate() {
    // A resize clears the canvases, so start over.
    this.generations = [];
    this.newGeneration();
    const G = GlyphCrystal;
    this.probe.width = G.PROBE;
    this.probe.height = Math.max(1, Math.round(G.PROBE * this.height / this.width));
  }

  newGeneration() {
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(this.width * dpr));
    canvas.height = Math.max(1, Math.round(this.height * dpr));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'destination-over';
    this.generations.push({ canvas, ctx, crystals: [], age: 0, coverage: 0, seeded: 0 });
  }

  onInput(slot, data) {
    if (slot === 'seed') {
      const k = impact(data);
      this.kick = Math.max(this.kick, k);
      this.flash = Math.max(this.flash, k);
      this.spawnDebt += 1 + 2 * k;
    }
  }

  /** Drop a seed somewhere not too close to the others in the current generation. */
  plant(gen) {
    const { gap } = GlyphCrystal.SIZES[this.size];
    const min = gap * Math.min(this.width, this.height);
    let best = null;
    let bestD = -1;
    for (let tries = 0; tries < 6; tries++) {
      const x = this.rand() * this.width;
      const y = this.rand() * this.height;
      let d = Infinity;
      for (const c of gen.crystals) d = Math.min(d, Math.hypot(c.x - x, c.y - y));
      if (d > bestD) { bestD = d; best = { x, y }; }
      if (d >= min) break;
    }
    const n = this.profile.length;
    gen.crystals.push({
      x: best.x, y: best.y, r: 0, last: 0,
      turn: (this.rand() * n) | 0, flip: this.rand() < 0.5,
      phase: this.rand() * Math.PI * 2,
      tone: 0.4 + 0.5 * this.rand(),     // 'flat': fixed brightness
    });
    gen.seeded++;
  }

  /** The habit at radius r (and r0 inside it, for an annulus) as a path. */
  annulus(c, r0, r1) {
    const p = this.profile;
    const n = p.length;
    const path = new Path2D();
    for (const [r, dir] of [[r1, 1], [r0, -1]]) {
      if (r <= 0) continue;
      for (let i = 0; i < n; i++) {
        const j = dir > 0 ? i : n - 1 - i;
        const a = (j / n) * Math.PI * 2;
        const k = c.flip ? (n - j + c.turn) % n : (j + c.turn) % n;
        const rr = r * p[k];
        const x = c.x + Math.cos(a) * rr;
        const y = c.y + Math.sin(a) * rr;
        if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
      }
      path.closePath();
    }
    return path;
  }

  /** Colour of the ring a crystal lays at radius r. */
  ringColor(c, r) {
    const G = GlyphCrystal;
    const s = this.style;
    const line = s.lineColor;
    const accent = s.accentColor ?? line;
    const bg = s.background;
    if (!this.rings) return mixColor(bg, mixColor(line, accent, 0.5 + 0.5 * Math.sin(c.phase)), c.tone);
    const nucleus = this.nucleus * Math.min(this.width, this.height);
    const hue = 0.5 + 0.5 * Math.sin(c.phase + (r / nucleus) * this.hueRate);
    const bright = clamp01(G.BODY + (G.CORE - G.BODY) * Math.exp(-r / nucleus) + G.FLASH * this.flash);
    // The band a hard hit lays is in the peak colour, and stays in the crystal.
    return this.peak(mixColor(bg, mixColor(line, accent, hue), bright), this.flash);
  }

  measureCoverage(gen) {
    const pc = this.probeCtx;
    const { width: w, height: h } = this.probe;
    pc.clearRect(0, 0, w, h);
    pc.drawImage(gen.canvas, 0, 0, w, h);
    const data = pc.getImageData(0, 0, w, h).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 200) n++;
    gen.coverage = n / (w * h);
  }

  draw(ctx, dt) {
    const G = GlyphCrystal;
    const size = G.SIZES[this.size];
    this.grow = approach(this.grow, clamp01(this.in('grow')), G.GROW_TAU, dt);
    this.glow = approach(this.glow, clamp01(this.in('glow')), G.GLOW_TAU, dt);
    this.kick *= Math.exp(-G.HIT_DECAY * dt);
    this.flash *= Math.exp(-G.FLASH_DECAY * dt);
    const minDim = Math.min(this.width, this.height);
    const diag = Math.hypot(this.width, this.height);
    const rate = G.RATE * minDim * size.speed
      * (G.BASE_GROW + (1 - G.BASE_GROW) * this.grow) * (1 + G.HIT_GROW * this.kick);

    const gens = this.generations;
    const current = gens[gens.length - 1];
    current.age += dt;

    // Seeding: a steady trickle up to the generation's cap, plus what hits
    // owe, which may run past the cap.
    this.spawnDebt += dt * size.rate;
    while (this.spawnDebt >= 1) {
      this.spawnDebt -= 1;
      if (current.seeded < size.cap * 1.5 && (current.seeded < size.cap || this.kick > 0.05)) this.plant(current);
    }
    this.spawnDebt = Math.min(this.spawnDebt, 4);

    // Grow: every live crystal paints the ring between last frame's edge and
    // this one's, under whatever is already there.
    const maxR = diag / Math.max(1e-6, this.profile.reduce((a, b) => Math.max(a, b), 0)) * 0.55;
    for (const gen of gens) {
      const gc = gen.ctx;
      for (const c of gen.crystals) {
        if (c.r >= maxR) continue;
        c.last = c.r;
        c.r = Math.min(maxR, c.r + rate * dt);
        gc.fillStyle = this.ringColor(c, c.r);
        gc.fill(this.annulus(c, Math.max(0, c.last - G.OVERLAP), c.r), 'evenodd');
      }
    }

    // Is the current generation finished? Then the next starts over it, and
    // once that one is done the older ones can go.
    this.sinceProbe += dt;
    if (this.sinceProbe >= G.PROBE_EVERY) {
      this.sinceProbe = 0;
      this.measureCoverage(current);
      if (current.coverage >= G.FULL || current.age > G.MAX_AGE) {
        if (gens.length > 1) gens.splice(0, gens.length - 1);
        this.newGeneration();
      }
    }

    ctx.shadowBlur = 0;
    for (let i = 0; i < gens.length; i++) {
      ctx.drawImage(gens[i].canvas, 0, 0, this.width, this.height);
      if (i < gens.length - 1) {
        // A finished generation sinks back, so the new one grows out of dusk.
        ctx.fillStyle = rgba(this.style.background, G.VEIL);
        ctx.fillRect(0, 0, this.width, this.height);
      }
    }

    // The live fronts, glowing.
    const alpha = G.FRONT_ALPHA + G.FRONT_GAIN * this.glow + 0.3 * this.flash;
    if (alpha > 0.02) {
      const front = new Path2D();
      for (const c of current.crystals) {
        if (c.r >= maxR || c.r <= 0) continue;
        front.addPath(this.annulus(c, 0, c.r));
      }
      ctx.shadowBlur = this.style.shadowBlur ?? 0;
      ctx.shadowColor = this.style.shadowColor ?? this.style.accentColor ?? this.style.lineColor;
      ctx.lineWidth = Math.max(0.8, (this.style.lineWidth ?? 2) * 0.6);
      ctx.strokeStyle = rgba(this.peak(this.style.accentColor ?? this.style.lineColor, this.flash), Math.min(1, alpha));
      ctx.stroke(front);
      ctx.shadowBlur = 0;
    }
  }
}
