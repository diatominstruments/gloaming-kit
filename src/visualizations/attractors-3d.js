import { flowRibbon } from './flow-ribbon.js';
import { pointCloud3D } from './point-cloud-3d.js';
import { DeJong } from './attractor.js';
import { Clifford } from './clifford.js';
import { Bedhead } from './bedhead.js';
import { Thomas } from './thomas.js';
import { Aizawa } from './aizawa.js';
import { Rossler } from './rossler.js';
import { Halvorsen } from './halvorsen.js';

/**
 * The 3D attractors: each is its 2D class rendered by flowRibbon (flows) or
 * pointCloud3D (maps), and
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

export class DeJong3D extends pointCloud3D(DeJong) {
  static id = 'attractor-3d';
  static label = 'De Jong 3D';
  static description = 'De Jong attractor lifted into depth and turning, so its folded sheets pull apart.';
}

export class Clifford3D extends pointCloud3D(Clifford) {
  static id = 'clifford-3d';
  static label = 'Clifford 3D';
  static description = 'Clifford attractor lifted into depth and turning, its filaments separating into layers.';
}

export class Bedhead3D extends pointCloud3D(Bedhead) {
  static id = 'bedhead-3d';
  static label = 'Bedhead 3D';
  static description = 'Bedhead attractor lifted into depth and turning, its whorls stacking into a sculpture.';
}
