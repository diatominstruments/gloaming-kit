import { ThreeVisualization } from './three-base.js';
import { approach, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';
import { mulberry32 } from '../noise.js';
import {
  PALETTE_OPTION, paletteColor, isPsychedelic, instanceGlow, fogToAlpha,
} from './three-shared.js';

const SHAPES = ['octahedron', 'cube', 'torus', 'tetrahedron'];

/**
 * HelixCorridor — flying down the axis of a spiral of tumbling solids.
 *
 * A few intertwined helical strands of lit, faceted shapes wind around the
 * flight line; the camera rushes along it and the shapes stream past on all
 * sides, the near ones huge and blurred by speed, the far ones a spiral
 * vanishing into the distance. It is the fullest use of the lit pipeline
 * among these: every solid is shaded by a headlight and two coloured lights
 * that travel down the corridor ahead of the camera.
 *
 * Each shape keeps its angle round the helix as it approaches — the twist is
 * fixed to its position along the corridor, not to time — so what turns is
 * the whole spiral, by `spin`, and the strands read as solid structure you
 * are flying through rather than things orbiting you.
 *
 * Reactions:
 *
 *   ripple   a hit sends a swell down the corridor: shapes it passes push
 *            outward, grow, and flash with light
 *   spin     how fast the helix turns, and how hard the shapes tumble
 *   glow     how brightly every shape shines in its own colour
 *
 * Distant shapes fade to transparent rather than into a fog colour, so a
 * background layer shows through the far end of the corridor.
 *
 * Instances are positioned on the CPU each frame — a few thousand matrices,
 * which is cheap, and keeps the lit material stock.
 */
export class HelixCorridor extends ThreeVisualization {
  static id = 'helix-corridor';
  static label = 'Helix Corridor';
  static description = 'Flight down a spiral of tumbling lit solids; hits send swells of light rippling down the corridor.';
  static category = CATEGORY.SPACES;
  static fallback = 'tunnel';

  static inputs = {
    ripple: { kind: 'event', default: TRIGGER.BASS },
    spin:   { kind: 'level', default: { intensity: 'mid', smooth: 0.6 } },
    glow:   { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
      smooth: 0.1,
    } },
  };

  static options = {
    palette: PALETTE_OPTION,
    shape: { kind: 'enum', values: SHAPES, default: 'octahedron' },
    strands: { kind: 'number', default: 4, min: 1, max: 8, step: 1 },
  };

  static PER_STRAND = 150;   // shapes per strand
  // Wide enough apart that each solid reads on its own; closer, the strands
  // fuse into continuous ribbons and the tumbling is lost.
  static SPACING = 0.6;      // world units between shapes along a strand
  static RADIUS = 2.4;       // helix radius
  static TWIST = 0.32;       // radians of helix per world unit along it
  static SIZE = 0.24;
  static SPEED = 9;          // world units per second, constant (see road)
  static SPIN = [0.15, 0.9]; // helix turn rate: [idle, added at full spin]
  static WAVE_SPEED = 26;
  static WAVE_DECAY = 0.9;

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    const { PER_STRAND, SPACING } = HelixCorridor;
    this.psychedelic = isPsychedelic(this);

    const shape = SHAPES.includes(this.options.shape) ? this.options.shape : 'octahedron';
    this.strands = Math.max(1, Math.min(8, Math.round(this.options.strands ?? 4)));
    this.count = this.strands * PER_STRAND;
    this.length = PER_STRAND * SPACING;   // corridor length before it wraps

    const geometry = {
      octahedron: () => new THREE.OctahedronGeometry(1, 0),
      cube: () => new THREE.BoxGeometry(1.3, 1.3, 1.3),
      torus: () => new THREE.TorusGeometry(0.85, 0.3, 10, 24),
      tetrahedron: () => new THREE.TetrahedronGeometry(1.2, 0),
    }[shape]();
    // Barely metallic: metal shows its colour through reflections, and with
    // no environment map to reflect it just renders dark.
    const material = new THREE.MeshStandardMaterial({
      metalness: 0.15, roughness: 0.4, flatShading: shape !== 'torus',
    });
    this.glow = instanceGlow(material, 0.25);
    fogToAlpha(material);

    this.mesh = new THREE.InstancedMesh(geometry, material, this.count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    // Per shape: a tumble axis and rate, fixed for its life.
    const rand = mulberry32(Math.floor(Math.random() * 1e9));
    this.tumble = Array.from({ length: this.count }, () => ({
      axis: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
      rate: 0.6 + rand() * 1.8,
      phase: rand() * Math.PI * 2,
    }));

    this.scene.fog = new THREE.Fog(0x000000, this.length * 0.35, this.length * 0.95);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    this.headlight = new THREE.PointLight(0xffffff, 9, 0, 0.6);
    this.scene.add(this.headlight);
    this.lamps = [0, 1].map(() => {
      const lamp = new THREE.PointLight(0xffffff, 14, 0, 1);
      this.scene.add(lamp);
      return lamp;
    });

    this.camera.fov = 75;
    this.camera.near = 0.05;
    this.camera.far = this.length + 10;
    this.camera.position.set(0, 0, 0);

    this.travel = 0;
    this.spin = 0;
    this.spinRate = HelixCorridor.SPIN[0];
    this.time = 0;
    this.hue = rand();
    this.waves = [];   // { dist, strength }

    // Scratch, so the per-instance loop never allocates.
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.p = new THREE.Vector3();
    this.s = new THREE.Vector3();
    this.c = new THREE.Color();
  }

  onInput(slot, data) {
    if (slot !== 'ripple') return;
    this.waves.push({ dist: 0, strength: impact(data) });
    if (this.waves.length > 4) this.waves.shift();
  }

  draw(ctx, dt) {
    const {
      PER_STRAND, SPACING, RADIUS, TWIST, SIZE, SPEED, SPIN, WAVE_SPEED, WAVE_DECAY,
    } = HelixCorridor;
    const spinIn = this.in('spin');
    this.time += dt;
    this.travel += SPEED * dt;
    this.spinRate = approach(this.spinRate, SPIN[0] + spinIn * SPIN[1], 0.4, dt);
    this.spin += this.spinRate * dt;
    this.hue += dt * 0.03;
    for (const w of this.waves) {
      w.dist += WAVE_SPEED * dt;
      w.strength *= Math.exp(-dt * WAVE_DECAY);
    }
    this.waves = this.waves.filter((w) => w.dist < this.length + 5);

    const { m, q, p, s, c } = this;
    const L = this.length;
    const tumbleRate = 0.4 + spinIn * 1.2;
    for (let strand = 0; strand < this.strands; strand++) {
      const offset = (strand / this.strands) * Math.PI * 2;
      for (let k = 0; k < PER_STRAND; k++) {
        const i = strand * PER_STRAND + k;
        // Distance ahead of the camera, wrapping so shapes that pass behind
        // reappear at the far end. `along` is the shape's fixed position on
        // the helix, so its angle doesn't change as it approaches.
        const ahead = ((k * SPACING - this.travel) % L + L) % L;
        const along = ahead + this.travel;

        let swell = 0;
        for (const w of this.waves) {
          const d = ahead - w.dist;
          swell += Math.exp(-d * d * 0.08) * w.strength;
        }

        const angle = offset + along * TWIST + this.spin;
        const radius = RADIUS * (1 + swell * 0.45);
        p.set(Math.cos(angle) * radius, Math.sin(angle) * radius, -ahead);

        const t = this.tumble[i];
        q.setFromAxisAngle(t.axis, t.phase + this.time * t.rate * tumbleRate);
        s.setScalar(SIZE * (1 + swell * 1.2));
        m.compose(p, q, s);
        this.mesh.setMatrixAt(i, m);

        paletteColor(this, strand / this.strands * 0.5 + along * 0.012 + this.hue, c);
        // Only the swell glows hard; the rest stays lit, so the facets show.
        c.multiplyScalar(1 + swell * 4);
        this.mesh.setColorAt(i, c);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;

    this.glow.value = 0.15 + this.in('glow') * 0.45;
    // Two coloured lamps drifting down the corridor ahead, and back.
    this.lamps.forEach((lamp, n) => {
      const a = this.time * (0.5 + n * 0.23) + n * Math.PI;
      lamp.position.set(Math.cos(a) * 1.2, Math.sin(a) * 1.2, -(6 + (Math.sin(this.time * 0.3 + n * 2) * 0.5 + 0.5) * 20));
      paletteColor(this, this.hue + 0.33 + n * 0.33, lamp.color);
    });

    // Bank gently into the helix's turn.
    this.camera.rotation.z = Math.sin(this.spin * 0.5) * 0.25;
    if (this.camera.aspect !== this.width / this.height) {
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
    }
    this.present(ctx);
  }
}
