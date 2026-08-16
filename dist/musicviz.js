var musicviz = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/engine.js
  var engine_exports = {};
  __export(engine_exports, {
    BANDS: () => BANDS,
    DEFAULT_TRIGGERS: () => DEFAULT_TRIGGERS,
    MusicViz: () => MusicViz,
    TRIGGER: () => TRIGGER,
    VIZ: () => VIZ,
    Visualization: () => Visualization,
    register: () => register,
    registry: () => registry
  });

  // src/emitter.js
  var Emitter = class {
    #listeners = /* @__PURE__ */ new Map();
    on(event, fn) {
      if (!this.#listeners.has(event)) this.#listeners.set(event, /* @__PURE__ */ new Set());
      this.#listeners.get(event).add(fn);
      return () => this.off(event, fn);
    }
    off(event, fn) {
      this.#listeners.get(event)?.delete(fn);
    }
    emit(event, payload) {
      this.#listeners.get(event)?.forEach((fn) => fn(payload));
    }
  };

  // src/player.js
  var SongPlayer = class extends Emitter {
    constructor(audioContext) {
      super();
      this.ctx = audioContext ?? new (window.AudioContext || window.webkitAudioContext)();
      this.output = this.ctx.createGain();
      this.output.connect(this.ctx.destination);
      this.buffer = null;
      this.source = null;
      this.startedAt = 0;
      this.offset = 0;
      this.playing = false;
    }
    /** Accepts a URL string or a File/Blob (e.g. from an <input type="file">). */
    async load(song) {
      this.stop();
      const arrayBuffer = song instanceof Blob ? await song.arrayBuffer() : await (await fetch(song)).arrayBuffer();
      this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
      this.offset = 0;
      this.emit("load", { duration: this.buffer.duration });
    }
    get duration() {
      return this.buffer?.duration ?? 0;
    }
    /** Current playback position in seconds. */
    get currentTime() {
      if (!this.playing) return this.offset;
      return Math.min(this.offset + (this.ctx.currentTime - this.startedAt), this.duration);
    }
    async play() {
      if (!this.buffer || this.playing) return;
      if (this.ctx.state === "suspended") await this.ctx.resume();
      this.source = this.ctx.createBufferSource();
      this.source.buffer = this.buffer;
      this.source.connect(this.output);
      this.source.onended = () => {
        if (this.playing && this.currentTime >= this.duration - 0.05) {
          this.playing = false;
          this.offset = 0;
          this.emit("ended");
        }
      };
      this.source.start(0, this.offset);
      this.startedAt = this.ctx.currentTime;
      this.playing = true;
      this.emit("play");
    }
    pause() {
      if (!this.playing) return;
      this.offset = this.currentTime;
      this.stop();
      this.emit("pause");
    }
    seek(time) {
      const wasPlaying = this.playing;
      this.offset = Math.max(0, Math.min(time, this.duration));
      if (wasPlaying) {
        this.stop();
        this.play();
      }
      this.emit("seek", { time: this.offset });
    }
    /** Tear down the current source node without emitting events. */
    stop() {
      if (this.source) {
        this.playing = false;
        try {
          this.source.stop();
        } catch {
        }
        this.source.disconnect();
        this.source = null;
      }
    }
  };

  // src/analyzer.js
  var BANDS = {
    subBass: [20, 60],
    bass: [60, 150],
    lowMid: [150, 400],
    mid: [400, 1200],
    highMid: [1200, 4e3],
    treble: [4e3, 16e3]
  };
  var TRIGGER = {
    BASS: "bass",
    SNARE: "snare",
    HIHAT: "hihat"
  };
  var DEFAULT_TRIGGERS = [
    { name: TRIGGER.BASS, band: [40, 130], threshold: 0.55, cooldown: 0.15 },
    { name: TRIGGER.SNARE, band: [1500, 4e3], threshold: 0.45, cooldown: 0.15 },
    { name: TRIGGER.HIHAT, band: [8e3, 14e3], threshold: 0.35, cooldown: 0.08 }
  ];
  var Analyzer = class extends Emitter {
    constructor(player, { fftSize = 2048, smoothing = 0.6, triggers = DEFAULT_TRIGGERS } = {}) {
      super();
      this.player = player;
      this.node = player.ctx.createAnalyser();
      this.node.fftSize = fftSize;
      this.node.smoothingTimeConstant = smoothing;
      player.output.connect(this.node);
      this.spectrum = new Uint8Array(this.node.frequencyBinCount);
      this.waveform = new Uint8Array(this.node.fftSize);
      this.binHz = player.ctx.sampleRate / this.node.fftSize;
      this.fired = /* @__PURE__ */ new Map();
      this.setTriggers(triggers);
    }
    /** Whether a trigger by this name is configured. */
    hasTrigger(name) {
      return this.triggers.some((t) => t.name === name);
    }
    setTriggers(triggers) {
      this.triggers = triggers.map((t) => ({
        ...t,
        prevEnergy: 0,
        lastFired: -Infinity
      }));
    }
    /** Average normalized magnitude of the FFT bins covering [lo, hi] Hz. */
    bandEnergy(lo, hi) {
      const start = Math.max(0, Math.floor(lo / this.binHz));
      const end = Math.min(this.spectrum.length - 1, Math.ceil(hi / this.binHz));
      let sum = 0;
      for (let i = start; i <= end; i++) sum += this.spectrum[i];
      return sum / ((end - start + 1) * 255);
    }
    /** Called by the engine once per animation frame. Returns the frame data. */
    update() {
      this.node.getByteFrequencyData(this.spectrum);
      this.node.getByteTimeDomainData(this.waveform);
      const time = this.player.currentTime;
      const bands = {};
      for (const [name, [lo, hi]] of Object.entries(BANDS)) {
        bands[name] = this.bandEnergy(lo, hi);
      }
      let sumSq = 0;
      for (let i = 0; i < this.waveform.length; i++) {
        const v = (this.waveform[i] - 128) / 128;
        sumSq += v * v;
      }
      const level = Math.sqrt(sumSq / this.waveform.length);
      const frame = { time, bands, level, spectrum: this.spectrum, waveform: this.waveform };
      this.emit("frame", frame);
      this.fired.clear();
      for (const t of this.triggers) {
        const energy = this.bandEnergy(t.band[0], t.band[1]);
        const rising = energy > t.prevEnergy;
        const offCooldown = time - t.lastFired >= t.cooldown;
        if (energy >= t.threshold && rising && offCooldown) {
          t.lastFired = time;
          const strength = Math.min(1, (energy - t.threshold) / (1 - t.threshold));
          const data = { name: t.name, time, energy, strength };
          this.fired.set(t.name, data);
          this.emit(`trigger:${t.name}`, data);
        }
        t.prevEnergy = energy;
      }
      return frame;
    }
  };

  // src/timeline.js
  var keyOf = (entry) => entry.bind ? `${entry.id}#${JSON.stringify(entry.bind)}` : entry.id;
  var normalize = (entry) => {
    const e = typeof entry === "string" ? { id: entry, bind: null } : { id: entry.id, bind: entry.bind ?? null };
    return { ...e, key: keyOf(e) };
  };
  var Timeline = class {
    constructor(windows = []) {
      this.setWindows(windows);
    }
    setWindows(windows) {
      this.windows = windows.map((w) => ({
        from: w.from ?? 0,
        to: w.to ?? Infinity,
        visualizations: (w.visualizations ?? []).map(normalize),
        style: w.style ?? null
      }));
    }
    /**
     * Merged style patch from every window covering time t, or null if none
     * carry one. Later windows override earlier ones key by key.
     */
    styleAt(t) {
      let merged = null;
      for (const w of this.windows) {
        if (w.style && t >= w.from && t < w.to) {
          merged = merged ? { ...merged, ...w.style } : w.style;
        }
      }
      return merged;
    }
    /**
     * Entries active at song time t (seconds), keyed by instance identity.
     * Two windows naming the same visualization with different bindings yield
     * two entries, so both can be on screen at once.
     */
    activeAt(t) {
      const active = /* @__PURE__ */ new Map();
      for (const w of this.windows) {
        if (t >= w.from && t < w.to) {
          for (const entry of w.visualizations) {
            if (!active.has(entry.key)) active.set(entry.key, entry);
          }
        }
      }
      return active;
    }
  };

  // src/util.js
  var approach = (current, target, tau, dt) => current + (target - current) * (1 - Math.exp(-dt / tau));
  var clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;

  // src/signals.js
  var warn = (path, message) => console.warn(`MusicViz routing (${path}): ${message}`);
  var constant = (k) => () => k;
  var band = (name, path) => {
    if (!(name in BANDS)) {
      warn(path, `unknown band '${name}' \u2014 expected one of ${Object.keys(BANDS).join(", ")}`);
      return constant(0);
    }
    return (frame) => frame?.bands?.[name] ?? 0;
  };
  var rms = () => (frame) => frame?.level ?? 0;
  var envelope = (name, decay) => {
    let value = 0;
    return (frame, dt, events) => {
      const hit = events?.get(name);
      if (hit) value = Math.max(value, hit.strength);
      value = Math.max(0, value - dt * decay);
      return value;
    };
  };
  var combine = (specs, path, reducer, seed) => {
    const parts = specs.map((s, i) => compileLevel(s, `${path}[${i}]`));
    return (frame, dt, events) => {
      let acc = seed;
      for (const part of parts) acc = reducer(acc, part(frame, dt, events));
      return acc;
    };
  };
  function compileLevel(spec, path = "input") {
    let signal;
    if (spec == null) {
      signal = constant(0);
    } else if (typeof spec === "number") {
      signal = constant(spec);
    } else if (typeof spec === "string") {
      signal = spec === "rms" ? rms() : band(spec, path);
    } else if (Array.isArray(spec)) {
      return combine(spec, path, (a, b) => a + b, 0);
    } else if (typeof spec === "object") {
      if (spec.band !== void 0) {
        signal = band(spec.band, path);
      } else if (spec.trigger !== void 0) {
        signal = envelope(spec.trigger, spec.decay ?? 3);
      } else if (spec.const !== void 0) {
        signal = constant(spec.const);
      } else if (spec.sum !== void 0) {
        signal = combine(spec.sum, path, (a, b) => a + b, 0);
      } else if (spec.max !== void 0) {
        signal = combine(spec.max, path, Math.max, 0);
      } else {
        warn(path, `no source in spec (expected band, trigger, const, sum or max)`);
        signal = constant(0);
      }
      if (spec.smooth) {
        const inner = signal;
        const tau = spec.smooth;
        let held = 0;
        signal = (f, dt, e) => held = approach(held, inner(f, dt, e), tau, dt);
      }
      if (spec.curve) {
        const inner = signal;
        const exponent = spec.curve;
        signal = (f, dt, e) => Math.pow(Math.max(0, inner(f, dt, e)), exponent);
      }
      if (spec.gain !== void 0) {
        const inner = signal;
        const gain = spec.gain;
        signal = (f, dt, e) => inner(f, dt, e) * gain;
      }
      if (spec.clamp) {
        const inner = signal;
        signal = (f, dt, e) => clamp01(inner(f, dt, e));
      }
    } else {
      warn(path, `cannot route from ${typeof spec}`);
      signal = constant(0);
    }
    return signal;
  }
  function resolveEvent(spec, path = "input") {
    if (typeof spec === "string") return spec;
    if (spec && typeof spec === "object" && typeof spec.trigger === "string") return spec.trigger;
    warn(path, "event slots take a trigger name");
    return null;
  }

  // src/visualizations/base.js
  var Visualization = class {
    static triggers = [];
    static inputs = {};
    constructor({ width, height, style, bind = null }) {
      this.width = width;
      this.height = height;
      this.style = style;
      this.frame = null;
      this.levels = {};
      this.signals = [];
      for (const [slot, def] of Object.entries(this.constructor.inputs)) {
        if (def.kind !== "level") continue;
        const spec = bind && bind[slot] !== void 0 ? bind[slot] : def.default;
        this.signals.push([slot, compileLevel(spec, `${this.constructor.id}.${slot}`)]);
        this.levels[slot] = 0;
      }
    }
    onFrame(frame) {
      this.frame = frame;
    }
    /** Called by the engine each tick, before draw. */
    updateInputs(frame, dt, events) {
      for (const [slot, signal] of this.signals) {
        this.levels[slot] = signal(frame, dt, events);
      }
    }
    /** Current value of a level input slot. */
    in(slot) {
      return this.levels[slot] ?? 0;
    }
    onInput(slot, data) {
    }
    onTrigger(name, data) {
    }
    draw(ctx, dt) {
    }
    resize(width, height) {
      this.width = width;
      this.height = height;
    }
    /** Apply the shared style object to a canvas context. */
    applyStyle(ctx) {
      const s = this.style;
      ctx.strokeStyle = s.lineColor;
      ctx.fillStyle = s.lineColor;
      ctx.lineWidth = s.lineWidth ?? 2;
      ctx.shadowBlur = s.shadowBlur ?? 0;
      ctx.shadowColor = s.shadowColor ?? s.lineColor;
    }
  };

  // src/visualizations/eq-bars.js
  var EQBars = class extends Visualization {
    static id = "eq-bars";
    constructor(opts) {
      super(opts);
      this.barCount = 28;
      this.values = new Float32Array(this.barCount);
    }
    draw(ctx, dt) {
      if (!this.frame) return;
      const { spectrum } = this.frame;
      const n = this.barCount;
      const gap = 4;
      const barW = (this.width - gap * (n + 1)) / n;
      const maxH = this.height * 0.75;
      this.applyStyle(ctx);
      for (let i = 0; i < n; i++) {
        const lo = Math.floor(Math.pow(spectrum.length, i / n));
        const hi = Math.max(lo + 1, Math.floor(Math.pow(spectrum.length, (i + 1) / n)));
        let sum = 0;
        for (let j = lo; j < hi; j++) sum += spectrum[j];
        const target = sum / ((hi - lo) * 255);
        this.values[i] = target > this.values[i] ? target : Math.max(target, this.values[i] - dt * 1.5);
        const h = this.values[i] * maxH;
        const x = gap + i * (barW + gap);
        const y = (this.height + maxH) / 2 - h;
        ctx.globalAlpha *= 0.9;
        ctx.fillRect(x, y, barW, h);
        ctx.globalAlpha /= 0.9;
      }
    }
  };

  // src/visualizations/waveform.js
  var Waveform = class extends Visualization {
    static id = "waveform";
    static inputs = {
      amplitude: { kind: "level", default: "rms" }
    };
    draw(ctx, dt) {
      if (!this.frame) return;
      const { waveform } = this.frame;
      const midY = this.height / 2;
      const amp = this.height * (0.2 + this.in("amplitude") * 0.6);
      this.applyStyle(ctx);
      ctx.beginPath();
      for (let i = 0; i < waveform.length; i++) {
        const x = i / (waveform.length - 1) * this.width;
        const y = midY + (waveform[i] - 128) / 128 * amp;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  };

  // src/visualizations/radial-burst.js
  var RadialBurst = class extends Visualization {
    static id = "radial-burst";
    static inputs = {
      ring: { kind: "event", default: TRIGGER.BASS },
      scatter: { kind: "event", default: TRIGGER.HIHAT },
      core: { kind: "level", default: "bass" }
    };
    constructor(opts) {
      super(opts);
      this.rings = [];
      this.ticks = [];
    }
    onInput(slot, { strength }) {
      if (slot === "ring") {
        this.rings.push({ r: 10, speed: 220 + strength * 380, life: 1 });
      } else if (slot === "scatter") {
        const count = 6 + Math.round(strength * 10);
        for (let i = 0; i < count; i++) {
          this.ticks.push({
            angle: Math.random() * Math.PI * 2,
            dist: Math.min(this.width, this.height) * (0.28 + Math.random() * 0.14),
            life: 1
          });
        }
      }
    }
    draw(ctx, dt) {
      const cx = this.width / 2;
      const cy = this.height / 2;
      this.applyStyle(ctx);
      const baseR = Math.min(this.width, this.height) * (0.06 + this.in("core") * 0.08);
      ctx.beginPath();
      ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
      ctx.stroke();
      for (const ring of this.rings) {
        ring.r += ring.speed * dt;
        ring.life -= dt * 1.4;
        if (ring.life <= 0) continue;
        ctx.globalAlpha *= Math.max(0, ring.life);
        ctx.beginPath();
        ctx.arc(cx, cy, ring.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha /= Math.max(0, ring.life);
      }
      this.rings = this.rings.filter((r) => r.life > 0);
      ctx.strokeStyle = this.style.accentColor ?? this.style.lineColor;
      for (const tick of this.ticks) {
        tick.life -= dt * 5;
        if (tick.life <= 0) continue;
        const len = 10 + tick.life * 14;
        const x1 = cx + Math.cos(tick.angle) * tick.dist;
        const y1 = cy + Math.sin(tick.angle) * tick.dist;
        ctx.globalAlpha *= Math.max(0, tick.life);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 + Math.cos(tick.angle) * len, y1 + Math.sin(tick.angle) * len);
        ctx.stroke();
        ctx.globalAlpha /= Math.max(0, tick.life);
      }
      this.ticks = this.ticks.filter((t) => t.life > 0);
    }
  };

  // src/visualizations/polygon-pulse.js
  var PolygonPulse = class extends Visualization {
    static id = "polygon-pulse";
    static inputs = {
      kick: { kind: "event", default: TRIGGER.SNARE },
      punch: { kind: "event", default: TRIGGER.BASS },
      sides: { kind: "level", default: "mid" },
      swell: { kind: "level", default: "bass" }
    };
    constructor(opts) {
      super(opts);
      this.rotation = 0;
      this.spin = 0.3;
      this.punch = 0;
    }
    onInput(slot, { strength }) {
      if (slot === "kick") this.spin += (Math.random() < 0.5 ? -1 : 1) * (2 + strength * 4);
      if (slot === "punch") this.punch = Math.max(this.punch, strength);
    }
    draw(ctx, dt) {
      const cx = this.width / 2;
      const cy = this.height / 2;
      this.spin += (0.3 - this.spin) * dt * 2;
      this.rotation += this.spin * dt;
      this.punch = Math.max(0, this.punch - dt * 3);
      const sides = 3 + Math.round(this.in("sides") * 6);
      const base = Math.min(this.width, this.height) * 0.22;
      const r = base * (1 + this.in("swell") * 0.4 + this.punch * 0.5);
      this.applyStyle(ctx);
      for (const [radius, color] of [[r, this.style.lineColor], [r * 0.62, this.style.accentColor ?? this.style.lineColor]]) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        for (let i = 0; i <= sides; i++) {
          const a = this.rotation + i / sides * Math.PI * 2;
          const x = cx + Math.cos(a) * radius;
          const y = cy + Math.sin(a) * radius;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
  };

  // src/visualizations/particles.js
  var ParticleField = class _ParticleField extends Visualization {
    static id = "particles";
    static inputs = {
      shove: { kind: "event", default: TRIGGER.BASS },
      twinkle: { kind: "level", default: "treble" }
    };
    static COUNT = 110;
    // A critically damped spring absorbs an impulse in roughly 1/OMEGA seconds
    // and lets it travel about v/(e*OMEGA) px, so OMEGA sets both how far a hit
    // throws the field and how long it takes to settle. Stiff values swallow
    // the shove before the eye catches it; this is soft enough that the field
    // is still moving when the next beat lands.
    static OMEGA = 3.2;
    // spring rate back to the drift point, rad/s
    static SHOVE = 460;
    // px/s of outward impulse at full strength
    static SWIRL = 0.35;
    // of the shove applied tangentially, so a hit
    // blooms rather than detonating in a clean ring
    static DRIFT = 16;
    // px/s of slow wandering
    static TRAIL = 0.07;
    // seconds of motion drawn behind each mote
    static MAX_TRAIL = 110;
    // px, so a heavy hit can't streak across the page
    static HEAT_SPEED = 400;
    // px/s that counts as "fully lit"; brightness
    // rides speed so the hit itself is what flashes
    static HOT = 0.45;
    // heat above which a mote burns accent-coloured
    static MIN_TRAIL = 0.5;
    // px; a round-capped stub is how a still mote
    // renders as a dot, and zero-length subpaths are
    // not reliably drawn
    constructor(opts) {
      super(opts);
      this.particles = Array.from({ length: _ParticleField.COUNT }, () => this.spawn());
    }
    spawn() {
      const { DRIFT } = _ParticleField;
      const x = Math.random() * this.width;
      const y = Math.random() * this.height;
      return {
        x,
        y,
        // live position
        hx: x,
        hy: y,
        // home: where it drifts, and springs back to
        hvx: (Math.random() - 0.5) * DRIFT * 2,
        hvy: (Math.random() - 0.5) * DRIFT * 2,
        vx: 0,
        vy: 0,
        size: 1 + Math.random() * 2.5,
        phase: Math.random() * Math.PI * 2,
        // Per-mote gain and swirl direction, so a hit scatters the field
        // unevenly instead of moving it as one rigid shell.
        respond: 0.55 + Math.random() * 0.9,
        swirl: Math.random() < 0.5 ? -1 : 1,
        ax: x,
        ay: y,
        alpha: 0,
        lw: 1
        // streak tail + per-mote draw state
      };
    }
    onInput(slot, { strength }) {
      if (slot !== "shove") return;
      const { SHOVE, SWIRL } = _ParticleField;
      const cx = this.width / 2;
      const cy = this.height / 2;
      for (const p of this.particles) {
        const dx = p.x - cx;
        const dy = p.y - cy;
        const d = Math.hypot(dx, dy) || 1;
        const kick = SHOVE * (0.3 + strength * 0.7) * p.respond;
        p.vx += (dx / d + -dy / d * SWIRL * p.swirl) * kick;
        p.vy += (dy / d + dx / d * SWIRL * p.swirl) * kick;
      }
    }
    draw(ctx, dt) {
      const { OMEGA, TRAIL, MAX_TRAIL, MIN_TRAIL, HEAT_SPEED, HOT } = _ParticleField;
      const treble = this.in("twinkle");
      const w = this.width;
      const h = this.height;
      const decay = Math.exp(-OMEGA * dt);
      const baseAlpha = ctx.globalAlpha;
      this.applyStyle(ctx);
      ctx.lineCap = "round";
      const glow = new Path2D();
      for (const p of this.particles) {
        p.hx += p.hvx * dt;
        p.hy += p.hvy * dt;
        if (p.hx < 0) {
          p.hx = 0;
          p.hvx = Math.abs(p.hvx);
        } else if (p.hx > w) {
          p.hx = w;
          p.hvx = -Math.abs(p.hvx);
        }
        if (p.hy < 0) {
          p.hy = 0;
          p.hvy = Math.abs(p.hvy);
        } else if (p.hy > h) {
          p.hy = h;
          p.hvy = -Math.abs(p.hvy);
        }
        let ch = p.x - p.hx;
        let tmp = (p.vx + OMEGA * ch) * dt;
        p.vx = (p.vx - OMEGA * tmp) * decay;
        p.x = p.hx + (ch + tmp) * decay;
        ch = p.y - p.hy;
        tmp = (p.vy + OMEGA * ch) * dt;
        p.vy = (p.vy - OMEGA * tmp) * decay;
        p.y = p.hy + (ch + tmp) * decay;
        const speed = Math.hypot(p.vx, p.vy);
        let tx = -p.vx * TRAIL;
        let ty = -p.vy * TRAIL;
        const len = Math.hypot(tx, ty);
        if (len > MAX_TRAIL) {
          tx = tx / len * MAX_TRAIL;
          ty = ty / len * MAX_TRAIL;
        } else if (len < MIN_TRAIL) {
          tx = MIN_TRAIL;
          ty = 0;
        }
        p.ax = p.x + tx;
        p.ay = p.y + ty;
        p.phase += dt * (0.6 + treble * 6);
        const shimmer = 0.5 + 0.5 * Math.sin(p.phase);
        const heat = Math.min(1, speed / HEAT_SPEED);
        p.hot = heat > HOT;
        p.alpha = Math.min(1, 0.18 + shimmer * (0.22 + treble * 0.5) + heat * 0.55);
        p.lw = p.size * (1 + treble * 0.8 + heat * 0.5);
        glow.moveTo(p.ax, p.ay);
        glow.lineTo(p.x, p.y);
      }
      ctx.globalAlpha = baseAlpha * (0.1 + treble * 0.18);
      ctx.lineWidth = (this.style.lineWidth ?? 2) * 1.6;
      ctx.stroke(glow);
      ctx.shadowBlur = 0;
      const accent = this.style.accentColor ?? this.style.lineColor;
      for (const p of this.particles) {
        ctx.strokeStyle = p.hot ? accent : this.style.lineColor;
        ctx.globalAlpha = baseAlpha * p.alpha;
        ctx.lineWidth = p.lw;
        ctx.beginPath();
        ctx.moveTo(p.ax, p.ay);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      ctx.globalAlpha = baseAlpha;
    }
  };

  // src/visualizations/shape.js
  function sampleTrace(wf, segments) {
    const shape = new Float32Array(segments);
    if (!wf) return shape;
    const stride = wf.length / segments;
    for (let i = 0; i < segments; i++) {
      let sum = 0;
      const s0 = Math.floor(i * stride);
      const s1 = Math.floor((i + 1) * stride);
      for (let j = s0; j < s1; j++) sum += wf[j] - 128;
      shape[i] = sum / ((s1 - s0) * 128);
    }
    return shape;
  }
  function sampleEnvelope(wf, segments) {
    const env = new Float32Array(segments);
    if (!wf) return env;
    const stride = wf.length / segments;
    for (let i = 0; i < segments; i++) {
      let sum = 0;
      const s0 = Math.floor(i * stride);
      const s1 = Math.floor((i + 1) * stride);
      for (let j = s0; j < s1; j++) {
        const v = (wf[j] - 128) / 128;
        sum += v * v;
      }
      env[i] = Math.sqrt(sum / (s1 - s0));
    }
    return env;
  }
  function expandEnvelope(env, floor) {
    if (!(floor > 0)) return env;
    const span = 1 - floor;
    for (let i = 0; i < env.length; i++) {
      env[i] = env[i] > floor ? (env[i] - floor) / span : 0;
    }
    return env;
  }
  function signsOf(shape) {
    const signs = new Float32Array(shape.length);
    for (let i = 0; i < shape.length; i++) signs[i] = shape[i] < 0 ? -1 : 1;
    return signs;
  }

  // src/visualizations/road.js
  var Road = class _Road extends Visualization {
    static id = "road";
    static inputs = {
      swell: { kind: "level", default: "rms" }
    };
    static Z_NEAR = 1.5;
    static Z_FAR = 30;
    static SPACING = 1.2;
    static SEGMENTS = 64;
    static SPEED = 9;
    // world units per second
    // --- live rungs (tune these by eye) ---
    static LIVE_EVERY = 3;
    // 1 rung in N keeps tracking the music; 0 disables
    static LIVE_TAU = 0.25;
    // seconds to cover most of the way to the current
    // envelope. Larger = smoother and lazier; below
    // ~0.15 it starts to look like the jumpy waveform.
    static LIVE_GAIN = 0.8;
    // envelope → trace-sized displacement, so live
    // rungs sit at the same scale as frozen ones.
    static LIVE_FLOOR = 0.06;
    // envelope below this reads as silence, so the
    // line has something to fall back to. Raise until
    // quiet passages flatten; too high and only the
    // loudest peaks move the line at all.
    constructor(opts) {
      super(opts);
      this.rungs = [];
      this.sinceSpawn = _Road.SPACING;
      this.spawned = 0;
    }
    /**
     * Ease every live rung toward the current envelope. One envelope is sampled
     * per frame and shared: they're all reading the same instant, and they
     * differ because each keeps its own silhouette and its own lag.
     */
    updateLive(dt) {
      const { SEGMENTS, LIVE_TAU, LIVE_GAIN, LIVE_FLOOR } = _Road;
      if (!this.rungs.some((r) => r.signs)) return;
      const env = expandEnvelope(sampleEnvelope(this.frame?.waveform, SEGMENTS), LIVE_FLOOR);
      for (const rung of this.rungs) {
        if (!rung.signs) continue;
        for (let i = 0; i < SEGMENTS; i++) {
          const target = rung.signs[i] * env[i] * LIVE_GAIN;
          rung.shape[i] = approach(rung.shape[i], target, LIVE_TAU, dt);
        }
      }
    }
    draw(ctx, dt) {
      const { Z_NEAR, Z_FAR, SPACING, SEGMENTS, SPEED, LIVE_EVERY } = _Road;
      const w = this.width;
      const h = this.height;
      const cx = w / 2;
      const horizonY = h * 0.42;
      const K = (h - horizonY) * Z_NEAR;
      const W = w * 0.9 * Z_NEAR;
      const level = this.in("swell");
      for (const r of this.rungs) r.z -= SPEED * dt;
      this.rungs = this.rungs.filter((r) => r.z > Z_NEAR * 0.75);
      this.sinceSpawn += SPEED * dt;
      while (this.sinceSpawn >= SPACING) {
        this.sinceSpawn -= SPACING;
        const shape = sampleTrace(this.frame?.waveform, SEGMENTS);
        const live = LIVE_EVERY > 0 && this.spawned % LIVE_EVERY === 0;
        this.spawned++;
        this.rungs.push({
          z: Z_FAR - this.sinceSpawn,
          shape,
          level,
          signs: live ? signsOf(shape) : null
        });
      }
      this.updateLive(dt);
      this.applyStyle(ctx);
      ctx.globalAlpha *= 0.6;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx, horizonY);
        ctx.lineTo(cx + side * W / Z_NEAR, horizonY + K / Z_NEAR);
        ctx.stroke();
      }
      ctx.globalAlpha /= 0.6;
      const sorted = [...this.rungs].sort((a, b) => b.z - a.z);
      for (const rung of sorted) {
        const y0 = horizonY + K / rung.z;
        const half = W / rung.z;
        const amp = h * 0.16 * (Z_NEAR / rung.z) * (0.4 + rung.level * 1.2);
        const fade = Math.min(1, (Z_FAR - rung.z) / (Z_FAR * 0.25));
        ctx.globalAlpha *= fade;
        ctx.beginPath();
        for (let i = 0; i < SEGMENTS; i++) {
          const x = cx - half + i / (SEGMENTS - 1) * half * 2;
          const y = y0 - rung.shape[i] * amp;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.globalAlpha /= fade;
      }
    }
  };

  // src/visualizations/tunnel.js
  var closeSeam = (shape, blend = 8) => {
    const n = shape.length;
    for (let i = 0; i < blend; i++) {
      const t = i / blend;
      shape[n - blend + i] = shape[n - blend + i] * (1 - t) + shape[0] * t;
    }
    return shape;
  };
  var Tunnel = class _Tunnel extends Visualization {
    static id = "tunnel";
    static inputs = {
      spin: { kind: "level", default: "treble" }
    };
    static Z_NEAR = 0.14;
    static Z_FAR = 4;
    static SPACING = 0.34;
    static SEGMENTS = 48;
    static SPEED = 0.75;
    // world units per second
    static SPIN_SMOOTHING = 3;
    // higher = rotation tracks treble more tightly
    // --- live rings (tune these by eye) ---
    static LIVE_EVERY = 3;
    // 1 ring in N keeps tracking the music; 0 disables
    static LIVE_TAU = 0.45;
    // seconds to cover most of the way to the current
    // envelope. Larger = smoother and lazier; below
    // ~0.15 it starts to look like the jumpy waveform.
    static LIVE_GAIN = 0.8;
    // envelope → trace-sized displacement, so live
    // rings sit at the same scale as frozen ones.
    static LIVE_FLOOR = 0.06;
    // envelope below this reads as silence, so the
    // ring has something to relax back to. Raise until
    // quiet passages round the ring out; too high and
    // only the loudest peaks deform it at all.
    constructor(opts) {
      super(opts);
      this.rings = [];
      this.sinceSpawn = _Tunnel.SPACING;
      this.rotation = 0;
      this.spinRate = 0;
      this.spawned = 0;
    }
    /**
     * Ease every live ring toward the current envelope. One envelope is sampled
     * per frame and shared: they're all reading the same instant, and they
     * differ because each keeps its own silhouette and its own lag.
     */
    updateLive(dt) {
      const { SEGMENTS, LIVE_TAU, LIVE_GAIN, LIVE_FLOOR } = _Tunnel;
      if (!this.rings.some((r) => r.signs)) return;
      const env = expandEnvelope(sampleEnvelope(this.frame?.waveform, SEGMENTS), LIVE_FLOOR);
      for (const ring of this.rings) {
        if (!ring.signs) continue;
        const target = new Float32Array(SEGMENTS);
        for (let i = 0; i < SEGMENTS; i++) target[i] = ring.signs[i] * env[i] * LIVE_GAIN;
        closeSeam(target);
        for (let i = 0; i < SEGMENTS; i++) {
          ring.shape[i] = approach(ring.shape[i], target[i], LIVE_TAU, dt);
        }
      }
    }
    draw(ctx, dt) {
      const { Z_NEAR, Z_FAR, SPACING, SEGMENTS, SPEED, SPIN_SMOOTHING, LIVE_EVERY } = _Tunnel;
      const cx = this.width / 2;
      const cy = this.height / 2;
      const focal = Math.min(this.width, this.height) * 0.14;
      const target = 0.15 + this.in("spin") * 1.2;
      this.spinRate += (target - this.spinRate) * Math.min(1, dt * SPIN_SMOOTHING);
      this.rotation += dt * this.spinRate;
      for (const r of this.rings) r.z -= SPEED * dt;
      this.rings = this.rings.filter((r) => r.z > Z_NEAR);
      this.sinceSpawn += SPEED * dt;
      while (this.sinceSpawn >= SPACING) {
        this.sinceSpawn -= SPACING;
        const shape = closeSeam(sampleTrace(this.frame?.waveform, SEGMENTS));
        const live = LIVE_EVERY > 0 && this.spawned % LIVE_EVERY === 0;
        this.spawned++;
        this.rings.push({
          z: Z_FAR - this.sinceSpawn,
          shape,
          signs: live ? signsOf(shape) : null
        });
      }
      this.updateLive(dt);
      this.applyStyle(ctx);
      const sorted = [...this.rings].sort((a, b) => b.z - a.z);
      for (const ring of sorted) {
        const radius = focal / ring.z;
        const depth = 1 - (ring.z - Z_NEAR) / (Z_FAR - Z_NEAR);
        const alpha = Math.pow(depth, 1.6);
        ctx.globalAlpha *= alpha;
        ctx.strokeStyle = depth > 0.82 ? this.style.accentColor ?? this.style.lineColor : this.style.lineColor;
        ctx.beginPath();
        for (let i = 0; i <= SEGMENTS; i++) {
          const idx = i % SEGMENTS;
          const a = this.rotation + idx / SEGMENTS * Math.PI * 2;
          const r = radius * (1 + ring.shape[idx] * 0.45);
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.globalAlpha /= alpha;
      }
    }
  };

  // src/visualizations/rolling-ball.js
  var RollingBall = class _RollingBall extends Visualization {
    static id = "rolling-ball";
    static inputs = {
      swerve: { kind: "event", default: TRIGGER.SNARE },
      speed: { kind: "level", default: "rms" },
      swell: { kind: "level", default: "bass" }
    };
    static LATITUDES = 7;
    // rings between the poles
    static MERIDIANS = 12;
    // pole-to-pole half circles
    static RESOLUTION = 48;
    // points per full circle
    static RADIUS = 0.3;
    // of the smaller screen dimension
    static SWELL = 0.14;
    // extra radius at full `swell`
    static BASE_SPIN = 0.9;
    // rad/s at silence
    static SPIN_GAIN = 2.4;
    // extra rad/s at full `speed`
    static SPIN_TAU = 0.35;
    // roll rate is smoothed; tracking level directly
    // makes the tumble stutter frame to frame
    static TURN_TAU = 0.12;
    // heading ease; small enough to read as a swerve
    static MIN_TURN = 0.9;
    // radians; smallest swerve a hit can produce
    static MAX_TURN = 2.4;
    // radians; largest, at full strength
    static KICK_DECAY = 2.5;
    // per second, for the post-hit speed surge
    static BACK_ALPHA = 0.22;
    // far hemisphere, relative to the near one
    constructor(opts) {
      super(opts);
      this.lines = _RollingBall.buildWireframe();
      this.m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      this.heading = 0;
      this.targetHeading = 0;
      this.spin = _RollingBall.BASE_SPIN;
      this.kick = 0;
    }
    /** Unit-sphere polylines: latitude rings plus pole-to-pole meridians. */
    static buildWireframe() {
      const { LATITUDES, MERIDIANS, RESOLUTION } = _RollingBall;
      const lines = [];
      for (let i = 1; i <= LATITUDES; i++) {
        const phi = i / (LATITUDES + 1) * Math.PI;
        const sp = Math.sin(phi);
        const cp = Math.cos(phi);
        const pts = new Float32Array((RESOLUTION + 1) * 3);
        for (let j = 0; j <= RESOLUTION; j++) {
          const th = j / RESOLUTION * Math.PI * 2;
          pts[j * 3] = sp * Math.cos(th);
          pts[j * 3 + 1] = cp;
          pts[j * 3 + 2] = sp * Math.sin(th);
        }
        lines.push(pts);
      }
      const half = Math.round(RESOLUTION / 2);
      for (let i = 0; i < MERIDIANS; i++) {
        const th = i / MERIDIANS * Math.PI * 2;
        const ct = Math.cos(th);
        const st = Math.sin(th);
        const pts = new Float32Array((half + 1) * 3);
        for (let j = 0; j <= half; j++) {
          const phi = j / half * Math.PI;
          const sp = Math.sin(phi);
          pts[j * 3] = sp * ct;
          pts[j * 3 + 1] = Math.cos(phi);
          pts[j * 3 + 2] = sp * st;
        }
        lines.push(pts);
      }
      return lines;
    }
    onInput(slot, { strength }) {
      if (slot !== "swerve") return;
      const { MIN_TURN, MAX_TURN } = _RollingBall;
      const turn = MIN_TURN + strength * (MAX_TURN - MIN_TURN);
      this.targetHeading += (Math.random() < 0.5 ? -1 : 1) * turn;
      this.kick = Math.max(this.kick, strength);
    }
    /**
     * Pre-multiply the accumulated orientation by a rotation of `angle` about
     * the screen-space axis (ax, ay, 0), then pull the basis back onto the
     * orthonormal manifold it drifts off of.
     */
    rotate(ax, ay, angle) {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const t = 1 - c;
      const r = [
        t * ax * ax + c,
        t * ax * ay,
        s * ay,
        t * ax * ay,
        t * ay * ay + c,
        -s * ax,
        -s * ay,
        s * ax,
        c
      ];
      const m = this.m;
      const out = new Array(9);
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          out[i * 3 + j] = r[i * 3] * m[j] + r[i * 3 + 1] * m[3 + j] + r[i * 3 + 2] * m[6 + j];
        }
      }
      let n = Math.hypot(out[0], out[1], out[2]) || 1;
      out[0] /= n;
      out[1] /= n;
      out[2] /= n;
      const d = out[0] * out[3] + out[1] * out[4] + out[2] * out[5];
      out[3] -= out[0] * d;
      out[4] -= out[1] * d;
      out[5] -= out[2] * d;
      n = Math.hypot(out[3], out[4], out[5]) || 1;
      out[3] /= n;
      out[4] /= n;
      out[5] /= n;
      out[6] = out[1] * out[5] - out[2] * out[4];
      out[7] = out[2] * out[3] - out[0] * out[5];
      out[8] = out[0] * out[4] - out[1] * out[3];
      this.m = out;
    }
    draw(ctx, dt) {
      const {
        BASE_SPIN,
        SPIN_GAIN,
        SPIN_TAU,
        TURN_TAU,
        KICK_DECAY,
        RADIUS,
        SWELL,
        BACK_ALPHA
      } = _RollingBall;
      const cx = this.width / 2;
      const cy = this.height / 2;
      this.kick = Math.max(0, this.kick - dt * KICK_DECAY);
      this.heading = approach(this.heading, this.targetHeading, TURN_TAU, dt);
      this.spin = approach(this.spin, BASE_SPIN + this.in("speed") * SPIN_GAIN, SPIN_TAU, dt);
      this.rotate(-Math.sin(this.heading), Math.cos(this.heading), (this.spin + this.kick * 2) * dt);
      const m = this.m;
      const radius = Math.min(this.width, this.height) * RADIUS * (1 + this.in("swell") * SWELL + this.kick * 0.06);
      const back = new Path2D();
      const front = new Path2D();
      for (const pts of this.lines) {
        let prevPath = null;
        let px = 0;
        let py = 0;
        let pz = 0;
        for (let i = 0; i < pts.length; i += 3) {
          const x = pts[i];
          const y = pts[i + 1];
          const z = pts[i + 2];
          const rx = m[0] * x + m[1] * y + m[2] * z;
          const ry = m[3] * x + m[4] * y + m[5] * z;
          const rz = m[6] * x + m[7] * y + m[8] * z;
          const sx = cx + rx * radius;
          const sy = cy - ry * radius;
          const path = rz >= 0 ? front : back;
          if (prevPath === null) {
            path.moveTo(sx, sy);
          } else if (path === prevPath) {
            path.lineTo(sx, sy);
          } else {
            const t = pz / (pz - rz);
            const mx = px + (sx - px) * t;
            const my = py + (sy - py) * t;
            prevPath.lineTo(mx, my);
            path.moveTo(mx, my);
            path.lineTo(sx, sy);
          }
          prevPath = path;
          px = sx;
          py = sy;
          pz = rz;
        }
      }
      const baseAlpha = ctx.globalAlpha;
      this.applyStyle(ctx);
      ctx.globalAlpha = baseAlpha * BACK_ALPHA;
      ctx.shadowBlur = 0;
      ctx.stroke(back);
      ctx.globalAlpha = baseAlpha;
      ctx.shadowBlur = this.style.shadowBlur ?? 0;
      ctx.stroke(front);
      ctx.globalAlpha = baseAlpha * (0.35 + this.kick * 0.5);
      ctx.strokeStyle = this.style.accentColor ?? this.style.lineColor;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = baseAlpha;
    }
  };

  // src/visualizations/starfield.js
  var Starfield = class _Starfield extends Visualization {
    static id = "starfield";
    static inputs = {
      swell: { kind: "event", default: TRIGGER.BASS }
    };
    static SPEED = 0.5;
    // depth units per second
    constructor(opts) {
      super(opts);
      this.stars = Array.from({ length: 240 }, () => this.spawn(Math.random()));
      this.sizeBoost = 0;
    }
    spawn(z = 1) {
      return {
        x: Math.random() * 2 - 1,
        y: Math.random() * 2 - 1,
        z
      };
    }
    onInput(slot, { strength }) {
      if (slot === "swell") this.sizeBoost = Math.max(this.sizeBoost, strength);
    }
    draw(ctx, dt) {
      const cx = this.width / 2;
      const cy = this.height / 2;
      const focal = Math.min(this.width, this.height) * 0.5;
      this.sizeBoost = Math.max(0, this.sizeBoost - dt * 2.2);
      this.applyStyle(ctx);
      ctx.shadowBlur = 0;
      for (const s of this.stars) {
        const prevZ = s.z;
        s.z -= _Starfield.SPEED * dt;
        if (s.z <= 0.03) {
          Object.assign(s, this.spawn(1));
          continue;
        }
        const sx = cx + s.x * focal / s.z;
        const sy = cy + s.y * focal / s.z;
        if (sx < 0 || sx > this.width || sy < 0 || sy > this.height) {
          Object.assign(s, this.spawn(1));
          continue;
        }
        const depth = 1 - s.z;
        const size = (0.4 + depth * 2.6) * (1 + this.sizeBoost * 5.4);
        ctx.globalAlpha *= Math.min(1, 0.15 + depth * 1.1);
        const px = cx + s.x * focal / prevZ;
        const py = cy + s.y * focal / prevZ;
        ctx.lineWidth = size;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(sx, sy);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(sx, sy, size / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha /= Math.min(1, 0.15 + depth * 1.1);
      }
      ctx.lineWidth = this.style.lineWidth ?? 2;
    }
  };

  // src/visualizations/lightning.js
  var subdivide = (pts, displace, passes, roughness) => {
    for (let p = 0; p < passes; p++) {
      const next = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const off = (Math.random() * 2 - 1) * displace;
        next.push({ x: (a.x + b.x) / 2 - dy / len * off, y: (a.y + b.y) / 2 + dx / len * off });
        next.push(b);
      }
      pts = next;
      displace *= roughness;
    }
    return pts;
  };
  var Lightning = class _Lightning extends Visualization {
    static id = "lightning";
    static inputs = {
      strike: { kind: "event", default: TRIGGER.BASS },
      offshoot: { kind: "event", default: TRIGGER.SNARE },
      flicker: { kind: "event", default: TRIGGER.HIHAT },
      wander: { kind: "level", default: "mid" },
      fork: { kind: "level", default: "highMid" }
    };
    static MAX_BOLTS = 6;
    static TIERS = 3;
    // main channel, fork, twig
    static GROW_SECONDS = 0.12;
    // strike-to-full time; short is what sells it
    static FADE_SECONDS = 0.5;
    static MAX_SEGMENTS = 240;
    // per bolt, guards against fork blowup
    static ROUGHNESS = 0.55;
    // >0.5 keeps fine kinks sharp; 0.5 halves them
    static PASSES = 5;
    // main channel detail; 2^PASSES segments
    // --- firing rate (tune these by ear) ---
    static STRIKE_THRESHOLD = 0.35;
    // trigger strength needed for a real bolt;
    // weaker hits only flicker what's lit
    static REFRACTORY_SECONDS = 0.4;
    // hard floor on the gap between bolts, so a
    // busy drum pattern can't become a strobe
    static IDLE_STRIKE_SECONDS = 5;
    // last-resort strike so a long quiet
    // passage isn't an empty screen
    constructor(opts) {
      super(opts);
      this.bolts = [];
      this.flicker = 0;
      this.flash = 0;
      this.sinceStrike = 0;
    }
    onInput(slot, { strength }) {
      if (slot === "flicker") {
        this.flicker = Math.max(this.flicker, 0.5 + strength * 0.5);
        return;
      }
      if (slot !== "strike" && slot !== "offshoot") return;
      const { STRIKE_THRESHOLD, REFRACTORY_SECONDS } = _Lightning;
      if (strength < STRIKE_THRESHOLD || this.sinceStrike < REFRACTORY_SECONDS) {
        this.flicker = Math.max(this.flicker, 0.3 + strength * 0.4);
        return;
      }
      if (slot === "strike") {
        this.strike(strength, 1);
        this.flash = Math.max(this.flash, 0.5 + strength * 0.5);
      } else {
        this.strike(strength, 0.55);
      }
    }
    /** Generate one bolt's full geometry and push it onto the live list. */
    strike(strength, reach) {
      const { MAX_BOLTS, TIERS, MAX_SEGMENTS, ROUGHNESS, PASSES } = _Lightning;
      const w = this.width;
      const h = this.height;
      const jag = 0.1 + this.in("wander") * 0.16;
      const forkChance = 0.1 + this.in("fork") * 0.16;
      const byTier = Array.from({ length: TIERS }, () => []);
      let count = 0;
      let maxDist = 0;
      const emit = (x0, y0, heading, length, tier, startDist) => {
        if (tier >= TIERS || count >= MAX_SEGMENTS) return;
        const pts = subdivide(
          [
            { x: x0, y: y0 },
            { x: x0 + Math.cos(heading) * length, y: y0 + Math.sin(heading) * length }
          ],
          length * jag,
          tier === 0 ? PASSES : PASSES - 2,
          ROUGHNESS
        );
        let dist = startDist;
        pts[0].dist = dist;
        for (let i = 1; i < pts.length; i++) {
          dist += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
          pts[i].dist = dist;
        }
        if (dist > maxDist) maxDist = dist;
        count += pts.length - 1;
        byTier[tier].push(pts);
        const chance = tier === 0 ? forkChance : forkChance * 0.4;
        for (let i = 1; i < pts.length - 1; i++) {
          if (Math.random() >= chance) continue;
          const local = Math.atan2(pts[i + 1].y - pts[i - 1].y, pts[i + 1].x - pts[i - 1].x);
          const off = (Math.random() < 0.5 ? -1 : 1) * (0.45 + Math.random() * 0.75);
          emit(pts[i].x, pts[i].y, local + off, length * (0.25 + Math.random() * 0.25), tier + 1, pts[i].dist);
        }
      };
      emit(w * (0.12 + Math.random() * 0.76), -h * 0.03, Math.PI / 2, h * reach * 1.05, 0, 0);
      this.bolts.push({ byTier, maxDist, progress: 0, life: 1, strength });
      if (this.bolts.length > MAX_BOLTS) this.bolts.shift();
      this.sinceStrike = 0;
    }
    draw(ctx, dt) {
      const { TIERS, GROW_SECONDS, FADE_SECONDS: FADE_SECONDS2, IDLE_STRIKE_SECONDS } = _Lightning;
      this.flicker = Math.max(0, this.flicker - dt * 4);
      this.flash = Math.max(0, this.flash - dt * 3.5);
      this.sinceStrike += dt;
      if (this.sinceStrike > IDLE_STRIKE_SECONDS) this.strike(0.3, 0.7);
      for (const b of this.bolts) {
        if (b.progress < 1) b.progress = Math.min(1, b.progress + dt / GROW_SECONDS);
        else b.life -= dt / FADE_SECONDS2;
      }
      this.bolts = this.bolts.filter((b) => b.life > 0);
      const baseAlpha = ctx.globalAlpha;
      const lineColor = this.style.lineColor;
      const accent = this.style.accentColor ?? lineColor;
      const glow = this.style.shadowBlur ?? 0;
      if (this.flash > 0) {
        ctx.globalAlpha = baseAlpha * this.flash * 0.14;
        ctx.fillStyle = accent;
        ctx.fillRect(0, 0, this.width, this.height);
      }
      this.applyStyle(ctx);
      ctx.lineCap = "butt";
      ctx.lineJoin = "miter";
      ctx.miterLimit = 3;
      for (const b of this.bolts) {
        const frontier = b.progress * b.maxDist;
        const bright = (b.progress < 1 ? 1 : b.life) * (0.7 + this.flicker * 0.3);
        let headX = 0;
        let headY = 0;
        for (let tier = 0; tier < TIERS; tier++) {
          ctx.beginPath();
          let drawn = 0;
          for (const pts of b.byTier[tier]) {
            if (pts[0].dist > frontier) continue;
            ctx.moveTo(pts[0].x, pts[0].y);
            let lx = pts[0].x;
            let ly = pts[0].y;
            for (let i = 1; i < pts.length; i++) {
              const p = pts[i];
              if (p.dist > frontier) {
                const q = pts[i - 1];
                const span = p.dist - q.dist;
                const t = span > 0 ? (frontier - q.dist) / span : 0;
                lx = q.x + (p.x - q.x) * t;
                ly = q.y + (p.y - q.y) * t;
                ctx.lineTo(lx, ly);
                break;
              }
              ctx.lineTo(p.x, p.y);
              lx = p.x;
              ly = p.y;
            }
            if (tier === 0) {
              headX = lx;
              headY = ly;
            }
            drawn++;
          }
          if (drawn === 0) continue;
          const taper = 1 - tier / TIERS;
          const width = Math.max(0.5, (this.style.lineWidth ?? 2) * taper * 1.4);
          ctx.shadowBlur = tier === 0 ? glow : 0;
          ctx.strokeStyle = lineColor;
          ctx.globalAlpha = baseAlpha * bright * (0.35 + taper * 0.65);
          ctx.lineWidth = width;
          ctx.stroke();
          if (tier === 0) {
            ctx.shadowBlur = 0;
            ctx.strokeStyle = accent;
            ctx.globalAlpha = baseAlpha * bright;
            ctx.lineWidth = Math.max(0.5, width * 0.4);
            ctx.stroke();
          }
        }
        if (b.progress < 1) {
          ctx.shadowBlur = glow;
          ctx.shadowColor = accent;
          ctx.fillStyle = accent;
          ctx.globalAlpha = baseAlpha * bright;
          ctx.beginPath();
          ctx.arc(headX, headY, 2 + b.strength * 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = baseAlpha;
    }
  };

  // src/visualizations/attractor-base.js
  var perParam = (value, n) => Array.isArray(value) ? value : new Array(n).fill(value);
  var AttractorBase = class extends Visualization {
    static inputs = {
      jolt: { kind: "event", default: TRIGGER.BASS },
      drift: { kind: "level", default: "mid" },
      glow: { kind: "level", default: { band: "treble", smooth: 0.08 } }
    };
    static PARAMS = [];
    static DRIFT = 0;
    static JOLT = 0;
    static DRIFT_RATE = [0.05, 0.5];
    // [idle, added per unit of mid energy]
    static ALPHA = [0.1, 2.35];
    // [floor, gain] applied to treble
    static JOLT_DECAY = 1.8;
    constructor(opts) {
      super(opts);
      const n = this.constructor.PARAMS.length;
      this.t = 0;
      this.jolt = new Array(n).fill(0);
      this.params = [...this.constructor.PARAMS];
      this.drift = perParam(this.constructor.DRIFT, n);
      this.joltAmp = perParam(this.constructor.JOLT, n);
    }
    onInput(slot, { strength }) {
      for (let i = 0; i < this.jolt.length; i++) {
        const amp = this.joltAmp[i];
        const next = this.jolt[i] + (Math.random() * 2 - 1) * strength * amp;
        this.jolt[i] = Math.max(-amp, Math.min(amp, next));
      }
    }
    /** Advance the parameter drift and jolt decay. Fills `this.params`. */
    updateParams(dt) {
      const { PARAMS, DRIFT_RATE, JOLT_DECAY } = this.constructor;
      this.t += dt * (DRIFT_RATE[0] + this.in("drift") * DRIFT_RATE[1]);
      const decay = Math.exp(-dt * JOLT_DECAY);
      for (let i = 0; i < PARAMS.length; i++) {
        this.jolt[i] *= decay;
        this.params[i] = PARAMS[i] + Math.sin(this.t * (0.31 + i * 0.13) + i * 2.1) * this.drift[i] + this.jolt[i];
      }
    }
    /** Brightness from the `glow` slot, which smooths in its default binding. */
    brightness() {
      const { ALPHA } = this.constructor;
      return Math.min(1, ALPHA[0] + this.in("glow") * ALPHA[1]);
    }
  };
  var PointCloudAttractor = class extends AttractorBase {
    static POINTS = 3200;
    static SEED = [0.1, 0.1];
    static DOT = 1.4;
    static LIMIT = 1e3;
    // orbit escape threshold; beyond this, reseed
    constructor(opts) {
      super(opts);
      this.x = this.constructor.SEED[0];
      this.y = this.constructor.SEED[1];
      this.out = [0, 0];
    }
    step(x, y, p, out) {
      out[0] = x;
      out[1] = y;
    }
    draw(ctx, dt) {
      const { POINTS, SCALE, SEED, DOT, LIMIT } = this.constructor;
      this.updateParams(dt);
      const cx = this.width / 2;
      const cy = this.height / 2;
      const scale = Math.min(this.width, this.height) * SCALE;
      const p = this.params;
      const out = this.out;
      this.applyStyle(ctx);
      ctx.shadowBlur = 0;
      const baseAlpha = ctx.globalAlpha;
      ctx.globalAlpha = baseAlpha * this.brightness();
      let x = this.x;
      let y = this.y;
      for (let i = 0; i < POINTS; i++) {
        this.step(x, y, p, out);
        x = out[0];
        y = out[1];
        if (!(Math.abs(x) < LIMIT && Math.abs(y) < LIMIT)) {
          x = SEED[0];
          y = SEED[1];
          continue;
        }
        ctx.fillRect(cx + x * scale, cy + y * scale, DOT, DOT);
      }
      this.x = x;
      this.y = y;
      ctx.globalAlpha = baseAlpha;
    }
  };
  var FlowAttractor = class extends AttractorBase {
    static inputs = {
      ...AttractorBase.inputs,
      travel: { kind: "level", default: "mid" },
      spin: { kind: "level", default: "mid" }
    };
    static TRAIL = 1400;
    // positions retained in the ribbon
    static SUBSTEPS = 6;
    // integration steps per frame
    static H = 0.05;
    // base step size, in the system's own time units
    static SPEED = [1, 1.6];
    // [idle, per unit of mid energy] multiplier on H
    static SEED = [0.1, 0, 0];
    static CENTER = [0, 0, 0];
    // world-space origin to draw around
    static FOCAL = 9;
    // perspective strength, in world units
    static CHUNKS = 8;
    // ribbon is stroked in this many fading pieces
    static SPIN = [0.25, 0.6];
    // [idle, per unit of mid energy] yaw rate, rad/s
    static LIMIT = 1e4;
    // Draw-time deformation. TWIST is [idle amplitude, added by a full-strength
    // hit] in radians of corkscrew per world unit of height — so it scales with
    // the system's own extent and needs retuning per attractor. PULSE is the
    // radial swell a full-strength hit adds.
    static TWIST = [0.05, 0.3];
    static PULSE = 0.7;
    static WARP_DECAY = 5.2;
    constructor(opts) {
      super(opts);
      this.state = new Float64Array(this.constructor.SEED);
      this.trail = new Float32Array(this.constructor.TRAIL * 3);
      this.count = 0;
      this.head = 0;
      this.yaw = 0;
      this.spin = this.constructor.SPIN[0];
      this.surge = 0;
      this.warp = 0;
      this.k = [0, 1, 2, 3].map(() => new Float64Array(3));
      this.tmp = new Float64Array(3);
    }
    derivative(x, y, z, p, out) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
    }
    onInput(slot, data) {
      super.onInput(slot, data);
      this.surge = Math.max(this.surge, data.strength);
    }
    /** One classical RK4 step of size `h`, advancing `this.state` in place. */
    integrate(h, p) {
      const s = this.state;
      const [k1, k2, k3, k4] = this.k;
      const tmp = this.tmp;
      this.derivative(s[0], s[1], s[2], p, k1);
      for (let i = 0; i < 3; i++) tmp[i] = s[i] + h / 2 * k1[i];
      this.derivative(tmp[0], tmp[1], tmp[2], p, k2);
      for (let i = 0; i < 3; i++) tmp[i] = s[i] + h / 2 * k2[i];
      this.derivative(tmp[0], tmp[1], tmp[2], p, k3);
      for (let i = 0; i < 3; i++) tmp[i] = s[i] + h * k3[i];
      this.derivative(tmp[0], tmp[1], tmp[2], p, k4);
      for (let i = 0; i < 3; i++) {
        s[i] += h / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
      }
    }
    pushTrail(x, y, z) {
      const i = this.head * 3;
      this.trail[i] = x;
      this.trail[i + 1] = y;
      this.trail[i + 2] = z;
      this.head = (this.head + 1) % this.constructor.TRAIL;
      if (this.count < this.constructor.TRAIL) this.count++;
    }
    draw(ctx, dt) {
      const {
        TRAIL,
        SUBSTEPS,
        H,
        SPEED,
        SEED,
        CENTER,
        SCALE,
        FOCAL,
        CHUNKS,
        SPIN,
        LIMIT,
        TWIST,
        PULSE,
        WARP_DECAY
      } = this.constructor;
      this.updateParams(dt);
      this.surge = Math.max(0, this.surge - dt * 2.5);
      const h = H * (SPEED[0] + this.in("travel") * SPEED[1] + this.surge * 1.5);
      const s = this.state;
      for (let i = 0; i < SUBSTEPS; i++) {
        this.integrate(h, this.params);
        if (!(Math.abs(s[0]) < LIMIT && Math.abs(s[1]) < LIMIT && Math.abs(s[2]) < LIMIT)) {
          s.set(SEED);
          this.count = 0;
          this.head = 0;
        }
        this.pushTrail(s[0], s[1], s[2]);
      }
      this.spin = approach(this.spin, SPIN[0] + this.in("spin") * SPIN[1], 0.3, dt);
      this.yaw += this.spin * dt;
      const pitch = 0.35 + Math.sin(this.t * 0.4) * 0.18;
      this.warp = Math.max(0, this.warp - dt * WARP_DECAY);
      const twist = TWIST[0] * Math.sin(this.t * 0.55) + TWIST[1] * this.warp;
      const swell = 1 + PULSE * this.warp;
      const cx = this.width / 2;
      const cy = this.height / 2;
      const scale = Math.min(this.width, this.height) * SCALE;
      const cosY = Math.cos(this.yaw);
      const sinY = Math.sin(this.yaw);
      const cosP = Math.cos(pitch);
      const sinP = Math.sin(pitch);
      this.applyStyle(ctx);
      ctx.lineJoin = "round";
      const baseAlpha = ctx.globalAlpha;
      const bright = this.brightness();
      const glow = this.style.shadowBlur ?? 0;
      const start = (this.head - this.count + TRAIL) % TRAIL;
      const per = Math.ceil(this.count / CHUNKS);
      for (let c = 0; c < CHUNKS; c++) {
        const from = c * per;
        const to = Math.min(this.count, from + per + 1);
        if (to - from < 2) continue;
        ctx.beginPath();
        for (let k = from; k < to; k++) {
          const i = (start + k) % TRAIL * 3;
          const x0 = this.trail[i] - CENTER[0];
          const y0 = this.trail[i + 1] - CENTER[1];
          const z0 = this.trail[i + 2] - CENTER[2];
          const ta = twist * y0;
          const tc = Math.cos(ta);
          const ts = Math.sin(ta);
          const x = (x0 * tc - z0 * ts) * swell;
          const z = (x0 * ts + z0 * tc) * swell;
          const y = y0 * swell;
          const rx = x * cosY - z * sinY;
          const rz = x * sinY + z * cosY;
          const ry = y * cosP - rz * sinP;
          const rzp = y * sinP + rz * cosP;
          const persp = FOCAL / (FOCAL + rzp);
          const sx = cx + rx * scale * persp;
          const sy = cy + ry * scale * persp;
          k === from ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
        }
        const age = (c + 1) / CHUNKS;
        ctx.shadowBlur = c === CHUNKS - 1 ? glow : 0;
        ctx.strokeStyle = c === CHUNKS - 1 ? this.style.accentColor ?? this.style.lineColor : this.style.lineColor;
        ctx.globalAlpha = baseAlpha * bright * age * age;
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = baseAlpha;
    }
  };

  // src/visualizations/attractor.js
  var DeJong = class extends PointCloudAttractor {
    static id = "attractor";
    static PARAMS = [1.4, -2.3, 2.4, -2.1];
    static DRIFT = 0.35;
    static JOLT = 2.55;
    static SCALE = 0.24;
    step(x, y, p, out) {
      const a = p[0], b = p[1], c = p[2], d = p[3];
      out[0] = Math.sin(a * y) - Math.cos(b * x);
      out[1] = Math.sin(c * x) - Math.cos(d * y);
    }
  };

  // src/visualizations/clifford.js
  var Clifford = class extends PointCloudAttractor {
    static id = "clifford";
    static PARAMS = [-1.4, 1.6, 1, 0.7];
    static DRIFT = 0.3;
    static JOLT = 0.9;
    static SCALE = 0.26;
    step(x, y, p, out) {
      const a = p[0], b = p[1], c = p[2], d = p[3];
      out[0] = Math.sin(a * y) + c * Math.cos(a * x);
      out[1] = Math.sin(b * x) + d * Math.cos(b * y);
    }
  };

  // src/visualizations/bedhead.js
  var Bedhead = class extends PointCloudAttractor {
    static id = "bedhead";
    static PARAMS = [-0.81, -0.92];
    static DRIFT = 0.12;
    static JOLT = 0.2;
    static SCALE = 0.34;
    step(x, y, p, out) {
      const a = p[0], b = p[1];
      out[0] = Math.sin(x * y / b) * y + Math.cos(a * x - y);
      out[1] = x + Math.sin(y) / b;
    }
  };

  // src/visualizations/thomas.js
  var Thomas = class extends FlowAttractor {
    static id = "thomas";
    static PARAMS = [0.18, 1];
    // [b damping, ω lattice frequency]
    static DRIFT = [0.05, 0.09];
    // b ∈ [0.13, 0.23], ω ∈ [0.91, 1.09]
    static JOLT = [0.025, 0.04];
    // hits widen those to [0.105, 0.255], [0.87, 1.13]
    static SCALE = 0.1;
    static SEED = [1.1, 1.1, -0.01];
    static H = 0.06;
    static FOCAL = 9;
    // Tuned for this system's ±4.5 extent: ~0.2 rad of corkscrew across the
    // body at idle, opening to ~1.5 rad on a full-strength hit.
    static TWIST = [0.045, 0.33];
    static PULSE = 0.22;
    derivative(x, y, z, p, out) {
      const b = p[0], w = p[1];
      out[0] = Math.sin(w * y) - b * x;
      out[1] = Math.sin(w * z) - b * y;
      out[2] = Math.sin(w * x) - b * z;
    }
  };

  // src/visualizations/harmonograph.js
  var Harmonograph = class _Harmonograph extends Visualization {
    static id = "harmonograph";
    static inputs = {
      snap: { kind: "event", default: TRIGGER.SNARE },
      swell: { kind: "event", default: TRIGGER.BASS },
      twist: { kind: "level", default: "mid" },
      // Smoothing lives in the binding rather than in draw(): the raw band
      // would jitter the figure's scale frame to frame.
      size: { kind: "level", default: { band: "bass", smooth: 0.12 } }
    };
    static RATIOS = [[1, 2], [2, 3], [3, 4], [3, 5], [4, 5], [5, 6]];
    static STEPS = 900;
    static BASE_TWIST = 0.35;
    // rad/s of drift when mid sits at its average
    static TWIST_GAIN = 4.5;
    // how hard mid deviation pushes the twist rate
    static TWIST_TAU = 0.25;
    // seconds for the rate to reach a new target
    constructor(opts) {
      super(opts);
      this.phase = 0;
      this.twist = _Harmonograph.BASE_TWIST;
      this.midFast = 0;
      this.midSlow = 0;
      this.ratioIndex = 1;
      this.morph = 1;
      this.prevRatio = _Harmonograph.RATIOS[0];
      this.swell = 0;
      this.rotation = 0;
    }
    onInput(slot, { strength }) {
      if (slot === "snap") {
        this.prevRatio = this.currentRatio();
        this.ratioIndex = (this.ratioIndex + 1 + Math.floor(Math.random() * (_Harmonograph.RATIOS.length - 1))) % _Harmonograph.RATIOS.length;
        this.morph = 0;
      }
      if (slot === "swell") this.swell = Math.max(this.swell, strength);
    }
    currentRatio() {
      const [p, q] = _Harmonograph.RATIOS[this.ratioIndex];
      const m = 1 - Math.pow(1 - this.morph, 3);
      return [
        this.prevRatio[0] + (p - this.prevRatio[0]) * m,
        this.prevRatio[1] + (q - this.prevRatio[1]) * m
      ];
    }
    draw(ctx, dt) {
      const { BASE_TWIST, TWIST_GAIN, TWIST_TAU, STEPS } = _Harmonograph;
      this.morph = Math.min(1, this.morph + dt * 1.6);
      this.swell = Math.max(0, this.swell - dt * 2);
      this.rotation += dt * 0.1;
      const mid = this.in("twist");
      this.midFast = approach(this.midFast, mid, 0.08, dt);
      this.midSlow = approach(this.midSlow, mid, 2.5, dt);
      const targetTwist = BASE_TWIST + (this.midFast - this.midSlow) * TWIST_GAIN;
      this.twist = approach(this.twist, targetTwist, TWIST_TAU, dt);
      this.phase += this.twist * dt;
      const [p, q] = this.currentRatio();
      const damping = 0.12;
      const cx = this.width / 2;
      const cy = this.height / 2;
      const A = Math.min(this.width, this.height) * (0.3 + this.swell * 0.12 + this.in("size") * 0.06);
      this.applyStyle(ctx);
      const cos = Math.cos(this.rotation);
      const sin = Math.sin(this.rotation);
      ctx.beginPath();
      for (let i = 0; i <= STEPS; i++) {
        const tau = i / STEPS * Math.PI * 5;
        const decay = Math.exp(-damping * tau);
        const x = Math.sin(p * tau + this.phase) * decay;
        const y = Math.sin(q * tau) * decay;
        const sx = cx + (x * cos - y * sin) * A;
        const sy = cy + (x * sin + y * cos) * A;
        i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }
  };

  // src/visualizations/index.js
  var registry = new Map(
    [
      EQBars,
      Waveform,
      RadialBurst,
      PolygonPulse,
      ParticleField,
      Road,
      Tunnel,
      RollingBall,
      Starfield,
      Lightning,
      Harmonograph,
      DeJong,
      Clifford,
      Bedhead,
      Thomas
    ].map((V) => [V.id, V])
  );
  var VIZ = Object.freeze({
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
    THOMAS: Thomas.id
  });
  function register(VizClass) {
    registry.set(VizClass.id, VizClass);
  }

  // src/style.js
  var HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
  var HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
  var SNAP = 1e-3;
  function parseColor(value) {
    if (typeof value !== "string") return null;
    const six = HEX6.exec(value);
    if (six) return [parseInt(six[1], 16), parseInt(six[2], 16), parseInt(six[3], 16)];
    const three = HEX3.exec(value);
    if (three) {
      return [
        parseInt(three[1] + three[1], 16),
        parseInt(three[2] + three[2], 16),
        parseInt(three[3] + three[3], 16)
      ];
    }
    return null;
  }
  var channel = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  var formatColor = ([r, g, b]) => `#${channel(r)}${channel(g)}${channel(b)}`;
  function easeStyle(current, target, tau, dt) {
    for (const key of Object.keys(target)) {
      const to = target[key];
      const from = current[key];
      if (typeof to === "number" && typeof from === "number") {
        const next = approach(from, to, tau, dt);
        current[key] = Math.abs(to - next) < SNAP ? to : next;
        continue;
      }
      const toRGB = parseColor(to);
      const fromRGB = parseColor(from);
      if (toRGB && fromRGB) {
        current[key] = formatColor([
          approach(fromRGB[0], toRGB[0], tau, dt),
          approach(fromRGB[1], toRGB[1], tau, dt),
          approach(fromRGB[2], toRGB[2], tau, dt)
        ]);
        continue;
      }
      current[key] = to;
    }
  }

  // src/engine.js
  var FADE_SECONDS = 0.6;
  var STYLE_TAU = 0.3;
  var MusicViz = class extends Emitter {
    constructor({
      canvas,
      style = {},
      timeline = [],
      triggers = DEFAULT_TRIGGERS,
      styleFade = STYLE_TAU
    } = {}) {
      super();
      this.canvas = canvas;
      this.ctx2d = canvas.getContext("2d");
      this.baseStyle = {
        background: "#0a0a12",
        lineColor: "#7fffd4",
        accentColor: "#ff5d8f",
        lineWidth: 2,
        shadowBlur: 0,
        shadowColor: null,
        ...style
      };
      this.style = { ...this.baseStyle };
      this.styleFade = styleFade;
      this.styleDirty = true;
      this.player = new SongPlayer();
      this.analyzer = new Analyzer(this.player, { triggers });
      this.timeline = new Timeline(timeline);
      this.active = /* @__PURE__ */ new Map();
      this.rafId = null;
      this.lastTick = 0;
      for (const ev of ["load", "play", "pause", "ended", "seek"]) {
        this.player.on(ev, (d) => this.emit(ev, d));
      }
      this.player.on("seek", () => {
        this.styleDirty = true;
      });
      this.analyzer.on("frame", (d) => this.emit("frame", d));
      this.resize();
    }
    async load(song) {
      await this.player.load(song);
    }
    play() {
      this.player.play();
      this.startLoop();
    }
    pause() {
      this.player.pause();
    }
    seek(time) {
      this.player.seek(time);
    }
    setStyle(patch) {
      Object.assign(this.baseStyle, patch);
      Object.assign(this.style, patch);
      for (const entry of this.active.values()) entry.viz.style = this.style;
    }
    /** Ease the live style toward whatever the timeline asks for at time t. */
    updateStyle(time, dt) {
      const target = { ...this.baseStyle, ...this.timeline.styleAt(time) };
      if (target.shadowColor == null) target.shadowColor = target.lineColor;
      if (this.styleDirty) {
        Object.assign(this.style, target);
        this.styleDirty = false;
      } else {
        easeStyle(this.style, target, this.styleFade, dt);
      }
    }
    setTimeline(windows) {
      this.timeline.setWindows(windows);
    }
    setTriggers(triggers) {
      this.analyzer.setTriggers(triggers);
    }
    resize() {
      const dpr = window.devicePixelRatio || 1;
      const { clientWidth: w, clientHeight: h } = this.canvas;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const entry of this.active.values()) entry.viz.resize(w, h);
    }
    startLoop() {
      if (this.rafId !== null) return;
      this.lastTick = performance.now();
      const tick = (now) => {
        const dt = Math.min((now - this.lastTick) / 1e3, 0.1);
        this.lastTick = now;
        this.step(dt);
        this.rafId = requestAnimationFrame(tick);
      };
      this.rafId = requestAnimationFrame(tick);
    }
    stopLoop() {
      if (this.rafId !== null) cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    /** One animation-loop tick: analyze, sync active set, fade, draw. */
    step(dt) {
      const dpr = window.devicePixelRatio || 1;
      if (this.canvas.width !== Math.round(this.canvas.clientWidth * dpr) || this.canvas.height !== Math.round(this.canvas.clientHeight * dpr)) {
        this.resize();
      }
      const frame = this.analyzer.update();
      this.syncActive(this.timeline.activeAt(frame.time));
      this.updateStyle(frame.time, dt);
      const events = this.analyzer.fired;
      const ctx = this.ctx2d;
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      ctx.fillStyle = this.style.background;
      ctx.shadowBlur = 0;
      ctx.fillRect(0, 0, w, h);
      for (const [key, entry] of this.active) {
        entry.alpha += (entry.leaving ? -1 : 1) * (dt / FADE_SECONDS);
        if (entry.leaving && entry.alpha <= 0) {
          entry.offs.forEach((off) => off());
          this.active.delete(key);
          continue;
        }
        entry.alpha = Math.min(entry.alpha, 1);
        entry.viz.onFrame(frame);
        entry.viz.updateInputs(frame, dt, events);
        ctx.save();
        ctx.globalAlpha = entry.alpha;
        entry.viz.draw(ctx, dt);
        ctx.restore();
      }
    }
    /** Reconcile on-screen visualizations with what the timeline wants. */
    syncActive(wanted) {
      for (const [key, spec] of wanted) {
        const entry = this.active.get(key);
        if (entry) {
          entry.leaving = false;
        } else {
          this.spawn(key, spec);
        }
      }
      for (const [key, entry] of this.active) {
        if (!wanted.has(key)) entry.leaving = true;
      }
    }
    spawn(key, { id, bind }) {
      const VizClass = registry.get(id);
      if (!VizClass) {
        console.warn(`MusicViz: unknown visualization '${id}'`);
        return;
      }
      const viz = new VizClass({
        width: this.canvas.clientWidth,
        height: this.canvas.clientHeight,
        style: this.style,
        bind
      });
      const entry = { viz, alpha: 0, leaving: false, offs: [] };
      for (const [slot, def] of Object.entries(VizClass.inputs ?? {})) {
        if (def.kind !== "event") continue;
        const spec = bind && bind[slot] !== void 0 ? bind[slot] : def.default;
        const name = resolveEvent(spec, `${id}.${slot}`);
        if (!name) continue;
        if (!this.analyzer.hasTrigger(name)) {
          console.warn(`MusicViz: '${id}.${slot}' is bound to trigger '${name}', which is not configured \u2014 it will never fire`);
        }
        entry.offs.push(
          this.analyzer.on(`trigger:${name}`, (data) => {
            if (this.active.get(key) === entry) viz.onInput(slot, data);
          })
        );
      }
      for (const trigger of VizClass.triggers ?? []) {
        entry.offs.push(
          this.analyzer.on(`trigger:${trigger}`, (data) => {
            if (this.active.get(key) === entry) viz.onTrigger(trigger, data);
          })
        );
      }
      this.active.set(key, entry);
    }
  };
  return __toCommonJS(engine_exports);
})();
//# sourceMappingURL=musicviz.js.map
