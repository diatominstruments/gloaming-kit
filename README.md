# MusicViz

A small framework for building music visualizations with Canvas 2D and the
WebAudio API. A song plays in the browser, an analyzer emits per-frame band
energies and threshold-based trigger events (bass hits, snare, hihat), and a
timeline decides which visualizations are on screen for each time window of
the song — how each one is wired to the audio, and what palette it wears.

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
import { MusicViz, TRIGGER } from './src/engine.js';
```

Or from the bundle, via the global:

```js
const { MusicViz, registry, TRIGGER, Visualization, register } = musicviz;
```

## Architecture

```
SongPlayer ──▶ Analyzer ──▶ MusicViz engine ──▶ active Visualizations ──▶ canvas
 (buffer,       (FFT bands,    (raf loop, timeline,   (draw, read input
  transport)     triggers)      routing, style)        slots)
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
  active visualizations, each with an optional routing override and an
  optional per-window style. Windows may overlap (union wins).
- **Signals** ([src/signals.js](src/signals.js)) — compiles a routing spec
  into a per-frame function. Triggers pass through envelopes so every source
  is a continuous number, which is what lets bands and hits combine.
- **Style** ([src/style.js](src/style.js)) — interpolates the live style
  toward whatever the current windows ask for, so colours and widths travel
  between sections instead of cutting.
- **MusicViz** ([src/engine.js](src/engine.js)) — the entry point. Runs the
  animation loop, instantiates and disposes visualizations as their windows
  come and go (with an alpha crossfade), feeds their input slots, and keeps
  the live style moving toward the timeline's target.

## Usage

```js
import { MusicViz, TRIGGER } from './src/engine.js';

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

viz.setStyle({ lineColor: '#ffcc00' });   // updates the base style
viz.setTimeline([...]);                   // live-updates the schedule
viz.setTriggers([...]);                   // redefine trigger bands/thresholds
viz.resize();                             // call on window resize
viz.on('trigger:bass', ({ strength }) => { /* app-level reactions */ });
```

## Built-in visualizations

| id | what it does |
|----|--------------|
| `eq-bars` | spectrum as log-spaced bars, fast attack / slow decay |
| `waveform` | oscilloscope trace; the trace gains vertical scale with loudness |
| `radial-burst` | hits launch expanding rings from the centre and scatter ticks around the rim; a centre circle breathes |
| `polygon-pulse` | rotating polygon; radius pulses, side count morphs, hits kick the spin |
| `particles` | drifting particles that twinkle; hits shove every particle outward |

**Motion set** — perspective visuals that put the viewer in motion. Travel
speed is a fixed constant in all three (tune it via the class's `SPEED`
static): audio-driven speed makes the approach visibly stutter, because
loudness swings frame to frame. The sound shapes what you fly past, not how
fast you fly.

| id | what it does |
|----|--------------|
| `road` | rungs spawn at the horizon as frozen waveform traces and fly toward the viewer; each rung keeps the amplitude it was captured at |
| `tunnel` | rings extruded from the waveform at spawn rush past; the tunnel spins, with the spin rate smoothed |
| `starfield` | fly-through with motion streaks; hits swell star size |

**Chaos set** — recursive and chaotic geometry steered by the sound:

| id | what it does |
|----|--------------|
| `lightning` | branching bolts that strike and grow outward from the impact point, revealed by an advancing frontier so forks light up in the order the charge reaches them; big hits add a screen flash |
| `attractor` | de Jong strange attractor point cloud; parameters orbit slowly and hits jolt them to a nearby region, morphing the figure |
| `clifford` | Clifford Pickover attractor; layered and filamentary, same reactions as `attractor` |
| `bedhead` | Bedhead attractor; asymmetric swept whorls, same reactions as `attractor` |
| `thomas` | Thomas cyclically symmetric attractor as a rotating 3D ribbon; damping and lattice frequency drift to morph the structure, and hits surge the trajectory forward while corkscrewing and swelling the ribbon |
| `harmonograph` | damped Lissajous figure; hits snap it to a new musical frequency ratio and swell the amplitude, while a signed twist rate winds and unwinds the phase |

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

