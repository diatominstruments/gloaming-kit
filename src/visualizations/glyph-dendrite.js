import { Visualization, approach, clamp01, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { LAYER } from './layers.js';
import { TRIGGER } from '../analyzer.js';
import { createNoise3D, mulberry32 } from '../noise.js';
import { mixColor, rgba } from '../style.js';
import { glyphOption, readGlyph, FERN } from './glyph.js';

/**
 * GlyphDendrite — the drawing as a branching rule. Each row is one
 * generation of growth: a filled cell is a child branch, its column the
 * angle it leaves at (left of centre turns left, right turns right) and its
 * strength how long and thick it grows; an empty row grows straight on. A
 * growing tip follows the rows in turn, over and over, so a drawing with a
 * wide row and a narrow row grows a plant that fans, then reaches, then fans
 * again, finer each time.
 *
 * Seeds start at the screen's edges and grow inward like frost on a window,
 * tips wandering a little and stopping dead when they reach anything already
 * grown; later seeds land wherever there is still room, so the trees pack
 * the screen into territories. When nothing is left growing the whole thing
 * thaws — fades out while new seeds start over it — and grows again.
 *
 *   sprout  a hit: tips branch now, a fresh seed lands, and new growth
 *           flares brighter
 *   grow    how fast the tips advance
 *   glow    how brightly the growing tips sparkle
 *
 * Options:
 *   glyph   the drawing
 *   spread  'narrow' | 'wide' — how far the outermost column turns a branch
 *   from    'edges' (default) | 'centre' | 'scatter' — where the first seeds
 *           start; after that they land where there is room
 *   seed    which noise bends the branches
 */
export class GlyphDendrite extends Visualization {
  static id = 'glyph-dendrite';
  static label = 'Glyph Dendrite';
  static description = 'Branching growth that reads the drawing\'s rows as its rule, packing the screen like frost, thawing and regrowing; hits make every tip branch.';
  static category = CATEGORY.GLYPHS;
  static layer = LAYER.MAIN;
  static inputs = {
    sprout: { kind: 'event', default: TRIGGER.BASS },
    grow:   { kind: 'level', default: { intensity: 'mid' } },
    glow:   { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
    } },
  };
  static options = {
    glyph:  glyphOption({ width: 9, height: 9, value: FERN }),
    spread: { kind: 'enum', values: ['narrow', 'wide'], default: 'wide' },
    from:   { kind: 'enum', values: ['edges', 'centre', 'scatter'], default: 'edges' },
    seed:   { kind: 'number', default: 1, min: 0, max: 9999, step: 1 },
  };

  static SPREADS = { narrow: Math.PI * 0.4, wide: Math.PI * 0.7 };
  static SEEDS = { edges: 36, centre: 10, scatter: 0 };   // the opening wave, from where `from` says
  static MAX_SEEDS = 160;     // per growth
  static MIN_SEEDS = 40;      // before a thaw is allowed
  static CANDIDATES = 8;      // spots tried for each later seed; the emptiest wins
  static CROWD = 7;           // cells; the radius that counts as a spot's surroundings
  static SPEED = 0.08;        // of the smaller dimension per second, at full grow
  static BASE_GROW = 0.3;     // of SPEED at silence
  static GROW_TAU = 0.4;
  static HIT_GROW = 1.2;      // extra speed at a full hit
  static HIT_DECAY = 4;       // per second
  static SEGMENT = 0.05;      // first segment length, of the smaller dimension
  static STRIDE = 0.985;      // a trunk's segment length per generation
  static SHRINK = 0.93;       // a lateral's or fork's
  static LATERAL_SHORT = 0.35; // how much shorter an outermost lateral grows than a trunk
  static LATERAL_THIN = 0.35;  // and how much thinner
  static MIN_SEGMENT = 3.5;   // px; a tip this fine stops
  static MAX_DEPTH = 48;
  static WIDTH = 1.8;         // first width, times the style's lineWidth
  static THIN = 0.88;         // width per generation
  static MAX_TIPS = 900;
  static WANDER = 1.0;        // radians per second of noise bend at full
  static NOISE_SCALE = 2.5;   // noise units across the smaller dimension
  static CELL = 5;            // px; occupancy grid cell
  static GRACE = 3;           // cells a new branch may share with its own tree
  static SELF_CROSS = 0.12;   // chance a tip may cross its own tree after that
  static SEED_RATE = 3;       // seeds per second while seeding
  static MIN_LIVE = 150;      // keep seeding while fewer tips than this are alive
  static THAW_WAIT = 1.5;     // seconds still before thawing
  static THAW = 4;            // seconds the old growth takes to fade
  static GLOW_TAU = 0.3;
  static TIP_ALPHA = 0.15;    // tip sparkle at silence
  static TIP_GAIN = 0.85;

  constructor(opts) {
    super(opts);
    const G = GlyphDendrite;
    this.glyph = readGlyph(this);
    this.spread = G.SPREADS[this.options.spread] ?? G.SPREADS.wide;
    this.from = G.SEEDS[this.options.from] ? this.options.from : 'edges';
    const seed = Number(this.options.seed ?? 1) | 0;
    this.noise = createNoise3D(seed);
    this.rand = mulberry32(seed * 1021 + 7);
    this.rules = this.readRules();
    this.tips = [];
    this.t = 0;
    this.grow = 0;
    this.glow = 0;
    this.kick = 0;
    this.seeded = 0;
    this.seedDebt = 0;
    this.still = 0;
    this.thaw = 0;             // seconds left of the old growth's fade
    this.nextTree = 1;
    this.current = this.makeCanvas();
    this.old = this.makeCanvas();
    this.allocate();
  }

  /** One rule per row: the children a branch splits into at that generation. */
  readRules() {
    const g = this.glyph;
    const rules = [];
    for (let y = 0; y < g.height; y++) {
      const children = [];
      for (let x = 0; x < g.width; x++) {
        const w = g.weight(x, y);
        if (!w) continue;
        const angle = ((x + 0.5) / g.width - 0.5) * this.spread;
        // How far off the parent's heading, 0 for a trunk that carries on
        // to 1 at the outermost column: laterals grow shorter and thinner.
        children.push({ angle, weight: w, lateral: Math.abs(angle) / (this.spread / 2) });
      }
      rules.push(children.length ? children : [{ angle: 0, weight: 0.7, lateral: 0, straight: true }]);
    }
    return rules;
  }

  makeCanvas() {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    return { canvas, ctx };
  }

  resize(width, height) {
    super.resize(width, height);
    this.allocate();
  }

  allocate() {
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.current, this.old]) {
      c.canvas.width = Math.max(1, Math.round(this.width * dpr));
      c.canvas.height = Math.max(1, Math.round(this.height * dpr));
      c.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.ctx.lineCap = 'round';
      c.ctx.lineJoin = 'round';
    }
    this.cols = Math.ceil(this.width / GlyphDendrite.CELL) + 1;
    this.rows = Math.ceil(this.height / GlyphDendrite.CELL) + 1;
    this.grid = new Int32Array(this.cols * this.rows);
    this.tips = [];
    this.seeded = 0;
    this.thaw = 0;
  }

  onInput(slot, data) {
    if (slot === 'sprout') {
      const k = impact(data);
      this.kick = Math.max(this.kick, k);
      // A share of the live tips branch at once.
      for (const tip of this.tips) if (this.rand() < 0.3 + 0.5 * k) tip.done = tip.seg;
      this.seedDebt += 1;
    }
  }

  /** How much is already grown within `r` cells of (x, y) px. */
  crowding(x, y, r = GlyphDendrite.CROWD) {
    const cx = (x / GlyphDendrite.CELL) | 0;
    const cy = (y / GlyphDendrite.CELL) | 0;
    let n = 0;
    for (let j = Math.max(0, cy - r); j <= Math.min(this.rows - 1, cy + r); j++) {
      for (let i = Math.max(0, cx - r); i <= Math.min(this.cols - 1, cx + r); i++) {
        if (this.grid[j * this.cols + i]) n++;
      }
    }
    return n;
  }

  plant() {
    const G = GlyphDendrite;
    const w = this.width;
    const h = this.height;
    let x; let y; let a;
    if (this.seeded >= G.SEEDS[this.from]) {
      // The opening wave has landed; from here seeds go where there is room,
      // so the growth fills in rather than piling up where it started.
      let best = Infinity;
      for (let i = 0; i < G.CANDIDATES; i++) {
        const px = this.rand() * w;
        const py = this.rand() * h;
        const c = this.crowding(px, py);
        if (c < best) { best = c; x = px; y = py; }
      }
      a = this.rand() * Math.PI * 2;
    } else if (this.from === 'centre') {
      a = this.rand() * Math.PI * 2;
      const r = Math.min(w, h) * 0.04 * this.rand();
      x = w / 2 + Math.cos(a) * r;
      y = h / 2 + Math.sin(a) * r;
    } else if (this.from === 'scatter') {
      x = this.rand() * w;
      y = this.rand() * h;
      a = this.rand() * Math.PI * 2;
    } else {
      const side = (this.rand() * 4) | 0;
      const t = this.rand();
      if (side === 0) { x = t * w; y = 1; a = Math.PI / 2; }
      else if (side === 1) { x = t * w; y = h - 1; a = -Math.PI / 2; }
      else if (side === 2) { x = 1; y = t * h; a = 0; }
      else { x = w - 1; y = t * h; a = Math.PI; }
      a += (this.rand() - 0.5) * 1.0;
    }
    const seg = G.SEGMENT * Math.min(w, h);
    this.tips.push({
      x, y, a, depth: 0, seg, done: 0,
      w: G.WIDTH * (this.style.lineWidth ?? 2),
      tree: this.nextTree++, grace: G.GRACE, cell: -1,
    });
    this.seeded++;
  }

  /** The tip steps into cell index c: may it, and does it claim it? */
  enter(tip, c) {
    if (c === tip.cell) return true;
    const owner = this.grid[c];
    if (owner && owner !== tip.tree) return false;
    if (owner === tip.tree && tip.grace <= 0 && this.rand() > GlyphDendrite.SELF_CROSS) return false;
    this.grid[c] = tip.tree;
    tip.cell = c;
    tip.grace--;
    return true;
  }

  branch(tip, out) {
    const G = GlyphDendrite;
    const rule = this.rules[tip.depth % this.rules.length];
    const room = Math.max(0, G.MAX_TIPS - this.tips.length - out.length);
    const keep = room >= rule.length ? 1 : room / rule.length;
    for (const child of rule) {
      if (this.rand() > keep) continue;
      // A trunk keeps its stride; laterals and forks grow shorter each time.
      const trunk = child.lateral < 0.15;
      const seg = tip.seg * (trunk ? G.STRIDE : G.SHRINK * (1 - G.LATERAL_SHORT * child.lateral))
        * (0.55 + 0.45 * child.weight);
      if (seg < G.MIN_SEGMENT || tip.depth + 1 > G.MAX_DEPTH) continue;
      const thin = child.straight ? 0.97 : G.THIN * (0.75 + 0.25 * child.weight) * (1 - G.LATERAL_THIN * child.lateral);
      out.push({
        x: tip.x, y: tip.y,
        a: tip.a + child.angle + (this.rand() - 0.5) * 0.15,
        depth: tip.depth + 1, seg, done: 0,
        w: Math.max(0.5, tip.w * thin),
        tree: tip.tree, grace: G.GRACE, cell: tip.cell,
      });
    }
  }

  draw(ctx, dt) {
    const G = GlyphDendrite;
    this.grow = approach(this.grow, clamp01(this.in('grow')), G.GROW_TAU, dt);
    this.glow = approach(this.glow, clamp01(this.in('glow')), G.GLOW_TAU, dt);
    this.kick *= Math.exp(-G.HIT_DECAY * dt);
    this.t += dt;
    const minDim = Math.min(this.width, this.height);
    const speed = G.SPEED * minDim * (G.BASE_GROW + (1 - G.BASE_GROW) * this.grow) * (1 + G.HIT_GROW * this.kick);
    const maxSeeds = G.SEEDS[this.from];

    // Seeding, while the growth is thin: new seeds keep landing until the
    // screen is packed enough that nothing survives long.
    if (this.seeded < G.MAX_SEEDS && this.tips.length < G.MIN_LIVE) this.seedDebt += dt * G.SEED_RATE;
    while (this.seedDebt >= 1) {
      this.seedDebt -= 1;
      if (this.seeded < G.MAX_SEEDS) this.plant();
    }

    // Advance every tip, drawing its step; branch the ones that finished a
    // segment; drop the ones that ran into something.
    const noiseScale = G.NOISE_SCALE / minDim;
    const paths = new Map();   // colour|width -> Path2D
    const stroke = (key, x0, y0, x1, y1) => {
      let p = paths.get(key);
      if (!p) { p = new Path2D(); paths.set(key, p); }
      p.moveTo(x0, y0);
      p.lineTo(x1, y1);
    };
    const line = this.style.lineColor;
    const accent = this.style.accentColor ?? line;
    const born = [];
    const alive = [];
    const step = speed * dt;
    const cols = this.cols;
    for (const tip of this.tips) {
      tip.a += this.noise(tip.x * noiseScale, tip.y * noiseScale, tip.tree * 0.37) * G.WANDER * dt;
      const x0 = tip.x;
      const y0 = tip.y;
      tip.x += Math.cos(tip.a) * step;
      tip.y += Math.sin(tip.a) * step;
      tip.done += step;
      if (tip.x < 0 || tip.y < 0 || tip.x >= this.width || tip.y >= this.height) continue;
      const c = ((tip.y / G.CELL) | 0) * cols + ((tip.x / G.CELL) | 0);
      if (!this.enter(tip, c)) continue;
      const k = Math.min(1, tip.depth / 8);
      const colour = mixColor(line, accent, k);
      const bright = Math.min(1, 0.55 + 0.45 * k + 0.5 * this.kick);
      stroke(`${colour}|${bright.toFixed(1)}|${tip.w.toFixed(1)}`, x0, y0, tip.x, tip.y);
      if (tip.done >= tip.seg) this.branch(tip, born);
      else alive.push(tip);
    }
    this.tips = alive.concat(born);

    const cc = this.current.ctx;
    cc.shadowBlur = 0;
    for (const [key, path] of paths) {
      const [colour, bright, width] = key.split('|');
      cc.strokeStyle = rgba(colour, Number(bright));
      cc.lineWidth = Number(width);
      cc.stroke(path);
    }

    // Thaw: when growth has stopped, fade it out while a new one begins.
    if (this.tips.length === 0 && this.seeded >= Math.max(maxSeeds, G.MIN_SEEDS)) {
      this.still += dt;
      if (this.still >= G.THAW_WAIT) {
        this.still = 0;
        [this.current, this.old] = [this.old, this.current];
        this.current.ctx.clearRect(0, 0, this.width, this.height);
        this.grid.fill(0);
        this.seeded = 0;
        this.thaw = G.THAW;
      }
    } else {
      this.still = 0;
    }
    if (this.thaw > 0) this.thaw = Math.max(0, this.thaw - dt);

    ctx.shadowBlur = 0;
    if (this.thaw > 0) {
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * (this.thaw / G.THAW);
      ctx.drawImage(this.old.canvas, 0, 0, this.width, this.height);
      ctx.globalAlpha = a;
    }
    ctx.drawImage(this.current.canvas, 0, 0, this.width, this.height);

    // Growing tips sparkle.
    const alpha = G.TIP_ALPHA + G.TIP_GAIN * this.glow + 0.4 * this.kick;
    if (alpha > 0.03 && this.tips.length) {
      const dots = new Path2D();
      const r = Math.max(1, (this.style.lineWidth ?? 2) * 0.8);
      for (const tip of this.tips) {
        dots.moveTo(tip.x + r, tip.y);
        dots.arc(tip.x, tip.y, r, 0, Math.PI * 2);
      }
      ctx.shadowBlur = this.style.shadowBlur ?? 0;
      ctx.shadowColor = this.style.shadowColor ?? accent;
      ctx.fillStyle = rgba(accent, Math.min(1, alpha));
      ctx.fill(dots);
      ctx.shadowBlur = 0;
    }
  }
}
