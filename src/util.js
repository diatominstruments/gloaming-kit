/**
 * Frame-rate independent exponential smoothing toward `target`. `tau` is the
 * time constant in seconds — roughly how long the value takes to cover most
 * of the remaining distance, regardless of frame rate.
 */
export const approach = (current, target, tau, dt) =>
  current + (target - current) * (1 - Math.exp(-dt / tau));

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
