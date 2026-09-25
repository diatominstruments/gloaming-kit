import { Visualization, approach } from './base.js';

/**
 * BouncingText — a string drifting around the screen like an idle DVD logo.
 * It reflects off the edges, and whenever the `bounce` level rises past a
 * threshold it swings onto a new heading mid-flight.
 *
 * `bounce` is a level slot rather than an event slot so any band or signal
 * can drive it — `bind: { bounce: 'treble' }`, `{ band: 'mid', gain: 2 }` —
 * with the threshold set per instance. The crossing uses hysteresis: after a
 * bounce the level has to fall back below `threshold * REARM` before it can
 * fire again, or a level hovering at the line would jitter the heading every
 * frame.
 *
 * Options:
 *   text       the string to draw (default 'GLOAMING')
 *   threshold  level at which `bounce` turns the text (default 0.6)
 */
export class BouncingText extends Visualization {
  static id = 'text';
  static label = 'Bouncing Text';
  static inputs = {
    bounce: { kind: 'level', default: 'bass' },
    speed:  { kind: 'level', default: 'rms' },
  };

  static TEXT = 'GLOAMING';
  static THRESHOLD = 0.6;
  static REARM = 0.8;        // fraction of threshold the level must drop below

  static SIZE = 0.12;        // font size, of the smaller screen dimension
  static BASE_SPEED = 0.12;  // of the screen diagonal per second, at silence
  static SPEED_GAIN = 0.35;  // extra at full `speed`
  static SPEED_TAU = 0.4;    // speed is smoothed so loudness swings don't stutter
  static MIN_TURN = 0.6;     // radians; smallest heading change on a bounce
  static MAX_TURN = 2.2;     // radians; largest
  static POP = 0.18;         // extra scale right after a bounce
  static POP_DECAY = 3;      // per second

  constructor(opts) {
    super(opts);
    this.text = String(this.options.text ?? BouncingText.TEXT);
    this.threshold = this.options.threshold ?? BouncingText.THRESHOLD;
    this.armed = true;
    this.pop = 0;
    this.speed = BouncingText.BASE_SPEED;

    // Normalized position (0..1 of the free area) so a resize keeps it in frame.
    this.u = Math.random();
    this.v = Math.random();
    const heading = Math.random() * Math.PI * 2;
    this.dx = Math.cos(heading);
    this.dy = Math.sin(heading);
  }

  font(size) {
    return `bold ${size}px ${this.style.fontFamily ?? 'sans-serif'}`;
  }

  turn() {
    const { MIN_TURN, MAX_TURN } = BouncingText;
    const angle = (Math.random() < 0.5 ? -1 : 1)
      * (MIN_TURN + Math.random() * (MAX_TURN - MIN_TURN));
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    [this.dx, this.dy] = [this.dx * c - this.dy * s, this.dx * s + this.dy * c];
    this.pop = 1;
  }

  draw(ctx, dt) {
    const {
      SIZE, BASE_SPEED, SPEED_GAIN, SPEED_TAU, REARM, POP, POP_DECAY,
    } = BouncingText;

    const level = this.in('bounce');
    if (this.armed && level >= this.threshold) {
      this.turn();
      this.armed = false;
    } else if (!this.armed && level < this.threshold * REARM) {
      this.armed = true;
    }

    this.pop = Math.max(0, this.pop - dt * POP_DECAY);
    this.speed = approach(this.speed, BASE_SPEED + this.in('speed') * SPEED_GAIN, SPEED_TAU, dt);

    const size = Math.min(this.width, this.height) * SIZE;
    ctx.font = this.font(size);
    const m = ctx.measureText(this.text);
    const w = m.width;
    const h = (m.actualBoundingBoxAscent ?? size * 0.75) + (m.actualBoundingBoxDescent ?? 0);

    // Move in pixels, store normalized. The free area is what's left once the
    // text's own box is subtracted; text wider than the screen just sits centred.
    const freeW = Math.max(0, this.width - w);
    const freeH = Math.max(0, this.height - h);
    const step = this.speed * Math.hypot(this.width, this.height) * dt;
    if (freeW > 0) this.u += (this.dx * step) / freeW;
    if (freeH > 0) this.v += (this.dy * step) / freeH;

    // Reflect off the edges.
    if (this.u < 0) { this.u = -this.u; this.dx = Math.abs(this.dx); }
    if (this.u > 1) { this.u = 2 - this.u; this.dx = -Math.abs(this.dx); }
    if (this.v < 0) { this.v = -this.v; this.dy = Math.abs(this.dy); }
    if (this.v > 1) { this.v = 2 - this.v; this.dy = -Math.abs(this.dy); }
    this.u = Math.min(1, Math.max(0, this.u));
    this.v = Math.min(1, Math.max(0, this.v));

    const cx = (freeW ? this.u * freeW : (this.width - w) / 2) + w / 2;
    const cy = (freeH ? this.v * freeH : (this.height - h) / 2) + h / 2;

    this.applyStyle(ctx);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.translate(cx, cy);
    const scale = 1 + this.pop * POP;
    ctx.scale(scale, scale);
    ctx.fillText(this.text, 0, 0);
    if (this.pop > 0) {
      const baseAlpha = ctx.globalAlpha;
      ctx.globalAlpha = baseAlpha * this.pop;
      ctx.strokeStyle = this.style.accentColor ?? this.style.lineColor;
      ctx.lineWidth = 1.5;
      ctx.strokeText(this.text, 0, 0);
      ctx.globalAlpha = baseAlpha;
    }
    ctx.restore();
    ctx.shadowBlur = 0;
  }
}
