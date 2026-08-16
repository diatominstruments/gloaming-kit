import { PointCloudAttractor } from './attractor-base.js';

/**
 * Bedhead — an Ivan Emrich attractor:
 *
 *   x' = sin(x·y / b)·y + cos(a·x − y)
 *   y' = x + sin(y) / b
 *
 * The x·y coupling inside the sine gives it the asymmetric, swept-hair
 * whorls it's named for. Only two parameters, and both drift and jolt are
 * kept small here: `b` divides, so it must never be allowed to reach zero.
 * With base -0.92, drift 0.12 and jolt clamped at 0.2, it stays inside
 * roughly [-1.24, -0.6].
 */
export class Bedhead extends PointCloudAttractor {
  static id = 'bedhead';

  static PARAMS = [-0.81, -0.92];
  static DRIFT = 0.12;
  static JOLT = 0.2;
  static SCALE = 0.34;

  step(x, y, p, out) {
    const a = p[0], b = p[1];
    out[0] = Math.sin(x * y / b) * y + Math.cos(a * x - y);
    out[1] = x + Math.sin(y) / b;
  }
}