Binding a slot to a trigger that isn't configured logs a warning rather than
failing silently. Two windows naming the same visualization with different
bindings produce two independent instances, so both can be on screen at once;
crossing between them cross-fades rather than rewiring in place, which means
accumulated state restarts.

### Slots by visualization

`slot` ← its default source.

| id | event slots | level slots |
|----|-------------|-------------|
| `eq-bars` | — | — |
| `waveform` | — | `amplitude` ← rms |
| `radial-burst` | `ring` ← bass, `scatter` ← hihat | `core` ← bass |
| `polygon-pulse` | `kick` ← snare, `punch` ← bass | `sides` ← mid, `swell` ← bass |
| `particles` | `shove` ← bass | `twinkle` ← treble |
| `road` | — | `swell` ← rms |
| `tunnel` | — | `spin` ← treble |
| `starfield` | `swell` ← bass | — |
| `lightning` | `strike` ← bass, `offshoot` ← snare, `flicker` ← hihat | `wander` ← mid, `fork` ← highMid |
| `attractor`, `clifford`, `bedhead` | `jolt` ← bass | `drift` ← mid, `glow` ← treble (smoothed) |
| `thomas` | `jolt` ← bass | `drift` ← mid, `glow` ← treble (smoothed), `travel` ← mid, `spin` ← mid |
| `harmonograph` | `snap` ← snare, `swell` ← bass | `twist` ← mid, `size` ← bass (smoothed) |

`eq-bars` has no slots because it draws the raw `spectrum`, and `waveform`
routes only its amplitude — the trace data itself is an array, with nothing
meaningful to remap.

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

Style is global: everything on screen shares one palette, so simultaneous
visualizations can't be styled apart.

## Writing a visualization

```js
import { Visualization, TRIGGER, register } from './src/engine.js';

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

Two conventions worth following, both learned the hard way:

- **Drive rates, not positions.** Adding a band level straight into a
  position or phase makes the figure lurch on a loud frame and snap back on
  the next quiet one, because the offset is absolute rather than accumulated.
  Integrate instead: let the audio set how fast something moves.
- **Smooth anything continuous.** Raw band values jitter frame to frame. Use
  `smooth` in the slot's binding, or `approach(current, target, tau, dt)` from
  [src/util.js](src/util.js), which is frame-rate independent.

## Adding an attractor

The chaos family shares [src/visualizations/attractor-base.js](src/visualizations/attractor-base.js),
which owns the parameter dynamics — a parameter vector that orbits slowly,
decaying jolts from hits, and brightness — so a new attractor is a formula
plus a few constants. Two render strategies extend it:

```js
// 2D iterated map, drawn as a point cloud
class Clifford extends PointCloudAttractor {
  static id = 'clifford';
  static PARAMS = [-1.4, 1.6, 1.0, 0.7];
  static DRIFT = 0.3;     // scalar, or one entry per parameter
  static JOLT = 0.9;
  static SCALE = 0.26;    // world units → fraction of the short screen edge

  step(x, y, p, out) {    // runs thousands of times per frame
    out[0] = Math.sin(p[0] * y) + p[2] * Math.cos(p[0] * x);
    out[1] = Math.sin(p[1] * x) + p[3] * Math.cos(p[1] * y);
  }
}

// 3D flow, integrated with RK4 and drawn as a rotating ribbon
class Thomas extends FlowAttractor {
  derivative(x, y, z, p, out) { /* dx/dt, dy/dt, dz/dt */ }
}
```

`step` and `derivative` take an out-parameter and index `p` directly because
they run in a hot loop — returning or destructuring arrays there generates
hundreds of thousands of short-lived objects per second.

De Jong is bounded by construction; most of its relatives are not, and a jolt
can push them into a runaway region where one `Infinity` poisons the orbit
permanently. Both renderers guard with a bounds check and reseed, so keep
`DRIFT` and `JOLT` inside a range where the system stays interesting — and
watch for parameters that must not cross zero, like Bedhead's divisor.
