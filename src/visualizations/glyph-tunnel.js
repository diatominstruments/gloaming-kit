import { ThreeVisualization } from './three-base.js';
import { approach, clamp01, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { LAYER } from './layers.js';
import { TRIGGER } from '../analyzer.js';
import { mulberry32 } from '../noise.js';
import {
  PALETTE_GLSL, paletteUniforms, updatePalette, FULLSCREEN_VERTEX, logSpectrum,
} from './three-shared.js';
import {
  glyphOption, readGlyph, glyphField, radialProfile, profileOutline, WHEEL,
} from './glyph.js';
import { Route, frame, length, dot } from './glyph-tunnel-route.js';
import { SUBSTANCES } from './glyph-tunnel-substances.js';

const MAX_PIECES = 28;
const PULSES = 3;
const SHAFTS = 3;
const MAX_WAVES = 16;
const BINS = 16;
const RECORD_TEXELS = 512;
const NOISE_PERIOD = 8;   // lattice cells across the baked noise before it repeats
const NOISE_SIZE = 64;    // texels across it

/**
 * GlyphTunnel — a flight down a tunnel that branches where the music hits,
 * the branches drawn from the drawing, and turns down one of them.
 *
 * The camera rides a route at a steady pace through passages of some
 * `substance`. A hard hit opens a junction a long way ahead: the drawing
 * gives its exits (see glyph-tunnel-route.js for the two readings), the
 * chamber swells and the exits open in the wall while the way that was
 * there closes, and a ring of light runs ahead down the tunnel to it. One
 * exit is the route; seconds later the flight turns down it, gently, never
 * rolling, and the rest fall behind as side passages you glimpse into as you
 * pass. Softer hits open small alcoves in the walls instead, and a lull
 * opens a cavern with every exit at once.
 *
 *   branch  a hit: a hard one opens a junction ahead, a soft one an alcove
 *   cavern  a hit: the next junction is a great chamber with every exit
 *   flare   a hit: the substance's flourish (below)
 *   glow    how brightly the substance's light burns
 *   swell   how far its relief stands out
 *
 * Substances (option `substance`):
 *
 *   canyon    (default) a slot canyon: tall, narrow, sculpted sandstone in
 *             level layers, lit from a sliver of sky above, beams of sun
 *             standing in the dusty air. The layers are laid down as the
 *             tunnel is built, out at the far end of the view, each standing
 *             out as far as its band of the music was loud at that moment —
 *             so the music paints the far end and you fly through what it
 *             painted. A flare pours sand down the sunbeams; glow is the
 *             sunlight.
 *   sponge    passages carved through an endless porous lattice (a
 *             gyroid's sheet), bone flushing to coral in its hollows. Swell
 *             opens it from thick-walled to lace; through its holes you see
 *             the lattice going on, and other passages. A flare lights it
 *             from deep inside; the spectrum glows in its hollows, bass near
 *             and treble far.
 *   carved    dark stone with the drawing cut into it, tiled round and along
 *             the walls; the spectrum runs in the carvings down the tunnel,
 *             bass nearest, and a flare burns them molten out to a front
 *             racing away.
 *   cymatics  a bronze tube ringing with the drawing as standing waves,
 *             sand gathered on its nodal lines; the spectrum weights the
 *             waves, a flare lurches them.
 *   geode     the walls lined with six-sided crystal points proportioned
 *             by the drawing's silhouette; each twinkles with its own band,
 *             and a flare lights them from within.
 *   lantern   paper stretched over bamboo hoops, glowing with lamps outside,
 *             each as bright as its stretch of the spectrum; the frame and
 *             the drawing, as shadow puppets drifting along outside, cast
 *             their shadows on it. A flare turns the lamps up.
 *   cloud     a passage bored through heaped cloud, silver above and slate
 *             beneath, misty inside; a flare is lightning somewhere in the
 *             cloud ahead, flickering through the vapour.
 *   ice       a glacier cave: scalloped ice, deep blue where thick and pale
 *             where thin, brightest down the spectrum's loud stretches.
 *             Frost feathers over it when the bass drops away; a flare
 *             cracks it, the fractures lighting out to a running front.
 *   neon      a dark tube ruled with a glowing grid, its rings carrying the
 *             spectrum down the tunnel; dashes of data race along the lines
 *             with the hihats, and a flare flashes the rings.
 *   chrome    liquid metal mirroring the passage, rippling with standing
 *             waves from the spectrum; a flare sends a swell running away
 *             down it, and passages part like a drop splitting.
 *
 * Options:
 *   glyph      the drawing
 *   substance  see above
 *   reading    'end-on' (default) | 'walk' — how the drawing becomes exits
 *   choose     'strength' (default; a harder hit takes a sharper turn) |
 *              'strongest' (the strongest cell's exit) | 'random'
 *   speed      flight speed, world units per second
 *   radius     the tunnel's radius, world units
 *   palette    'auto' (default: 'style' for the abstract substances — carved,
 *              cymatics, geode, neon, chrome — and 'natural' for the rest) |
 *              'natural' (the substance's own colours) | 'style' (the
 *              window's line and accent colours, each substance putting the
 *              line colour on its main light and the accent on the other) |
 *              'psychedelic'
 *   seed
 *
 * The whole scene is ray-marched in one full-screen shader, so it renders
 * at reduced RESOLUTION. It fills the screen, so it draws in the background
 * layer: a feedback background (hue drift, zoom burst…) that comes on after
 * it draws over it, one that came on before shows through the tunnel's
 * shadows and its far end, which fades to transparent.
 */
export class GlyphTunnel extends ThreeVisualization {
  static id = 'glyph-tunnel';
  static label = 'Glyph Tunnel';
  static description = 'Flight down a tunnel of sandstone, lattice, carved stone, bronze, crystal, paper, cloud, ice, neon or chrome that branches on hard hits — the exits drawn from the drawing — and turns down one of them.';
  static category = CATEGORY.GLYPHS;
  static layer = LAYER.BACKGROUND;
  static fallback = 'tunnel';
  // Every pixel marches dozens of steps through the passages; upscaled, the
  // softness reads as atmosphere.
  static RESOLUTION = 0.4;

  static inputs = {
    branch: { kind: 'event', default: TRIGGER.ONSET },
    cavern: { kind: 'event', default: TRIGGER.LULL },
    flare:  { kind: 'event', default: TRIGGER.SNARE },
    glow:   { kind: 'level', default: {
      sum: [{ relative: 'treble', gain: 0.7 }, { trigger: 'hihat', decay: 5, gain: 0.5 }],
      smooth: 0.1,
    } },
    swell:  { kind: 'level', default: {
      sum: [{ relative: 'bass', gain: 0.6 }, { intensity: 'bass', gain: 0.4 }],
      smooth: 0.3,
    } },
  };

  static options = {
    glyph:     glyphOption({ width: 9, height: 9, value: WHEEL }),
    substance: { kind: 'enum', values: Object.keys(SUBSTANCES), default: 'canyon' },
    reading:   { kind: 'enum', values: ['end-on', 'walk'], default: 'end-on' },
    choose:    { kind: 'enum', values: ['strength', 'strongest', 'random'], default: 'strength' },
    speed:     { kind: 'number', default: 3.5, min: 1, max: 8, step: 0.25 },
    radius:    { kind: 'number', default: 1.5, min: 0.8, max: 3, step: 0.1 },
    palette:   { kind: 'enum', values: ['auto', 'natural', 'style', 'psychedelic'], default: 'auto' },
  };

  static FAR = 28;            // radii the view reaches
  static COVER = 2.5;         // how opaque the wall is per unit of its brightness: under 1/COVER it is see-through
  static FOCAL = 1.3;         // focal length, of the half-height: ~75° vertical view
  static STEPS = 90;
  static SPANS = 8;           // stretches of each ray, for asking only the pieces near each
  static GATE = 0.6;          // a branch hit's strength that opens a junction; softer ones open alcoves
  static REFRACTORY = 4;      // seconds between junctions, at least
  static PULSE_SPEED = 10;    // radii per second a junction's ring of light runs ahead
  static PULSE_FADE = 1.5;    // per second, once it arrives
  static FLARE_DECAY = 2.2;   // per second
  static FLARE_SPEED = 12;    // radii per second a flare's front runs ahead
  static RECORD_STEP = 0.2;   // radii of route per texel of the record
  static SHAFT_GAP = [8, 15]; // radii between sunbeams
  static WAVES_AROUND = 3;    // cycles round the wall of a wave one cell from the drawing's centre
  static WAVE_DRIFT = [0.1, 0.45];  // radians per second
  static WAVE_KICK = 0.9;     // radians of phase jump at a full flare
  static GLOW_TAU = 0.08;
  static SWELL_TAU = 0.25;

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    const G = GlyphTunnel;
    this.glyph = readGlyph(this);
    this.kind = this.option('substance');
    this.substance = SUBSTANCES[this.kind];
    this.radius = this.option('radius');
    this.paletteMode = this.option('palette') === 'auto' ? this.substance.palette ?? 'natural' : this.option('palette');
    this.psychedelic = this.paletteMode === 'psychedelic';
    this.far = G.FAR * this.radius;
    this.uses = new Set(this.substance.uses);
    this.route = new Route({
      glyph: this.glyph,
      random: this.random,
      radius: this.radius,
      speed: this.option('speed'),
      reading: this.option('reading'),
      choose: this.option('choose'),
    });

    this.time = 0;
    this.glow = 0;
    this.swell = 0;
    this.flare = 0;
    this.flareFrom = 0;
    this.flareAge = 0;
    this.lastJunction = -Infinity;
    this.pulses = [];       // { from, to, age, strength }
    this.bins = new Float32Array(BINS);
    this.spec = new Float32Array(BINS);

    const vec4s = (n) => Array.from({ length: n }, () => new THREE.Vector4());
    this.uniforms = {
      ...paletteUniforms(THREE),
      uA: { value: vec4s(MAX_PIECES) },
      uB: { value: vec4s(MAX_PIECES) },
      uC: { value: vec4s(MAX_PIECES) },
      uD: { value: vec4s(MAX_PIECES) },
      uE: { value: vec4s(MAX_PIECES) },
      uF: { value: vec4s(MAX_PIECES) },
      uCount: { value: 0 },
      uFw: { value: new THREE.Vector3() },
      uRt: { value: new THREE.Vector3() },
      uUpv: { value: new THREE.Vector3() },
      uAspect: { value: 1 },
      uFocal: { value: G.FOCAL },
      uOrigin: { value: new THREE.Vector3() },
      uWrapped: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uCamS: { value: 0 },
      uR: { value: this.radius },
      uFar: { value: this.far },
      uGlow: { value: 0 },
      uSwell: { value: 0 },
      uFlare: { value: 0 },
      uFlareS: { value: -1e4 },
      uSpec: { value: vec4s(BINS / 4) },
      uPulses: { value: vec4s(PULSES) },
      uStyle: { value: this.paletteMode === 'natural' ? 0 : 1 },
      uLattice: { value: (Math.PI * 2) / ((this.substance.period ?? 1) * this.radius) },
      uNoise: { value: this.noiseTexture() },
    };
    const defines = [];
    if (this.uses.has('record')) this.setupRecord(defines);
    if (this.uses.has('shafts')) this.setupShafts(defines);
    if (this.uses.has('field')) this.setupField(defines);
    if (this.uses.has('waves')) this.setupWaves(defines);
    if (this.uses.has('profile')) this.setupProfile(defines);
    if (this.uses.has('flash')) this.setupFlash(defines);
    if (this.substance.air) defines.push('#define AIR');

    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: fragment(this.substance, this.radius, defines),
        depthTest: false,
        depthWrite: false,
      }),
    );
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  noiseTexture() {
    const THREE = this.THREE;
    const tex = new THREE.Data3DTexture(bakeNoise(), NOISE_SIZE, NOISE_SIZE, NOISE_SIZE);
    tex.format = THREE.RedFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    this.textures = [tex];
    return tex;
  }

  /** The music laid along the route: four bands per texel, written at the far end of the view. */
  setupRecord(defines) {
    const THREE = this.THREE;
    this.record = new Uint8Array(RECORD_TEXELS * 4).fill(90);
    const tex = new THREE.DataTexture(this.record, RECORD_TEXELS, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.textures.push(tex);
    this.recordTex = tex;
    this.recordStep = GlyphTunnel.RECORD_STEP * this.radius;
    this.recordAt = null;
    this.recordLevels = [0.35, 0.35, 0.35, 0.35];
    this.uniforms.uRecord = { value: tex };
    defines.push('#define USE_RECORD', `const float RECORD_SPAN = ${glslFloat(RECORD_TEXELS * this.recordStep)};`);
  }

  setupShafts(defines) {
    this.shafts = [];
    this.nextShaft = this.radius * 4;
    this.uniforms.uShafts = { value: Array.from({ length: SHAFTS }, () => new this.THREE.Vector4()) };
    defines.push('#define USE_SHAFTS');
  }

  /** The drawing as a smooth field, mirrored at its edges as a texture's wrapping does. */
  setupField(defines) {
    const THREE = this.THREE;
    const field = glyphField(this.glyph, { blur: 0.42 });
    const [w, h] = field.size;
    const data = new Uint16Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = THREE.DataUtils.toHalfFloat(field.table[i]);
    const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.HalfFloatType);
    tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.textures.push(tex);
    this.uniforms.uField = { value: tex };
    defines.push('#define USE_FIELD');
  }

  /**
   * The drawing as waves standing on the wall, as glyph-cymatics reads it:
   * each cell's offset from the centre a wave vector. Round the wall a
   * wave must close on itself, so its count of cycles round is whole.
   */
  setupWaves(defines) {
    const G = GlyphTunnel;
    const g = this.glyph;
    const cx = (g.width - 1) / 2;
    const cy = (g.height - 1) / 2;
    const merged = new Map();
    for (const { x, y, weight } of g.filled()) {
      let around = Math.round((x - cx) * G.WAVES_AROUND);
      let along = (cy - y) * G.WAVES_AROUND;
      if (!around && !along) continue;
      // cos is even, so k and −k are one wave.
      if (along < 0 || (along === 0 && around < 0)) { around = -around; along = -along; }
      const key = `${around},${along}`;
      const wave = merged.get(key);
      if (wave) wave.amp += weight; else merged.set(key, { around, along, amp: weight, mag: Math.hypot(around, along) });
    }
    let waves = [...merged.values()].sort((a, b) => b.amp - a.amp).slice(0, MAX_WAVES);
    if (!waves.length) waves = [{ around: G.WAVES_AROUND, along: 0, amp: 1, mag: G.WAVES_AROUND }];
    // Finer waves answer higher in the spectrum.
    const byMag = [...waves].sort((a, b) => a.mag - b.mag);
    const [lo, hi] = G.WAVE_DRIFT;
    for (const w of waves) {
      w.band = waves.length > 1 ? byMag.indexOf(w) / (waves.length - 1) : 0.5;
      w.phase = this.random() * Math.PI * 2;
      w.rate = (lo + this.random() * (hi - lo)) * (this.random() < 0.5 ? -1 : 1);
    }
    this.waves = waves;
    this.kick = 0;
    this.uniforms.uWaves = { value: Array.from({ length: MAX_WAVES }, () => new this.THREE.Vector4()) };
    this.uniforms.uWaveCount = { value: waves.length };
    defines.push('#define USE_WAVES', `#define MAX_WAVES ${MAX_WAVES}`);
  }

  /** The drawing's silhouette, 72 directions round, for the crystals' cross-section. */
  setupProfile(defines) {
    const outline = profileOutline(radialProfile(this.glyph));
    const value = Array.from({ length: 18 }, (_, i) => new this.THREE.Vector4(
      ...[0, 1, 2, 3].map((j) => outline(((i * 4 + j) / 72) * Math.PI * 2)),
    ));
    this.uniforms.uProfile = { value };
    defines.push('#define USE_PROFILE');
  }

  /** A light somewhere in the rock ahead, put there by each flare: lightning in the cloud. */
  setupFlash(defines) {
    this.flash = null;
    this.uniforms.uFlash = { value: new this.THREE.Vector4() };
    defines.push('#define USE_FLASH');
  }

  placeFlash() {
    const R = this.radius;
    const route = this.route;
    const s = route.s + R * (5 + 7 * this.random());
    const at = route.pointAt(s);
    const { up, right } = frame(route.tangentAt(s));
    const a = this.random() * Math.PI * 2;
    const out = R * (1.6 + 0.8 * this.random());
    this.flash = [0, 1, 2].map((i) => at[i] + (right[i] * Math.cos(a) + up[i] * Math.sin(a)) * out);
  }

  onInput(slot, data) {
    const G = GlyphTunnel;
    if (slot === 'branch') {
      const strong = data.strength >= G.GATE && this.time - this.lastJunction >= G.REFRACTORY;
      const node = strong ? this.route.junction({ strength: (data.strength - G.GATE) / (1 - G.GATE) }) : null;
      if (node) {
        this.lastJunction = this.time;
        this.announce(node, impact(data));
      } else {
        this.route.vent(data.strength);
      }
    } else if (slot === 'cavern') {
      const node = this.route.junction({ strength: 1, cavern: true });
      if (node) {
        this.lastJunction = this.time;
        this.announce(node, Math.max(0.6, impact(data)));
      }
    } else if (slot === 'flare') {
      const k = impact(data);
      this.flare = Math.max(this.flare, k);
      this.flareFrom = this.route.s;
      this.flareAge = 0;
      if (this.waves) this.kick += G.WAVE_KICK * k;
      if (this.uses.has('flash')) this.placeFlash();
    }
  }

  announce(node, strength) {
    this.pulses.push({ from: this.route.s, to: node.s, age: 0, strength });
    if (this.pulses.length > PULSES) this.pulses.shift();
  }

  draw(ctx, dt) {
    const G = GlyphTunnel;
    const u = this.uniforms;
    const R = this.radius;
    this.time += dt;
    this.route.update(dt);
    this.glow = approach(this.glow, clamp01(this.in('glow')), G.GLOW_TAU, dt);
    this.swell = approach(this.swell, clamp01(this.in('swell')), G.SWELL_TAU, dt);
    this.flare *= Math.exp(-G.FLARE_DECAY * dt);
    this.flareAge += dt;

    logSpectrum(this.frame?.spectrum, this.bins);
    for (let i = 0; i < BINS; i++) this.spec[i] = approach(this.spec[i], this.bins[i], 0.1, dt);
    for (let i = 0; i < BINS / 4; i++) u.uSpec.value[i].fromArray(this.spec, i * 4);

    for (let i = 0; i < PULSES; i++) {
      const p = this.pulses[i];
      if (!p) {
        u.uPulses.value[i].set(-1e4, 0, 0, 0);
        continue;
      }
      p.age += dt;
      const travel = (p.to - p.from) / (G.PULSE_SPEED * R);
      const front = Math.min(p.to, p.from + p.age * G.PULSE_SPEED * R);
      u.uPulses.value[i].set(front, p.strength * Math.exp(-Math.max(0, p.age - travel) * G.PULSE_FADE), 0, 0);
    }
    this.pulses = this.pulses.filter((p) => p.age < 8);

    if (this.record) this.writeRecord(dt);
    if (this.shafts) this.updateShafts();
    if (this.waves) this.updateWaves(dt);
    if (this.flash) {
      const [x, y, z] = this.route.camera().position;
      this.uniforms.uFlash.value.set(this.flash[0] - x, this.flash[1] - y, this.flash[2] - z, this.flare);
    }

    const cam = this.route.camera();
    this.pack(cam);
    u.uFw.value.fromArray(cam.forward);
    u.uRt.value.fromArray(cam.right);
    u.uUpv.value.fromArray(cam.up);
    u.uOrigin.value.fromArray(cam.position);
    const period = (this.substance.period ?? 1) * R;
    const wrap = (v) => ((v % period) + period) % period;
    u.uWrapped.value.set(wrap(cam.position[0]), wrap(cam.position[1]), wrap(cam.position[2]));
    u.uAspect.value = this.width / this.height;
    u.uTime.value = this.time;
    u.uCamS.value = this.route.s;
    u.uGlow.value = this.glow;
    u.uSwell.value = this.swell;
    u.uFlare.value = this.flare;
    u.uFlareS.value = this.flareFrom + this.flareAge * G.FLARE_SPEED * R;
    updatePalette(this, u);
    this.present(ctx);
  }

  /**
   * Hand the shader the pieces in view, camera-relative so they stay precise
   * however far the flight has gone: the route first, then each other
   * passage's pieces together, so the shader can join each passage hard and
   * blend it with the rest.
   */
  pack(cam) {
    const u = this.uniforms;
    const elong = this.substance.elong;
    const aspect = this.width / this.height;
    const f = GlyphTunnel.FOCAL;
    const { forward: fw, right: rt, up } = cam;
    // Inward normals of the view's four sides.
    const planes = [
      [aspect, -f, 0], [aspect, f, 0], [1, 0, -f], [1, 0, f],
    ].map(([a, b, c]) => {
      const n = [0, 1, 2].map((i) => fw[i] * a + rt[i] * b + up[i] * c);
      const l = length(n);
      return n.map((v) => v / l);
    });
    const shown = [];
    for (const p of this.route.pieces()) {
      const open = p.open * p.open * (3 - 2 * p.open);
      const r = Math.max(p.r0, p.r1) * open;
      if (r < 1e-3) continue;
      const c = [p.centre[0] - cam.position[0], p.centre[1] - cam.position[1], p.centre[2] - cam.position[2]];
      const reach = p.reach + r * elong + this.radius;
      const dist = length(c);
      if (dist - reach > this.far) continue;
      if (planes.some((n) => dot(n, c) < -reach)) continue;
      shown.push({ p, open, dist: dist - reach });
    }
    // Over the limit, the furthest passages go first; the route stays.
    shown.sort((a, b) => (a.p.chain === 0) - (b.p.chain === 0) || b.dist - a.dist);
    while (shown.length > MAX_PIECES) shown.shift();
    shown.sort((a, b) => a.p.chain - b.p.chain || a.p.s0 - b.p.s0);

    const [ox, oy, oz] = cam.position;
    shown.forEach(({ p, open }, i) => {
      u.uA.value[i].set(p.p0[0] - ox, p.p0[1] - oy, p.p0[2] - oz, p.kind);
      u.uB.value[i].set(p.t0[0], p.t0[1], p.t0[2], p.len);
      if (p.bend) {
        const [tx, ty, tz] = p.t0;
        const [bx, by, bz] = p.bend;
        u.uC.value[i].set(bx, by, bz, p.R);
        u.uF.value[i].set(ty * bz - tz * by, tz * bx - tx * bz, tx * by - ty * bx, Math.cos(p.len / p.R));
      } else {
        u.uC.value[i].set(0, 0, 0, 0);
        u.uF.value[i].set(0, 0, 0, 1);
      }
      u.uD.value[i].set(p.centre[0] - ox, p.centre[1] - oy, p.centre[2] - oz, p.reach);
      u.uE.value[i].set(p.r0 * open, p.r1 * open, p.s0, p.chain);
    });
    u.uCount.value = shown.length;
  }

  /**
   * Lay the music down at the far end of the view: four bands against their
   * recent dynamics, one texel per RECORD_STEP of route.
   */
  writeRecord(dt) {
    const rel = this.frame?.relative ?? {};
    const now = [rel.bass, rel.lowMid, rel.mid, rel.treble];
    for (let i = 0; i < 4; i++) this.recordLevels[i] = approach(this.recordLevels[i], now[i] ?? 0, 0.12, dt);
    const head = Math.floor((this.route.s + this.far + this.radius * 4) / this.recordStep);
    if (this.recordAt === null) this.recordAt = head;
    if (head <= this.recordAt) return;
    for (let k = Math.max(this.recordAt + 1, head - RECORD_TEXELS + 1); k <= head; k++) {
      const i = (((k % RECORD_TEXELS) + RECORD_TEXELS) % RECORD_TEXELS) * 4;
      for (let c = 0; c < 4; c++) this.record[i + c] = Math.round(clamp01(this.recordLevels[c]) * 255);
    }
    this.recordAt = head;
    this.recordTex.needsUpdate = true;
  }

  /** Sunbeams standing at intervals down the canyon, fixed in the world. */
  updateShafts() {
    const R = this.radius;
    const [lo, hi] = GlyphTunnel.SHAFT_GAP;
    const route = this.route;
    while (this.nextShaft < route.s + R * 24) {
      const s = this.nextShaft;
      const at = route.pointAt(s);
      const t = route.tangentAt(s);
      // Square to the route on the level, so the beam sits across the passage.
      const side = (this.random() - 0.5) * 0.6 * R;
      const sx = -t[2];
      const sz = t[0];
      const sl = Math.hypot(sx, sz) || 1;
      this.shafts.push({
        s,
        x: at[0] + (sx / sl) * side,
        z: at[2] + (sz / sl) * side,
        radius: R * (0.35 + 0.25 * this.random()),
        bright: 0.6 + 0.4 * this.random(),
      });
      this.nextShaft += R * (lo + (hi - lo) * this.random());
    }
    this.shafts = this.shafts.filter((sh) => sh.s > route.s - R * 3);
    const [ox, , oz] = route.camera().position;
    for (let i = 0; i < SHAFTS; i++) {
      const sh = this.shafts[i];
      if (sh) this.uniforms.uShafts.value[i].set(sh.x - ox, sh.z - oz, sh.radius, sh.bright);
      else this.uniforms.uShafts.value[i].set(0, 0, 1, 0);
    }
  }

  updateWaves(dt) {
    // A flare's jump is paid out over a few frames, so it lurches rather than cuts.
    const paid = this.kick * (1 - Math.exp(-6 * dt));
    this.kick -= paid;
    const around = Math.PI * 2 * this.radius;
    let total = 0;
    const amps = this.waves.map((w) => {
      const x = Math.min(BINS - 1, Math.round(w.band * (BINS - 1)));
      const a = w.amp * (0.5 + this.spec[x] * 1.2);
      total += a;
      return a;
    });
    this.waves.forEach((w, i) => {
      w.phase += dt * w.rate + paid * Math.sign(w.rate);
      this.uniforms.uWaves.value[i].set(w.around, w.along / around, amps[i] / (total || 1), w.phase);
    });
  }

  dispose() {
    super.dispose();
    for (const tex of this.textures) tex.dispose();
  }
}

