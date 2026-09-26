import { FlowAttractor } from './attractor-base.js';
import { CATEGORY } from './categories.js';

/**
 * Halvorsen — a cyclically symmetric 3D flow:
 *
 *   dx/dt = −a·x − 4y − 4z − y²
 *   dy/dt = −a·y − 4z − 4x − z²
 *   dz/dt = −a·z − 4x − 4y − x²
 *
 * Each axis is driven by the other two plus a square of the next one round,
 * which is the same cyclic construction as [Thomas](thomas.js) but with a
 * very different result. Thomas's sine terms are bounded, so its trajectory
 * roams a lattice of repeating cells; the quadratic terms here are not, so
 * instead of sprawling the orbit gets thrown into three tightly wound horns
 * that meet near the middle. Same symmetry, opposite silhouette — one is
 * diffuse, this one has structure you can point at.
 *
 * The single parameter is unusually sharp-edged, and the drift band is
 * narrow because both sides of it are bad in different ways:
 *
 *   a ≤ 1.2   the quadratic terms win and the orbit escapes to infinity.
 *             The base class reseeds on its LIMIT check, but that drops the
 *             whole trail, which reads on screen as the figure blinking out.
 *   a 1.25–1.55  chaotic, and the interesting range.
 *   a ≥ 1.6   chaos gives way to a periodic orbit — still drawn, but it
 *             stops evolving and just retraces one clean loop.
 *
 * Base 1.42 with the drift and jolt below keeps `a` inside [1.31, 1.53],
 * which measured clean — no divergence and chaotic at every corner of the
 * envelope.
 */
export class Halvorsen extends FlowAttractor {
  static id = 'halvorsen';
  static label = 'Halvorsen';
  static description = 'Halvorsen attractor coiled into three horns running off the frame.';
  static category = CATEGORY.ATTRACTORS;

  static PARAMS = [1.42];
  static DRIFT = [0.06];
  static JOLT = [0.05];
  // Deliberately overscaled: at 0.036 the whole figure sat inside the frame
  // with room to spare, which made the three horns read as a small object on
  // a large background. At 0.09 the body is about 2.4x the short edge, so the
  // horns run off every side and what's on screen is a detail of a structure
  // implied to continue past it. Nothing is lost that the rotation doesn't
  // bring back round.
  static SCALE = 0.09;

  // Off-origin seed: the symmetric point is an equilibrium, so starting at
  // the origin would sit there instead of falling onto the attractor.
  static SEED = [-1.48, -1.51, 2.04];
  // The attractor is centred near (−3, −3, −3) rather than the origin — the
  // cyclic symmetry is about that point, not about zero.
  static CENTER = [-3.1, -3.1, -3.1];
  static H = 0.018;       // 6x; measured clean to 24x, so this is unstressed
  static H_LIMIT = 0.036;
  static FOCAL = 28;   // must clear the ~13 reach from CENTER

  static TWIST = 0.02;   // body half-height ~10

  derivative(x, y, z, p, out) {
    const a = p[0];
    out[0] = -a * x - 4 * y - 4 * z - y * y;
    out[1] = -a * y - 4 * z - 4 * x - z * z;
    out[2] = -a * z - 4 * x - 4 * y - x * x;
  }
}
