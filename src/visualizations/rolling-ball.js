import { Visualization, approach } from './base.js';
import { TRIGGER } from '../analyzer.js';

/**
 * RollingBall — a latitude/longitude wireframe sphere tumbling in the centre
 * of the screen. Snare hits swerve it onto a new heading.
 *
 * The roll is real, not a spin: for a ball rolling across the screen plane in
 * direction θ, the rotation axis is perpendicular to θ *within that plane*,
 * so the axis is (-sinθ, cosθ, 0) and the grid sweeps over the visible face
 * rather than pinwheeling flat. Changing θ therefore changes which way the
 * ball tumbles without ever moving it — orientation stays continuous across a
 * swerve, so a hard direction change still reads as smooth.
 *
 * Orientation accumulates into a 3x3 matrix, incrementally pre-multiplied so
 * each frame's rotation is applied in screen space. Repeated float multiplies
 * drift off the orthogonal manifold and would slowly shear the sphere into an
 * ellipsoid, so the basis is re-orthonormalized every frame — it's nine
 * multiplies and two square roots, far cheaper than the artifact.
 *
 * Drawing is two batched paths regardless of grid density: every polyline is
 * split at the horizon (z = 0) and routed into a dim "back of the sphere"
 * path or a bright front one. That depth cue is what makes a flat wireframe
 * read as a solid ball, and it costs two strokes rather than one per segment.
 */
export class RollingBall extends Visualization {
  static id = 'rolling-ball';
  static inputs = {
    swerve: { kind: 'event', default: TRIGGER.SNARE },
    speed:  { kind: 'level', default: 'rms' },
    swell:  { kind: 'level', default: 'bass' },
  };

  static LATITUDES = 7;      // rings between the poles
  static MERIDIANS = 12;     // pole-to-pole half circles
  static RESOLUTION = 48;    // points per full circle

  static RADIUS = 0.3;       // of the smaller screen dimension
  static SWELL = 0.14;       // extra radius at full `swell`

  static BASE_SPIN = 0.9;    // rad/s at silence
  static SPIN_GAIN = 2.4;    // extra rad/s at full `speed`
  static SPIN_TAU = 0.35;    // roll rate is smoothed; tracking level directly
                             // makes the tumble stutter frame to frame
  static TURN_TAU = 0.12;    // heading ease; small enough to read as a swerve
  static MIN_TURN = 0.9;     // radians; smallest swerve a hit can produce
  static MAX_TURN = 2.4;     // radians; largest, at full strength
  static KICK_DECAY = 2.5;   // per second, for the post-hit speed surge

  static BACK_ALPHA = 0.22;  // far hemisphere, relative to the near one

  constructor(opts) {
    super(opts);
    this.lines = RollingBall.buildWireframe();
    // Row-major 3x3, identity. Rows are the rotated basis vectors.
    this.m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.heading = 0;        // current roll direction, radians (y up)
    this.targetHeading = 0;  // where a swerve is steering it
    this.spin = RollingBall.BASE_SPIN;
    this.kick = 0;
  }

  /** Unit-sphere polylines: latitude rings plus pole-to-pole meridians. */
  static buildWireframe() {
    const { LATITUDES, MERIDIANS, RESOLUTION } = RollingBall;
    const lines = [];

    for (let i = 1; i <= LATITUDES; i++) {
      const phi = (i / (LATITUDES + 1)) * Math.PI;   // poles excluded
      const sp = Math.sin(phi);
      const cp = Math.cos(phi);
      const pts = new Float32Array((RESOLUTION + 1) * 3);
      for (let j = 0; j <= RESOLUTION; j++) {
        const th = (j / RESOLUTION) * Math.PI * 2;
        pts[j * 3] = sp * Math.cos(th);
        pts[j * 3 + 1] = cp;
        pts[j * 3 + 2] = sp * Math.sin(th);
      }
      lines.push(pts);
    }

    const half = Math.round(RESOLUTION / 2);
    for (let i = 0; i < MERIDIANS; i++) {
      const th = (i / MERIDIANS) * Math.PI * 2;
      const ct = Math.cos(th);
      const st = Math.sin(th);
      const pts = new Float32Array((half + 1) * 3);
      for (let j = 0; j <= half; j++) {
        const phi = (j / half) * Math.PI;
        const sp = Math.sin(phi);
        pts[j * 3] = sp * ct;
        pts[j * 3 + 1] = Math.cos(phi);
        pts[j * 3 + 2] = sp * st;
      }
      lines.push(pts);
    }

    return lines;
  }

  onInput(slot, { strength }) {
    if (slot !== 'swerve') return;
    const { MIN_TURN, MAX_TURN } = RollingBall;
    // Harder hits swing the ball further round. The target is nudged rather
    // than set, so back-to-back hits compound into a tight curve.
    const turn = MIN_TURN + strength * (MAX_TURN - MIN_TURN);
    this.targetHeading += (Math.random() < 0.5 ? -1 : 1) * turn;
    this.kick = Math.max(this.kick, strength);
  }

