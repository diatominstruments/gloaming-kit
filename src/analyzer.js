import { Emitter } from './emitter.js';
import { approach, clamp01 } from './util.js';

/** Coarse EQ bands (Hz ranges) reported on every frame. */
export const BANDS = {
  subBass: [20, 60],
  bass:    [60, 150],
  lowMid:  [150, 400],
  mid:     [400, 1200],
  highMid: [1200, 4000],
  treble:  [4000, 16000],
};

/**
 * Names of the built-in triggers, for `static inputs` defaults and
 * `onTrigger` comparisons. Custom triggers passed to the engine may use any
 * name; these are just the ones that ship by default.
 */
export const TRIGGER = {
  SUB: 'sub',
  BASS: 'bass',
  TOM: 'tom',
  SNARE: 'snare',
  CLAP: 'clap',
  HIHAT: 'hihat',
  ONSET: 'onset',
  LOUD: 'loud',
  LULL: 'lull',
};

/**
 * What a trigger listens to. Every kind runs the same Dynamics (see below) on
 * a different measurement, so `threshold` means the same thing for all of
 * them: how far up the recent floor-to-peak range the measurement has to jump.
 *
 *   band   energy in `band` Hz — a drum, a register, a hit in one part of the
 *          mix (the default)
 *   onset  spectral flux over `band`: how much the spectrum rose since the
 *          last frame. Fires on any transient — a kick, a snare, a plucked
 *          note — wherever it lands in the spectrum, and not on sustained
 *          tones however loud. Defaults to the whole audible band.
 *   rms    overall loudness, from the time-domain signal. A hit in the mix as
 *          a whole; with `minIntensity` it becomes a "loud passage" detector.
 *   lull   the inverse of the rest: fires once when the source's intensity
 *          (band, or rms if none) falls below `threshold` after having been
 *          above it — a breakdown, a drop into a quiet passage.
 */
export const TRIGGER_KINDS = ['band', 'onset', 'rms', 'lull'];

/** The span of an onset trigger that names no band. */
const ONSET_BAND = [20, 16000];
/** How far above its threshold a lull trigger's intensity must climb to re-arm. */
const LULL_HYSTERESIS = 0.1;
/** The intensity drop a lull hit reports as full strength (~18 dB). */
const LULL_FULL_DROP = 0.5;
/**
 * Spectral flux below this is the analyser's own jitter, in dB of mean rise
 * per bin. A hit on a full mix sits around -40 to -55; quantization noise on a
 * steady tone is well under -80.
 */
const FLUX_NOISE = -75;

/**
 * Default triggers. Each fires an event named `trigger:<name>`. Every field
 * but `name` is optional:
 *
 *   kind          see TRIGGER_KINDS; 'band' when left out
 *   band          [lo, hi] Hz; required for 'band', optional for 'onset'
 *                 and 'lull', ignored by 'rms'
 *   threshold     0..1, relative (see Dynamics), so the same value catches
 *                 hits in a quiet intro and a loud drop alike. It is really
 *                 a question of how prominent a hit must be against the
 *                 loudest thing sharing its band: the snare's is high so the
 *                 hihats bleeding into it don't fire it, and the hihat's is
 *                 low because the snare's noise tends to set the peak up there
 *   cooldown      seconds; shortest gap between two hits
 *   hold          seconds the measurement must stay over the threshold before
 *                 the trigger fires — 0 fires on the frame it crosses. Turns
 *                 a hit detector into a sustain detector: a riser, a held
 *                 chord, a swell
 *   minIntensity  0..1; don't fire unless the source is at least this loud in
 *                 absolute terms, however prominent the jump. For hits that
 *                 should only count in the loud parts
 *   rearm         fraction of `threshold` the measurement must fall back under
 *                 before the trigger can fire again (0.5 by default)
 */
