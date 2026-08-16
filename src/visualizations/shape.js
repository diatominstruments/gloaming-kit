/**
 * Waveform → fixed-length shape arrays, shared by the perspective
 * visualizations (road, tunnel) that extrude a line from the sound.
 *
 * There are two reductions here and they are NOT interchangeable:
 *
 *   sampleTrace     signed average of each slice — an oscilloscope trace.
 *                   Keeps the wave's shape, but the analyzer hands us a
 *                   window at an arbitrary phase every frame, so a trace is
 *                   only meaningful as a frozen snapshot.
 *   sampleEnvelope  RMS of each slice — unsigned, so phase drops out.
 *                   Consecutive frames broadly agree, which makes it the one
 *                   that survives being smoothed over time.
 *
 * That distinction is the whole reason live lines follow an envelope rather
 * than a trace: averaging successive traces cancels toward flat, because each
 * one arrives at a random phase. Averaging successive envelopes doesn't.
 */

/** Signed per-slice average, in roughly -1..1. The oscilloscope shape. */
export function sampleTrace(wf, segments) {
  const shape = new Float32Array(segments);
  if (!wf) return shape;
  const stride = wf.length / segments;
  for (let i = 0; i < segments; i++) {
    // Average the slice so single-sample spikes don't dominate.
    let sum = 0;
    const s0 = Math.floor(i * stride);
    const s1 = Math.floor((i + 1) * stride);
    for (let j = s0; j < s1; j++) sum += wf[j] - 128;
    shape[i] = sum / ((s1 - s0) * 128);
  }
  return shape;
}

/** Unsigned per-slice RMS, in 0..1. Phase-independent, so it's smoothable. */
export function sampleEnvelope(wf, segments) {
  const env = new Float32Array(segments);
  if (!wf) return env;
  const stride = wf.length / segments;
  for (let i = 0; i < segments; i++) {
    let sum = 0;
    const s0 = Math.floor(i * stride);
    const s1 = Math.floor((i + 1) * stride);
    for (let j = s0; j < s1; j++) {
      const v = (wf[j] - 128) / 128;
      sum += v * v;
    }
    env[i] = Math.sqrt(sum / (s1 - s0));
  }
  return env;
}

/**
 * Expander: push envelope values below `floor` onto zero, and rescale what
 * survives back to 0..1. Mutates and returns `env`.
 *
 * Needed because RMS never reaches zero while anything at all is playing —
 * it has a floor well above the signed trace it stands in for (RMS >= |mean|
 * for any slice, and the gap widens with high-frequency content, which
 * cancels in a signed average but not in RMS). Without an expander a line
 * driven by an envelope eases to a permanently inflated resting value and has
 * nothing to come back down to, which reads as the line getting stuck high
 * rather than tracking the music.
 */
export function expandEnvelope(env, floor) {
  if (!(floor > 0)) return env;
  const span = 1 - floor;
  for (let i = 0; i < env.length; i++) {
    env[i] = env[i] > floor ? (env[i] - floor) / span : 0;
  }
  return env;
}

/**
 * Which side of the line each segment sits on, captured once from a trace.
 * A live line keeps this silhouette for its whole flight and lets the
 * envelope drive only how far each point swings out — without it, an
 * unsigned envelope would fold the line onto one side of the axis.
 */
export function signsOf(shape) {
  const signs = new Float32Array(shape.length);
  // Not Math.sign: a slice that happened to average exactly 0 would pin that
  // point to the axis permanently.
  for (let i = 0; i < shape.length; i++) signs[i] = shape[i] < 0 ? -1 : 1;
  return signs;
}
