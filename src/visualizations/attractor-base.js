import { Visualization, approach } from './base.js';
import { TRIGGER } from '../analyzer.js';

/** Expand a scalar static into one entry per parameter. */
const perParam = (value, n) => (Array.isArray(value) ? value : new Array(n).fill(value));

/**
 * AttractorBase — shared machinery for chaotic-system visualizations.
 *
 * Every attractor here is "a set of parameters, iterated": the parameters
 * orbit slowly (mid energy sets the drift speed), bass hits jolt them to a
 * nearby region of parameter space to morph the figure, and treble sets
 * brightness. That part is identical whether the system is a 2D map drawn
 * as a point cloud or a 3D flow drawn as a ribbon, so it lives here and the
 * two render strategies below extend it.
 *
 * Subclasses configure via statics rather than constructor arguments so a
 * new attractor is a formula plus a handful of numbers:
 *
 *   static PARAMS = [1.4, -2.3]   base parameter vector (any length)
 *   static DRIFT  = 0.35          amplitude of the slow parameter orbit
 *   static JOLT   = 2.55          how far a full-strength bass hit shoves them
 *   static SCALE  = 0.24          world units → fraction of the short screen edge
 *
 * DRIFT and JOLT accept either a scalar (applied to every parameter) or an
 * array with one entry per parameter, for systems whose parameters live on
 * different scales or have different tolerances for being pushed around.
 */
export class AttractorBase extends Visualization {
  static inputs = {
    jolt:  { kind: 'event', default: TRIGGER.BASS },
    drift: { kind: 'level', default: 'mid' },
    glow:  { kind: 'level', default: { band: 'treble', smooth: 0.08 } },
  };

  static PARAMS = [];
  static DRIFT = 0;
  static JOLT = 0;
  static DRIFT_RATE = [0.05, 0.5];   // [idle, added per unit of mid energy]
  static ALPHA = [0.1, 2.35];        // [floor, gain] applied to treble
  static JOLT_DECAY = 1.8;

  constructor(opts) {
    super(opts);
    const n = this.constructor.PARAMS.length;
    this.t = 0;
    this.jolt = new Array(n).fill(0);
    this.params = [...this.constructor.PARAMS];
    this.drift = perParam(this.constructor.DRIFT, n);
    this.joltAmp = perParam(this.constructor.JOLT, n);
  }

  onInput(slot, { strength }) {
    for (let i = 0; i < this.jolt.length; i++) {
      // Clamped, because hits can land faster than the decay clears them and
      // some systems diverge if the parameters wander far enough.
      const amp = this.joltAmp[i];
      const next = this.jolt[i] + (Math.random() * 2 - 1) * strength * amp;
      this.jolt[i] = Math.max(-amp, Math.min(amp, next));
    }
  }

  /** Advance the parameter drift and jolt decay. Fills `this.params`. */
  updateParams(dt) {
    const { PARAMS, DRIFT_RATE, JOLT_DECAY } = this.constructor;
    // Integrated, not assigned — drift energy sets how fast the parameters
    // travel, so a loud frame speeds the morph instead of teleporting it.
    this.t += dt * (DRIFT_RATE[0] + this.in('drift') * DRIFT_RATE[1]);
    const decay = Math.exp(-dt * JOLT_DECAY);
    for (let i = 0; i < PARAMS.length; i++) {
      this.jolt[i] *= decay;
      // Incommensurate drift rates per parameter, so the figure never
      // retraces the same morph cycle.
      this.params[i] = PARAMS[i]
        + Math.sin(this.t * (0.31 + i * 0.13) + i * 2.1) * this.drift[i]
        + this.jolt[i];
    }
  }

  /** Brightness from the `glow` slot, which smooths in its default binding. */
  brightness() {
    const { ALPHA } = this.constructor;
    return Math.min(1, ALPHA[0] + this.in('glow') * ALPHA[1]);
  }
}

/**
 * PointCloudAttractor — for 2D iterated maps (de Jong, Clifford, Bedhead…).
 * Each frame walks the orbit POINTS times from where the last frame stopped
 * and plots every visit, so the cloud is a density sketch of the attractor
 * that re-forms as the parameters drift.
 *
 * Subclasses implement `step(x, y, p, out)`, writing the next point into
 * `out`. It runs thousands of times per frame, so it takes an out-parameter
 * and indexes `p` directly rather than returning or destructuring arrays.
 */
export class PointCloudAttractor extends AttractorBase {
  static POINTS = 3200;
  static SEED = [0.1, 0.1];
  static DOT = 1.4;
  static LIMIT = 1e3;   // orbit escape threshold; beyond this, reseed

  constructor(opts) {
    super(opts);
    this.x = this.constructor.SEED[0];
    this.y = this.constructor.SEED[1];
    this.out = [0, 0];
  }

  step(x, y, p, out) {
    out[0] = x;
    out[1] = y;
  }