const glslFloat = (v) => (Number.isInteger(v) ? `${v}.0` : `${v}`);

/**
 * Periodic gradient noise baked into bytes, NOISE_PERIOD lattice cells
 * across: shared by every tunnel, since it depends on nothing but itself.
 */
let NOISE = null;
function bakeNoise() {
  if (NOISE) return NOISE;
  const P = NOISE_PERIOD;
  const N = NOISE_SIZE;
  const rnd = mulberry32(0x7a11);
  const grads = new Float32Array(P * P * P * 3);
  for (let i = 0; i < P * P * P; i++) {
    const z = rnd() * 2 - 1;
    const a = rnd() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    grads.set([s * Math.cos(a), s * Math.sin(a), z], i * 3);
  }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const raw = new Float32Array(N * N * N);
  let lo = Infinity;
  let hi = -Infinity;
  const per = N / P;
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const px = x / per;
        const py = y / per;
        const pz = z / per;
        const ix = Math.floor(px);
        const iy = Math.floor(py);
        const iz = Math.floor(pz);
        const fx = px - ix;
        const fy = py - iy;
        const fz = pz - iz;
        let sum = 0;
        for (let c = 0; c < 8; c++) {
          const dx = c & 1;
          const dy = (c >> 1) & 1;
          const dz = c >> 2;
          const g = (((iz + dz) % P) * P * P + ((iy + dy) % P) * P + ((ix + dx) % P)) * 3;
          const v = grads[g] * (fx - dx) + grads[g + 1] * (fy - dy) + grads[g + 2] * (fz - dz);
          const wx = dx ? fade(fx) : 1 - fade(fx);
          const wy = dy ? fade(fy) : 1 - fade(fy);
          const wz = dz ? fade(fz) : 1 - fade(fz);
          sum += v * wx * wy * wz;
        }
        raw[(z * N + y) * N + x] = sum;
        lo = Math.min(lo, sum);
        hi = Math.max(hi, sum);
      }
    }
  }
  NOISE = new Uint8Array(N * N * N);
  for (let i = 0; i < raw.length; i++) NOISE[i] = Math.round(((raw[i] - lo) / (hi - lo)) * 255);
  return NOISE;
}