export const DEFAULT_TRIGGERS = [
  { name: TRIGGER.SUB,   band: [20, 60],      threshold: 0.6,  cooldown: 0.2 },
  { name: TRIGGER.BASS,  band: [40, 130],     threshold: 0.6,  cooldown: 0.15 },
  { name: TRIGGER.TOM,   band: [150, 400],    threshold: 0.65, cooldown: 0.15 },
  { name: TRIGGER.SNARE, band: [1500, 4000],  threshold: 0.7,  cooldown: 0.15 },
  { name: TRIGGER.CLAP,  band: [4000, 8000],  threshold: 0.65, cooldown: 0.12 },
  { name: TRIGGER.HIHAT, band: [8000, 14000], threshold: 0.4,  cooldown: 0.08 },
  { name: TRIGGER.ONSET, kind: 'onset', band: ONSET_BAND, threshold: 0.6, cooldown: 0.1 },
  { name: TRIGGER.LOUD,  kind: 'rms',   threshold: 0.9, minIntensity: 0.6, cooldown: 0.3 },
  { name: TRIGGER.LULL,  kind: 'lull',  threshold: 0.5,  cooldown: 2 },
];

/**
 * Where intensity reads 1, as dB of per-bin magnitude at 1 kHz. Measured from
 * pink noise at -12 dBFS RMS — about a loud modern master — through the
 * default AnalyserNode (-48), plus 6 dB, since intensity follows peaks rather
 * than the average. Pink noise falls 3 dB per octave per bin, which is what
 * lets one number calibrate every band.
 */
const LOUD_AT_1K = -42;
const INTENSITY_SPAN = 36;   // dB from intensity 0 to 1
const RMS_RANGE = [-44, -8];  // dBFS; the same pink noise measures -12
// Below these, a signal is the measurement's own noise: the analyser clips
// bins at minDecibels, and the byte waveform's step is -42 dBFS.
const BAND_NOISE_ABOVE_MIN = 3;
const RMS_NOISE = -50;

/** The dB range intensity spans for a band of [lo, hi] Hz. See LOUD_AT_1K. */
function intensityRange(lo, hi) {
  lo = Math.max(lo, 1);
  // Mean of log10(f) over the band: bins are spaced linearly, so that is the
  // average the band energy takes of a pink spectrum's dB.
  const meanLog = hi > lo
    ? (hi * Math.log(hi) - hi - lo * Math.log(lo) + lo) / ((hi - lo) * Math.LN10)
    : Math.log10(lo);
  const top = LOUD_AT_1K - 10 * (meanLog - 3);
  return [top - INTENSITY_SPAN, top];
}

/**
 * Dynamics — splits one energy stream into the two things a visual wants
 * from it, which a fixed threshold conflates:
 *
 *   relative   0..1, where the signal sits between the recent floor (the
 *              level between hits) and the recent peak (how high hits have
 *              been reaching). A hit reads near 1 whether the passage is
 *              quiet or loud, so it stays visible in both.
 *   intensity  0..1, a slow absolute measure of how loud the passage is.
 *              Scales how big or bright the response is, not whether it
 *              happens.
 *
 * Floor and peak are the minimum and maximum over the last WINDOW seconds,
 * then eased. A window long enough to span the gap between beats means the
 * peak doesn't sag between hits (so a snare stays clear of the hihats under
 * it), and short enough that after a sudden drop into a quiet passage its
 * hits reappear within about 1.7 s. Exponential decay can't do both:
 * slow enough to hold between beats, it takes ~5 s to forget a 20 dB drop.
 *
 * Works on linear amplitude, not dB: on a dB scale a hihat 5 dB under the
 * snare sharing its band reads 90% as prominent, which no threshold can split.
 */
class Dynamics {
  static WINDOW = 1.5;         // seconds of history floor and peak are taken from
  static EASE = 0.05;          // seconds; smooths the step as a hit leaves the window
  static INTENSITY_TAU = 1;    // smoothing on the absolute level
  // Narrowest floor→peak span treated as dynamics, as a fraction of the peak
  // (0.25 ≈ 2.5 dB). Narrower than that is frame-to-frame jitter.
  static MIN_SPAN = 0.25;
  static GATE_DB = 6;          // relative fades in over this far above the noise

