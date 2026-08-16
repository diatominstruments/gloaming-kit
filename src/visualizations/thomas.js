import { FlowAttractor } from './attractor-base.js';

/**
 * Thomas — René Thomas's cyclically symmetric attractor, a 3D flow:
 *
 *   dx/dt = sin(ω·y) − b·x
 *   dy/dt = sin(ω·z) − b·y
 *   dz/dt = sin(ω·x) − b·z
 *
 * Each axis is driven by the next one around, which is what makes the
 * trajectory wander through a lattice of cells with the same shape in every
 * direction — it looks the same from any of the three axes.
 *
 * Two knobs, and they deform the figure in different ways:
 *
 *   b (damping) sets how much of the lattice the trajectory explores. Near
 *     0.10 it sprawls through many cells as "labyrinth chaos"; toward 0.26 it
 *     pulls into a tight knot, and past ~0.32 chaos collapses into a plain
 *     limit cycle. The drift range here stays inside the interesting band.
 *   ω (frequency) scales the lattice itself — cell size goes as 1/ω, so
 *     drifting it makes the whole structure breathe in and out.
 *
 * Both are slow by nature: the ribbon only shows a new shape once the
 * trajectory has traced it, which takes about a trail-length. Beat-synced
 * motion comes from TWIST and PULSE, which deform the drawn trail directly.
 */
export class Thomas extends FlowAttractor {
  static id = 'thomas';

  static PARAMS = [0.18, 1.0];       // [b damping, ω lattice frequency]
  static DRIFT = [0.05, 0.09];       // b ∈ [0.13, 0.23], ω ∈ [0.91, 1.09]
  static JOLT = [0.025, 0.04];       // hits widen those to [0.105, 0.255], [0.87, 1.13]
  static SCALE = 0.1;

  static SEED = [1.1, 1.1, -0.01];
  static H = 0.06;
  static FOCAL = 9;

  // Tuned for this system's ±4.5 extent: ~0.2 rad of corkscrew across the
  // body at idle, opening to ~1.5 rad on a full-strength hit.
  static TWIST = [0.045, 0.33];
  static PULSE = 0.22;

  derivative(x, y, z, p, out) {
    const b = p[0], w = p[1];
    out[0] = Math.sin(w * y) - b * x;
    out[1] = Math.sin(w * z) - b * y;
    out[2] = Math.sin(w * x) - b * z;
  }
}
