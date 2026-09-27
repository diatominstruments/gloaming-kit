import { Visualization, approach, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { LAYER } from './layers.js';
import { TRIGGER } from '../analyzer.js';
import { rgba } from '../style.js';

/**
 * Moire — two identical fine patterns laid over each other, slightly out of
 * register. Neither pattern moves much, but their interference does: small
 * shifts sweep large bands across the whole screen.
 *
 * 'rings': two sets of concentric circles whose centres pull apart with
 * `shift`, orbiting each other at a rate set by `turn`. 'lines': two
 * gratings through the centre, crossed at an angle that opens with `shift`,
 * the pair rotating with `turn`. A `kick` jerks the offset out and lets it
 * settle back.
 *
 * Options:
 *   pattern  'rings' or 'lines' (default 'rings')
 */
export class Moire extends Visualization {
  static id = 'moire';
  static label = 'Moiré';
  static description = 'Two overlapping ring or line patterns whose interference bands sweep with the sound.';
  static category = CATEGORY.BACKGROUNDS;
  static layer = LAYER.BACKGROUND;
  static inputs = {
    shift: { kind: 'level', default: { intensity: 'bass' } },
    turn:  { kind: 'level', default: 'mid' },
    kick:  { kind: 'event', default: TRIGGER.BASS },
  };
  static options = {
    pattern: { kind: 'enum', values: ['rings', 'lines'], default: 'rings' },
  };

  static SPACING = 9;         // px between rings or lines
  static LINE_WIDTH = 1.2;
  static ALPHA = 0.28;
  static SHIFT_TAU = 0.25;
  static BASE_TURN = 0.04;    // radians per second, at silence
  static TURN_GAIN = 0.35;    // extra at full `turn`
  static TURN_TAU = 0.6;
  static KICK_DECAY = 3.5;    // per second
  // rings: centre separation, of the spacing
  static RING_BASE = 1.2;
  static RING_GAIN = 6;       // extra at full `shift`
  static RING_KICK = 4;       // extra at a full-impact kick
  // lines: crossing angle, radians
  static LINE_BASE = 0.02;
  static LINE_GAIN = 0.08;
  static LINE_KICK = 0.06;

  constructor(opts) {
    super(opts);
    this.pattern = this.options.pattern === 'lines' ? 'lines' : 'rings';
    this.shift = 0;
    this.turnRate = 0;
    this.angle = Math.random() * Math.PI * 2;
    this.kick = 0;
  }

  onInput(slot, data) {
    if (slot === 'kick') this.kick = Math.max(this.kick, impact(data));
  }

  rings(path, x, y, reach) {
    for (let r = Moire.SPACING; r < reach; r += Moire.SPACING) {
      path.moveTo(x + r, y);
      path.arc(x, y, r, 0, Math.PI * 2);
    }
  }

  grating(path, cx, cy, angle, reach) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    for (let o = -reach; o <= reach; o += Moire.SPACING) {
      // A line `o` from the centre along the normal, spanning the diagonal.
      const px = cx - s * o;
      const py = cy + c * o;
      path.moveTo(px - c * reach, py - s * reach);
      path.lineTo(px + c * reach, py + s * reach);
    }
  }

  draw(ctx, dt) {
    const M = Moire;
    this.shift = approach(this.shift, this.in('shift'), M.SHIFT_TAU, dt);
    this.turnRate = approach(this.turnRate, this.in('turn'), M.TURN_TAU, dt);
    this.angle += dt * (M.BASE_TURN + M.TURN_GAIN * this.turnRate);
    this.kick *= Math.exp(-M.KICK_DECAY * dt);

    const cx = this.width / 2;
    const cy = this.height / 2;
    const path = new Path2D();

    if (this.pattern === 'lines') {
      const reach = Math.hypot(cx, cy);
      const cross = M.LINE_BASE + M.LINE_GAIN * this.shift + M.LINE_KICK * this.kick;
      this.grating(path, cx, cy, this.angle - cross / 2, reach);
      this.grating(path, cx, cy, this.angle + cross / 2, reach);
    } else {
      const sep = M.SPACING * (M.RING_BASE + M.RING_GAIN * this.shift + M.RING_KICK * this.kick);
      const dx = (Math.cos(this.angle) * sep) / 2;
      const dy = (Math.sin(this.angle) * sep) / 2;
      const reach = Math.hypot(cx, cy) + sep;
      this.rings(path, cx + dx, cy + dy, reach);
      this.rings(path, cx - dx, cy - dy, reach);
    }

    ctx.shadowBlur = 0;
    ctx.lineWidth = M.LINE_WIDTH;
    ctx.strokeStyle = rgba(this.style.lineColor, M.ALPHA);
    ctx.stroke(path);
  }
}
