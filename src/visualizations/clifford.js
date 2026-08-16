import { PointCloudAttractor } from './attractor-base.js';

/**
 * Clifford — a Clifford Pickover attractor, close kin to de Jong but with a
 * cosine term scaled by its own parameter:
 *
 *   x' = sin(a·y) + c·cos(a·x)
 *   y' = sin(b·x) + d·cos(b·y)
 *
 * Reusing `a` and `b` on both terms is what gives it the layered, filamentary
 * look — the two halves of each coordinate stay locked in frequency while
 * `c` and `d` slide their weight around. Bounded by 1+|c| and 1+|d|, so the
 * drift on those two is what sets how much of the frame it fills.
 */
export class Clifford extends PointCloudAttractor {
  static id = 'clifford';

  static PARAMS = [-1.4, 1.6, 1.0, 0.7];
  static DRIFT = 0.3;
  static JOLT = 0.9;
  static SCALE = 0.26;

  step(x, y, p, out) {
    const a = p[0], b = p[1], c = p[2], d = p[3];
    out[0] = Math.sin(a * y) + c * Math.cos(a * x);
    out[1] = Math.sin(b * x) + d * Math.cos(b * y);
  }
}