function fragment(substance, radius, defines) {
  return /* glsl */ `
${PALETTE_GLSL}
#define MAX_PIECES ${MAX_PIECES}
#define PULSES ${PULSES}
#define SHAFTS ${SHAFTS}
#define STEPS ${GlyphTunnel.STEPS}
#define SPANS ${GlyphTunnel.SPANS}
const float ELONG = ${glslFloat(substance.elong)};
const float BLEND = ${glslFloat(substance.blend * radius)};
const float STEP = ${glslFloat(substance.step)};
const float RELIEF_MAX = ${glslFloat(substance.relief)};
const float COVER = ${glslFloat(GlyphTunnel.COVER)};
const vec3 RING_LIGHT = vec3(${(substance.ring ?? [1, 0.85, 0.6]).map(glslFloat).join(', ')});
const float NOISE_PERIOD = ${glslFloat(NOISE_PERIOD)};
${defines.join('\n')}

// The pieces of the passages' axes in view, camera-relative.
uniform vec4 uA[MAX_PIECES];   // start, kind (0 line, 1 arc, 2 ball)
uniform vec4 uB[MAX_PIECES];   // heading at the start, length
uniform vec4 uC[MAX_PIECES];   // an arc's bend direction, and radius
uniform vec4 uD[MAX_PIECES];   // centre of its bound, and its axis's reach from there
uniform vec4 uE[MAX_PIECES];   // tube radius at start and end, route distance at the start, chain
uniform vec4 uF[MAX_PIECES];   // an arc's plane normal, and the cosine of its sweep
uniform int uCount;
uniform vec3 uFw;
uniform vec3 uRt;
uniform vec3 uUpv;
uniform float uAspect;
uniform float uFocal;
uniform vec3 uOrigin;    // the camera's world position
uniform vec3 uWrapped;   // and wrapped by the substance's period
uniform float uTime;
uniform float uCamS;     // the camera's distance along the route
uniform float uR;
uniform float uFar;
uniform float uGlow;
uniform float uSwell;
uniform float uFlare;
uniform float uFlareS;   // route distance a flare's front has reached
uniform vec4 uSpec[4];   // 16 log-spaced bins, bass first
uniform vec4 uPulses[PULSES];   // route distance of a ring of light, its strength
uniform float uStyle;    // 0 a substance's own colours, 1 the palette's
uniform float uLattice;
uniform highp sampler3D uNoise;
#ifdef USE_RECORD
uniform sampler2D uRecord;
#endif
#ifdef USE_SHAFTS
uniform vec4 uShafts[SHAFTS];   // camera-relative x, z; radius; brightness
#endif
#ifdef USE_FIELD
uniform sampler2D uField;
#endif
#ifdef USE_WAVES
uniform vec4 uWaves[MAX_WAVES];   // cycles round, cycles per unit along, amplitude, phase
uniform int uWaveCount;
#endif
#ifdef USE_PROFILE
uniform vec4 uProfile[18];
#endif
#ifdef USE_FLASH
uniform vec4 uFlash;   // camera-relative position of a light in the rock, and its strength
#endif

varying vec2 vUv;

const float TAU = 6.28318530718;
const vec3 UP = vec3(0.0, 1.0, 0.0);

// Which pieces matter near the stretch of this pixel's ray being marched,
// one bit each; set by main() as the march moves from span to span.
uint gNear;
// The piece voidDist() last found nearest.
int gBest = 0;

// The nearest passage's route distance, set by voidDist(); and the offset
// to the point from its axis, the axis's heading and the tube's radius
// there, set by nearest().
float gS;
// How much nearer the nearest passage is than the next one over, set by
// voidDist(): small where two passages blend, see seam().
float gGap;
vec3 gOff;
vec3 gTan;
float gRad;

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float smax(float a, float b, float k) {
  return -smin(-a, -b, k);
}

/** Smooth noise 0–1, one lattice cell per unit of q. */
float noise(vec3 q) {
  return texture(uNoise, q * (1.0 / NOISE_PERIOD)).r;
}

/** The spectrum at x, 0 bass … 1 treble. */
float spectrum(float x) {
  float f = clamp(x, 0.0, 1.0) * 15.0;
  int i = int(f);
  int j = min(i + 1, 15);
  return mix(uSpec[i >> 2][i & 3], uSpec[j >> 2][j & 3], fract(f));
}

// Where the palette is the window's line colour and its accent colour, for
// substances to put each on the light it suits.
const float LINE = 0.75;
const float ACCENT = 0.25;

/** A substance's own colour, or the palette's at t at the same brightness. */
vec3 tint(vec3 natural, float t) {
  const vec3 LUMA = vec3(0.299, 0.587, 0.114);
  vec3 hue = palette(t);
  vec3 styled = hue * (dot(natural, LUMA) / max(dot(hue, LUMA), 0.08));
  return mix(natural, styled, uStyle);
}

/** A light carried with the camera, falling off with distance. */
float headlight(vec3 n, vec3 rd, float t) {
  return max(dot(n, -rd), 0.0) / (1.0 + t * t * 0.01 / (uR * uR));
}

/** Up across the nearest passage: world up with its heading taken out. */
vec3 wallUp() {
  vec3 u = UP - gTan * dot(gTan, UP);
  float l = length(u);
  return l > 0.05 ? u / l : normalize(cross(gTan, vec3(1.0, 0.0, 0.0)));
}

/** Where on the nearest passage's wall: round it 0–1 from the top, and along it. */
vec2 wallCoord() {
  vec3 u = wallUp();
  vec3 side = cross(gTan, u);
  return vec2(atan(dot(gOff, side), dot(gOff, u)) / TAU + 0.5, gS);
}

/** A flare's light, from just behind the camera out to its front. */
float flareFront(float s) {
  return uFlare * smoothstep(uFlareS + uR, uFlareS - uR, s) * smoothstep(uCamS - 3.0 * uR, uCamS - uR, s);
}

#ifdef USE_RECORD
/** Band k (of four, repeating) of the music as it was when route distance s was laid down. */
float recordBand(float s, float k) {
  vec4 r = texture(uRecord, vec2(s / RECORD_SPAN, 0.5));
  return r[int(mod(k, 4.0))];
}
#endif

/** atan(y, x), to within 0.005 rad: plenty for where along an arc. */
float fastAtan(float y, float x) {
  float ax = abs(x);
  float ay = abs(y);
  float a = min(ax, ay) / max(max(ax, ay), 1e-12);
  float s = a * a;
  float r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
  if (ay > ax) r = 1.57079637 - r;
  if (x < 0.0) r = 3.14159274 - r;
  return y < 0.0 ? -r : r;
}

float metric(vec3 off) {
  // A tall passage: height counts for less.
  return length(off - UP * dot(off, UP) * (1.0 - 1.0 / ELONG));
}

/**
 * Piece i's distance to p, past its tube's wall — or NONE, without working
 * it out, if it can't be under limit. Also how far along the piece is
 * nearest (u), the offset to p from there, the heading there and the
 * tube's radius there. Along an arc u is only roughly right unless precise,
 * which wall patterns need: the rough angle's error, times an arc's radius,
 * would ripple them.
 */
const float NONE = 1e5;
float pieceVoid(int i, vec3 p, float limit, bool precise, out float u, out vec3 off, out vec3 tn, out float r) {
  vec4 A = uA[i];
  vec4 B = uB[i];
  vec4 E = uE[i];
  if (A.w < 0.5) {
    u = clamp(dot(p - A.xyz, B.xyz), 0.0, B.w);
    off = p - A.xyz - B.xyz * u;
    tn = B.xyz;
  } else if (A.w > 1.5) {
    // A chamber: along it is along the way the route came in, so the walls'
    // patterns carry through it.
    off = p - A.xyz;
    tn = B.xyz;
    u = dot(off, tn);
  } else {
    vec4 C = uC[i];
    vec4 F = uF[i];
    vec3 c = A.xyz + C.xyz * C.w;
    vec3 q = p - c;
    float x = -dot(q, C.xyz);
    float y = dot(q, B.xyz);
    float rho = length(vec2(x, y));
    // The arc is never nearer than its whole circle: rule it out on that.
    if (length(vec2(rho - C.w, dot(q, F.xyz))) / ELONG - max(E.x, E.y) > limit) return NONE;
    float sw = sqrt(max(0.0, 1.0 - F.w * F.w));
    if (y >= 0.0 && x * sw - y * F.w >= 0.0) {
      // Within the arc's sweep: square to it.
      float k = 1.0 / max(rho, 1e-6);
      off = q - (B.xyz * y - C.xyz * x) * (k * C.w);
      tn = (C.xyz * y + B.xyz * x) * k;
      u = C.w * (precise ? atan(y, x) : fastAtan(y, x));
    } else {
      // Past an end: the nearer one.
      vec3 o0 = p - A.xyz;
      vec3 o1 = q - C.w * (B.xyz * sw - C.xyz * F.w);
      if (dot(o0, o0) < dot(o1, o1)) {
        off = o0;
        tn = B.xyz;
        u = 0.0;
      } else {
        off = o1;
        tn = C.xyz * sw + B.xyz * F.w;
        u = B.w;
      }
    }
  }
  r = B.w > 0.0 ? mix(E.x, E.y, clamp(u / B.w, 0.0, 1.0)) : E.x;
  return metric(off) - r;
}

/**
 * Distance to the passages' wall, negative inside them: each passage's
 * pieces joined hard, end to end, and the passages blended into each other.
 * Notes which piece was nearest and the route distance there; nearest()
 * fills in the rest. Kept lean, since the march asks it dozens of times a
 * pixel.
 */
float voidDist(vec3 p) {
  float total = 1e5;
  float run = 1e5;
  float chain = -1.0;
  float best = 1e5;
  float bestChain = -1.0;
  float other = 1e5;
  uint bits = gNear;
  for (int k = 0; k < MAX_PIECES; k++) {
    if (bits == 0u) break;
    // The lowest bit left, and which piece it is.
    uint low = bits & (~bits + 1u);
    bits ^= low;
    int i = int(log2(float(low)) + 0.5);
    float c = uE[i].w;
    if (c != chain) {
      total = smin(total, run, BLEND);
      run = 1e5;
      chain = c;
    }
    float u;
    vec3 off;
    vec3 tn;
    float r;
    // Nothing to gain from a piece further than what's found.
    float v = pieceVoid(i, p, min(total, run) + BLEND, false, u, off, tn, r);
    if (v == NONE) continue;
    run = min(run, v);
    if (v < best) {
      if (c != bestChain) other = best;
      best = v;
      bestChain = c;
      gBest = i;
      gS = uE[i].z + u;
    } else if (c != bestChain) {
      other = min(other, v);
    }
  }
  gGap = other - best;
  return smin(total, run, BLEND);
}

/**
 * 0 where two passages blend into each other, rising to 1 clear of it. Each
 * passage has its own wall coordinates, so a pattern drawn on them meets its
 * neighbour's at a seam; fading it out there hides that.
 */
float seam() {
  return smoothstep(0.0, BLEND, gGap);
}

/** Fill in gOff, gTan and gRad at p from the piece voidDist() found nearest. */
void nearest(vec3 p) {
  float u;
  pieceVoid(gBest, p, NONE, true, u, gOff, gTan, gRad);
  gS = uE[gBest].z + u;
}

/**
 * The pieces whose bounds the ray along rd passes within reach of between
 * t0 and t1: nothing else can shape the scene along that stretch.
 */
uint nearSpan(vec3 rd, float t0, float t1) {
  uint near = 0u;
  for (int i = 0; i < MAX_PIECES; i++) {
    if (i >= uCount) break;
    vec4 D = uD[i];
    vec4 E = uE[i];
    // Room for the tube, the relief, the blends and the occlusion taps.
    float reach = D.w + max(E.x, E.y) * ELONG + BLEND + (RELIEF_MAX + 0.6) * uR;
    vec3 c = D.xyz - rd * clamp(dot(D.xyz, rd), t0, t1);
    if (dot(c, c) < reach * reach) near |= 1u << uint(i);
  }
  return near;
}

${substance.glsl}

float scene(vec3 p) {
  return wall(p + uOrigin, p, voidDist(p));
}

vec3 normalAt(vec3 p, float t) {
  // Wide enough not to pick out the texels of the textures walls are made
  // from, which shows as banding.
  float e = 0.004 * uR + 0.0006 * t;
  const vec2 k = vec2(1.0, -1.0);
  return normalize(
    k.xyy * scene(p + k.xyy * e) + k.yyx * scene(p + k.yyx * e) +
    k.yxy * scene(p + k.yxy * e) + k.xxx * scene(p + k.xxx * e)
  );
}

void main() {
  vec2 uv = (vUv * 2.0 - 1.0) * vec2(uAspect, 1.0);
  vec3 rd = normalize(uFw * uFocal + uv.x * uRt + uv.y * uUpv);
  vec3 haze = vec3(0.0);
  float t = 0.0;
  // The march asks only the pieces near the span of the ray it is in.
  float span = uFar / float(SPANS);
  int at = -1;
  for (int i = 0; i < STEPS; i++) {
    int here = min(int(t / span), SPANS - 1);
    if (here != at) {
      at = here;
      gNear = nearSpan(rd, float(at) * span, float(at + 1) * span);
    }
    vec3 p = rd * t;
    float vd = voidDist(p);
    // Clear of anything the substance's relief could reach, the passages'
    // wall alone bounds the distance, so it can be stepped in full.
    float d = -vd - RELIEF_MAX * uR;
    float run = d;
    if (d < 0.02 * uR) {
      d = wall(p + uOrigin, p, vd);
      run = d * STEP;
    }
    if (d < 0.001 * t + 0.001 * uR) break;
    t += run;
    if (t > uFar) break;
  }

#ifdef AIR
  haze = air(rd, min(t, uFar));
#endif
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  if (t < uFar) {
    vec3 p = rd * t;
    // normalAt() and the occlusion taps overwrite these.
    nearest(p);
    float s = gS;
    vec3 off = gOff;
    vec3 tn = gTan;
    float rad = gRad;
    float gap = gGap;
    vec3 n = normalAt(p, t);
    float e1 = 0.15 * uR;
    float e2 = 0.45 * uR;
    float ao = clamp(0.2 + 0.4 * scene(p + n * e1) / e1 + 0.4 * scene(p + n * e2) / e2, 0.0, 1.0);
    gS = s;
    gOff = off;
    gTan = tn;
    gRad = rad;
    gGap = gap;
    col = surface(p + uOrigin, p, n, rd, t, ao);
    // Rings of light running ahead to the junctions they announce.
    for (int k = 0; k < PULSES; k++) {
      vec4 pu = uPulses[k];
      float ring = exp(-abs(s - pu.x) / (0.5 * uR)) * pu.y;
      col += peak(tint(RING_LIGHT, 0.5 + float(k) * 0.17), pu.y) * ring * 0.9;
    }
    float fade = 1.0 - smoothstep(uFar * 0.55, uFar, t);
    // Bright wall covers what's behind it; dark wall lets it show, so a
    // background drawn first (a feedback trail, a field) glows in the
    // tunnel's shadows instead of vanishing behind it.
    alpha = fade * clamp(max(col.r, max(col.g, col.b)) * COVER, 0.0, 1.0);
    col *= fade;
  }
  // Premultiplied, with alpha at least the colour, or the compositor clips it.
  col += haze;
  float a = clamp(max(alpha, max(col.r, max(col.g, col.b))), 0.0, 1.0);
  gl_FragColor = vec4(min(col, vec3(a)), a);
}
`;
}
