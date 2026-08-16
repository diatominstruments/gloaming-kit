import { Emitter } from './emitter.js';

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
 * Names of the built-in triggers, for `static triggers` declarations and
 * `onTrigger` comparisons. Custom triggers passed to the engine may use any
 * name; these are just the ones that ship by default.
 */
export const TRIGGER = {
  BASS: 'bass',
  SNARE: 'snare',
  HIHAT: 'hihat',
};

/** Default threshold triggers. Each fires an event named `trigger:<name>`. */
export const DEFAULT_TRIGGERS = [
  { name: TRIGGER.BASS,  band: [40, 130],     threshold: 0.55, cooldown: 0.15 },
  { name: TRIGGER.SNARE, band: [1500, 4000],  threshold: 0.45, cooldown: 0.15 },
  { name: TRIGGER.HIHAT, band: [8000, 14000], threshold: 0.35, cooldown: 0.08 },
];

/**
 * Analyzer — taps the player's output through an AnalyserNode and, once per
 * animation-loop tick (engine calls update()), emits:
 *
 *   'frame'           { time, bands, level, spectrum, waveform }
 *      bands:    normalized 0..1 energy per coarse band (see BANDS)
 *      level:    overall RMS loudness 0..1
 *      spectrum: Uint8Array of FFT magnitudes (for EQ-style visuals)
 *      waveform: Uint8Array time-domain samples (for oscilloscope visuals)
 *
 *   'trigger:<name>'  { name, time, energy, strength }
 *      Fired on a rising edge: band energy crosses the trigger's threshold,
 *      subject to a per-trigger cooldown. strength = how far past the
 *      threshold the hit landed, normalized 0..1 — useful for scaling the
 *      visual response to the intensity of the hit.
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
    this.waveform = new Uint8Array(this.node.fftSize);
    this.binHz = player.ctx.sampleRate / this.node.fftSize;

    // Triggers that fired during the current tick, by name. Rebuilt every
    // update() and consumed synchronously by the routing layer, which needs
    // to poll hits rather than subscribe to them.
    this.fired = new Map();

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
      lastFired: -Infinity,
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

    // RMS of the time-domain signal (bytes centered on 128).
    let sumSq = 0;
    for (let i = 0; i < this.waveform.length; i++) {
      const v = (this.waveform[i] - 128) / 128;
      sumSq += v * v;
    }
    const level = Math.sqrt(sumSq / this.waveform.length);

    const frame = { time, bands, level, spectrum: this.spectrum, waveform: this.waveform };
    this.emit('frame', frame);

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
}
