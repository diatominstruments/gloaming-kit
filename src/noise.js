/**
 * Seeded gradient noise, for visualizations that want smooth organic fields
 * rather than per-frame randomness.
 *
 *   const noise = createNoise3D(7);
 *   noise(x, y, t)                       // one octave, about -1..1
 *   fbm(noise, x, y, t, { octaves: 3 })  // layered octaves, about -1..1
 *
 * Ken Perlin's improved noise (2002): lattice gradients on a permutation
 * table, blended with the quintic fade so the field has no visible grid
 * creases. The third coordinate is usually time — sliding along it morphs
 * the 2D slice in place rather than scrolling it.
 *
 * Seeded rather than Math.random so a field is reproducible and two
 * instances can share one (text ghosts drifting through the same currents
 * as a glow behind them) or deliberately differ.
 */

/** Small fast seeded PRNG; returns floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

/** Dot product of the 12 cube-edge gradients (Perlin's grad) with (x, y, z). */
function grad(hash, x, y, z) {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
}

/**
 * A 3D noise function for one seed. Output is continuous, 0 at every
 * integer lattice point, and stays within about ±1.
 */
export function createNoise3D(seed = 0) {
  const rand = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  // Doubled so lookups can index past 255 without wrapping.
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  return (x, y, z) => {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const fz = Math.floor(z);
    const X = fx & 255;
    const Y = fy & 255;
    const Z = fz & 255;
    x -= fx; y -= fy; z -= fz;
    const u = fade(x);
    const v = fade(y);
    const w = fade(z);

    const A = perm[X] + Y;
    const AA = perm[A] + Z;
    const AB = perm[A + 1] + Z;
    const B = perm[X + 1] + Y;
    const BA = perm[B] + Z;
    const BB = perm[B + 1] + Z;

    return lerp(
      lerp(
        lerp(grad(perm[AA], x, y, z), grad(perm[BA], x - 1, y, z), u),
        lerp(grad(perm[AB], x, y - 1, z), grad(perm[BB], x - 1, y - 1, z), u),
        v,
      ),
      lerp(
        lerp(grad(perm[AA + 1], x, y, z - 1), grad(perm[BA + 1], x - 1, y, z - 1), u),
        lerp(grad(perm[AB + 1], x, y - 1, z - 1), grad(perm[BB + 1], x - 1, y - 1, z - 1), u),
        v,
      ),
      w,
    );
  };
}

/**
 * Fractal Brownian motion: `octaves` copies of the noise, each at
 * `lacunarity` times the frequency and `gain` times the amplitude of the
 * last, normalized so the result keeps the single octave's range. More
 * octaves add fine detail on top of the same broad shapes.
 */
export function fbm(noise, x, y, z, { octaves = 3, lacunarity = 2, gain = 0.5 } = {}) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x, y, z);
    norm += amp;
    x *= lacunarity;
    y *= lacunarity;
    // Offset z per octave so octaves don't share lattice zeros at z = 0.
    z = z * lacunarity + 17.3;
    amp *= gain;
  }
  return sum / norm;
}
