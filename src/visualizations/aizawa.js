import { FlowAttractor } from './attractor-base.js';

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
 *   d  is safe across 3.1–3.9 and barely affects stability
 *   e  ≤ 0.15 collapses
 *
 * So `d` carries almost all the morphing here, and everything else moves
 * only slightly. The measured worst case over the whole drift+jolt envelope
 * is no collapse and no divergence, which is what those tight numbers buy.
 */
export class Aizawa extends FlowAttractor {
  static id = 'aizawa';

  static PARAMS = [1.0, 0.70, 0.605, 3.5, 0.25, 0.1];   // [a, b, c, d, e, f]
  // Deliberately lopsided: d ranges ±0.28 and does the visible work, while
  // a, b, c, e and f stay within a few percent of the chaotic sweet spot.
  static DRIFT = [0.006, 0.010, 0.010, 0.16, 0.008, 0.008];
  static JOLT = [0.004, 0.007, 0.007, 0.12, 0.006, 0.006];
  static SCALE = 0.26;

  static SEED = [0.1, 0, 0];
  static CENTER = [0, 0, 0.7];   // the shell sits above the origin in z
  static H = 0.007;              // matches Thomas's step-length-to-body ratio
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
