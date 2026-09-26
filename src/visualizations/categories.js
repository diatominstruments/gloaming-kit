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
    id: CATEGORY.OTHER,
    label: 'Other',
    description: 'Visualizations that declare no category.',
  },
].map(Object.freeze));