  constructor([lo, hi], noise) {
    this.lo = lo;
    this.hi = hi;
    this.noise = noise;
    this.relative = 0;
    this.intensity = 0;
    this.primed = false;
    this.clock = 0;      // own time, advanced by dt, so seeks don't disturb the window
    this.history = [];   // [time, amp], oldest first
  }

  /** Extremes of the history window. It holds ~90 frames, so a scan is fine. */
  extremes() {
    let min = Infinity;
    let max = 0;
    for (const [, v] of this.history) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return [min, max];
  }

  update(amp, dt) {
    const { WINDOW, EASE, INTENSITY_TAU, MIN_SPAN, GATE_DB } = Dynamics;
    if (!this.primed) {
      this.history.push([0, amp]);
      this.floor = amp;
      this.peak = amp;
      this.level = amp;
      this.primed = true;
    } else if (dt > 0) {
      this.clock += dt;
      this.history.push([this.clock, amp]);
      while (this.history[0][0] < this.clock - WINDOW) this.history.shift();
      const [min, max] = this.extremes();
      // A new high lands at once, so relative never overshoots 1; everything
      // else eases, so a hit leaving the window doesn't step the scale.
      this.peak = max > this.peak ? max : approach(this.peak, max, EASE, dt);
      this.floor = approach(this.floor, min, EASE, dt);
      this.level = approach(this.level, this.peak, INTENSITY_TAU, dt);
    }
    const db = 20 * Math.log10(this.level || 1e-10);
    this.intensity = clamp01((db - this.lo) / (this.hi - this.lo));
    // Relative is scale-free, so on its own it would stretch the noise of a
    // silent passage into full-height hits. Fading it in just above the
    // noise keeps silence at 0 without losing genuinely quiet music.
    const span = Math.max(this.peak - this.floor, this.peak * MIN_SPAN) || 1;
    const gate = clamp01((db - this.noise) / GATE_DB);
    this.relative = clamp01((amp - this.floor) / span) * gate;
    return this;
  }
}

/**
 * Analyzer — taps the player's output through an AnalyserNode and, once per
 * animation-loop tick (engine calls update()), emits:
 *
 *   'frame'           { time, bands, level, relative, intensity, spectrum, waveform }
 *      bands:     absolute energy 0..1 per coarse band (see BANDS)
 *      level:     overall RMS loudness 0..1
 *      relative:  per band and 'rms', 0..1 against recent dynamics — near 1
 *                 on a hit in a quiet passage and a loud one alike
 *      intensity: per band and 'rms', 0..1 slow absolute loudness
 *      spectrum:  Uint8Array of FFT magnitudes (for EQ-style visuals)
 *      waveform:  Uint8Array time-domain samples (for oscilloscope visuals)
 *
 *   'trigger:<name>'  { name, kind, time, energy, strength, intensity }
 *      Fired when the trigger's measurement (see TRIGGER_KINDS) crosses
 *      `threshold` in relative terms, then re-armed once it falls back under
 *      `rearm` of it, subject to a per-trigger cooldown. strength = how
 *      prominent the hit is against its surroundings (relative, 0..1);
 *      intensity = how loud the source is overall (absolute, 0..1). Use
 *      strength for whether and how sharply to react, intensity for how big
 *      the reaction is. A 'lull' hit's strength is instead the size of the
 *      drop: how far intensity fell from the loudest point before it.
 */
export class Analyzer extends Emitter {
  constructor(player, { fftSize = 2048, smoothing = 0.6, triggers = DEFAULT_TRIGGERS } = {}) {
    super();
    this.player = player;
    this.node = player.ctx.createAnalyser();
    this.node.fftSize = fftSize;
    this.node.smoothingTimeConstant = smoothing;
    player.output.connect(this.node);

    this.spectrum = new Uint8Array(this.node.frequencyBinCount);
    this.previous = new Uint8Array(this.node.frequencyBinCount);   // last tick's spectrum, for flux
    this.waveform = new Uint8Array(this.node.fftSize);
    this.binHz = player.ctx.sampleRate / this.node.fftSize;

    // Triggers that fired during the current tick, by name. Rebuilt every
    // update() and consumed synchronously by the routing layer, which needs
    // to poll hits rather than subscribe to them.
    this.fired = new Map();

    this.dynamics = { rms: new Dynamics(RMS_RANGE, RMS_NOISE) };
    for (const [name, [lo, hi]] of Object.entries(BANDS)) {
      this.dynamics[name] = this.bandDynamics(lo, hi);
    }
    this.lastTime = null;

    this.setTriggers(triggers);
  }

