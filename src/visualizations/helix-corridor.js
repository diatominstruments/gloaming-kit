import { ThreeVisualization } from './three-base.js';
import { approach, clamp01, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';
import { PALETTE_OPTION, paletteColor, isPsychedelic } from './three-shared.js';
import { BLOOM_SHAPES } from './helix-blooms.js';
import {
  UnfoldField, FIELD_BUCKETS, SWELL, CHAMBER, PINCH, FRONT_WIDTH, Braid, Phyllotaxis, Weave, Ribbons,
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
 *                into three more. Buds appear along the unwound strands
 *                and bloom as the music holds it open.
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
 * The motion is steady: the flight keeps one pace, the camera stays level,
 * and the spiral and its parts turn slowly at constant rates. The music
 * never speeds, swings or rolls any of it, since a view lurching round
 * with the beat is hard to watch; it changes the structure's shape and
 * colour instead. The structure is fixed to the corridor — its twist
 * belongs to its position along it, not to time — so you fly through it
 * rather than it orbiting you. Nothing changes by jumps: the unfolding
 * follows its target on damped springs and every response eases.
 *
 * Reactions — each defaults to something that changes beat by beat, so the
 * corridor answers the music rather than sitting at one level through a
 * loud song:
 *
 *   ripple   a hit sends a front down the corridor, carrying a ring of
 *            light, and the stretch it passes unfolds and winds back up
 *            before the next beat (bass)
 *   open     how far the corridor stands unfolded between hits (overall
 *            level against the recent dynamics)
 *   pinch    how far the walls cinch into a string of chambers, narrow
 *            waists between broad bulbs (mids)
 *   flare    the threads swell thicker, ribbons widen and florets grow on
 *            the backbeat (mid level, plus snare and clap envelopes)
 *   glow     how brightly unfolded parts shine, and the lamps; a ribbon's
 *            ripples deepen with it (treble, plus a hihat envelope)
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
    open:   { kind: 'level', default: { relative: 'rms', smooth: 1 } },
    pinch:  { kind: 'level', default: { relative: 'mid', smooth: 0.15, gain: 2 } },
    flare:  { kind: 'level', default: {
      sum: [
        { intensity: 'mid', gain: 0.3 },
        { trigger: 'snare', decay: 1.5 },
        { trigger: 'clap', decay: 1.5, gain: 0.6 },
      ],
    } },
    glow:   { kind: 'level', default: {
      sum: [{ relative: 'treble', gain: 0.8 }, { trigger: 'hihat', decay: 5, gain: 0.8 }],
      smooth: 0.08,
    } },
  };

  static options = {
    palette: PALETTE_OPTION,
    mode: { kind: 'enum', values: Object.keys(STRUCTURES), default: 'braid' },
    flowers: { kind: 'enum', values: ['on', 'off'], default: 'on' },
    shape: { kind: 'enum', values: BLOOM_SHAPES, default: 'lotus' },
    strands: { kind: 'number', default: 4, min: 1, max: 8, step: 1 },
    density: { kind: 'number', default: 150, min: 30, max: 400, step: 10 },
    radius: { kind: 'number', default: 2.4, min: 0.8, max: 6, step: 0.1 },
    twist: { kind: 'number', default: 0.32, min: 0, max: 1.5, step: 0.02 },
    size: { kind: 'number', default: 0.24, min: 0.05, max: 0.8, step: 0.01 },
    speed: { kind: 'number', default: 3, min: 0.25, max: 8, step: 0.25 },
    ruffle: { kind: 'number', default: 1, min: 0, max: 3, step: 0.1 },
  };

  static LENGTH = 90;         // world units of corridor ahead before it wraps
  static SPIN = 0.15;         // the helix's steady turn, rad/s at the default speed
  static FLARE = 1.2;         // how much thicker threads swell at full flare
  static OPEN = 0.6;          // how far a full `open` holds the corridor unfolded
  static BLOOM_SIZE = 0.22;   // a flower's scale at the default size
  static BLOOM_GROWTH = 0.3;  // how much of size's scaling flowers follow (as a power)

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    this.psychedelic = isPsychedelic(this);

    this.mode = this.option('mode');
    this.flowers = this.option('flowers') === 'on';
    this.shape = this.option('shape');
    this.strands = this.option('strands');
    this.density = this.option('density');
    this.radius = this.option('radius');
    this.twist = this.option('twist');
    this.size = this.option('size');
    this.speed = this.option('speed');
    this.ruffle = this.option('ruffle');
    this.sizeScale = this.size / HelixCorridor.options.size.default;
    // Flowers follow size only a little: sized with the structure they
    // would fill the screen long before the threads look thick.
    this.bloomSize = HelixCorridor.BLOOM_SIZE * Math.pow(this.sizeScale, HelixCorridor.BLOOM_GROWTH);
    // How brisk every motion is beside the flight itself — the helix's spin,
    // a braid's turning, a ribbon's ripple — so a slow speed is slow all
    // round, not a slow flight through a spinning corridor.
    this.tempo = Math.sqrt(this.speed / HelixCorridor.options.speed.default);
    this.length = HelixCorridor.LENGTH;

    this.travel = 0;
    this.phase = 0;    // the helix's turn: twist × travel, plus spin
    this.spin = 0;
    this.pinch = 0;    // eased toward the pinch input
    this.flare = 0;    // and the flare
    this.thick = 0.02; // threads' thickness before the flare; structures set it
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
      uPinch: { value: 0 },
      uPhase: { value: 0 },
      uFrontAt: { value: new THREE.Vector4() },
      uFrontPower: { value: new THREE.Vector4() },
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

  // The helix's shape, for structures placing things on the CPU: the GLSL
  // twins are in helix-structures.js.

  /** How far round the helix has turned `ahead` units in front. */
  turnAt(ahead) {
    return this.twist * ahead + this.phase;
  }

  /** The corridor's radius there, where it is unfolded `u`. */
  radiusAt(ahead, u) {
    const waist = (0.5 + 0.5 * Math.cos((TAU * (ahead + this.uniforms.uFieldShift.value)) / CHAMBER)) ** 3;
    return this.radius * (1 + SWELL * u) * (1 - PINCH * this.pinch * waist);
  }

  /** The fronts' rings of light there. */
  frontLight(ahead) {
    let light = 0;
    const { fronts } = this.field;
    for (let i = Math.max(0, fronts.length - 4); i < fronts.length; i++) {
      const d = (ahead - fronts[i].dist) / FRONT_WIDTH;
      light += fronts[i].strength * Math.exp(-d * d);
    }
    return light;
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
    const { SPIN, FLARE, OPEN } = HelixCorridor;
    const openIn = clamp01(this.in('open'));
    const glow = this.in('glow');
    this.time += dt;
    // Every response eases rather than steps, so a hit reshapes the
    // corridor without jolting it.
    this.pinch = approach(this.pinch, clamp01(this.in('pinch')), 0.3, dt);
    this.flare = approach(this.flare, clamp01(this.in('flare')), 0.08, dt);
    // The flight and the turn keep steady paces whatever the music does.
    const step = this.speed * dt;
    const turn = SPIN * this.tempo * dt;
    this.travel += step;
    this.spin = (this.spin + turn) % TAU;
    this.phase = (this.phase + step * this.twist + turn) % TAU;
    this.hue += dt * 0.03;

    this.field.update(dt, this.travel, 0.02 + OPEN * openIn);
    const U = this.uniforms;
    U.uField.value.set(this.field.value);
    U.uHeat.value.set(this.field.heat);
    U.uFieldShift.value = this.travel % this.length;
    U.uPhase.value = this.phase;
    U.uPinch.value = this.pinch;
    U.uThick.value = this.thick * (1 + FLARE * this.flare);
    U.uGlow.value = 0.12 + glow;
    // The newest four fronts, for their rings of light.
    const { fronts } = this.field;
    const at = [0, 0, 0, 0];
    const power = [0, 0, 0, 0];
    for (let i = 0; i < Math.min(4, fronts.length); i++) {
      const front = fronts[fronts.length - 1 - i];
      at[i] = front.dist;
      power[i] = front.strength;
    }
    U.uFrontAt.value.fromArray(at);
    U.uFrontPower.value.fromArray(power);
    this.updateColors();
    this.structure.update(dt, { glow, flare: this.flare });

    // Two lamps drifting down the corridor ahead, and back, tinted toward
    // the first two colours — only tinted, since a saturated light on a
    // complementary surface would turn it black.
    this.lamps.forEach((lamp, n) => {
      const a = this.time * (0.5 + n * 0.23) + n * Math.PI;
      lamp.position.set(Math.cos(a) * 1.2, Math.sin(a) * 1.2, -(6 + (Math.sin(this.time * 0.3 + n * 2) * 0.5 + 0.5) * 20));
      lamp.color.copy(this.white).lerp(this.levelColors[n], 0.45);
      lamp.intensity = 8 + 22 * glow;
    });

    if (this.camera.aspect !== this.width / this.height) {
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
    }
    this.present(ctx);
  }
}