  draw(ctx, dt) {
    const { POINTS, SCALE, SEED, DOT, LIMIT } = this.constructor;
    this.updateParams(dt);

    const cx = this.width / 2;
    const cy = this.height / 2;
    const scale = Math.min(this.width, this.height) * SCALE;
    const p = this.params;
    const out = this.out;

    this.applyStyle(ctx);
    ctx.shadowBlur = 0; // thousands of points — glow is unaffordable here
    const baseAlpha = ctx.globalAlpha; // preserve the engine's crossfade
    ctx.globalAlpha = baseAlpha * this.brightness();

    let x = this.x;
    let y = this.y;
    for (let i = 0; i < POINTS; i++) {
      this.step(x, y, p, out);
      x = out[0];
      y = out[1];
      // Written as a failed `<` so NaN trips it too: a jolt can push some
      // maps into a runaway region, and one Infinity poisons the orbit for
      // good. De Jong is bounded by construction; its siblings are not.
      if (!(Math.abs(x) < LIMIT && Math.abs(y) < LIMIT)) {
        x = SEED[0];
        y = SEED[1];
        continue;
      }
      ctx.fillRect(cx + x * scale, cy + y * scale, DOT, DOT);
    }
    this.x = x;
    this.y = y;
    ctx.globalAlpha = baseAlpha;
  }
}

/**
 * FlowAttractor — for 3D continuous systems (Thomas, Lorenz, Aizawa…).
 *
 * Unlike the maps above, these are differential equations whose solution is
 * a single connected trajectory, so scattering points would throw away what
 * makes them worth drawing. Instead the state is integrated with RK4, recent
 * positions are kept in a ring buffer, and the trail is drawn as a rotating
 * projected ribbon that fades toward its tail.
 *
 * Shape motion comes from two places, and they behave differently. Drifting
 * the equation's parameters changes the attractor itself, but only newly
 * integrated points land on the new shape — the visible ribbon takes a full
 * trail-length to catch up, so it reads as slow structural morphing and
 * can't be beat-synced. The beat response is rigid instead: a hit whips the
 * view's yaw rate and briefly swells the whole figure (KICK_SPIN / PULSE),
 * moving every visible point at once without deforming the trail.
 *
 * Subclasses implement `derivative(x, y, z, p, out)`.
 */
export class FlowAttractor extends AttractorBase {
  static inputs = {
    ...AttractorBase.inputs,
    travel: { kind: 'level', default: 'mid' },
    spin:   { kind: 'level', default: 'mid' },
  };

  static TRAIL = 1400;        // positions retained in the ribbon
  static SUBSTEPS = 6;        // integration steps per frame
  static H = 0.05;            // base step size, in the system's own time units
  static SPEED = [1, 1.6];    // [idle, per unit of mid energy] multiplier on H
  static SEED = [0.1, 0, 0];
  static CENTER = [0, 0, 0];  // world-space origin to draw around
  static FOCAL = 9;           // perspective strength, in world units
  static CHUNKS = 8;          // ribbon is stroked in this many fading pieces
  static SPIN = [0.25, 0.6];  // [idle, per unit of mid energy] yaw rate, rad/s
  static LIMIT = 1e4;

  // Draw-time beat response, all of it rigid — a hit whips the yaw and
  // briefly swells the figure. Shearing the trail itself on hits (a
  // strength-driven corkscrew) was tried and cut: displacement proportional
  // to height bends the ribbon like a bone rather than moving it.
  // TWIST is the idle corkscrew, in radians per world unit of height — it
  // scales with the system's extent, so it may need retuning per attractor.
  static TWIST = 0.05;
  static KICK_SPIN = 2.2;   // extra yaw rate at full strength, rad/s
  static PULSE = 0.2;       // radial swell at full strength
  static KICK_DECAY = 3.2;  // exponential rate; ~0.3s time constant

  constructor(opts) {
    super(opts);
    this.state = new Float64Array(this.constructor.SEED);
    this.trail = new Float32Array(this.constructor.TRAIL * 3);
    this.count = 0;
    this.head = 0;
    this.yaw = 0;
    this.spin = this.constructor.SPIN[0];
    this.surge = 0;
    this.kick = 0;
    // Scratch for RK4, preallocated so integration never allocates.
    this.k = [0, 1, 2, 3].map(() => new Float64Array(3));
    this.tmp = new Float64Array(3);
  }

