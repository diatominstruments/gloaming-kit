import { FlowAttractor } from './attractor-base.js';
import { CATEGORY } from './categories.js';

/**
 * Aizawa — a 3D flow that winds around a rounded shell while a spindle runs
 * up its axis:
 *
 *   dx/dt = (z − b)·x − d·y
 *   dy/dt = d·x + (z − b)·y
 *   dz/dt = c + a·z − z³/3 − (x² + y²)(1 + e·z) + f·z·x³
 *
 * The first two equations are a rotation about the z axis whose rate is `d`
 * and whose radial gain is `z − b`, so the trajectory spirals outward above
 * z = b and inward below it. The z equation is what closes the loop: the
 * −z³/3 term caps the climb and the −(x² + y²) term pulls the orbit back
 * down once it has wandered wide. The result is a shell that keeps being
 * refilled from the pole, which reads very differently from the sprawling
 * lattice of [Thomas](thomas.js).
 *
 * Tuning note, because this system is fussier than its siblings. Its chaotic
 * region is small and it sits directly against a region where the attractor
 * collapses onto a fixed point — not a divergence the base class's LIMIT
 * guard would catch and reseed, but a silent shrink to a stationary dot.
 * Sweeping the parameters found:
 *
 *   a  ≥ 1.06 collapses; chaos lives around 0.95–1.05
 *   b  and c collapse jointly — either alone is fine down to b 0.66 / c 0.56,
 *      but low *together* is dead, which is the trap worth knowing about
 *   d  barely affects stability at any magnitude, either sign
 *   e  ≤ 0.15 collapses
 *
 * Two of those are now driven hard, and both needed re-measuring:
 *
 *   d at −14 rather than 3.5 spins the shell four times faster and reverses
 *     it, winding the trajectory into tight spirals up the spindle. The cost
 *     is honest: at this rate the system is no longer meaningfully chaotic
 *     (largest Lyapunov ~0.005 against ~0.11 at d = 3.5) — it is a fast
 *     periodic winding. It does not decay, drift or collapse, it just stops
 *     inventing new structure. What moves instead is b.
 *   b is squeezed between two different failures and gets 0.72–0.82. Below,
 *     it dies: b is safe to 0.68 with everything else centred but only to
 *     ~0.72 once c is simultaneously at the bottom of its own band — the
 *     joint collapse above — and by 0.62 the whole thing is a stationary dot.
 *     Above, it doesn't die, it just goes dull: the inner windings wash out
 *     and by 0.84 the figure is a plain smooth torus with nothing inside it,
 *     which is worse to look at than the collapse is dangerous. The base and
 *     amplitudes are set so base ± (drift + jolt) lands inside both limits.
 *
 * The temptation with b is to give it a wide band and let the shell breathe
 * in and out. It doesn't work — everything wider than this is either dead or
 * dull, and the effect it was reaching for is better had from the camera:
 * `options: { distance: 'near' }` puts the viewer inside the spindle with the
 * windings sweeping past, which costs nothing and can't collapse.
 *
 * Every corner of the six-parameter drift+jolt envelope was re-checked at
 * both the idle and the clamped step: no divergence, no collapse, and the
 * body never reaches the focal length.
 */
export class Aizawa extends FlowAttractor {
  static id = 'aizawa';
  static label = 'Aizawa';
  static description = 'Aizawa attractor as a shell wound into tight spirals by a fast spin.';
  static category = CATEGORY.ATTRACTORS;

  static PARAMS = [1.0, 0.77, 0.605, -14, 0.25, 0.1];   // [a, b, c, d, e, f]
  // d's drift is scaled up with its magnitude so it stays the same few-percent
  // wobble it always was. b gets a little more room than before but nothing
  // like free rein — see the note above.
  static DRIFT = [0.006, 0.035, 0.010, 0.64, 0.008, 0.008];
  static JOLT = [0.004, 0.015, 0.007, 0.48, 0.006, 0.006];
  static SCALE = 0.26;

  static SEED = [0.1, 0, 0];
  static CENTER = [0, 0, 0.7];   // the shell sits above the origin in z
  // The odd one out: this is *below* the old 0.06-era step, not above it,
  // because d at 14 spins the trajectory four times faster than d at 3.5 did.
  // Per-sample travel is what has to stay bounded, not the step number.
  static H = 0.013;
  static H_LIMIT = 0.026;
  static FOCAL = 3.5;            // world units, so it scales with the ±1.7 body

  // Body half-height is ~1.5, so the per-unit rate is much larger than
  // Thomas's to reach the same ~0.2 rad of twist across the figure.
  static TWIST = 0.13;

  derivative(x, y, z, p, out) {
    const a = p[0], b = p[1], c = p[2], d = p[3], e = p[4], f = p[5];
    const zb = z - b;
    const r2 = x * x + y * y;
    out[0] = zb * x - d * y;
    out[1] = d * x + zb * y;
    out[2] = c + a * z - (z * z * z) / 3 - r2 * (1 + e * z) + f * z * x * x * x;
  }
}
