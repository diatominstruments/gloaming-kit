/**
 * Demo app — an example end-user script, deliberately not part of the library
 * build. It loads as a classic <script> after dist/gloaming-kit.js and reads
 * the library off the `gloamingKit` global, the same way any page embedding
 * the library would. Wrapped in an IIFE so its locals don't leak onto `window`.
 */
(() => {
  const { GloamingKit, catalog, VIZ, Glyph } = gloamingKit;

  const canvas = document.getElementById('stage');

  const viz = new GloamingKit({
    canvas,
    // Loaded by index.html; undefined if that failed, which leaves 3D
    // visualizations drawing their 2D fallbacks.
    three: window.THREE,
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
      // A background joining mid-section: it comes on after the attractor,
      // but its layer still draws it underneath.
      { from: 46, to: 64, visualizations: [VIZ.PERLIN_GLOW] },
      // Same visualization, rewired: its ring bursts follow the hihat and its
      // core breathes with treble instead of bass.
      { from: 54, to: 64, visualizations: [
        { id: VIZ.RADIAL_BURST, bind: { ring: 'hihat', core: { relative: 'treble' } } },
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

  const toggle3D = document.getElementById('st-3d');
  toggle3D.addEventListener('change', () => viz.set3D(toggle3D.checked));
  if (!window.THREE) {
    toggle3D.checked = false;
    toggle3D.disabled = true;
    toggle3D.title = 'three.js did not load';
  }

  // ---- timeline editor -----------------------------------------------------

  const timelineEl = document.getElementById('timeline');
  // Grouped, labelled and described by the library, so the picker needs no
  // knowledge of what's in it.
  const groups = catalog();
  let windows = viz.timeline.windows.map((w) => ({
    ...w,
    visualizations: w.visualizations.map((e) => ({ ...e })),
  }));

  function apply() {
    viz.setTimeline(windows);
  }

  // ---- glyph editor --------------------------------------------------------

  // Shared by every editor, so mirroring stays on while moving between them.
  const mirror = { h: false, v: false };

  /**
   * A click-to-draw grid for a `kind: 'grid'` option. Clicking a cell steps
   * it up a strength (grey, then full, then empty again); dragging paints
   * the strength the first cell got; shift- or right-click erases. Mirroring
   * paints the reflected cells too. The finished drawing is handed to
   * `onChange` as rows on release — not per cell, since each change makes a
   * new instance and crossfades to it.
   */
  function glyphEditor(spec, value, onChange) {
    const { width, height, levels } = spec;
    const cells = new Uint8Array(width * height);
    const load = (rows) => {
      cells.fill(0);
      const g = Glyph.parse(rows, levels);
      if (!g) return;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) cells[y * width + x] = g.get(x, y);
      }
    };
    load(value ?? spec.default);

    const root = document.createElement('div');
    root.className = 'glyph-editor';
    const px = Math.floor(240 / Math.max(width, height));
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.style.width = `${width * px}px`;
    canvas.style.height = `${height * px}px`;
    canvas.width = width * px * dpr;
    canvas.height = height * px * dpr;
    const g2 = canvas.getContext('2d');
    g2.scale(dpr, dpr);

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7fffd4';
    const draw = () => {
      g2.fillStyle = '#10101a';
      g2.fillRect(0, 0, width * px, height * px);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const level = cells[y * width + x];
          g2.globalAlpha = level ? 0.25 + 0.75 * (level / levels) : 1;
          g2.fillStyle = level ? accent : '#1a1a26';
          g2.fillRect(x * px + 1, y * px + 1, px - 2, px - 2);
        }
      }
      g2.globalAlpha = 1;
    };

    const set = (x, y, level) => {
      const xs = mirror.h ? [x, width - 1 - x] : [x];
      const ys = mirror.v ? [y, height - 1 - y] : [y];
      for (const cx of xs) for (const cy of ys) cells[cy * width + cx] = level;
    };
    const rows = () => Array.from({ length: height }, (_, y) => Array.from(
      cells.subarray(y * width, (y + 1) * width), (c) => (c ? String(c) : '.'),
    ).join(''));
    const commit = () => onChange(rows());

    let paint = null;
    const cellAt = (e) => {
      const r = canvas.getBoundingClientRect();
      const x = Math.floor((e.clientX - r.left) / px);
      const y = Math.floor((e.clientY - r.top) / px);
      return x >= 0 && y >= 0 && x < width && y < height ? [x, y] : null;
    };
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      const at = cellAt(e);
      if (!at) return;
      canvas.setPointerCapture(e.pointerId);
      const [x, y] = at;
      paint = e.button === 2 || e.shiftKey ? 0 : (cells[y * width + x] + 1) % (levels + 1);
      set(x, y, paint);
      draw();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (paint === null) return;
      const at = cellAt(e);
      if (!at) return;
      set(at[0], at[1], paint);
      draw();
    });
    const release = () => {
      if (paint === null) return;
      paint = null;
      commit();
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    const tools = document.createElement('div');
    tools.className = 'glyph-tools';
    const tool = (label, title, onClick) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', () => onClick(b));
      tools.appendChild(b);
      return b;
    };
    for (const [axis, label, title] of [['h', '⇆', 'Mirror left–right'], ['v', '⇅', 'Mirror top–bottom']]) {
      const b = tool(label, title, () => {
        mirror[axis] = !mirror[axis];
        b.setAttribute('aria-pressed', mirror[axis]);
      });
      b.setAttribute('aria-pressed', mirror[axis]);
    }
    tool('Clear', 'Empty every cell', () => { cells.fill(0); draw(); commit(); });
    tool('Reset', 'Back to the default drawing', () => { load(spec.default); draw(); commit(); });

    draw();
    root.append(canvas, tools);
    return root;
  }

  /** Grid editors for the checked visualizations of one group, in one window. */
  function renderEditors(container, w, group) {
    container.innerHTML = '';
    for (const d of group.visualizations) {
      const entry = w.visualizations.find((e) => e.id === d.id);
      if (!entry) continue;
      for (const spec of d.options.filter((o) => o.kind === 'grid')) {
        const label = document.createElement('div');
        label.className = 'glyph-label';
        label.textContent = `${d.label} — ${spec.name}`;
        container.append(label, glyphEditor(spec, entry.options?.[spec.name], (rows) => {
          entry.options = { ...entry.options, [spec.name]: rows };
          apply();
        }));
      }
    }
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

      for (const group of groups) {
        const section = document.createElement('div');
        section.className = 'tl-group';
        const heading = document.createElement('h3');
        heading.textContent = group.label;
        heading.title = group.description;
        const vizzes = document.createElement('div');
        vizzes.className = 'tl-vizzes';
        const editors = document.createElement('div');
        for (const { id, label: name, description } of group.visualizations) {
          const label = document.createElement('label');
          label.title = description;
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = w.visualizations.some((e) => e.id === id);
          cb.addEventListener('change', () => {
            // Entries carry a `bind` alongside the id; unchecking drops any
            // custom routing with them, which is what the checkbox implies.
            w.visualizations = cb.checked
              ? [...w.visualizations, { id, bind: null }]
              : w.visualizations.filter((e) => e.id !== id);
            apply();
            renderEditors(editors, w, group);
          });
          label.append(cb, name);
          vizzes.appendChild(label);
        }
        renderEditors(editors, w, group);
        section.append(heading, vizzes, editors);
        div.appendChild(section);
      }
      timelineEl.appendChild(div);
    });
  }

  document.getElementById('add-window').addEventListener('click', () => {
    const last = windows[windows.length - 1];
    const from = last && Number.isFinite(last.to) ? last.to : 0;
    windows.push({ from, to: Infinity, visualizations: [{ id: groups[0].visualizations[0].id, bind: null }] });
    renderTimeline();
    apply();
  });

  renderTimeline();
})();