  /** Whether a trigger by this name is configured. */
  hasTrigger(name) {
    return this.triggers.some((t) => t.name === name);
  }

  setTriggers(triggers) {
    this.triggers = triggers.map((t) => {
      let kind = t.kind ?? 'band';
      if (!TRIGGER_KINDS.includes(kind)) {
        console.warn(`GloamingKit: trigger '${t.name}' has unknown kind '${kind}' — expected ${TRIGGER_KINDS.join('|')}; treating it as 'band'`);
        kind = 'band';
      }
      let band = t.band ?? (kind === 'onset' ? ONSET_BAND : null);
      if (kind === 'band' && !band) {
        console.warn(`GloamingKit: trigger '${t.name}' needs a band — it will never fire`);
        band = [0, 0];
      }
      const spec = {
        threshold: 0.6, cooldown: 0.15, hold: 0, minIntensity: 0, rearm: 0.5,
        ...t, kind, band,
      };
      return {
        ...spec,
        // Relative and intensity of what the trigger measures; an onset
        // trigger measures flux, whose dB mean nothing, so it takes its
        // intensity from the band's own level instead.
        dynamics: kind === 'onset'
          ? new Dynamics([0, 1], FLUX_NOISE)
          : this.sourceDynamics(spec),
        loudness: kind === 'onset' ? this.sourceDynamics(spec) : null,
        // A lull arms on the way up, so it can't fire into the silence
        // before the song starts.
        armed: kind !== 'lull',
        above: 0,            // seconds the measurement has been over threshold
        loudest: 0,          // lull: highest intensity since it armed
        lastFired: -Infinity,
      };
    });
  }

  /** Dynamics for the level a trigger watches: its band, or rms if it has none. */
  sourceDynamics({ band }) {
    return band ? this.bandDynamics(band[0], band[1]) : new Dynamics(RMS_RANGE, RMS_NOISE);
  }

  /**
   * What a trigger measures this tick, as a linear amplitude for its
   * Dynamics, plus the raw `energy` to report with a hit.
   */
  measure(t, level) {
    if (t.kind === 'onset') {
      const flux = this.bandFlux(t.band[0], t.band[1]);
      return [flux, flux];
    }
    if (t.band) {
      const energy = this.bandEnergy(t.band[0], t.band[1]);
      return [this.amplitude(energy), energy];
    }
    return [level, level];
  }

  /** Average normalized magnitude of the FFT bins covering [lo, hi] Hz. */
  bandEnergy(lo, hi) {
    const start = Math.max(0, Math.floor(lo / this.binHz));
    const end = Math.min(this.spectrum.length - 1, Math.ceil(hi / this.binHz));
    if (end < start) return 0;   // band lies entirely above Nyquist
    let sum = 0;
    for (let i = start; i <= end; i++) sum += this.spectrum[i];
    return sum / ((end - start + 1) * 255);
  }

  /**
   * Spectral flux over [lo, hi] Hz: the mean rise per bin since the last
   * tick, 0..1, counting only bins that got louder. A transient lifts many
   * bins at once; a sustained tone, however loud, lifts none.
   */
  bandFlux(lo, hi) {
    const start = Math.max(0, Math.floor(lo / this.binHz));
    const end = Math.min(this.spectrum.length - 1, Math.ceil(hi / this.binHz));
    if (end < start) return 0;
    let sum = 0;
    for (let i = start; i <= end; i++) {
      const rise = this.spectrum[i] - this.previous[i];
      if (rise > 0) sum += rise;
    }
    return sum / ((end - start + 1) * 255);
  }

