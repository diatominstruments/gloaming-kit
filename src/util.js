/**
 * Frame-rate independent exponential smoothing toward `target`. `tau` is the
 * time constant in seconds — roughly how long the value takes to cover most
 * of the remaining distance, regardless of frame rate.
 */
export const approach = (current, target, tau, dt) =>
  current + (target - current) * (1 - Math.exp(-dt / tau));

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * How big a response a hit deserves: its prominence against the passage
 * (`strength`, relative) scaled by how loud the passage is (`intensity`,
 * absolute). The floor keeps hits in a quiet passage visible — smaller, not
 * gone. Use `strength` alone to decide whether to react at all.
 */
export const IMPACT_FLOOR = 0.35;
export const impact = ({ strength, intensity = 1 }) =>
  strength * (IMPACT_FLOOR + (1 - IMPACT_FLOOR) * intensity);
