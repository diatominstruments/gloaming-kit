# MusicViz

A small framework for building music visualizations with Canvas 2D and the
WebAudio API. A song plays in the browser, an analyzer emits per-frame band
energies and threshold-based trigger events (bass hits, snare, hihat), and a
timeline decides which visualizations from the library are on screen for each
time window of the song.

No runtime dependencies — plain ES modules, with esbuild as the only dev
dependency for producing a browser bundle.

## Building and running

The build bundles **the library only**, from `src/engine.js`:

```bash
npm install && npm run build
```

That writes `dist/musicviz.js`, an IIFE bundle exposing the API on a
`musicviz` global. `npm run watch` rebuilds on change.

`index.html` then loads the library and the demo app as two classic scripts:

```html
<script src="dist/musicviz.js" defer></script>
<script src="demo.js" defer></script>
```

`demo.js` is an example consumer, not part of the build — it reads the
library off the global exactly as an embedding page would. Because neither
tag is a module, the page works opened straight from disk; only the "Demo
track" button needs a server, since `fetch()` is blocked on `file://`:

```bash
python3 -m http.server 8137 --directory musicviz
```

`demo-track.wav` is a generated 64-second synth loop (regenerate with
`node tools/make-demo-track.js`), or load any audio file the browser can
decode via the file picker.

## Consuming the library

As ES modules, straight from source, no build:

```js
import { MusicViz } from './src/engine.js';
```

Or from the bundle, via the global:

```js
const { MusicViz, registry, TRIGGER, Visualization, register } = musicviz;
```

## Architecture

```
SongPlayer ──▶ Analyzer ──▶ MusicViz engine ──▶ active Visualizations ──▶ canvas
 (buffer,       (FFT bands,    (raf loop,          (draw + react to
  transport)     triggers)      timeline, fades)    frames/triggers)
```

- **SongPlayer** ([src/player.js](src/player.js)) — decodes a URL or `File`
  into an `AudioBuffer`, handles play/pause/seek, exposes an output `GainNode`.
- **Analyzer** ([src/analyzer.js](src/analyzer.js)) — taps the player through
  an `AnalyserNode`. Each tick it emits a `frame` event with coarse band
  energies (`subBass`, `bass`, `lowMid`, `mid`, `highMid`, `treble`, each
  0–1), overall `level`, and the raw `spectrum`/`waveform` arrays. Configured
  triggers fire `trigger:<name>` events on a rising edge over a threshold,
  with a cooldown and a 0–1 `strength` for scaling the visual response.
- **Timeline** ([src/timeline.js](src/timeline.js)) — maps song time to the
  set of active visualizations, each with an optional routing override, plus
  an optional per-window style. Windows may overlap (union wins).
- **Style** ([src/style.js](src/style.js)) — interpolates the live style
  toward whatever the current windows ask for, so colours and widths travel
  between sections instead of cutting.
- **Signals** ([src/signals.js](src/signals.js)) — compiles a routing spec
  into a per-frame function. Triggers pass through envelopes so every source
  is a continuous number, which is what lets bands and hits combine.
- **MusicViz** ([src/engine.js](src/engine.js)) — the entry point. Runs the
  animation loop, instantiates/disposes visualizations as their windows come
  and go (with an alpha crossfade), routes frames and triggers to them, and
  applies the shared style object.

## Usage

```js
import { MusicViz } from './src/engine.js';

const viz = new MusicViz({
  canvas: document.querySelector('canvas'),
  style: {
    background: '#0a0a12',
    lineColor: '#7fffd4',
    accentColor: '#ff5d8f',
    lineWidth: 2,
    shadowBlur: 14,        // glow; shadowColor defaults to lineColor
  },
  timeline: [
    { from: 0,  to: 60, visualizations: ['eq-bars'] },
    {
      from: 60, to: Infinity,
      visualizations: [
        'waveform',
        // Rewire this instance: rings follow the hihat, the core breathes
        // with treble. Slots left out keep their defaults.
        { id: 'radial-burst', bind: { ring: 'hihat', core: 'treble' } },
      ],
      // Partial override of the base style, eased in and out.
      style: { lineColor: '#ffb347', background: '#120a06' },
    },
  ],
  styleFade: 0.3,   // optional; seconds, time constant for style transitions
  // optional — these are the defaults:
  triggers: [
    { name: TRIGGER.BASS,  band: [40, 130],     threshold: 0.55, cooldown: 0.15 },
    { name: TRIGGER.SNARE, band: [1500, 4000],  threshold: 0.45, cooldown: 0.15 },
    { name: TRIGGER.HIHAT, band: [8000, 14000], threshold: 0.35, cooldown: 0.08 },
  ],
});

await viz.load(fileOrUrl);   // File/Blob or URL string
viz.play();                  // must follow a user gesture (autoplay policy)

viz.setStyle({ lineColor: '#ffcc00' });   // live-updates running visuals
viz.setTimeline([...]);                    // live-updates the schedule
viz.on('trigger:bass', ({ strength }) => { /* app-level reactions */ });
```

## Built-in visualizations

