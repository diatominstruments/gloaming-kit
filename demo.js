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
      { from: 38, to: 51, visualizations: [VIZ.STARFIELD] },
      { from: 51, to: 64, visualizations: [VIZ.ATTRACTOR, VIZ.ROAD, VIZ.PARTICLES] },
      { from: 64, to: 77, visualizations: [VIZ.ATTRACTOR, VIZ.ROAD, VIZ.PARTICLES] },
      { from: 77, to: 102, visualizations: [VIZ.LIGHTNING, { id: VIZ.RADIAL_BURST, bind: { ring: 'treble', scatter: 'bass' } }, VIZ.THOMAS] },
      { from: 102, to: 128, visualizations: [VIZ.STARFIELD, VIZ.BEDHEAD] },
      { from: 128, to: 142, visualizations: [VIZ.ROAD, VIZ.PARTICLES] },
      { from: 142, to: 153, visualizations: [VIZ.ROAD, VIZ.PARTICLES, 'tunnel', VIZ.ATTRACTOR], style: { lineWidth: 1, lineColor: '#0cf800' } },
      { from: 153, to: 179, visualizations: [VIZ.TUNNEL, VIZ.ATTRACTOR] },
      { from: 179, to: Infinity, visualizations: [VIZ.ATTRACTOR] },
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

  window.viz = viz; // console access for debugging/experimentation
})();
  