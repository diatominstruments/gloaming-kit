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

  playBtn.addEventListener('click', async () => {
    await ready;
    viz.player.playing ? viz.pause() : viz.play();
  });
  window.viz = viz; // console access for debugging/experimentation
})();
  