  bandDynamics(lo, hi) {
    return new Dynamics(intensityRange(lo, hi), this.node.minDecibels + BAND_NOISE_ABOVE_MIN);
  }

  /** Band energy back to linear amplitude, undoing the analyser's dB scale. */
  amplitude(energy) {
    const { minDecibels, maxDecibels } = this.node;
    return Math.pow(10, (minDecibels + energy * (maxDecibels - minDecibels)) / 20);
  }

  /** Called by the engine once per animation frame. Returns the frame data. */
  update() {
    this.node.getByteFrequencyData(this.spectrum);
    this.node.getByteTimeDomainData(this.waveform);
    const time = this.player.currentTime;

    // Dynamics adapt in song time: a pause (dt 0) holds them where they are
    // rather than letting them settle onto silence. A seek (a jump either way)
    // counts as no time passing and keeps them: the new spot absorbs into the
    // window like any other change in level, whereas starting over from an
    // empty window fires a burst of false hits while it fills.
    let dt = this.lastTime === null ? 0 : time - this.lastTime;
    this.lastTime = time;
    if (dt < 0 || dt > 0.5) {
      // lastFired is in song time, so a backwards seek leaves it ahead of the
      // clock — which would hold the cooldown closed until playback re-passed
      // the old fire point.
      for (const t of this.triggers) {
        t.lastFired = -Infinity;
        t.above = 0;
      }
      dt = 0;
    }

    const bands = {};
    const relative = {};
    const intensity = {};
    for (const [name, [lo, hi]] of Object.entries(BANDS)) {
      bands[name] = this.bandEnergy(lo, hi);
      const d = this.dynamics[name].update(this.amplitude(bands[name]), dt);
      relative[name] = d.relative;
      intensity[name] = d.intensity;
    }

    // RMS of the time-domain signal (bytes centered on 128).
    let sumSq = 0;
    for (let i = 0; i < this.waveform.length; i++) {
      const v = (this.waveform[i] - 128) / 128;
      sumSq += v * v;
    }
    const level = Math.sqrt(sumSq / this.waveform.length);
    const rms = this.dynamics.rms.update(level, dt);
    relative.rms = rms.relative;
    intensity.rms = rms.intensity;

    const frame = { time, bands, level, relative, intensity, spectrum: this.spectrum, waveform: this.waveform };
    this.emit('frame', frame);

    this.fired.clear();
    for (const t of this.triggers) {
      const [amp, energy] = this.measure(t, level);
      const d = t.dynamics.update(amp, dt);
      const intensity = t.loudness
        ? t.loudness.update(this.amplitude(this.bandEnergy(t.band[0], t.band[1])), dt).intensity
        : d.intensity;
      let hit = null;

      if (t.kind === 'lull') {
        // Keyed on absolute loudness, and armed by the loud passage before.
        // Strength is the size of the drop from the loudest point since then:
        // a fall of LULL_FULL_DROP in intensity (about 18 dB) reads as 1.
        if (intensity > t.threshold + LULL_HYSTERESIS) t.armed = true;
        if (t.armed) t.loudest = Math.max(t.loudest, intensity);
        if (dt > 0 && t.armed && intensity < t.threshold) {
          hit = { strength: clamp01((t.loudest - intensity) / LULL_FULL_DROP), intensity };
          t.loudest = 0;
        }
      } else {
        if (d.relative < t.threshold * t.rearm) t.armed = true;
        const over = d.relative >= t.threshold && intensity >= t.minIntensity;
        t.above = over ? t.above + dt : 0;
        if (dt > 0 && t.armed && over && t.above >= t.hold) {
          hit = { strength: d.relative, intensity };
        }
      }

      if (hit && time - t.lastFired >= t.cooldown) {
        t.armed = false;
        t.lastFired = time;
        const data = { name: t.name, kind: t.kind, time, energy, ...hit };
        this.fired.set(t.name, data);
        this.emit(`trigger:${t.name}`, data);
      }
    }
    this.previous.set(this.spectrum);

    return frame;
  }
}
