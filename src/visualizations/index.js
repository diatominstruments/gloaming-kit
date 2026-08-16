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
import { Harmonograph } from './harmonograph.js';

/** Built-in visualization registry, keyed by the id used in timeline config. */
export const registry = new Map(
  [
    EQBars, Waveform, RadialBurst, PolygonPulse, ParticleField,
    Road, Tunnel, RollingBall, Starfield,
    Lightning, Harmonograph,
    DeJong, Clifford, Bedhead, Thomas,
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
  ATTRACTOR: DeJong.id,
  CLIFFORD: Clifford.id,
  BEDHEAD: Bedhead.id,
  THOMAS: Thomas.id,
});

/** Register a custom visualization class (must have a static `id`). */
export function register(VizClass) {
  registry.set(VizClass.id, VizClass);
}
