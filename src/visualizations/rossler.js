import { FlowAttractor } from './attractor-base.js';

/**
 * Rössler — a 3D flow built from a single fold, and the flattest thing in
 * this family:
 *
 *   dx/dt = −y − z
 *   dy/dt = x + a·y
 *   dz/dt = b + z(x − c)
 *
 * The x and y equations are a plain outward spiral in the plane, so the
 * trajectory spends nearly all its time drawing a broad disc. The z equation
 * does nothing at all while x < c — z stays pinned near zero — and then turns
 * sharply positive once the spiral has widened past that threshold, throwing
 * the trajectory up out of the plane and dropping it back near the middle to
 * start again.
 *
 * That asymmetry is the reason to draw it: unlike the space-filling systems
 * here, it has a genuine silhouette — a disc with one lifted fold — so the
 * base class's rotating ribbon actually shows something new as the view
 * turns, rather than an equally dense cloud from every angle.
 *
 * Two things about the parameters:
 *
 *   c sets how wide the spiral gets before it folds, so the whole figure
 *     grows with it — roughly radius 8.7 at c = 4.8 up to 15 at c = 6.6.
 *     Drift on c therefore reads as the attractor breathing in and out.
 *     Below about 4.2 the chaos collapses into a plain limit cycle.
 *   a is the dangerous one. It sets the spiral's outward gain, and the
 *     excursion grows fast with it — at c = 6 the farthest reach goes from
 *     ~15 at a = 0.17 to ~34 at a = 0.24. It gets very little room here.
 *
 * The z spike is tall enough that scaling the whole excursion into frame
 * would leave the disc tiny, so SCALE is set for the disc and the occasional
 * spike is allowed to run to the edge — it's brief, and the ribbon fades.
 */
export class Rossler extends FlowAttractor {
  static id = 'rossler';

  static PARAMS = [0.2, 0.2, 5.6];   // [a spiral gain, b, c fold threshold]
  static DRIFT = [0.010, 0.02, 0.25];
  static JOLT = [0.008, 0.015, 0.15];
  static SCALE = 0.022;

  static SEED = [0.1, 0, 0];
  // z never goes negative and spikes to ~26, so the drawn origin is lifted to
  // sit the disc near the middle of the frame rather than at the bottom.
  static CENTER = [0.2, -0.9, 4.0];
  static H = 0.015;
  // Must exceed the farthest reach from CENTER (~30) or the perspective
  // divide changes sign and points invert through the origin.
  static FOCAL = 60;

  static TWIST = 0.02;   // body half-height ~10

  derivative(x, y, z, p, out) {
    const a = p[0], b = p[1], c = p[2];
    out[0] = -y - z;
    out[1] = x + a * y;
    out[2] = b + z * (x - c);
  }
}
