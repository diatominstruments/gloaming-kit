import { Visualization, approach, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';
import { mixColor } from '../style.js';
import { Glyph, glyphOption, readGlyph, FLOWER } from './glyph.js';
import { interpret, interpretOption } from './glyph-interpret.js';
import { Evolver, evolveOption } from './glyph-evolve.js';

const LEAVES = 1600;   // most petals at the deepest level
const SHADES = 24;     // colour steps precomputed per frame
const PETAL = 100;     // the petal path's own scale; see the constructor

/**
 * GlyphWindow — a rose window grown from the drawing.
 *
 * The drawing is read into a handful of elements (option `interpret`; see
 * glyph-interpret.js), and each element holds a petal and, inside it, the
 * whole arrangement again — nested as deep as LEAVES allows, two levels for
 * a busy reading and four or five for a sparse one. Petals are drawn
 * translucent and added together, so where nested petals overlap the light
 * builds up like stained glass, and the outer levels are a faint ghost
 * around the bright fine structure.
 *
 * Every element turns about its own centre on its own phase, and since each
 * level is the same elements again, the turning compounds down the levels:
 * the window breathes and swirls as a whole. Option `evolve` keeps the
 * structure itself alive — drifting, growing, or morphing between readings;
 * see glyph-evolve.js.
 *
 * It is the 2D member of the Glyphs family, and what each of the 3D ones
 * draws when 3D is off — they pass it their own `glyph` (see windowOf), so
 * the fallback still grows from the viewer's drawing.
 *
 * Reactions:
 *
 *   pulse  a hit swells every petal and flashes it toward the accent
 *   spin   how fast the window turns and the petals swirl
 *   glow   brightness
 */
export class GlyphWindow extends Visualization {
  static id = 'glyph-window';
  static label = 'Glyph Window';
  static description = 'A rose window grown from the drawing: petals nested inside petals, swirling; hits swell and flash them.';
  static category = CATEGORY.GLYPHS;

  static inputs = {
    pulse: { kind: 'event', default: TRIGGER.BASS },
    spin:  { kind: 'level', default: { intensity: 'mid', smooth: 0.6 } },
    mutate: { kind: 'level', default: { intensity: 'mid', smooth: 1 } },
    glow:  { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
      smooth: 0.1,
    } },
  };

  static options = {
    glyph: glyphOption({ width: 7, height: 7, value: FLOWER }),
    interpret: interpretOption('rosette'),
    evolve: evolveOption('drift'),
  };

  static SIZE = 0.46;            // figure radius, fraction of the short edge
  static SPIN = [0.04, 0.22];    // window turn rate, rad/s: [idle, at full spin]
  static SWIRL = [0.3, 1.1];     // petals' phase rate: [idle, at full spin]
  static TWIST = 0.35;           // largest turn of a petal about its centre, rad
  static SWELL = 0.18;           // added petal size at full hit strength
  static ALPHA = [0.5, 0.5];     // [floor, added at full glow]
  static KICK_DECAY = 3;

  constructor(opts) {
    super(opts);
    const spec = this.constructor.options;
    this.glyph = readGlyph(this);
    let reading = this.options.interpret ?? spec.interpret.default;
    // One element nests into a single shrinking petal; read the default.
    if (interpret(this.glyph, reading, spec.interpret.default).length < 2) {
      this.glyph = Glyph.parse(spec.glyph.default, spec.glyph.levels);
      reading = spec.interpret.default;
    }
    this.evolver = new Evolver(this.glyph, reading, this.options.evolve ?? spec.evolve.default);
    // The live elements, rewritten in place every frame.
    this.elements = this.evolver.live;
    const n = this.elements.length;
    this.depth = Math.max(1, Math.min(5, Math.floor(Math.log(LEAVES) / Math.log(n))));
    // Per element, rewritten each frame: its map as a 2D affine (a b c d e f).
    this.maps = new Float64Array(n * 6);
    // Per level, the composed transform being built, so recursion allocates
    // nothing.
    this.stack = Array.from({ length: this.depth + 1 }, () => new Float64Array(6));

    // A petal spanning the element: a lens along its long axis. Built at
    // PETAL × size and scaled back down when drawn, because canvas flattens
    // curves at the path's own scale: built at unit size and magnified, the
    // lens comes out a polygon.
    this.petal = new Path2D();
    this.petal.moveTo(-PETAL, 0);
    this.petal.quadraticCurveTo(0, -1.7 * PETAL, PETAL, 0);
    this.petal.quadraticCurveTo(0, 1.7 * PETAL, -PETAL, 0);
    this.petal.closePath();

    this.angle = Math.random() * Math.PI * 2;
    this.rate = GlyphWindow.SPIN[0];
    this.phase = Math.random() * 10;
    this.hue = Math.random();
    this.kick = 0;
    this.shades = new Array(SHADES);
    this.cx = 0;   // where the figure's centre is, eased
    this.cy = 0;
  }

  onInput(slot, data) {
    if (slot !== 'pulse') return;
    this.kick = Math.max(this.kick, impact(data));
    this.evolver.hit(impact(data));
  }

  /** Each element's map for this frame: move, turn, stretch. */
  updateMaps() {
    const { TWIST, SWELL } = GlyphWindow;
    const swell = 1 + this.kick * SWELL;
    const m = this.maps;
    this.elements.forEach((e, i) => {
      // Mostly-grey elements turn against the rest.
      const turn = e.angle + Math.sin(this.phase + i * 1.7) * TWIST * (e.weight < 0.5 ? -1 : 1);
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      const j = i * 6;
      m[j] = c * e.sx * swell;
      m[j + 1] = s * e.sx * swell;
      m[j + 2] = -s * e.sy * swell;
      m[j + 3] = c * e.sy * swell;
      m[j + 4] = e.x;
      m[j + 5] = e.y;
    });
  }

  draw(ctx, dt) {
    const { SIZE, SPIN, SWIRL, ALPHA, KICK_DECAY } = GlyphWindow;
    const spin = this.in('spin');
    this.rate = approach(this.rate, SPIN[0] + spin * SPIN[1], 0.5, dt);
    this.angle += this.rate * dt;
    this.phase += dt * (SWIRL[0] + spin * SWIRL[1]);
    this.hue += dt * (0.02 + spin * 0.05);
    this.kick *= Math.exp(-dt * KICK_DECAY);
    this.evolver.update(dt, this.in('mutate'));
    this.updateMaps();

    // Colours for this frame, between line and accent and back.
    const line = this.style.lineColor;
    const accent = this.style.accentColor ?? line;
    for (let k = 0; k < SHADES; k++) {
      const t = 0.5 - 0.5 * Math.cos((k / SHADES) * Math.PI * 2);
      this.shades[k] = mixColor(line, accent, Math.min(1, t + this.kick * 0.4));
    }

    const base = ctx.getTransform();
    const r = Math.min(this.width, this.height) * SIZE;
    const c = Math.cos(this.angle) * r;
    const s = Math.sin(this.angle) * r;
    // Keep the figure centred on what is actually there: a growing, drifting
    // or morphing structure wanders off the origin.
    let mass = 0, mx = 0, my = 0;
    for (const e of this.elements) {
      const a = e.sx * e.sy;
      mass += a;
      mx += e.x * a;
      my += e.y * a;
    }
    if (mass > 0) {
      const follow = 1 - Math.exp(-dt / 0.8);
      this.cx += (mx / mass - this.cx) * follow;
      this.cy += (my / mass - this.cy) * follow;
    }
    // The figure's frame on screen: centred, turned and scaled, with y
    // flipped so the figure's y points up.
    this.stack[0].set([
      c, s, s, -c,
      this.width / 2 - (c * this.cx + s * this.cy),
      this.height / 2 - (s * this.cx - c * this.cy),
    ]);

    this.alpha = ctx.globalAlpha * Math.min(1, ALPHA[0] + this.in('glow') * ALPHA[1]);
    this.base = base;
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'lighter';
    this.nest(ctx, 1, 0, 1);
    ctx.restore();
  }

  /**
   * Draw level `level`'s petals inside the transform at stack[level - 1],
   * and recurse. `hue` and `bright` carry the address so far.
   */
  nest(ctx, level, hue, bright) {
    const parent = this.stack[level - 1];
    const out = this.stack[level];
    const m = this.maps;
    const { a: ba, b: bb, c: bc, d: bd, e: be, f: bf } = this.base;
    const deep = level / this.depth;
    // Outer levels a faint ghost, the finest the brightest.
    const levelAlpha = 0.1 + 0.55 * deep * deep;
    for (let i = 0; i < this.elements.length; i++) {
      const j = i * 6;
      // out = parent ∘ map
      out[0] = parent[0] * m[j] + parent[2] * m[j + 1];
      out[1] = parent[1] * m[j] + parent[3] * m[j + 1];
      out[2] = parent[0] * m[j + 2] + parent[2] * m[j + 3];
      out[3] = parent[1] * m[j + 2] + parent[3] * m[j + 3];
      out[4] = parent[0] * m[j + 4] + parent[2] * m[j + 5] + parent[4];
      out[5] = parent[1] * m[j + 4] + parent[3] * m[j + 5] + parent[5];

      const e = this.elements[i];
      // Absent (not grown, or withered): nothing here, nor inside it.
      if (e.sx * e.sy < 1e-6) continue;
      const h = hue + e.hue * 0.3 ** (level - 1);
      const b = bright * (0.45 + 0.55 * e.weight);
      ctx.setTransform(
        (ba * out[0] + bc * out[1]) / PETAL, (bb * out[0] + bd * out[1]) / PETAL,
        (ba * out[2] + bc * out[3]) / PETAL, (bb * out[2] + bd * out[3]) / PETAL,
        ba * out[4] + bc * out[5] + be, bb * out[4] + bd * out[5] + bf,
      );
      const shade = Math.floor((((h + this.hue) % 1) + 1) % 1 * SHADES) % SHADES;
      ctx.fillStyle = this.shades[shade];
      ctx.globalAlpha = this.alpha * levelAlpha * b;
      ctx.fill(this.petal);
      if (level < this.depth) this.nest(ctx, level + 1, h, b);
    }
  }
}

/**
 * GlyphWindow with another visualization's `glyph` (and `interpret` and
 * `evolve`, if it has them) options, so it can stand in for that one when 3D is off and still
 * grow from its default drawing when no drawing was given. Reports the same
 * id, so describe() names it as the window.
 *
 *   static fallback = windowOf(this.options);
 */
export const windowOf = ({ glyph, interpret: reading, evolve }) => class extends GlyphWindow {
  static options = {
    ...GlyphWindow.options,
    glyph,
    ...(reading ? { interpret: reading } : {}),
    ...(evolve ? { evolve } : {}),
  };
};
