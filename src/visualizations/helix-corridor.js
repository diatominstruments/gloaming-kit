import { ThreeVisualization } from './three-base.js';
import { approach, clamp01, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';
import { PALETTE_OPTION, paletteColor, isPsychedelic } from './three-shared.js';
import { BLOOM_SHAPES } from './helix-blooms.js';
import {
  UnfoldField, FIELD_BUCKETS, Braid, Phyllotaxis, Weave, Ribbons,
} from './helix-structures.js';

const TAU = Math.PI * 2;

const STRUCTURES = {
  braid: Braid, phyllotaxis: Phyllotaxis, weave: Weave, ribbon: Ribbons,
};

/**
 * HelixCorridor — flying down the axis of a helical structure that unfolds
 * with the music.
 *
 * A few intertwined helical strands wind round the flight line; the camera
 * glides along it and the structure streams past on all sides, the near
 * parts huge, the far ones a spiral vanishing into the distance.
 *
 * The music doesn't shake it; it opens it. Every hit sends a front racing
 * away down the corridor, and the stretch the front has passed unfolds
 * behind it — as far as the hit was hard — lingers, then winds slowly shut.
 * Loudness holds the whole corridor part-open between hits, so a quiet
 * passage is a sparse, tightly wound spiral and a dense one is a structure
 * opened into all its detail. What unfolding means is the `mode`:
 *
 *   braid        (default) each strand is a braided rope that unravels: into
 *                three helices winding round its path, then each of those
 *                into three more. At the height of the music buds appear
 *                along the unwound strands and bloom.
 *   phyllotaxis  the wall is a sunflower's head of florets on the golden
 *                angle; unfolding grows finer and finer florets in between,
 *                and the crossing spiral families the eye finds reorganise
 *                from a few lazy ones to dozens interlocking.
 *   weave        threads grow across between the strands: rungs, then
 *                diagonals, then a fine diamond in every cell, a basket
 *                weaving itself round you; buds open on its knots.
 *   ribbon       the strands are fins edge-on to you that roll face-on,
 *                widen, fan out into three, and ruffle at the edges.
 *
 * The three style colours mark the levels: the wound structure in
 * lineColor, what unfolding reveals in accentColor, and the finest detail —
 * shown only when fully open — lifted toward white and reaching peakColor
 * on the hardest hits. So the mix of colours on screen is how far the music
 * has opened the corridor.
 *
 * Nothing moves by jumps. The unfolding follows its target on damped
 * springs, every turn is integrated rather than multiplied by the clock,
 * and pieces move only as the structure's own shape changes, so neighbours
 * always move together. The structure is fixed to the corridor — its twist
 * belongs to its position along it, not to time — so what turns is the
 * whole spiral, by `spin`, and you fly through it rather than it orbiting
 * you.
 *
 * Reactions:
 *
 *   ripple   a hit sends a front down the corridor, unfolding what it passes
 *   open     how far the corridor stands unfolded between hits
 *   spin     how fast the helix turns, and its parts within it
 *   glow     how brightly unfolded parts shine
 *
 * Distant parts fade to transparent rather than into a fog colour, so a
 * background layer shows through the far end of the corridor.
 */
export class HelixCorridor extends ThreeVisualization {
  static id = 'helix-corridor';
  static label = 'Helix Corridor';
  static description = 'Flight down a helical structure that unfolds with the music: hits send fronts down the corridor that unravel, fill in, weave or fan it open.';
  static category = CATEGORY.SPACES;
  static fallback = 'tunnel';

  static inputs = {
    ripple: { kind: 'event', default: TRIGGER.BASS },
    open:   { kind: 'level', default: { intensity: 'rms', smooth: 1.2 } },
    spin:   { kind: 'level', default: { intensity: 'mid', smooth: 0.6 } },
    glow:   { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
      smooth: 0.1,
    } },
  };

  static options = {
    palette: PALETTE_OPTION,
    mode: { kind: 'enum', values: Object.keys(STRUCTURES), default: 'braid' },
    shape: { kind: 'enum', values: BLOOM_SHAPES, default: 'lotus' },
    strands: { kind: 'number', default: 4, min: 1, max: 8, step: 1 },
    density: { kind: 'number', default: 150, min: 30, max: 400, step: 10 },
    radius: { kind: 'number', default: 2.4, min: 0.8, max: 6, step: 0.1 },
    twist: { kind: 'number', default: 0.32, min: 0, max: 1.5, step: 0.02 },
    size: { kind: 'number', default: 0.24, min: 0.05, max: 0.8, step: 0.01 },
    speed: { kind: 'number', default: 9, min: 1, max: 30, step: 0.5 },
  };

  static LENGTH = 90;        // world units of corridor ahead before it wraps
  static SPIN = [0.15, 0.9]; // helix turn rate: [idle, added at full spin]

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    this.psychedelic = isPsychedelic(this);

    this.mode = this.option('mode');
    this.shape = this.option('shape');
    this.strands = this.option('strands');
    this.density = this.option('density');
    this.radius = this.option('radius');
    this.twist = this.option('twist');
    this.size = this.option('size');
    this.speed = this.option('speed');
    this.sizeScale = this.size / HelixCorridor.options.size.default;
    this.length = HelixCorridor.LENGTH;

    this.travel = 0;
    this.phase = 0;    // the helix's turn: twist × travel, plus spin
    this.spin = 0;
    this.spinRate = HelixCorridor.SPIN[0];
    this.time = 0;
    this.hue = Math.random();
    this.white = new THREE.Color(1, 1, 1);

    this.field = new UnfoldField(this.length, this);
    // The colour of each level: wound, unfolded, finest.
    this.levelColors = [new THREE.Color(), new THREE.Color(), new THREE.Color()];
    this.uniforms = {
      uField: { value: new Float32Array(FIELD_BUCKETS) },
      uHeat: { value: new Float32Array(FIELD_BUCKETS) },
      uFieldShift: { value: 0 },
      uFieldStep: { value: this.field.step },
      uLength: { value: this.length },
      uRadius: { value: this.radius },
      uTwist: { value: this.twist },
      uPhase: { value: 0 },
      uStrands: { value: this.strands },
      uThick: { value: 0.02 },
      uGlow: { value: 0.2 },
      uC0: { value: this.levelColors[0] },
      uC1: { value: this.levelColors[1] },
      uC2: { value: this.levelColors[2] },
    };
    this.structure = new STRUCTURES[this.mode](this);

    this.scene.fog = new THREE.Fog(0x000000, this.length * 0.35, this.length * 0.95);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    this.headlight = new THREE.PointLight(0xffffff, 6, 0, 0.6);
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
  }

  onInput(slot, data) {
    if (slot === 'ripple') this.field.hit(impact(data));
  }

  /** The three level colours, from the style or, psychedelic, the rainbow. */
  updateColors() {
    const [wound, unfolded, finest] = this.levelColors;
    if (this.psychedelic) {
      paletteColor(this, this.hue, wound);
      paletteColor(this, this.hue + 0.33, unfolded);
      paletteColor(this, this.hue + 0.66, finest).lerp(this.white, 0.3);
      return;
    }
    const s = this.style;
    wound.copy(this.color(s.lineColor));
    unfolded.copy(this.color(s.accentColor ?? s.lineColor));
    // With no peak colour the finest level just lifts further toward white.
    if (s.peakColor != null) finest.copy(this.color(s.peakColor));
    else finest.copy(unfolded).lerp(this.white, 0.5);
  }

  draw(ctx, dt) {
    const { SPIN } = HelixCorridor;
    const spinIn = this.in('spin');
    const openIn = clamp01(this.in('open'));
    const glow = this.in('glow');
    this.time += dt;
    const step = this.speed * dt;
    this.travel += step;
    this.spinRate = approach(this.spinRate, SPIN[0] + spinIn * SPIN[1], 0.6, dt);
    this.spin = (this.spin + this.spinRate * dt) % (2 * TAU);   // the bank below has period 4π
    this.phase = (this.phase + step * this.twist + this.spinRate * dt) % TAU;
    this.hue += dt * 0.03;

    this.field.update(dt, this.travel, 0.03 + 0.3 * openIn);
    const U = this.uniforms;
    U.uField.value.set(this.field.value);
    U.uHeat.value.set(this.field.heat);
    U.uFieldShift.value = this.travel % this.length;
    U.uPhase.value = this.phase;
    U.uGlow.value = 0.12 + glow * 0.45;
    this.updateColors();
    this.structure.update(dt, { spinIn, glow });

    // Two lamps drifting down the corridor ahead, and back, tinted toward
    // the first two colours — only tinted, since a saturated light on a
    // complementary surface would turn it black.
    this.lamps.forEach((lamp, n) => {
      const a = this.time * (0.5 + n * 0.23) + n * Math.PI;
      lamp.position.set(Math.cos(a) * 1.2, Math.sin(a) * 1.2, -(6 + (Math.sin(this.time * 0.3 + n * 2) * 0.5 + 0.5) * 20));
      lamp.color.copy(this.white).lerp(this.levelColors[n], 0.45);
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