  /**
   * Pre-multiply the accumulated orientation by a rotation of `angle` about
   * the screen-space axis (ax, ay, 0), then pull the basis back onto the
   * orthonormal manifold it drifts off of.
   */
  rotate(ax, ay, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;
    // Axis-angle matrix, with az = 0 substituted through.
    const r = [
      t * ax * ax + c, t * ax * ay, s * ay,
      t * ax * ay, t * ay * ay + c, -s * ax,
      -s * ay, s * ax, c,
    ];

    const m = this.m;
    const out = new Array(9);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        out[i * 3 + j] = r[i * 3] * m[j] + r[i * 3 + 1] * m[3 + j] + r[i * 3 + 2] * m[6 + j];
      }
    }

    // Gram-Schmidt: normalize row 0, make row 1 perpendicular to it, and take
    // row 2 as their cross product so the basis stays right-handed.
    let n = Math.hypot(out[0], out[1], out[2]) || 1;
    out[0] /= n; out[1] /= n; out[2] /= n;
    const d = out[0] * out[3] + out[1] * out[4] + out[2] * out[5];
    out[3] -= out[0] * d; out[4] -= out[1] * d; out[5] -= out[2] * d;
    n = Math.hypot(out[3], out[4], out[5]) || 1;
    out[3] /= n; out[4] /= n; out[5] /= n;
    out[6] = out[1] * out[5] - out[2] * out[4];
    out[7] = out[2] * out[3] - out[0] * out[5];
    out[8] = out[0] * out[4] - out[1] * out[3];

    this.m = out;
  }

  draw(ctx, dt) {
    const {
      BASE_SPIN, SPIN_GAIN, SPIN_TAU, TURN_TAU, KICK_DECAY, RADIUS, SWELL, BACK_ALPHA,
    } = RollingBall;

    const cx = this.width / 2;
    const cy = this.height / 2;

    this.kick = Math.max(0, this.kick - dt * KICK_DECAY);
    this.heading = approach(this.heading, this.targetHeading, TURN_TAU, dt);
    this.spin = approach(this.spin, BASE_SPIN + this.in('speed') * SPIN_GAIN, SPIN_TAU, dt);

    // Axis is perpendicular to the heading, in the screen plane — that is what
    // makes this a roll rather than a flat spin.
    this.rotate(-Math.sin(this.heading), Math.cos(this.heading), (this.spin + this.kick * 2) * dt);

    const m = this.m;
    const radius = Math.min(this.width, this.height) * RADIUS
      * (1 + this.in('swell') * SWELL + this.kick * 0.06);

    const back = new Path2D();
    const front = new Path2D();

    for (const pts of this.lines) {
      let prevPath = null;
      let px = 0;
      let py = 0;
      let pz = 0;

      for (let i = 0; i < pts.length; i += 3) {
        const x = pts[i];
        const y = pts[i + 1];
        const z = pts[i + 2];
        const rx = m[0] * x + m[1] * y + m[2] * z;
        const ry = m[3] * x + m[4] * y + m[5] * z;
        const rz = m[6] * x + m[7] * y + m[8] * z;

        const sx = cx + rx * radius;
        const sy = cy - ry * radius;   // canvas y grows downward
        const path = rz >= 0 ? front : back;

        if (prevPath === null) {
          path.moveTo(sx, sy);
        } else if (path === prevPath) {
          path.lineTo(sx, sy);
        } else {
          // Crossed the horizon: land both runs on the same interpolated
          // silhouette point so the hemispheres meet without a gap.
          const t = pz / (pz - rz);
          const mx = px + (sx - px) * t;
          const my = py + (sy - py) * t;
          prevPath.lineTo(mx, my);
          path.moveTo(mx, my);
          path.lineTo(sx, sy);
        }

        prevPath = path;
        px = sx;
        py = sy;
        pz = rz;
      }
    }

    const baseAlpha = ctx.globalAlpha;   // engine crossfade
    this.applyStyle(ctx);

    ctx.globalAlpha = baseAlpha * BACK_ALPHA;
    ctx.shadowBlur = 0;
    ctx.stroke(back);

    ctx.globalAlpha = baseAlpha;
    ctx.shadowBlur = this.style.shadowBlur ?? 0;
    ctx.stroke(front);

    // Silhouette, in the accent colour, brightening on a hit.
    ctx.globalAlpha = baseAlpha * (0.35 + this.kick * 0.5);
    ctx.strokeStyle = this.style.accentColor ?? this.style.lineColor;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.globalAlpha = baseAlpha;
  }
}
