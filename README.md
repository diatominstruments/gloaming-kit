# GloamingKit

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

That writes `dist/gloaming-kit.js`, an IIFE bundle exposing the API on a
`gloamingKit` global. `npm run watch` rebuilds on change.

`dist/` is **not** checked in, so this build is a required first step after
cloning — `index.html` loads the bundle by path and will do nothing without
it. (Keeping generated output out of git is also what keeps the `gh-pages`
demo branch rebasing cleanly; see [DEMO.md](DEMO.md).)

`index.html` then loads the library and the demo app as two classic scripts:

```html
<script src="dist/gloaming-kit.js" defer></script>
<script src="demo.js" defer></script>
```

`demo.js` is an example consumer, not part of the build — it reads the
library off the global exactly as an embedding page would. Because neither
tag is a module, the page works opened straight from disk; only the "Demo
track" button needs a server, since `fetch()` is blocked on `file://`:

```bash
python3 -m http.server 8137 --directory gloaming-kit
```

`demo-track.wav` is a generated 64-second synth loop (regenerate with
`node tools/make-demo-track.js`), or load any audio file the browser can
decode via the file picker.

## Consuming the library

As ES modules, straight from source, no build:

```js
import { GloamingKit, VIZ, TRIGGER } from './src/engine.js';
```

Or from the bundle, via the global:

```js
const { GloamingKit, registry, VIZ, TRIGGER, Visualization, register } = gloamingKit;
```

Importing from source, IDEs infer everything and autocomplete works out of
the box (`VIZ.` lists every visualization). The global does **not** get this:
a classic `<script>` declares nothing to the language service, so `gloamingKit`
is implicitly `any` and completion goes silent. A JSDoc cast restores it —
no TypeScript build required, IDEs read the annotation as-is:

```js
const { GloamingKit, VIZ } = /** @type {import('./src/engine.js')} */ (gloamingKit);
```

(Adjust the path to wherever the source lives relative to your script.)

## Architecture

```
SongPlayer ──▶ Analyzer ──▶ GloamingKit engine ──▶ active Visualizations ──▶ canvas
 (buffer,       (FFT bands,    (raf loop, timeline,   (draw, read input
  transport)     triggers)      routing, style)        slots)
```

- **SongPlayer** ([src/player.js](src/player.js)) — feeds audio into the graph
  and exposes transport. Takes a URL, a `File`/`Blob`, an `<audio>` element or
  a bare `AudioNode`; everything reaches the speakers through an output
  `GainNode` that the Analyzer taps, so the rest of the system is indifferent
  to which kind of source is upstream.
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
- **GloamingKit** ([src/engine.js](src/engine.js)) — the entry point. Runs the
  animation loop, instantiates and disposes visualizations as their windows
  come and go (with an alpha crossfade), feeds their input slots, and keeps
  the live style moving toward the timeline's target.

## Usage

```js
import { GloamingKit, VIZ, TRIGGER } from './src/engine.js';

const viz = new GloamingKit({
  canvas: document.querySelector('canvas'),
  style: {
    background: '#0a0a12',
    lineColor: '#7fffd4',
    accentColor: '#ff5d8f',
    lineWidth: 2,
    shadowBlur: 14,        // glow; shadowColor defaults to lineColor
  },
  timeline: [
    // Ids are plain strings; VIZ holds them as constants so the full list
    // shows up in IDE completion.
    { from: 0,  to: 60, visualizations: [VIZ.EQ_BARS] },
    {
      from: 60, to: Infinity,
      visualizations: [
        VIZ.WAVEFORM,
        // Rewire this instance: rings follow the hihat, the core breathes
        // with treble. Slots left out keep their defaults.
        { id: VIZ.RADIAL_BURST, bind: { ring: 'hihat', core: 'treble' } },
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

await viz.load(source);      // see "Audio sources" below
viz.play();                  // must follow a user gesture (autoplay policy)

viz.setStyle({ lineColor: '#ffcc00' });   // updates the base style
viz.setTimeline([...]);                   // live-updates the schedule
viz.setTriggers([...]);                   // redefine trigger bands/thresholds
viz.resize();                             // call on window resize
viz.on('trigger:bass', ({ strength }) => { /* app-level reactions */ });
```

## Audio sources

`load()` accepts four things, and picks its strategy from what it's given:

