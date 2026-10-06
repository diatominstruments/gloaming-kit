import { Visualization, approach, clamp01, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { LAYER } from './layers.js';
import { TRIGGER } from '../analyzer.js';
import { createNoise3D, mulberry32 } from '../noise.js';
import { rgba } from '../style.js';
import { glyphOption, readGlyph, glyphField, WHORLS } from './glyph.js';

/**
 * GlyphCurrent — the drawing as a stream function. Read as a smooth field
 * tiled across the plane, the drawing's filled cells are hills; the current
 * runs along their contours (the field's curl), so it circles every drawn
 * shape, fast where a shape is steep and slow in the flats between. A few
 * thousand motes ride it, leaving fading trails, and what builds up is a
 * grain — a texture of eddies and seams whose whorls are the drawing's
 * shapes, repeated and mirrored across the screen under a slow turn, so no
 * two eddies line up and the drawing itself is never there to see.
 *
 *   surge  a hit: the current quickens and brightens, then settles
 *   flow   how fast the current runs
 *   turn   how fast the field turns beneath the motes, which drags the
 *          whole grain round and keeps it from settling into fixed loops
 *   glow   how bright the trails burn
 *
 * Options:
 *   glyph  the drawing
 *   count  motes (default 2200)
 *   scale  size of one copy of the drawing, of the smaller screen dimension
 *          (default 1 = half of it, so a few copies are in view)
 *   seed   which noise breaks the tiling's regularity
 */
export class GlyphCurrent extends Visualization {
  static id = 'glyph-current';
  static label = 'Glyph Current';
  static description = 'Motes ride a current that circles the drawing\'s shapes, tiled and turning, leaving a grain of eddies behind them; hits quicken it.';
  static category = CATEGORY.GLYPHS;
  static layer = LAYER.MAIN;
  static inputs = {
    surge: { kind: 'event', default: TRIGGER.BASS },
    flow:  { kind: 'level', default: { intensity: 'rms' } },
    turn:  { kind: 'level', default: { intensity: 'mid' } },
    glow:  { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
    } },
  };
  static options = {
    glyph: glyphOption({ width: 9, height: 9, value: WHORLS }),
    count: { kind: 'number', default: 2200, min: 200, max: 6000, step: 100 },
    scale: { kind: 'number', default: 1, min: 0.4, max: 3, step: 0.05 },
    seed:  { kind: 'number', default: 1, min: 0, max: 9999, step: 1 },
  };

  static TILE = 0.5;          // one copy of the drawing, of the smaller dimension, at scale 1
  static SPEED = 0.5;         // tile widths per second on the steepest slope, at full flow
  static BASE_FLOW = 0.4;     // of SPEED at silence
  static FLOW_TAU = 0.4;
  static SURGE = 1.6;         // extra speed at a full surge
  static SURGE_DECAY = 2.2;   // per second
  static BASE_TURN = 0.015;   // radians per second at silence
  static TURN_GAIN = 0.12;
  static TURN_TAU = 0.8;
  static DRIFT = 0.012;       // tiles per second the field slides
  static NOISE = 0.25;        // noise added to the stream function, in field units
  static NOISE_SCALE = 1.7;   // noise units per tile
  static NOISE_RATE = 0.05;   // noise time per second
  static TRAIL_TAU = 1.6;     // seconds a trail takes to fade mostly away
  static LIFE = [3, 8];       // seconds a mote rides before respawning
  static STALL = 1.5;         // px/s below which a mote counts as stuck
  static STALL_LIMIT = 0.5;   // seconds stuck before it respawns
  static ALPHA = 0.4;         // trail opacity at silence
  static GLOW_GAIN = 0.5;
  static GLOW_TAU = 0.3;
  static SLOW = 0.3;          // of full speed, below which a trail draws dim
  static FAST = 0.75;         // above which it draws in accent
  static EPS = 1.5;           // px, finite-difference step for the curl
  static CAP = 1.3;           // of full speed; the noise can steepen the field past it

  constructor(opts) {
    super(opts);
    this.glyph = readGlyph(this);
    this.field = glyphField(this.glyph);
    this.scale = Math.max(0.1, Number(this.options.scale ?? 1) || 1);
    const seed = Number(this.options.seed ?? 1) | 0;
    this.noise = createNoise3D(seed);
    this.rand = mulberry32(seed * 7919 + 17);
    this.count = Math.max(1, Number(this.options.count ?? 2200) | 0);
    this.px = new Float32Array(this.count);
    this.py = new Float32Array(this.count);
    this.life = new Float32Array(this.count);
    this.stuck = new Float32Array(this.count);
    this.theta = this.rand() * Math.PI * 2;
    this.du = this.rand() * 2;
    this.dv = this.rand() * 2;
    this.t = 0;
    this.flow = 0;
    this.turn = 0;
    this.glow = 0;
    this.kick = 0;
    this.trail = document.createElement('canvas');
    this.trailCtx = this.trail.getContext('2d');
    this.allocate();
    for (let i = 0; i < this.count; i++) this.respawn(i, true);
  }

  resize(width, height) {
    super.resize(width, height);
    this.allocate();
  }

  allocate() {
    const dpr = window.devicePixelRatio || 1;
    this.trail.width = Math.max(1, Math.round(this.width * dpr));
    this.trail.height = Math.max(1, Math.round(this.height * dpr));
    this.trailCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.trailCtx.lineCap = 'round';
    this.tile = Math.min(this.width, this.height) * GlyphCurrent.TILE * this.scale;
  }

  respawn(i, anywhere = false) {
    const [lo, hi] = GlyphCurrent.LIFE;
    this.px[i] = this.rand() * this.width;
    this.py[i] = this.rand() * this.height;
    // At start, stagger ages so the field doesn't respawn in one wave.
    this.life[i] = lo + this.rand() * (hi - lo) * (anywhere ? this.rand() : 1);
    this.stuck[i] = 0;
  }

  onInput(slot, data) {
    if (slot === 'surge') this.kick = Math.max(this.kick, impact(data));
  }

  /** Stream function at screen point (x, y): the tiled drawing plus a little noise. */
  psi(x, y) {
    const G = GlyphCurrent;
    const { tile, cos, sin } = this;
    const rx = (x - this.width / 2) / tile;
    const ry = (y - this.height / 2) / tile;
    const u = rx * cos - ry * sin + this.du;
    const v = rx * sin + ry * cos + this.dv;
    return this.field(u, v)
      + G.NOISE * this.noise(u * G.NOISE_SCALE, v * G.NOISE_SCALE, this.t * G.NOISE_RATE);
  }

  draw(ctx, dt) {
    const G = GlyphCurrent;
    this.flow = approach(this.flow, clamp01(this.in('flow')), G.FLOW_TAU, dt);
    this.turn = approach(this.turn, clamp01(this.in('turn')), G.TURN_TAU, dt);
    this.glow = approach(this.glow, clamp01(this.in('glow')), G.GLOW_TAU, dt);
    this.kick *= Math.exp(-G.SURGE_DECAY * dt);
    this.t += dt;
    this.theta += dt * (G.BASE_TURN + G.TURN_GAIN * this.turn);
    this.du += dt * G.DRIFT;
    this.dv += dt * G.DRIFT * 0.37;
    this.cos = Math.cos(this.theta);
    this.sin = Math.sin(this.theta);

    // Full speed in px/s is what the field's steepest slope produces; the
    // slope of the tabulated field is known, per tile unit, so divide it
    // out. The range is compressed (square root) so the flats between the
    // drawing's shapes still move while the steep rims don't streak.
    const full = G.SPEED * this.tile * (G.BASE_FLOW + (1 - G.BASE_FLOW) * this.flow) * (1 + G.SURGE * this.kick);
    const perSlope = this.tile / (2 * G.EPS * this.field.gradMax);   // Δψ → slope, as a fraction of the steepest
    const cap = full * G.CAP;
    const step = Math.min(dt, 0.05);

    const slow = new Path2D();
    const mid = new Path2D();
    const fast = new Path2D();
    const { px, py, life, stuck } = this;
    const margin = 4;
    for (let i = 0; i < this.count; i++) {
      const x = px[i];
      const y = py[i];
      let vx = (this.psi(x, y + G.EPS) - this.psi(x, y - G.EPS)) * perSlope;
      let vy = (this.psi(x - G.EPS, y) - this.psi(x + G.EPS, y)) * perSlope;
      const slope = Math.hypot(vx, vy);
      let speed = slope > 0 ? Math.min(cap, full * Math.sqrt(slope)) : 0;
      if (slope > 0) { vx *= speed / slope; vy *= speed / slope; }
      const nx = x + vx * step;
      const ny = y + vy * step;
      const path = speed < full * G.SLOW ? slow : speed < full * G.FAST ? mid : fast;
      path.moveTo(x, y);
      path.lineTo(nx, ny);
      px[i] = nx;
      py[i] = ny;
      life[i] -= dt;
      stuck[i] = speed < G.STALL ? stuck[i] + dt : 0;
      if (life[i] <= 0 || stuck[i] > G.STALL_LIMIT
        || nx < -margin || ny < -margin || nx > this.width + margin || ny > this.height + margin) {
        this.respawn(i);
      }
    }

    const tc = this.trailCtx;
    tc.globalCompositeOperation = 'destination-out';
    tc.fillStyle = `rgba(0, 0, 0, ${1 - Math.exp(-dt / G.TRAIL_TAU)})`;
    tc.fillRect(0, 0, this.width, this.height);
    tc.globalCompositeOperation = 'source-over';
    const alpha = Math.min(1, (G.ALPHA + G.GLOW_GAIN * this.glow) * (1 + 0.8 * this.kick));
    const line = this.style.lineColor;
    const accent = this.style.accentColor ?? line;
    tc.lineWidth = Math.max(1.2, (this.style.lineWidth ?? 2) * 0.65);
    tc.strokeStyle = rgba(line, alpha * 0.45);
    tc.stroke(slow);
    tc.strokeStyle = rgba(line, alpha);
    tc.stroke(mid);
    tc.strokeStyle = rgba(accent, Math.min(1, alpha * 1.3));
    tc.stroke(fast);

    ctx.shadowBlur = 0;
    ctx.drawImage(this.trail, 0, 0, this.width, this.height);
  }
}
