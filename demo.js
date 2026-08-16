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
      lineColor: '#fffd7f',
      accentColor: '#fc3373',
      lineWidth: 1,
      shadowBlur: 14,
    },
    timeline: [
      { from: 0, to: 13, visualizations: ['attractor'] },
      { from: 13, to: 25, visualizations: ['attractor', 'starfield'] },
      { from: 25, to: 38, visualizations: ['attractor', 'starfield'], style: { lineWidth: 2, accentColor: '#8d00f9' } },
      { from: 38, to: 51, visualizations: ['starfield'] },
      { from: 51, to: 64, visualizations: ['attractor', 'road', 'particles'] },
      { from: 64, to: 77, visualizations: ['attractor', 'road', 'particles'] },
      { from: 77, to: 102, visualizations: ['lightning', 'radial-burst', 'thomas'] },
      { from: 102, to: 128, visualizations: ['starfield', 'bedhead'] },
      { from: 128, to: 142, visualizations: ['road', 'particles'] },
      { from: 142, to: 153, visualizations: ['road', 'particles', 'tunnel', 'attractor'], style: { lineWidth: 1, lineColor: '#0cf800' } },
      { from: 153, to: 179, visualizations: ['tunnel', 'attractor'] },
      { from: 179, to: Infinity, visualizations: ['attractor'] },
    ],
  });
  window.addEventListener('resize', () => viz.resize());
  playBtn.addEventListener('click', () => async () => {
    await viz.load('sound2.wav');
    viz.player.playing ? viz.pause() : viz.play()
  });
  window.viz = viz; // console access for debugging/experimentation
  const sound = new Audio(document.getElementById('song').src);
  viz.load(sound);
})();
  