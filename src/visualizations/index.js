import { EQBars } from './eq-bars.js';
import { Waveform } from './waveform.js';
import { RadialBurst } from './radial-burst.js';
import { PolygonPulse } from './polygon-pulse.js';
import { ParticleField } from './particles.js';
import { Road } from './road.js';
import { Tunnel } from './tunnel.js';
import { RollingBall } from './rolling-ball.js';
import { Starfield } from './starfield.js';
import { Lightning } from './lightning.js';
import { DeJong } from './attractor.js';
import { Clifford } from './clifford.js';
import { Bedhead } from './bedhead.js';
import { Thomas } from './thomas.js';
import { Aizawa } from './aizawa.js';
import { Rossler } from './rossler.js';
import { Halvorsen } from './halvorsen.js';
import { Harmonograph } from './harmonograph.js';
import { BouncingText } from './text.js';
import { CATEGORY, CATEGORIES } from './categories.js';

export { CATEGORY, CATEGORIES };

/** Built-in visualization registry, keyed by the id used in timeline config. */
export const registry = new Map(
  [
    EQBars, Waveform, RadialBurst, PolygonPulse, ParticleField,
    Road, Tunnel, RollingBall, Starfield,
    Lightning, Harmonograph, BouncingText,
    DeJong, Clifford, Bedhead, Thomas, Aizawa, Rossler, Halvorsen,
  ].map((V) => [V.id, V]),
);

/**
 * Timeline ids as constants, so app code can write `VIZ.ROAD` instead of a
 * bare string and get the full list from IDE completion:
 *
 *   { from: 0, to: 20, visualizations: [VIZ.ROAD, VIZ.PARTICLES] }
 *
 * Values are read off each class's `id`, not repeated as literals, so an id
 * rename can't leave this table silently stale. Covers the built-ins only —
 * a class added via register() names its own id.
 */
export const VIZ = Object.freeze({
  EQ_BARS: EQBars.id,
  WAVEFORM: Waveform.id,
  RADIAL_BURST: RadialBurst.id,
  POLYGON_PULSE: PolygonPulse.id,
  PARTICLES: ParticleField.id,
  ROAD: Road.id,
  TUNNEL: Tunnel.id,
  ROLLING_BALL: RollingBall.id,
  STARFIELD: Starfield.id,
  LIGHTNING: Lightning.id,
  HARMONOGRAPH: Harmonograph.id,
  TEXT: BouncingText.id,
  ATTRACTOR: DeJong.id,
  CLIFFORD: Clifford.id,
  BEDHEAD: Bedhead.id,
  THOMAS: Thomas.id,
  AIZAWA: Aizawa.id,
  ROSSLER: Rossler.id,
  HALVORSEN: Halvorsen.id,
});

/** Register a custom visualization class (must have a static `id`). */
export function register(VizClass) {
  registry.set(VizClass.id, VizClass);
}

/** 'radial-burst' → 'Radial Burst', for anything that declares no label. */
const titleCase = (id) => id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Deep copy through JSON, which is also what guarantees the result serializes. */
const copy = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Normalize one `static options` entry: the array shorthand becomes an enum. */
const describeOption = (name, spec) => (Array.isArray(spec)
  ? { name, kind: 'enum', values: [...spec] }
  : { name, ...copy(spec) });

/**
 * Everything a client needs to present one visualization, as plain JSON-safe
 * data: safe to serialize, and a copy, so editing it can't reach the class.
 *
 *   {
 *     id: 'thomas', label: 'Thomas', description: '…', category: 'attractors',
 *     inputs:  [{ name: 'jolt', kind: 'event', default: 'bass' }, …],
 *     options: [{ name: 'distance', kind: 'enum', values: [...], default: 'near' }],
 *   }
 *
 * Accepts an id or a class; returns null for an unknown id.
 */
export function describe(vizOrId) {
  const V = typeof vizOrId === 'string' ? registry.get(vizOrId) : vizOrId;
  if (!V) return null;
  return {
    id: V.id,
    label: V.label ?? titleCase(V.id),
    description: V.description ?? '',
    category: V.category ?? CATEGORY.OTHER,
    inputs: Object.entries(V.inputs ?? {}).map(([name, def]) => ({
      name, kind: def.kind, default: copy(def.default),
    })),
    options: Object.entries(V.options ?? {}).map(([name, spec]) => describeOption(name, spec)),
  };
}

/**
 * The whole registry, described and grouped by category for a picker:
 * categories in CATEGORIES order, visualizations in registration order,
 * empty categories left out. Includes anything added via register(); a
 * category id not in CATEGORIES gets its own group, after the known ones.
 *
 *   for (const { label, visualizations } of catalog()) { … }
 */
export function catalog() {
  const groups = new Map(CATEGORIES.map((c) => [c.id, { ...c, visualizations: [] }]));
  for (const V of registry.values()) {
    const d = describe(V);
    if (!groups.has(d.category)) {
      groups.set(d.category, { id: d.category, label: titleCase(d.category), description: '', visualizations: [] });
    }
    groups.get(d.category).visualizations.push(d);
  }
  // Keep OTHER last even when a custom category was appended after it.
  const other = groups.get(CATEGORY.OTHER);
  groups.delete(CATEGORY.OTHER);
  groups.set(CATEGORY.OTHER, other);
  return [...groups.values()].filter((g) => g.visualizations.length);
}