  derivative(x, y, z, p, out) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
  }

  onInput(slot, data) {
    super.onInput(slot, data);
    // Bass surges travel speed as well as nudging parameters: on a system
    // this stiff, parameter jolts alone are too subtle to read as a hit.
    // The kick drives the rigid beat response — yaw whip and swell.
    this.surge = Math.max(this.surge, data.strength);
    this.kick = Math.max(this.kick, data.strength);
  }

  /** One classical RK4 step of size `h`, advancing `this.state` in place. */
  integrate(h, p) {
    const s = this.state;
    const [k1, k2, k3, k4] = this.k;
    const tmp = this.tmp;

    this.derivative(s[0], s[1], s[2], p, k1);
    for (let i = 0; i < 3; i++) tmp[i] = s[i] + (h / 2) * k1[i];
    this.derivative(tmp[0], tmp[1], tmp[2], p, k2);
    for (let i = 0; i < 3; i++) tmp[i] = s[i] + (h / 2) * k2[i];
    this.derivative(tmp[0], tmp[1], tmp[2], p, k3);
    for (let i = 0; i < 3; i++) tmp[i] = s[i] + h * k3[i];
    this.derivative(tmp[0], tmp[1], tmp[2], p, k4);

    for (let i = 0; i < 3; i++) {
      s[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    }
  }

  pushTrail(x, y, z) {
    const i = this.head * 3;
    this.trail[i] = x;
    this.trail[i + 1] = y;
    this.trail[i + 2] = z;
    this.head = (this.head + 1) % this.constructor.TRAIL;
    if (this.count < this.constructor.TRAIL) this.count++;
  }

  draw(ctx, dt) {
    const {
      TRAIL, SUBSTEPS, H, SPEED, SEED, CENTER, SCALE, FOCAL, CHUNKS, SPIN, LIMIT,
      TWIST, KICK_SPIN, PULSE, KICK_DECAY,
    } = this.constructor;
    this.updateParams(dt);

    this.surge = Math.max(0, this.surge - dt * 2.5);
    // Exponential, not linear: a linear ramp ends in a corner where the whip
    // stops dead, which reads as snapping back. This eases out instead.
    this.kick *= Math.exp(-dt * KICK_DECAY);
    const h = H * (SPEED[0] + this.in('travel') * SPEED[1] + this.surge * 1.5);

    const s = this.state;
    for (let i = 0; i < SUBSTEPS; i++) {
      this.integrate(h, this.params);
      if (!(Math.abs(s[0]) < LIMIT && Math.abs(s[1]) < LIMIT && Math.abs(s[2]) < LIMIT)) {
        s.set(SEED);
        this.count = 0;   // drop the trail; it would streak across the screen
        this.head = 0;
      }
      this.pushTrail(s[0], s[1], s[2]);
    }

    // Rotation as a rate, eased, so the view never jumps when the mix shifts.
    // The kick adds a decaying whip on hits — extra *rate*, so the figure
    // accelerates round and eases off rather than jumping to a new angle.
    this.spin = approach(this.spin, SPIN[0] + this.in('spin') * SPIN[1], 0.3, dt);
    this.yaw += (this.spin + this.kick * KICK_SPIN) * dt;
    const pitch = 0.35 + Math.sin(this.t * 0.4) * 0.18;

    // Idle corkscrew rides `this.t`, which advances with mid energy, so the
    // shape keeps writhing between hits and writhes faster when the track is
    // busy. Hits swell the figure uniformly — never shear it.
    const twist = TWIST * Math.sin(this.t * 0.55);
    const swell = 1 + PULSE * this.kick;

    const cx = this.width / 2;
    const cy = this.height / 2;
    const scale = Math.min(this.width, this.height) * SCALE;
    const cosY = Math.cos(this.yaw);
    const sinY = Math.sin(this.yaw);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);

    this.applyStyle(ctx);
    ctx.lineJoin = 'round';
    const baseAlpha = ctx.globalAlpha;
    const bright = this.brightness();
    const glow = this.style.shadowBlur ?? 0;

    // Oldest sample first, so the ribbon is stroked tail → head.
    const start = (this.head - this.count + TRAIL) % TRAIL;
    const per = Math.ceil(this.count / CHUNKS);

    for (let c = 0; c < CHUNKS; c++) {
      const from = c * per;
      // Overlap by one sample so consecutive chunks join without a gap.
      const to = Math.min(this.count, from + per + 1);
      if (to - from < 2) continue;

      ctx.beginPath();
      for (let k = from; k < to; k++) {
        const i = ((start + k) % TRAIL) * 3;
        const x0 = this.trail[i] - CENTER[0];
        const y0 = this.trail[i + 1] - CENTER[1];
        const z0 = this.trail[i + 2] - CENTER[2];

        // Twist by an angle proportional to height, so the structure shears
        // into a corkscrew rather than just spinning, then swell radially.
        const ta = twist * y0;
        const tc = Math.cos(ta);
        const ts = Math.sin(ta);
        const x = (x0 * tc - z0 * ts) * swell;
        const z = (x0 * ts + z0 * tc) * swell;
        const y = y0 * swell;

        const rx = x * cosY - z * sinY;
        const rz = x * sinY + z * cosY;
        const ry = y * cosP - rz * sinP;
        const rzp = y * sinP + rz * cosP;

        const persp = FOCAL / (FOCAL + rzp);
        const sx = cx + rx * scale * persp;
        const sy = cy + ry * scale * persp;
        k === from ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
      }

      const age = (c + 1) / CHUNKS;   // 0 → tail, 1 → head
      // Glow only on the leading piece; a blurred stroke costs a pass over
      // its whole bounding box, and the ribbon spans the screen.
      ctx.shadowBlur = c === CHUNKS - 1 ? glow : 0;
      ctx.strokeStyle = c === CHUNKS - 1
        ? (this.style.accentColor ?? this.style.lineColor)
        : this.style.lineColor;
      ctx.globalAlpha = baseAlpha * bright * age * age;
      ctx.stroke();
    }

    ctx.shadowBlur = 0;
    ctx.globalAlpha = baseAlpha;
  }
}
