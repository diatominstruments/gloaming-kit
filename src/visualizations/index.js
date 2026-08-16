import { EQBars } from './eq-bars.js';
import { Waveform } from './waveform.js';
import { RadialBurst } from './radial-burst.js';
import { PolygonPulse } from './polygon-pulse.js';
import { ParticleField } from './particles.js';
import { Road } from './road.js';
import { Tunnel } from './tunnel.js';
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
    Road, Tunnel, Starfield,
    Lightning, Harmonograph,
    DeJong, Clifford, Bedhead, Thomas,
  ].map((V) => [V.id, V]),
);

/** Register a custom visualization class (must have a static `id`). */
export function register(VizClass) {
  registry.set(VizClass.id, VizClass);
}
