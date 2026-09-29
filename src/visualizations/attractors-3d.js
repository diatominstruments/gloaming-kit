import { flowRibbon } from './flow-ribbon.js';
import { Thomas } from './thomas.js';
import { Aizawa } from './aizawa.js';
import { Rossler } from './rossler.js';
import { Halvorsen } from './halvorsen.js';

/**
 * The 3D flow attractors: each is its 2D class rendered by flowRibbon, and
 * falls back to that class when 3D is off or unavailable. The systems, their
 * tuning and their options all live in the 2D files; only how they look
 * differs, so nothing here but ids and descriptions.
 */

export class Thomas3D extends flowRibbon(Thomas) {
  static id = 'thomas-3d';
  static label = 'Thomas 3D';
  static description = 'Thomas attractor in depth: strands swell as they sweep past the camera inside the lattice.';
}

export class Aizawa3D extends flowRibbon(Aizawa) {
  static id = 'aizawa-3d';
  static label = 'Aizawa 3D';
  static description = 'Aizawa attractor in depth: a wound shell whose near side stands out from its far side.';
}

export class Rossler3D extends flowRibbon(Rossler) {
  static id = 'rossler-3d';
  static label = 'Rössler 3D';
  static description = 'Rössler attractor in depth: the disc and its fold rendered with perspective width and falloff.';
}

export class Halvorsen3D extends flowRibbon(Halvorsen) {
  static id = 'halvorsen-3d';
  static label = 'Halvorsen 3D';
  static description = 'Halvorsen attractor in depth: three horns thickening as they run toward the camera.';
}