| id | reacts to |
|----|-----------|
| `eq-bars` | spectrum (log-spaced bars, fast attack / slow decay) |
| `waveform` | time-domain signal + overall level |
| `radial-burst` | `bass` trigger → expanding rings; `hihat` → rim ticks |
| `polygon-pulse` | bass energy → radius; mid energy → side count; `snare` → spin kicks |
| `particles` | treble energy → twinkle; `bass` trigger → outward shove |

**Motion set** — perspective visuals that put the viewer in motion. Travel
speed is a fixed constant in all three (tune it via the class's `SPEED`
static): audio-driven speed makes the approach visibly stutter, because
loudness swings frame to frame. The sound shapes what you fly past, not how
fast you fly.

| id | reacts to |
|----|-----------|
| `road` | rungs spawn at the horizon as frozen waveform traces and fly toward the viewer; each rung keeps the amplitude it was captured at |
| `tunnel` | rings extruded from the waveform at spawn rush past; treble spins the tunnel, with the spin rate smoothed |
| `starfield` | fly-through with motion streaks; `bass` swells star size |

**Chaos set** — recursive/chaotic geometry steered by the sound:

| id | reacts to |
|----|-----------|
| `lightning` | branching bolts that strike and grow outward from the impact point; `bass` fires a full-height strike plus a screen flash, `snare` a shorter offshoot, `hihat` flickers what's still burning; mid widens each channel's wander, high-mid makes it fork more |
| `attractor` | de Jong strange attractor point cloud; mid energy sets parameter drift; `bass` jolts parameters (morphs the figure); treble brightens |
| `clifford` | Clifford Pickover attractor; layered and filamentary, same reactions as `attractor` |
| `bedhead` | Bedhead attractor; asymmetric swept whorls, same reactions as `attractor` |
| `thomas` | Thomas cyclically symmetric attractor as a rotating 3D ribbon; mid energy drives travel speed, yaw rate and how fast the shape writhes; damping and lattice frequency drift to morph the structure; `bass` surges the trajectory forward and corkscrews/swells the ribbon; treble brightens |
| `harmonograph` | damped Lissajous figure; `snare` snaps to a new musical frequency ratio; mids twist phase; `bass` swells amplitude |

## Window styles

Any window may carry a partial `style` that overrides the base style while it
runs. Overlapping windows cascade in config order, later keys winning, and
anything left unset falls back to the base style.

Transitions are interpolated rather than cross-faded: numbers ease, and hex
colours ease per channel, so a section change slides the palette instead of
cutting it. Values that can't be parsed as numbers or hex colours (gradients,
`rgba(…)`, keywords) snap. `styleFade` sets the time constant.

`setStyle()` updates the base style and snaps the live one, so a colour picker
stays responsive — but a window override still wins on the next frame, so
editing a key some window overrides will appear to spring back. Seeking snaps
rather than gliding, so scrubbing across sections doesn't smear.

## Routing

A visualization declares named **input slots** instead of reading the analyzer
directly, so a timeline window can rewire any of them without the
visualization knowing. Slots come in two kinds:

- `level` — a continuous number, read during `draw` with `this.in('name')`
- `event` — a discrete hit, delivered to `onInput('name', data)`, for
  responses that must happen once at an instant

Every slot declares a default, so an unbound visualization behaves exactly as
if the routing layer weren't there. A window's `bind` overrides slots
individually:

```js
{ id: 'lightning', bind: { strike: 'snare', wander: 'treble' } }
```

Event slots take a trigger name. Level slots take a signal spec:

```js
'mid'                                   // a band, by name
'rms'                                   // overall loudness
0.5                                     // a constant
{ band: 'treble', gain: 1.4 }           // shaped
{ trigger: 'bass', decay: 4 }           // envelope on a trigger
{ sum: ['bass', { band: 'mid', gain: 0.5 }] }
{ max: [...] }                          // loudest wins
[a, b]                                  // shorthand for { sum: [a, b] }
```

Any spec object also accepts `smooth` (seconds), `curve` (exponent), `gain`
(multiplier) and `clamp` (to 0–1), applied in that order. Because triggers
become envelopes, a hit is usable anywhere a level is — including summed with
one.

## Writing a visualization

```js
import { Visualization, TRIGGER } from './src/engine.js';
import { register } from './src/visualizations/index.js';

class Strobe extends Visualization {
  static id = 'strobe';
  static inputs = {
    hit:  { kind: 'event', default: TRIGGER.SNARE },
    tint: { kind: 'level', default: { band: 'treble', smooth: 0.1 } },
  };

  onInput(slot, { strength }) { this.flash = strength; }

  draw(ctx, dt) {
    this.flash = Math.max(0, (this.flash ?? 0) - dt * 4);
    this.applyStyle(ctx);        // strokeStyle/fillStyle/lineWidth/shadow from style
    ctx.globalAlpha *= this.flash * (0.5 + this.in('tint'));
    ctx.fillRect(0, 0, this.width, this.height);
  }
}
register(Strobe);                // now usable in timeline config as 'strobe'
```

`onFrame(frame)` is called every tick before `draw` (the base class stashes it
on `this.frame`) — use it for raw `spectrum`/`waveform` access, which isn't
routed. The engine handles clearing the canvas, fade in/out, and
`resize(width, height)`.

`static triggers = [...]` with `onTrigger(name, data)` still works for
visualizations that don't declare slots, but it can't be rerouted.
