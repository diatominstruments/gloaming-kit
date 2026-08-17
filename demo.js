/**
 * Demo app — an example end-user script, deliberately not part of the library
 * build. It loads as a classic <script> after dist/gloaming-kit.js and reads
 * the library off the `gloamingKit` global, the same way any page embedding
 * the library would. Wrapped in an IIFE so its locals don't leak onto `window`.
 */
(() => {
  const { GloamingKit, registry, VIZ } = gloamingKit;

  const canvas = document.getElementById('stage');

  const viz = new GloamingKit({
    canvas,
    style: {
      background: '#0a0a12',
      lineColor: '#7fffd4',
      accentColor: '#ff5d8f',
      lineWidth: 2,
      shadowBlur: 14,
    },
    timeline: [
      { from: 0, to: 11, visualizations: [VIZ.ROAD] },
      { from: 11, to: 22, visualizations: [VIZ.TUNNEL] },
      { from: 22, to: 32, visualizations: [VIZ.STARFIELD] },
      // Window styles override the base style while they run, and the engine
      // interpolates into and out of them.
      {
        from: 32, to: 43,
        visualizations: [VIZ.LIGHTNING],
        style: { lineColor: '#a9c9ff', accentColor: '#fff4b8', background: '#05060f' },
      },
      {
        from: 43, to: 54,
        visualizations: [VIZ.ATTRACTOR],
        style: { lineColor: '#ff9d5c', accentColor: '#ffe08a', background: '#120a06' },
      },
      // Same visualization, rewired: its ring bursts follow the hihat and its
      // core breathes with treble instead of bass.
      { from: 54, to: 64, visualizations: [
        { id: VIZ.RADIAL_BURST, bind: { ring: 'hihat', core: 'treble' } },
      ] },
      { from: 64, to: Infinity, visualizations: [VIZ.HARMONOGRAPH, VIZ.PARTICLES] },
    ],
  });
  window.addEventListener('resize', () => viz.resize());
  window.viz = viz; // console access for debugging/experimentation

  // ---- transport -----------------------------------------------------------

  const playBtn = document.getElementById('play');
  const seek = document.getElementById('seek');
  const clock = document.getElementById('clock');
  const songName = document.getElementById('song-name');

  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  let scrubbing = false;

  viz.on('load', ({ duration }) => {
    playBtn.disabled = false;
    seek.max = duration;
    clock.textContent = `0:00 / ${fmt(duration)}`;
  });
  viz.on('play', () => (playBtn.textContent = 'Pause'));
  viz.on('pause', () => (playBtn.textContent = 'Play'));
  viz.on('ended', () => (playBtn.textContent = 'Play'));
  viz.on('frame', ({ time }) => {
    if (!scrubbing) seek.value = time;
    clock.textContent = `${fmt(time)} / ${fmt(viz.player.duration)}`;
  });

  playBtn.addEventListener('click', () => (viz.player.playing ? viz.pause() : viz.play()));
  seek.addEventListener('input', () => (scrubbing = true));
  seek.addEventListener('change', () => {
    viz.seek(parseFloat(seek.value));
    scrubbing = false;
  });

  // ---- song loading --------------------------------------------------------

  const fileInput = document.getElementById('file-input');
  document.getElementById('pick-song').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    await viz.load(file);
    songName.textContent = file.name;
  });
  document.getElementById('demo-song').addEventListener('click', async () => {
    try {
      await viz.load('demo-track.wav');
      songName.textContent = 'demo-track.wav (generated)';
    } catch {
      // fetch() is blocked when the page is opened via file:// — picker still works.
      songName.textContent = 'Demo track needs a local server — use "Choose file…" instead';
    }
  });

  // ---- style controls ------------------------------------------------------

  const bindControl = (id, key, parse = (v) => v) => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => viz.setStyle({ [key]: parse(el.value) }));
  };
  bindControl('st-bg', 'background');
  bindControl('st-line', 'lineColor');
  bindControl('st-accent', 'accentColor');
  bindControl('st-width', 'lineWidth', parseFloat);
  bindControl('st-glow', 'shadowBlur', parseFloat);

  // ---- timeline editor -----------------------------------------------------

  const timelineEl = document.getElementById('timeline');
  const vizNames = [...registry.keys()];
  let windows = viz.timeline.windows.map((w) => ({
    ...w,
    visualizations: w.visualizations.map((e) => ({ ...e })),
  }));

  function apply() {
    viz.setTimeline(windows);
  }

  function renderTimeline() {
    timelineEl.innerHTML = '';
    windows.forEach((w, i) => {
      const div = document.createElement('div');
      div.className = 'tl-window';

      const remove = document.createElement('button');
      remove.className = 'tl-remove';
      remove.textContent = '✕';
      remove.addEventListener('click', () => {
        windows.splice(i, 1);
        renderTimeline();
        apply();
      });
      div.appendChild(remove);

      const times = document.createElement('div');
      times.className = 'row';
      for (const key of ['from', 'to']) {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = 0;
        input.value = Number.isFinite(w[key]) ? w[key] : '';
        input.placeholder = key === 'to' ? 'end' : '0';
        input.addEventListener('change', () => {
          w[key] = input.value === '' ? (key === 'to' ? Infinity : 0) : parseFloat(input.value);
          apply();
        });
        const label = document.createElement('label');
        label.textContent = `${key} (s)`;
        times.append(label, input);
      }
      div.appendChild(times);

      const vizzes = document.createElement('div');
      vizzes.className = 'tl-vizzes';
      for (const name of vizNames) {
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = w.visualizations.some((e) => e.id === name);
        cb.addEventListener('change', () => {
          // Entries carry a `bind` alongside the id; unchecking drops any
          // custom routing with them, which is what the checkbox implies.
          w.visualizations = cb.checked
            ? [...w.visualizations, { id: name, bind: null }]
            : w.visualizations.filter((e) => e.id !== name);
          apply();
        });
        label.append(cb, name);
        vizzes.appendChild(label);
      }
      div.appendChild(vizzes);
      timelineEl.appendChild(div);
    });
  }

  document.getElementById('add-window').addEventListener('click', () => {
    const last = windows[windows.length - 1];
    const from = last && Number.isFinite(last.to) ? last.to : 0;
    windows.push({ from, to: Infinity, visualizations: [{ id: vizNames[0], bind: null }] });
    renderTimeline();
    apply();
  });

  renderTimeline();
})();