| passed | how it plays | transport |
|--------|--------------|-----------|
| URL string | fetched, decoded to an `AudioBuffer` | full |
| `File` / `Blob` | decoded, no network | full |
| `HTMLMediaElement` | `MediaElementAudioSourceNode`, streamed | delegated to the element |
| `AudioNode` | connected as-is | none |

```js
await viz.load('song.wav');                          // URL
await viz.load(fileInput.files[0]);                  // picker
await viz.load(document.querySelector('audio'));     // <audio> element
await viz.load(micStreamNode);                       // live input
```

**Which to use.** The URL path needs an `http(s)` origin, because `fetch` is
blocked on `file://`. The `File`/`Blob` path has no such restriction, which is
why a file picker works from disk. An `<audio>` element also loads under rules
that permit `file://`, and streams rather than decoding up front — worth it
for long tracks — while keeping play/pause/seek working, since the element
owns the transport and the player mirrors its events. That means transport
stays in sync even if something else drives the element, such as native
`controls`.

**The catch with elements:** media feeding Web Audio is subject to CORS. A
cross-origin element without permissive headers still plays *audibly* but
delivers silence to the graph, so every band reads zero and the visualizations
sit dead. Same-origin, or `crossOrigin` set before the `src`, keeps the
analyzer fed.

This rules the element path out on `file://`. Chrome treats each local file as
its own opaque origin, so an `<audio>` element pointed at a file next to the
page is already cross-origin, and the console says so:

```
MediaElementAudioSource outputs zeroes due to CORS access restrictions
```

Over `http(s)` the element path is unaffected, and is the better choice for
long tracks since it streams instead of decoding everything up front. For
autoloading from disk with no server, the only routes are a `File` from a
picker, or audio embedded in the page as a `Blob` — both bypass CORS entirely
because no media element is involved.

**Bare nodes** have no transport, so `play`/`pause`/`seek` are no-ops and
`duration` is `Infinity`. `currentTime` reports seconds since the node was
connected, so timeline windows still advance rather than pinning to the start.
The node must belong to the player's `AudioContext` — either build it from
`viz.player.ctx`, or pass your own context to the engine:

```js
const viz = new GloamingKit({ canvas, audioContext: myCtx, timeline: [...] });
```

## Built-in visualizations

| id | what it does |
|----|--------------|
| `eq-bars` | spectrum as log-spaced bars, fast attack / slow decay |
| `waveform` | oscilloscope trace; the trace gains vertical scale with loudness |
| `radial-burst` | hits launch expanding rings from the centre and scatter ticks around the rim; a centre circle breathes |
| `polygon-pulse` | rotating polygon; radius pulses, side count morphs, hits kick the spin |
| `particles` | drifting particles that twinkle; hits shove every particle outward |
| `rolling-ball` | wireframe sphere tumbling in place — loudness sets the roll rate, bass swells it, and snare hits swerve it onto a new heading |

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
| `thomas` | Thomas cyclically symmetric attractor as a rotating 3D ribbon, viewed from inside the lattice (`distance: 'near'`) so cells sweep past the camera; damping and lattice frequency drift to morph the structure, and hits surge the trajectory forward while whipping the spin and briefly swelling the figure |
| `aizawa` | Aizawa attractor as a rotating ribbon; a shell wound into tight concentric spirals by a fast reversed spin. Same reactions as `thomas`, and the one most worth trying at `distance: 'near'` |
| `rossler` | Rössler attractor as a rotating ribbon; a broad flat disc with one lifted fold, so the silhouette changes markedly as the view turns. Its fold threshold drifts over a wide band, growing and shrinking the whole figure fourfold — it reads as the attractor rushing in and falling away. Same reactions as `thomas` |
| `halvorsen` | Halvorsen attractor as a rotating ribbon; cyclically symmetric like `thomas` but coiled into three tight horns rather than sprawling, and scaled past the frame so the horns run off every edge. Same reactions as `thomas` |
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
| `rolling-ball` | `swerve` ← snare | `speed` ← rms, `swell` ← bass |
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

## Options

`bind` decides what a visualization listens to. `options` carries per-instance
settings that have nothing to do with audio — a plain object, passed through
untouched and read by the visualization as `this.options`:

```js
{ id: VIZ.THOMAS, options: { distance: 'far' } }
```

Nothing compiles or validates it; a visualization reads the keys it knows and
falls back to its own statics for the rest. Like `bind`, an entry carrying
`options` is a distinct instance, so the same attractor can be on screen twice
at two different distances.

