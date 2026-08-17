/**
 * Demo app — an example end-user script, deliberately not part of the library
 * build. It loads as a classic <script> after dist/gloaming-kit.js and reads
 * the library off the `gloamingKit` global, the same way any page embedding
 * the library would. Wrapped in an IIFE so its locals don't leak onto `window`.
 */
(() => {
  const { GloamingKit, registry, VIZ } = gloamingKit;

  const canvas = document.getElementById('stage');
  const playBtn = document.getElementById('play');
  const toggleBtn = document.getElementById('toggle');
  const progress = document.getElementById('progress');
  const progressFill = document.getElementById('progress-fill');

  const viz = new GloamingKit({
    canvas,
    style: {
      background: '#0a0a12',
      lineColor: '#f1fe3e',
      accentColor: '#fc3373',
      lineWidth: 1,
      shadowBlur: 14,
    },
    timeline: [
      { from: 0, to: 13, visualizations: [VIZ.ATTRACTOR] },
      { from: 13, to: 25, visualizations: [VIZ.ATTRACTOR], style: { accentColor: '#334efc' } },
      { from: 25, to: 38, visualizations: [VIZ.ATTRACTOR, VIZ.STARFIELD], style: { accentColor: '#8d00f9' } },
      { from: 38, to: 51, visualizations: [VIZ.STARFIELD], style: { background: '#1800f5' } },
      { from: 51, to: 64, visualizations: [VIZ.ATTRACTOR, VIZ.ROAD, VIZ.PARTICLES] },
      { from: 64, to: 77, visualizations: [VIZ.ATTRACTOR, VIZ.ROAD, VIZ.PARTICLES] },
      { from: 77, to: 102, visualizations: [VIZ.LIGHTNING, { id: VIZ.RADIAL_BURST, bind: { ring: TRIGGER.HIHAT, scatter: 'bass' } }, VIZ.THOMAS] },
      { from: 102, to: 111, visualizations: [VIZ.STARFIELD, VIZ.BEDHEAD] },
      { from: 111, to: 117, visualizations: [VIZ.STARFIELD, VIZ.BEDHEAD], style: { lineColor: '#0cf800' } },
      { from: 117, to: 128, visualizations: [VIZ.STARFIELD, VIZ.BEDHEAD], style: { lineColor: '#ff17dc' } },
      { from: 128, to: 142, visualizations: [VIZ.ROAD, VIZ.PARTICLES, VIZ.STARFIELD], style: { lineColor: '#ffffff' } },
      { from: 142, to: 153, visualizations: [VIZ.ROAD, VIZ.PARTICLES, 'tunnel', VIZ.ATTRACTOR] },
      { from: 153, to: 161, visualizations: [VIZ.TUNNEL, VIZ.ATTRACTOR], style: { background: '#ff3939' } },
      { from: 161, to: 179, visualizations: [VIZ.TUNNEL, VIZ.THOMAS, VIZ.STARFIELD, VIZ.PARTICLES]},
      { from: 179, to: 186, visualizations: [{ id: VIZ.CLIFFORD, bind: { glow: 'bass' } }, VIZ.STARFIELD] },
      { from: 186, to: Infinity, visualizations: [VIZ.WAVEFORM, VIZ.ROLLING_BALL], style: { background: '#fb5df6', lineColor: '#000000', accentColor: '#fffc42' } },
    ],
  });
  window.addEventListener('resize', () => viz.resize());

  // Load the <audio> element that's already in the page — it streams rather
  // than decoding the whole file up front, and its preload has a head start on
  // the first click. Kicked off once here; the click just waits on it.
  const ready = viz.load(document.getElementById('song'));
  ready.catch((err) => console.error('demo: failed to load song', err));

  // The centre button only ever starts the song; from then on the corner
  // toggle owns the transport.
  let started = false;
  playBtn.addEventListener('click', async () => {
    if (started) return;
    try {
      await ready;
    } catch {
      return;   // load failed — leave the button up rather than stranding the page
    }
    started = true;
    viz.play();
    playBtn.classList.add('gone');
    toggleBtn.classList.add('show');
    progress.classList.add('show');
  });

  toggleBtn.addEventListener('click', () => {
    viz.player.playing ? viz.pause() : viz.play();
  });

  // Icon follows the player's own events rather than the click, so it stays
  // right when something else moves the transport — the song ending, or the
  // <audio> element being driven from elsewhere.
  const showPaused = (paused) => {
    toggleBtn.classList.toggle('paused', paused);
    toggleBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    toggleBtn.setAttribute('title', paused ? 'Play' : 'Pause');
  };
  viz.on('play', () => showPaused(false));
  viz.on('pause', () => showPaused(true));
  viz.on('ended', () => showPaused(true));

  // ---- progress / seek bar -------------------------------------------------

  // Driven by the engine's frame events rather than the audio element, so it
  // tracks whatever source the player actually has. aria-valuenow only
  // updates on whole-percent changes to keep screen readers quiet.
  let lastPct = -1;
  viz.on('frame', ({ time }) => {
    const d = viz.player.duration;
    if (!Number.isFinite(d) || d <= 0) return;   // no song yet, or live input
    const frac = Math.min(time / d, 1);
    progressFill.style.transform = `scaleX(${frac})`;
    const pct = Math.round(frac * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      progress.setAttribute('aria-valuenow', String(pct));
    }
  });

  // Click or drag anywhere on the strip to seek. Pointer capture keeps a
  // scrub alive when the pointer wanders off the 4px strip mid-drag.
  const seekTo = (clientX) => {
    const d = viz.player.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const rect = progress.getBoundingClientRect();
    const frac = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    viz.seek(frac * d);
    // Snap the fill now — the next frame event confirms it, but waiting for
    // one makes a paused-scrub feel dead.
    progressFill.style.transform = `scaleX(${frac})`;
  };
  progress.addEventListener('pointerdown', (e) => {
    // Capture can throw on exotic/synthetic pointers; the click-seek should
    // survive that, it just won't scrub.
    try { progress.setPointerCapture(e.pointerId); } catch { /* no scrub */ }
    seekTo(e.clientX);
  });
  progress.addEventListener('pointermove', (e) => {
    if (progress.hasPointerCapture(e.pointerId)) seekTo(e.clientX);
  });

  window.viz = viz; // console access for debugging/experimentation
})();
  