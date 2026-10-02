import { ThreeVisualization } from './three-base.js';
import { approach, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';
import { mulberry32 } from '../noise.js';
import {
  PALETTE_OPTION, PALETTE_GLSL, paletteUniforms, updatePalette, isPsychedelic,
} from './three-shared.js';
import { windowOf } from './glyph-window.js';
import { glyphOption, readGlyph, EYE } from './glyph.js';

const DISTANCES = { near: 0.6, med: 1, far: 1.5 };

/**
 * GlyphFlow — light pouring through the drawing as through a stencil.
 *
 * The drawing is a plate far off in the dark, and every filled cell is a hole
 * cut in it. Behind the plate is a flood of light under pressure, so each
 * hole lets through a jet of streaks that runs out of the distance straight
 * at the viewer: a single dot is one narrow jet from the middle of the
 * screen, a line is a sheet, and the whole drawing hangs far off, lit by its
 * own openings, with its shape streaming toward you. Grey cells are smaller
 * holes — a thinner, dimmer jet in the accent colour.
 *
 * Jets fray as they come: each one snakes like a hose, its wave travelling
 * toward the viewer, and the whole stream twists about the line of sight, so
 * off-centre jets corkscrew.
 *
 * Reactions:
 *
 *   surge  a hit blasts a wide, bright spray out of every hole; it travels
 *          toward the viewer as a front, and the jets speed up a moment
 *   flow   how fast the streaks run, heavily smoothed
 *   swirl  how hard the jets snake and the stream twists
 *   glow   brightness
 *
 * The camera stands in the stream, a little off its axis, looking back at
 * the plate. Option `distance`: 'near' | 'med' (default) | 'far' — how far
 * off the plate is.
 */
export class GlyphFlow extends ThreeVisualization {
  static id = 'glyph-flow';
  static label = 'Glyph Flow';
  static description = 'Light pouring through the drawing as a stencil: a jet of streaks from every cell, running out of the distance at you; hits blast a spray through.';
  static category = CATEGORY.GLYPHS;

  static inputs = {
    surge: { kind: 'event', default: TRIGGER.BASS },
    flow:  { kind: 'level', default: { intensity: 'rms', smooth: 1.5 } },
    swirl: { kind: 'level', default: { intensity: 'mid', smooth: 0.4 } },
    glow:  { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
      smooth: 0.1,
    } },
  };

  static options = {
    glyph: glyphOption({ width: 12, height: 12, value: EYE }),
    distance: { kind: 'enum', values: Object.keys(DISTANCES), default: 'med' },
    count: { kind: 'number', default: 24000, min: 4000, max: 60000, step: 1000 },
    palette: PALETTE_OPTION,
  };
  // The 2D window, wearing this one's default drawing.
  static fallback = windowOf(this.options);

  static SPAN = 9;             // the plate's drawing width in world units
  static CELL = 0.6;           // largest hole, so a coarse drawing still jets narrow
  static VIEW = 30;            // plate-to-camera distance at `med`
  static RUN = 0.6;            // how far the jets carry, as a fraction of VIEW
  static PER_CELL = 500;       // streaks per full-strength hole, up to `count`
  static SPEED = [7, 9];       // streak speed: [idle, added at full flow]
  static SPREAD = 0.004;       // a jet's widening per unit travelled
  static BURST = 0.035;        // added widening for streaks born on a full hit
  static WOBBLE = [0.1, 0.5];  // jet snaking at the viewer's end: [idle, added at full swirl]
  static TWIST = [0.2, 0.9];    // stream's twist over its length, rad: [idle, added at full swirl]
  static TRAIL = 0.14;         // streak length, in seconds of travel
  static KICK_DECAY = 2.5;

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    this.psychedelic = isPsychedelic(this);
    this.glyph = readGlyph(this);
    this.rand = mulberry32(Math.floor(Math.random() * 1e9));

    const distance = this.options.distance ?? 'med';
    if (!(distance in DISTANCES)) console.warn(`GloamingKit: glyph-flow distance '${distance}'; expected ${Object.keys(DISTANCES).join('|')}`);
    this.view = GlyphFlow.VIEW * (DISTANCES[distance] ?? 1);
    this.run = this.view * GlyphFlow.RUN;
    this.buildHoles();

    // Streaks are shared out by hole size, so a lone dot gets a narrow jet
    // rather than the whole budget.
    const cap = Math.max(1000, Math.min(60000, Math.round(Number(this.options.count ?? 24000)) || 24000));
    const count = Math.max(300, Math.min(cap, Math.round(this.area * GlyphFlow.PER_CELL)));
    this.count = count;
    this.travel = new Float32Array(count);   // distance from the plate
    this.origin = new Float32Array(count * 2); // where on the plate it came through
    this.spread = new Float32Array(count * 2); // sideways drift per unit travelled
    this.pace = new Float32Array(count);     // own speed, relative
    this.hole = new Uint16Array(count);
    this.burst = new Float32Array(count);    // hit strength when it came through
    this.lane = new Float32Array(count);     // fixed per streak, for colour
    for (let i = 0; i < count; i++) this.spawn(i, this.rand() * this.run);

    // Each streak is one segment: head at the particle, tail behind it.
    this.lines = new Float32Array(count * 6);
    this.tones = new Float32Array(count * 4);   // (hue, brightness) at each end
    const shade = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) shade[i * 2] = 1;
    const geometry = new THREE.BufferGeometry();
    this.position = new THREE.BufferAttribute(this.lines, 3).setUsage(THREE.DynamicDrawUsage);
    this.tone = new THREE.BufferAttribute(this.tones, 2).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.position);
    geometry.setAttribute('tone', this.tone);
    geometry.setAttribute('shade', new THREE.BufferAttribute(shade, 1));

    this.uniforms = { ...paletteUniforms(THREE), uHue: { value: 0 }, uGlow: { value: 1 } };
    const lines = new THREE.LineSegments(geometry, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    lines.frustumCulled = false;
    this.scene.add(lines);

    this.camera.fov = 50;
    this.camera.near = 0.05;
    this.camera.far = 400;
    this.center = new THREE.Vector3();

    this.time = 0;
    this.speed = GlyphFlow.SPEED[0];
    this.twist = GlyphFlow.TWIST[0];
    this.wobble = GlyphFlow.WOBBLE[0];
    this.kick = 0;
    this.hue = this.rand();
    this.swing = this.rand() * 10;
    this.point = { x: 0, y: 0 };
  }

  /**
   * One hole per filled cell, centred on the plate: its centre, half-width
   * (grey cells are smaller holes), strength, and a phase for its snaking.
   * `pick` is the running total of hole areas, for choosing a hole in
   * proportion to how much light it lets through.
   */
  buildHoles() {
    const { width, height, levels } = this.glyph;
    const cell = Math.min(GlyphFlow.CELL, GlyphFlow.SPAN / Math.max(width, height));
    this.holes = this.glyph.filled().map(({ x, y, level, weight }) => ({
      x: (x - (width - 1) / 2) * cell,
      y: -(y - (height - 1) / 2) * cell,
      half: cell * (level === levels ? 0.5 : 0.3),
      weight,
      full: level === levels,
      phase: this.rand() * Math.PI * 2,
    }));
    let total = 0;
    this.pick = this.holes.map((h) => (total += h.half * h.half));
    this.area = total / (cell * cell * 0.25);
  }

  /** Send streak `i` through a hole, `travel` units out from the plate. */
  spawn(i, travel = 0) {
    const r = this.rand;
    const { pick, holes } = this;
    const want = r() * pick[pick.length - 1];
    let lo = 0;
    let hi = pick.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pick[mid] < want) lo = mid + 1;
      else hi = mid;
    }
    const h = holes[lo];
    this.hole[i] = lo;
    this.origin[i * 2] = h.x + (r() * 2 - 1) * h.half;
    this.origin[i * 2 + 1] = h.y + (r() * 2 - 1) * h.half;
    // A narrow cone out of the hole, widened by whatever hit is ringing.
    const kick = this.kick ?? 0;
    const a = r() * Math.PI * 2;
    const s = Math.sqrt(r()) * (GlyphFlow.SPREAD + kick * GlyphFlow.BURST);
    this.spread[i * 2] = Math.cos(a) * s;
    this.spread[i * 2 + 1] = Math.sin(a) * s;
    this.pace[i] = 0.85 + r() * 0.3 + kick * 0.5;
    this.burst[i] = kick;
    this.lane[i] = r();
    this.travel[i] = travel;
  }

  /**
   * Where streak `i` is after travelling `d` from the plate, as (x, y) into
   * `this.point`: straight out of its hole along its cone, snaking with its
   * jet, and turned with the whole stream about the axis.
   */
  place(i, d) {
    const h = this.holes[this.hole[i]];
    const k = d / this.run;
    const sway = this.wobble * k * k;
    const wave = d * 0.35 - this.time * 2.2 + h.phase;
    let x = this.origin[i * 2] + this.spread[i * 2] * d + Math.sin(wave) * sway;
    let y = this.origin[i * 2 + 1] + this.spread[i * 2 + 1] * d + Math.cos(wave * 0.83 + 1) * sway;
    const turn = this.twist * k;
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    this.point.x = x * c - y * s;
    this.point.y = x * s + y * c;
    return this.point;
  }

  onInput(slot, data) {
    if (slot === 'surge') this.kick = Math.max(this.kick, impact(data));
  }

  draw(ctx, dt) {
    const { SPEED, TWIST, WOBBLE, TRAIL, KICK_DECAY } = GlyphFlow;
    this.time += dt;
    this.kick *= Math.exp(-dt * KICK_DECAY);
    this.speed = approach(this.speed, SPEED[0] + this.in('flow') * SPEED[1], 0.8, dt);
    const swirl = this.in('swirl');
    this.twist = approach(this.twist, TWIST[0] + swirl * TWIST[1], 1.5, dt);
    this.wobble = approach(this.wobble, WOBBLE[0] + swirl * WOBBLE[1], 1, dt);
    this.hue += dt * (0.02 + swirl * 0.04);

    const { travel, pace, burst, lane, holes, hole, lines, tones, count, run: end } = this;
    const step = Math.min(dt, 1 / 20);
    for (let i = 0; i < count; i++) {
      const v = this.speed * pace[i];
      let d = travel[i] + v * step;
      if (d > end) {
        this.spawn(i, (d - end) % 1);
        d = travel[i];
      }
      travel[i] = d;

      const l = i * 6;
      let p = this.place(i, d);
      lines[l] = p.x;
      lines[l + 1] = p.y;
      lines[l + 2] = d;
      const back = Math.max(0, d - v * TRAIL);
      p = this.place(i, back);
      lines[l + 3] = p.x;
      lines[l + 4] = p.y;
      lines[l + 5] = back;

      // Bright where it leaves the hole, so the drawing glows far off;
      // fading out well short of the camera, so the jets stay jets rather
      // than a blizzard in the viewer's face; hit streaks burn hotter.
      const h = holes[hole[i]];
      const k = d / end;
      const leave = 1 + 1.5 * Math.exp(-d * 1.5);
      const fade = Math.min(1, (1 - k) * 2.5);
      const bright = fade * leave * (0.65 + 0.35 * h.weight + burst[i] * 0.6);
      // In the style palette, 0.75 is the line colour and 0.25 the accent:
      // full holes pour the one and grey holes the other.
      const hue = (h.full ? 0.75 : 0.25) + lane[i] * 0.1 + k * 0.08;
      const t = i * 4;
      tones[t] = hue;
      tones[t + 1] = bright;
      tones[t + 2] = hue;
      tones[t + 3] = bright;
    }
    this.position.needsUpdate = true;
    this.tone.needsUpdate = true;

    // Looking back up the stream at the plate from past the jets' ends,
    // swinging between face-on, where the drawing hangs in the middle of the
    // screen with its jets bursting out at you, and oblique, where the jets
    // show as beams.
    this.swing += dt * (0.05 + swirl * 0.07);
    const yaw = Math.sin(this.swing) * 0.5;
    const pitch = Math.sin(this.swing * 0.61 + 1) * 0.22;
    const cam = this.camera;
    cam.position.set(
      Math.sin(yaw) * Math.cos(pitch) * this.view,
      Math.sin(pitch) * this.view,
      Math.cos(yaw) * Math.cos(pitch) * this.view,
    );
    this.center.set(0, 0, this.run * 0.3);
    cam.lookAt(this.center);
    if (cam.aspect !== this.width / this.height) {
      cam.aspect = this.width / this.height;
      cam.updateProjectionMatrix();
    }

    const u = this.uniforms;
    updatePalette(this, u);
    u.uHue.value = this.hue;
    u.uGlow.value = 0.6 + this.in('glow') * 0.45 + this.kick * 0.25;
    this.present(ctx);
  }
}

const VERTEX = /* glsl */ `
${PALETTE_GLSL}
attribute vec2 tone;    // (hue, brightness)
attribute float shade;  // 1 at the head, 0 at the tail

uniform float uHue;
uniform float uGlow;

varying vec3 vColor;

void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vColor = palette(tone.x + uHue) * tone.y * shade * uGlow * 1.2;
}
`;

const FRAGMENT = /* glsl */ `
varying vec3 vColor;

void main() {
  gl_FragColor = vec4(vColor, 1.0);
}
`;