### Camera distance

The flow attractors take `distance: 'near' | 'med' | 'far'`. `FOCAL` is a
distance in world units and the projection divides by `FOCAL + z`, so this is
literally the camera sliding along its own axis — each system declares the
framing that suits it as `med`, and the presets are multipliers on that
(0.15 / 1 / 1.6).

`near` puts the camera **inside** the body. Perspective goes violent, near
sections balloon past the frame, and the figure reads as something you are
flying through rather than orbiting. That is only safe because the renderer
clips at a near plane: without it, everything behind the camera inverts
through the origin and whips across the screen. `NEAR` sets where that plane
sits as a fraction of the focal length, and it doubles as the cap on how much
the projection can magnify anything — on Thomas at `near`, over a full
revolution, the longest segment drawn goes from 3.1× the canvas diagonal at
`NEAR = 0.06` to 0.4× at 0.35. At `med` and `far` nothing is ever clipped.

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

### Fitting a new flow to the renderer

Four constants have to be re-derived per system rather than inherited, and
most of them fail in ways that aren't obvious from reading the code:

- **`FOCAL`** is a distance in *world units*, and the projection divides by
  `FOCAL + z`. If the body is larger than `FOCAL`, that crosses zero and
  points invert through the origin, streaking across the screen. It must
  exceed the farthest reach from `CENTER` — Thomas sits at roughly 2× its
  own reach, which is a reasonable target. Inheriting Thomas's `FOCAL = 9`
  is fine for a small system and catastrophic for a large one.
- **`H`** is a step in the system's own time units, and those differ by an
  order of magnitude between systems. What transfers is the ratio of step
  length to body radius — how far one sample moves as a fraction of the
  figure. The four here idle at about 0.035, which buys a lot of trajectory
  per frame while staying smooth; past roughly 0.1 the ribbon visibly facets.
  Reuse another system's `H` directly and RK4 will alias or diverge. Note
  that a *parameter* can force this down: Aizawa's spin term at 14 moves the
  trajectory four times faster than at 3.5, so its step had to shrink even
  though nothing about the renderer changed.
- **`H_LIMIT`** is the ceiling on `H` after everything that scales it. Mid
  energy and a bass surge together multiply the step by up to ~4, and that
  product is what has to stay safe, not the base value — Rössler diverges
  outright at ~24× its resting step, which a loud passage reaches on its own.
  Set it from a sweep, at roughly half the multiplier where the system breaks.
- **`TWIST`** is radians per world unit of height, so it scales inversely
  with the body. Thomas's 0.045 across its ±4.5 body is ~0.2 rad of twist;
  aim for that.

`SUBSTEPS` is not in that list, because it is free. Accuracy is set by `H`
alone; taking more steps per frame only buys more trajectory in the ring
buffer, which is what makes the ribbon read as the whole attractor drawn at
once with a bright head racing round it rather than a short worm crawling
over an invisible shape. At 32, six instances cost about 0.3 ms a frame.
Reach for it before reaching for `H`.

Worth checking a candidate numerically before tuning it by eye. Some systems
have a failure mode the `LIMIT` guard does *not* catch: rather than diverging,
the attractor collapses onto a fixed point and the figure silently shrinks to
a stationary dot. Aizawa does this, and its chaotic region sits right next to
the collapse — see [aizawa.js](src/visualizations/aizawa.js) for the bands
that came out of sweeping it. A largest-Lyapunov estimate over the corners of
the drift+jolt envelope distinguishes genuine chaos from a limit cycle, which
an extent check alone will not.

Sweep the *corners*, not one parameter at a time. Aizawa's `b` is safe down to
0.68 on its own and only to 0.72 once `c` is simultaneously at the bottom of
its own band; a one-at-a-time sweep says the wider setting is fine and it goes
to a stationary dot on stage. Sweep at the clamped step as well as the idle
one, too — a larger step's own error can carry a trajectory off a fixed point
it would otherwise settle onto, so a config can look alive under load and die
when the track goes quiet.

Not every non-chaotic result is a failure. Rössler spends the bottom of its
fold band as a plain limit cycle: full extent, no evolution, which on screen
is the figure settling into one clean loop before the drift carries it back
up. Worth knowing which of the two you have, and choosing the base parameter
so the resting state is the one you want to look at.
