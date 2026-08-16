import { PointCloudAttractor } from './attractor-base.js';

/**
 * Attractor — a Peter de Jong strange attractor rendered as a drifting
 * point cloud:
 *
 *   x' = sin(a·y) − cos(b·x)
 *   y' = sin(c·x) − cos(d·y)
 *
 * Output is bounded to [-2, 2] by construction, which is why this one never
 * needs the escape guard its siblings rely on.
 */
export class DeJong extends PointCloudAttractor {
  static id = 'attractor';

  static PARAMS = [1.4, -2.3, 2.4, -2.1];
  static DRIFT = 0.35;
  static JOLT = 2.55;
  static SCALE = 0.24;

  step(x, y, p, out) {
    const a = p[0], b = p[1], c = p[2], d = p[3];
    out[0] = Math.sin(a * y) - Math.cos(b * x);
    out[1] = Math.sin(c * x) - Math.cos(d * y);
  }
}
