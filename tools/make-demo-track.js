#!/usr/bin/env node
/**
 * Generates demo-track.wav — a 64s, 125 BPM synth loop with a kick on
 * quarters, snare on 2 & 4, hihats on eighths, a bassline, and a pad.
 * Gives the analyzer's default triggers (bass/snare/hihat) real material.
 *
 * Usage: node tools/make-demo-track.js
 */
const fs = require('fs');
const path = require('path');

const SR = 44100;
const BPM = 125;
const BEAT = 60 / BPM;
const DURATION = 64;
const N = SR * DURATION;
const out = new Float32Array(N);

const add = (start, samples, gain = 1) => {
  const s0 = Math.floor(start * SR);
  for (let i = 0; i < samples.length && s0 + i < N; i++) out[s0 + i] += samples[i] * gain;
};

// ---- drum synthesis --------------------------------------------------------

function kick() {
  const len = Math.floor(SR * 0.25);
  const s = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const freq = 150 * Math.exp(-t * 18) + 45;       // pitch drop
    const env = Math.exp(-t * 14);
    s[i] = Math.sin(2 * Math.PI * freq * t) * env;
  }
  return s;
}

function snare() {
  const len = Math.floor(SR * 0.18);
  const s = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const noise = Math.random() * 2 - 1;
    const tone = Math.sin(2 * Math.PI * 190 * t);
    s[i] = (noise * 0.7 + tone * 0.3) * Math.exp(-t * 24);
  }
  return s;
}

function hihat(open = false) {
  const len = Math.floor(SR * (open ? 0.2 : 0.05));
  const s = new Float32Array(len);
  let hp = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const noise = Math.random() * 2 - 1;
    hp = noise - hp * 0.15;                          // crude high-pass
    s[i] = hp * Math.exp(-t * (open ? 18 : 70));
  }
  return s;
}

// ---- tonal synthesis -------------------------------------------------------

function bassNote(freq, dur) {
  const len = Math.floor(SR * dur);
  const s = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const env = Math.min(1, t * 40) * Math.exp(-t * 3);
    s[i] = (Math.sin(2 * Math.PI * freq * t) + 0.4 * Math.sin(4 * Math.PI * freq * t)) * env;
  }
  return s;
}

function padChord(freqs, dur) {
  const len = Math.floor(SR * dur);
  const s = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const env = Math.min(1, t * 2.5) * Math.min(1, (dur - t) * 2.5);
    let v = 0;
    for (const f of freqs) {
      v += Math.sin(2 * Math.PI * f * t + 0.3 * Math.sin(2 * Math.PI * 0.7 * t));
    }
    s[i] = (v / freqs.length) * env;
  }
  return s;
}

// ---- arrangement -----------------------------------------------------------

// A minor: Am — F — C — G, one chord per 4-beat bar.
const CHORDS = [
  { bass: 55.0,  pad: [220.0, 261.63, 329.63] },  // Am
  { bass: 43.65, pad: [174.61, 220.0, 261.63] },  // F
  { bass: 65.41, pad: [196.0, 261.63, 329.63] },  // C
  { bass: 49.0,  pad: [196.0, 246.94, 293.66] },  // G
];

const bars = Math.floor(DURATION / (BEAT * 4));
for (let bar = 0; bar < bars; bar++) {
  const barStart = bar * BEAT * 4;
  const chord = CHORDS[bar % 4];
  const section = Math.floor((barStart / DURATION) * 4); // 0..3, mirrors demo timeline

  add(barStart, padChord(chord.pad, BEAT * 4), 0.16);

  for (let beat = 0; beat < 4; beat++) {
    const t = barStart + beat * BEAT;
    add(t, kick(), 0.85);
    if (beat === 1 || beat === 3) add(t, snare(), 0.5);
    add(t, hihat(), 0.3);
    if (section >= 1) add(t + BEAT / 2, hihat(beat === 3), 0.3); // 8ths after intro
    add(t, bassNote(chord.bass, BEAT * 0.9), 0.5);
    if (section >= 2) add(t + BEAT / 2, bassNote(chord.bass * 1.5, BEAT * 0.4), 0.3);
  }
}

// ---- normalize + write WAV -------------------------------------------------

let peak = 0;
for (const v of out) peak = Math.max(peak, Math.abs(v));
const norm = 0.89 / peak;

const data = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) {
  data.writeInt16LE(Math.round(out[i] * norm * 32767), i * 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);          // fmt chunk size
header.writeUInt16LE(1, 20);           // PCM
header.writeUInt16LE(1, 22);           // mono
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 2, 28);      // byte rate
header.writeUInt16LE(2, 32);           // block align
header.writeUInt16LE(16, 34);          // bits per sample
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

const dest = path.join(__dirname, '..', 'demo-track.wav');
fs.writeFileSync(dest, Buffer.concat([header, data]));
console.log(`Wrote ${dest} (${((44 + data.length) / 1e6).toFixed(1)} MB, ${DURATION}s)`);
