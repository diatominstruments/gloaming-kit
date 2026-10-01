/**
 * Visualization categories, for grouping the library in pickers and menus.
 *
 * Kept apart from index.js so visualization modules can import CATEGORY
 * without a cycle through the registry that imports them.
 *
 * A visualization names its category with `static category = CATEGORY.MOTION`.
 * One that names none, or names a category not listed here, still appears in
 * catalog() — the former under OTHER, the latter in a group of its own.
 */
export const CATEGORY = Object.freeze({
  CLASSIC: 'classic',
  MOTION: 'motion',
  CHAOS: 'chaos',
  ATTRACTORS: 'attractors',
  SPACES: 'spaces',
  GLYPHS: 'glyphs',
  BACKGROUNDS: 'backgrounds',
  OVERLAYS: 'overlays',
  OTHER: 'other',
});

/** Display metadata for each category, in the order a picker should list them. */
export const CATEGORIES = Object.freeze([
  {
    id: CATEGORY.CLASSIC,
    label: 'Classic',
    description: 'Spectrum, waveform and shape displays that react in place.',
  },
  {
    id: CATEGORY.MOTION,
    label: 'Motion',
    description: 'Perspective scenes that put the viewer in motion; the sound shapes what you fly past.',
  },
  {
    id: CATEGORY.CHAOS,
    label: 'Chaos',
    description: 'Branching and recursive figures steered by the sound.',
  },
  {
    id: CATEGORY.ATTRACTORS,
    label: 'Attractors',
    description: 'Strange attractors whose parameters drift with the music and jolt on hits.',
  },
  {
    id: CATEGORY.SPACES,
    label: 'Spaces',
    description: 'Native 3D worlds and volumes to fly through and look into. Need 3D; each falls back to a 2D cousin.',
  },
  {
    id: CATEGORY.GLYPHS,
    label: 'Glyphs',
    description: 'Structures grown from a small drawing: each takes a `glyph` option, a grid of cells at a few strengths, and builds from it.',
  },
  {
    id: CATEGORY.BACKGROUNDS,
    label: 'Backgrounds',
    description: 'Full-screen fields that sit behind everything else and breathe with the mix.',
  },
  {
    id: CATEGORY.OVERLAYS,
    label: 'Overlays',
    description: 'Screen treatments laid over everything else.',
  },
  {
    id: CATEGORY.OTHER,
    label: 'Other',
    description: 'Visualizations that declare no category.',
  },
].map(Object.freeze));
