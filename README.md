# GloamingKit

A small framework for building music visualizations with Canvas 2D and the
WebAudio API. A song plays in the browser, an analyzer emits per-frame band
energies and adaptive trigger events (bass hits, snare, hihat), and a
timeline decides which visualizations are on screen for each time window of
the song — how each one is wired to the audio, and what palette it wears.

No runtime dependencies — plain ES modules, with esbuild as the only dev
dependency for producing a browser bundle. The optional 3D visualizations use
three.js, which the app passes in rather than the library bundling (see
[3D rendering](#3d-rendering)).

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
const { GloamingKit, registry, VIZ, TRIGGER, Visualization, register, catalog, describe } = gloamingKit;
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
  0–1), overall `level`, per-band `relative` and `intensity` (see
  [Dynamics](#dynamics)), and the raw `spectrum`/`waveform` arrays.
  Configured triggers fire `trigger:<name>` events when a band jumps out of
  its recent dynamics, with a cooldown, a relative 0–1 `strength` and an
  absolute 0–1 `intensity`.
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
    { name: TRIGGER.BASS,  band: [40, 130],     threshold: 0.6, cooldown: 0.15 },
    { name: TRIGGER.SNARE, band: [1500, 4000],  threshold: 0.7, cooldown: 0.15 },
    { name: TRIGGER.HIHAT, band: [8000, 14000], threshold: 0.4, cooldown: 0.08 },
  ],
});

await viz.load(source);      // see "Audio sources" below
viz.play();                  // must follow a user gesture (autoplay policy)

viz.setStyle({ lineColor: '#ffcc00' });   // updates the base style
viz.setTimeline([...]);                   // live-updates the schedule
viz.setTriggers([...]);                   // redefine trigger bands/thresholds
viz.resize();                             // call on window resize
viz.on('trigger:bass', ({ strength, intensity }) => { /* app-level reactions */ });
```

## Dynamics

A fixed threshold on band energy fails both ways: a quiet track never reaches
it, and a loud, compressed one sits above it and fires on every wobble. So the
analyzer tracks each band (and `rms`) against its own recent behaviour and
reports two separate numbers:

- **`relative`** (0–1) — where the band sits between its recent floor (the
  level between hits) and its recent peak (how high hits have been reaching).
  A hit reads near 1 in a quiet intro and a loud drop alike. Floor and peak
  are the minimum and maximum over the last 1.5 s, so the peak holds steady
  between beats but a sudden 20 dB drop is forgotten in under 2 s. It's
  measured on linear amplitude, which is what lets a snare stand clear of the
  hihats bleeding into its band.
- **`intensity`** (0–1) — a slow, absolute measure of how loud the band is.
  Every band is calibrated against pink noise at a loud-master level, so 1
  means "as loud as a modern master" in any band and a passage 20 dB down
  reads about 0.45 lower.

Triggers fire when their band's `relative` crosses `threshold` and re-arm once
it falls under half of it. The threshold is really a question of prominence
against the loudest thing sharing the band, which is why the snare's is high
(hats bleed into it) and the hihat's low (the snare's noise sets its peak).
Silence is gated out near the analyser's noise floor, so hiss never stretches
into hits.

Each hit carries both numbers, which answer different questions: `strength`
(relative) says *whether* and how sharply to react, `intensity` how *big*.
`impact(hit)` (exported from the library) combines them — strength scaled by
intensity, with a floor so quiet hits shrink rather than vanish — and is what
the built-in visualizations use to size their responses.

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

Grouped here by the categories the library reports through `catalog()` (see
[Metadata](#metadata)).

**Classic** — spectrum, waveform and shape displays that react in place.

| id | what it does |
|----|--------------|
| `eq-bars` | spectrum as log-spaced bars, fast attack / slow decay |
| `waveform` | oscilloscope trace; the trace gains vertical scale with loudness |
| `radial-burst` | hits launch expanding rings from the centre and scatter ticks around the rim; a centre circle breathes |
| `polygon-pulse` | rotating polygon; radius pulses, side count morphs, hits kick the spin |
| `particles` | drifting particles that twinkle; hits shove every particle outward |
| `rolling-ball` | wireframe sphere tumbling in place — loudness sets the roll rate, bass swells it, and snare hits swerve it onto a new heading |
| `text` | a string drifting around the screen and reflecting off the edges; each time `bounce` rises past a threshold it turns onto a new heading with a pop. Takes `text` and `threshold` options |

**Motion** — perspective visuals that put the viewer in motion. Travel
speed is a fixed constant in all three (tune it via the class's `SPEED`
static): audio-driven speed makes the approach visibly stutter, because
loudness swings frame to frame. The sound shapes what you fly past, not how
fast you fly.

| id | what it does |
|----|--------------|
| `road` | rungs spawn at the horizon as frozen waveform traces and fly toward the viewer; each rung keeps the amplitude it was captured at |
| `tunnel` | rings extruded from the waveform at spawn rush past; the tunnel spins, with the spin rate smoothed |
| `starfield` | fly-through with motion streaks; hits swell star size |

**Chaos** — branching and recursive figures steered by the sound. The
attractors (`attractor` through `halvorsen`) are reported as their own
**Attractors** category, so a picker can list them apart:

| id | what it does |
|----|--------------|
| `lightning` | branching bolts that strike and grow outward from the impact point, revealed by an advancing frontier so forks light up in the order the charge reaches them; big hits add a screen flash |
| `attractor` | de Jong strange attractor point cloud; parameters orbit slowly and hits jolt them to a nearby region, morphing the figure. Its `accent` slot blends the cloud from `lineColor` toward `accentColor`: a bass-hit envelope by default, so it flashes on hits, or bind a band for a steady shift, e.g. `bind: { accent: { intensity: 'treble', smooth: 0.3 } }` |
| `clifford` | Clifford Pickover attractor; layered and filamentary, same reactions and `accent` slot as `attractor` |
| `bedhead` | Bedhead attractor; asymmetric swept whorls, same reactions and `accent` slot as `attractor` |
| `thomas` | Thomas cyclically symmetric attractor as a rotating 3D ribbon, viewed from inside the lattice (`distance: 'near'`) so cells sweep past the camera; damping and lattice frequency drift to morph the structure, and hits surge the trajectory forward while whipping the spin and briefly swelling the figure |
| `aizawa` | Aizawa attractor as a rotating ribbon; a shell wound into tight concentric spirals by a fast reversed spin. Same reactions as `thomas`, and the one most worth trying at `distance: 'near'` |
| `rossler` | Rössler attractor as a rotating ribbon; a broad flat disc with one lifted fold, so the silhouette changes markedly as the view turns. Its fold threshold drifts over a wide band, growing and shrinking the whole figure fourfold — it reads as the attractor rushing in and falling away. Same reactions as `thomas` |
| `halvorsen` | Halvorsen attractor as a rotating ribbon; cyclically symmetric like `thomas` but coiled into three tight horns rather than sprawling, and scaled past the frame so the horns run off every edge. Same reactions as `thomas` |
| `thomas-3d`, `aizawa-3d`, `rossler-3d`, `halvorsen-3d` | the four flow attractors above, rendered with three.js: the same motion and options, with line width and brightness following depth so strands swell as they pass the camera and the far side recedes. Each falls back to its 2D version when 3D is off — see [3D rendering](#3d-rendering) |
| `attractor-3d`, `clifford-3d`, `bedhead-3d` | the three point-cloud maps above, rendered with three.js and turning in 3D. The maps are flat, so each point is lifted by the orbit's previous point: face-on it is exactly the 2D figure, and as it turns the sheets the map folds together pull apart. Yaw speed follows the `spin` slot (mid by default), hits whip the spin and swell the figure as well as jolting its parameters, and `accent` deepens the near side's lean toward the accent colour across the whole cloud; the cloud keeps a few frames of history that fade, so morphs dissolve instead of popping. Each falls back to its 2D version when 3D is off |
| `harmonograph` | damped Lissajous figure; hits snap it to a new musical frequency ratio and swell the amplitude, while a signed twist rate winds and unwinds the phase |

**Spaces** — native 3D worlds and volumes, built for the three.js renderer
rather than ported to it: lighting, depth, parallax and particle counts that
Canvas 2D can't reach. All need [3D rendering](#3d-rendering) and fall back
to the 2D visualization named in the last column when it's off. Each takes a
`palette` option: `'style'` (default) cycles between the window's
`lineColor` and `accentColor`, so the scene wears the same colours as
everything else; `'psychedelic'` cycles a full rainbow instead.

`nebula` and `tesseract` look at an object rather than flying through a
space, and take a `distance` option: `near`, `med` and `far` circle it at a
fixed range, and `orbit` (default) flies a true elliptical orbit with the
object at one focus — drifting along the far end with the object small in
frame, accelerating as it falls in, whipping round the object at the closest
point and climbing away out the other side, turning partway toward its
heading so the object sweeps across the frame. The ellipse turns a little
each loop, so passes come in from different directions.

| id | what it does | falls back to |
|----|--------------|---------------|
| `fractal-cathedral` | flight down an endless Menger-sponge fractal, ray-marched per pixel: arches opening onto arches, lit by a headlight and fogged into the background colour. Hits fire rings of light down the nave ahead and kick the deformation; the `warp` input (bass by default — rebind it to tie the walls to another band) sets how deformed the walls are, mid how fast the deformation cycles, treble lights the haze. Options: `speed` (`slow`, `med`, `fast`), `deform` (`twist` wrings each cell, `ripple` makes walls flow like liquid, `breathe` opens and closes the holes at every scale until walls thin to lace), `deformAmount` (`off`, `low`, `med`, `high`). Draws in the background layer, at half resolution by default (`RESOLUTION`) | `perlin-glow` |
| `spectrum-terrain` | low flight along a valley made of the song's history: rows laid at the horizon from the live spectrum scroll toward the camera, treble rippling the floor and bass heaving the canyon walls, over noise ridges. Hits roll waves of light out to the horizon; the sky is left transparent for a background layer to fill | `road` |
| `nebula` | a cloud of 150k motes (option `count`), watched from `distance`; motes swell and soften with nearness, so the close pass of `orbit` skims through blurred structure. Option `shape`: `spiral` (default) and `barred` galaxies (with `arms`, 1–6), `ring` (a core inside a detached ring), `vortex` (a whirlpool spiralling down a funnel into a drain), `quasar` (a thin disc firing two corkscrewing jets from its poles), `shell` (a planetary nebula's hourglass lobes round a hot star). Bands of colour flow outward through it at a rate, and brightness, set by the `color` input — upper mids by default, rebindable to any band. Hits launch shockwave shells from the core that shove and light the motes they pass; mid turns it, treble sparkles | `particles` |
| `helix-corridor` | flight down the axis of intertwined helical strands of lit, tumbling solids. Hits send swells rippling down the corridor that push shapes outward and flash them; mid turns the helix, treble makes the solids glow. Options `shape` (`octahedron`, `cube`, `torus`, `tetrahedron`) and `strands` | `tunnel` |
| `tesseract` | a 4D polytope rotating through all six of its planes, projected into 3D and drawn as lit tubes and glowing beads sized by their depth in w — rotations through w turn it inside out. Hits whip it through w and swell it. Option `shape`: `tesseract`, `24-cell` (default), or `600-cell` (720 edges); and `distance` | `rolling-ball` |

**Glyphs** — structures grown from a small drawing the viewer makes. Each
takes a `glyph` option, a coarse grid of cells at a few strengths; see
[Glyphs](#glyphs) for the format and for building an editor. The 3D ones
take a `palette` option like the Spaces, and fall back to the 2D
`glyph-window` growing from the same drawing.

| id | what it does |
|----|--------------|
| `glyph-mosaic` | a crystal garden grown along the drawing: the drawing is a plan on the ground, and growth starts at the outer end of each stroke and travels along it cell to cell, a crystal sprouting at each one as the front arrives — its root leaning the way the growth came — and branching into smaller solids two to four levels deep. Fully grown, it holds, dissolves in the order it grew, and regrows from where the last growth ended with every crystal mutated, so it is never the same garden twice. Grey cells grow smaller, dimmer crystals; colour flows along the drawing. Hits send a wave of light along the strokes and spur the growth. Option `shape`: `crystal` (default; branching prisms), `coral` (wide budding lumps), `spire` (tall forking diamonds); and `distance`. Draws its best from a drawing of long strokes — the default is a spiral |
| `glyph-fractal` | a fractal grown from the drawing: it is read into elements (option `interpret`, default `contour`), each becomes a map shrinking the whole figure into it — moved, turned and stretched to match — and the maps are played as a chaos game. Copies strung along an outline curl into lacy filaments, a few stretched blobs grow fronds, a rosette grows whorls. Option `evolve` (default `drift`) keeps it alive: it mutates, grows, or morphs between readings rather than holding one shape — see [Evolution](#evolution). Option `form`: `bloom` (default) is a point cloud whose copies tilt out of the plane like petals, mostly-black elements one way and mostly-grey the other; `solid` revolves the elements into three planes and draws the figure as lit, stretched cubes nested two or three levels deep — a crystal. The `fold` input (bass) sets the tilt, `spin` the copies' twist, and hits swell them. Option `distance` as `nebula` |
| `glyph-automaton` | the drawing as the first generation of a cellular automaton, each generation a slice of lit cubes stacked into a tower that sinks as new ones land on top — gliders leave diagonal tubes, oscillators pillars. Bass hits step a generation and light that slice for good, so the tower's sides record where the beats fell; snare hits plant the drawing again; it replants itself when the pattern dies or repeats. Option `rule`: `brain` (default; Brian's Brain), `life`, `star-wars` — black cells start alive and grey ones dying. Option `distance` |
| `glyph-tunnel` | flight down a tunnel built from the drawing: black cells are lit stone, grey ones panes of translucent light, repeated `repeat` times round it with every other copy mirrored. Option `wrap`: `wall` (default) carves it in relief on the wall, rows running down the tunnel; `section` makes every ring the whole drawing bent into an annulus, twisting into a spiral. Hits send swells down it |
| `glyph-city` | flight between two endless cities planned from the drawing — filled cells are towers, black tall and grey low, the plan tiled to the horizon and hung upside down overhead. Each column is a band of the spectrum, so every street rises and falls with its part of the mix. Edges and streets glow; hits roll light down the streets. Option `twist` (`off`, `low`, `med`, `high`) corkscrews the two cities round each other ahead; `speed`. Ray-marched in the background layer at half resolution |
| `glyph-flow` | a stream of light parting round the drawing as an obstacle, so it shows as a hole outlined in fire; streaks that skim it carry the accent colour downstream, tracing it in their wakes, and each cell swirls the stream (black one way, grey the other). Hits inflate the obstacle so the stream bursts outward. Options `distance` (`near`, `med`, `far`) and `count` |
| `glyph-window` | a rose window grown from the drawing: it is read into a handful of elements (option `interpret`, default `rosette`; see [Glyphs](#glyphs)), each holding a translucent petal with the whole arrangement nested inside it again, two to five levels deep. Petals add up like stained glass and turn on their own phases, compounding down the levels so the window swirls; option `evolve` (default `drift`) keeps the structure itself changing. Hits swell and flash them. 2D, and what the others draw when 3D is off |

**Backgrounds** — full-screen fields that draw in the background layer (see
[Layers](#layers)), so they sit behind anything else in the window whatever
order they came on in. Pair one with a figure from above.

| id | what it does |
|----|--------------|
| `perlin-glow` | domain-warped noise shaded from the background colour up through a dimmed line colour to accent on its brightest ridges; brightens with the passage. Option `react` picks what a hit does, none of which move the field: `'grow'` (default) spreads the bright zones outward in place, `'layers'` fades up a second, finer field in the accent colour, `'curl'` deepens the warp so shapes twist. Options `scale`, `seed` |
| `infinity-mirror` | a rim whose inside reflects the previous frame shrunk and turned, so the rim and everything on screen recede into a twisting tunnel. The reflection opens up with `reveal`, the twist per reflection follows `turn`, and `flip` hits reverse it. Option `shape: 'rect' \| 'circle'` |
| `kaleidoscope` | a turning wedge of the previous frame mirrored around the centre into a rosette behind the foreground; hits step the wedge count. Option `segments` |
| `text-ghosts` | hits stamp the text somewhere on screen; each fades into a ghost, and ghosts drift on a noise flow field, showing in slow patches. Options `text`, `count`, `seed` (share a seed with `perlin-glow` to drift in the same currents) |
| `dot-grid` | halftone grid of dots sized by a drifting noise field (`mode: 'noise'`) or a radial spectrum (`mode: 'spectrum'`); hits ripple an accent ring outward. Option `spacing` |
| `moire` | two fine ring (`pattern: 'rings'`) or line (`pattern: 'lines'`) patterns slightly out of register, so small audio-driven shifts sweep large interference bands |
| `light-leaks` | drifting bokeh discs and glows bleeding in from off-screen edges, added with `lighter`; hits bloom a few discs and flare the leaks |

**Overlays** — screen treatments in the overlay layer, drawn over everything.

| id | what it does |
|----|--------------|
| `scanlines` | CRT scanlines crawling down, a vignette, and red/cyan channel split that opens on hits; snare hits send a roll bar down the screen and tear the channels wider. Option `strength` |

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
'mid'                                   // a band, by name (absolute)
'rms'                                   // overall loudness (absolute)
{ relative: 'bass' }                    // a band or 'rms' against its recent dynamics
{ intensity: 'bass' }                   // a band or 'rms', slow absolute loudness
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
one. A trigger envelope rises to the hit's `impact`, so it carries loudness
as well as timing.

Pulse-like slots default to `relative` and "how hard is it going" slots to
`intensity`, so each visualization shows every hit while its overall scale
tracks the song. `{ sum: [{ intensity: 'treble', gain: 0.75 }, { relative:
'treble', gain: 0.25 }] }` is a useful middle ground: mostly loudness, with
enough movement on top to glint on the beat.

Binding a slot to a trigger that isn't configured logs a warning rather than
failing silently. Two windows naming the same visualization with different
bindings produce two independent instances, so both can be on screen at once;
crossing between them cross-fades rather than rewiring in place, which means
accumulated state restarts.

### Slots by visualization

`slot` ← its default source. *rel* is `{ relative: … }`, *int* is `{ intensity: … }`, and *mix* is 0.75
intensity plus 0.25 relative.

| id | event slots | level slots |
|----|-------------|-------------|
| `eq-bars` | — | — |
| `waveform` | — | `amplitude` ← rms |
| `radial-burst` | `ring` ← bass, `scatter` ← hihat | `core` ← rel bass |
| `polygon-pulse` | `kick` ← snare, `punch` ← bass | `sides` ← int mid, `swell` ← rel bass, `energy` ← int rms |
| `particles` | `shove` ← bass | `twinkle` ← mix treble |
| `rolling-ball` | `swerve` ← snare | `speed` ← int rms, `swell` ← rel bass |
| `text` | — | `bounce` ← rel bass, `speed` ← int rms |
| `road` | — | `swell` ← 0.6 int rms + 0.4 rel rms |
| `tunnel` | — | `spin` ← int treble |
| `starfield` | `swell` ← bass | — |
| `lightning` | `strike` ← bass, `offshoot` ← snare, `flicker` ← hihat | `wander` ← int mid, `fork` ← int highMid |
| `attractor`, `clifford`, `bedhead` | `jolt` ← bass | `drift` ← int mid, `glow` ← mix treble (smoothed) |
| `thomas` & other flows | `jolt` ← bass | `drift` ← int mid, `glow` ← mix treble (smoothed), `travel` ← int mid, `spin` ← int mid |
| `harmonograph` | `snap` ← snare, `swell` ← bass | `twist` ← mid (compared to its own average), `size` ← rel bass (smoothed) |
| `glyph-mosaic` | `pulse` ← bass | `grow` ← int mid (smoothed), `sway` ← int highMid, `glow` ← mix treble |
| `glyph-window` | `pulse` ← bass | `spin` ← int mid, `mutate` ← int mid (smoothed), `glow` ← mix treble |
| `glyph-fractal` | `jolt` ← bass | `fold` ← 0.5 int bass + 0.5 rel bass, `spin` ← int mid, `mutate` ← int mid (smoothed), `glow` ← mix treble |
| `glyph-automaton` | `step` ← bass, `stamp` ← snare | `rate` ← int mid, `glow` ← mix treble |
| `glyph-tunnel` | `ripple` ← bass | `spin` ← int mid, `glow` ← mix treble |
| `glyph-city` | `pulse` ← bass | `twist` ← int mid, `shimmer` ← mix treble, `travel` ← int rms (smoothed 2 s) |
| `glyph-flow` | `surge` ← bass | `flow` ← int rms (smoothed), `swirl` ← int mid, `glow` ← mix treble |
| `perlin-glow` | `flare` ← bass | `glow` ← int rms, `flow` ← mid |
| `infinity-mirror` | `flip` ← snare | `reveal` ← rel bass (fast rise, slow fall), `turn` ← mid |
| `kaleidoscope` | `shift` ← snare | `reveal` ← int rms, `spin` ← mid |
| `text-ghosts` | `stamp` ← bass | `haze` ← int rms, `drift` ← mid |
| `dot-grid` | `ripple` ← bass | `swell` ← int rms, `flow` ← mid |
| `moire` | `kick` ← bass | `shift` ← int bass, `turn` ← mid |
| `light-leaks` | `bloom` ← bass | `warmth` ← int rms, `drift` ← mid |
| `scanlines` | `roll` ← snare | `split` ← rel bass |

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

A visualization declares the options it reads in `static options`, so editors
can offer them. Each is an object with a `kind` and a `default`: `'enum'`
(with `values`), `'string'` (optional `maxLength`), `'number'` (optional
`min`, `max`, `step`) or `'grid'` (a drawing; `width`, `height` and `levels`
— see [Glyphs](#glyphs)). A bare array is shorthand for an enum with no
declared default:

```js
static options = {
  distance:  { kind: 'enum', values: ['near', 'med', 'far'], default: 'med' },
  text:      { kind: 'string', default: 'GLOAMING', maxLength: 32 },
  threshold: { kind: 'number', default: 0.6, min: 0, max: 1, step: 0.01 },
};
```

### Bouncing text

`text` takes `text` (the string, default `'GLOAMING'`) and `threshold` (default
0.6). Which frequency turns it is just the `bounce` binding, so any band or
signal works:

```js
{ id: VIZ.TEXT, options: { text: 'hello', threshold: 0.5 }, bind: { bounce: { relative: 'treble' } } }
```

The default binding is `{ relative: 'bass' }`, which swings from near 0
between hits to near 1 on them whatever the loudness, so 0.6 works for any
`relative` binding. After a turn, the level has to dip 0.12 below the peak it
reached since before it can fire again, and turns are at least 0.3 s apart.
That dip is what keeps an absolute binding like `bounce: 'bass'` working too:
absolute band levels on a full mix rarely fall far between hits (bass on the
demo track sits at 0.78–0.95), and mid and treble run lower, around 0.3
median, so absolute bindings need a threshold tuned to the band and song.

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

## Glyphs

The Glyphs visualizations build their structure from a drawing: a coarse grid
of cells, each empty or filled at one of a few strengths. The idea is that a
client gives the viewer a small canvas to click on — once for grey, again for
black — and passes the result in as an option:

```js
{ id: VIZ.GLYPH_FRACTAL, options: { glyph: [
  '2..1..2',
  '.2.1.2.',
  '..222..',
  '1122211',
  '..222..',
  '.2.1.2.',
  '2..1..2',
] } }
```

One string per row, top row first, one character per cell: a digit is that
strength, `.` or a space is empty, and any other character (`#`, `x`…) is
full strength, so ASCII art works too. Rows may also be arrays of numbers,
for a client that keeps a matrix. It is plain JSON like any other option, so
a drawing saved with a timeline comes back with it.

`describe()` reports the option as `kind: 'grid'`, with the canvas an editor
should offer:

```js
{ name: 'glyph', kind: 'grid', width: 7, height: 7, levels: 2, default: [ /* rows */ ] }
```

`levels` is the number of strengths above empty (2: grey and black). The size
is a suggestion — each visualization fits whatever drawing it is given, up
to 32 cells a side — and an empty or unreadable drawing falls back to the
visualization's own default, so there is always something on screen.

The demo's timeline editor shows a grid editor under any checked
visualization with a `grid` option: click to step a cell's strength, drag to
paint, shift- or right-click to erase, with left–right and top–bottom
mirroring (any scribble mirrored both ways looks intentional). It hands the
drawing over on release rather than per cell, since a changed option is a new
instance and crossfades in. The library exports `Glyph` for clients that want
to read or normalize drawings the same way the visualizations do:

```js
const g = Glyph.parse(rows, levels);   // null if it isn't a grid
g.width; g.height; g.get(x, y);         // strength 0–levels, 0 outside
g.filled();                             // [{ x, y, level, weight }, …]
g.toRows();                             // back to strings
```

### Interpretations

A drawing is an abstract input, not a picture to reproduce, so `glyph-window`
and `glyph-fractal` don't copy cells onto the screen. They first *read* the
drawing into a handful of elements — oriented, stretched blobs, each with a
position, angle, two sizes, a weight (how much was drawn black) and a hue —
and build from those. Option `interpret` picks the reading, independently of
what the visualization then builds, so all three pair with either one:

| `interpret` | how the drawing is read |
|-------------|-------------------------|
| `contour` | blurred into a smooth shape, with elements strung evenly along its outline, each turned to follow it. Blocky cells become flowing curves: a ring becomes a loop, a line a long hairpin |
| `clusters` | touching cells merge into blobs, large regions split into a few, and each blob becomes one element at its centre of mass, sized by its mass and stretched along its own grain. Few, uneven, organic pieces |
| `rosette` | wrapped round a circle — columns go round, rows run from the rim (top) to the hub (bottom) — with every unbroken run down a column becoming one petal pointing outward. Any drawing becomes a radial flower |

Every reading is normalized the same way — centred, fitted to the figure,
and sized so the elements' areas add up to most of it with none too large —
so placing a copy of the whole figure in each one is always a contraction,
as a fractal needs. The readings are in
[src/visualizations/glyph-interpret.js](src/visualizations/glyph-interpret.js)
as `interpret(glyph, name)`, for any visualization to use.

### Evolution

A reading is a snapshot; option `evolve` keeps it alive, so the structure
itself changes over time rather than only turning and swelling. It works on
the elements, so it pairs with any reading and with either visualization:

| `evolve` | what happens |
|----------|--------------|
| `drift` | every element wanders on its own slow noise path — moving, turning, stretching and swelling a little — so the figure mutates continuously and never repeats. Hits jolt a few elements at random: a mutation on the beat that heals slowly |
| `grow` | the figure assembles itself element by element along the reading, each one sprouting out of the one before. Once most are grown the oldest start withering as new ones sprout, so a growth front travels round it forever, and every regrowth is a mutation (a new turn and stretch). Hits sprout the next element at once |
| `morph` | the figure flows between the three readings in turn — contour, clusters, rosette — holding each a while, elements sliding, turning and resizing into their new places, extras sprouting from or shrinking into their neighbours. Hits hurry the next change along |
| `still` | the reading as it is |

The `mutate` input sets how fast (mid by default). A changing figure wanders
off the origin, so both visualizations follow its centre. Evolution is in
[src/visualizations/glyph-evolve.js](src/visualizations/glyph-evolve.js), as
an `Evolver` any visualization built on elements can use.

To write one, declare the option with `glyphOption()` and read it with
`readGlyph(this)`, both in
[src/visualizations/glyph.js](src/visualizations/glyph.js); that file also
holds every built-in default drawing.

## Layers

The engine draws active visualizations back to front by layer — `background`,
`main`, `overlay` — and, within a layer, in the order they came on screen. A
visualization names its layer with `static layer = LAYER.BACKGROUND`; without
one it draws in `main`. So a background window that starts partway through a
figure's window still lands behind it, and `scanlines` covers both.

Layer is separate from category: category groups a picker, layer decides what
covers what. `describe()` reports both.

A background's darkest colour should be the style's `background`, so it
replaces the engine's flat fill without a seam as it fades in.

## Metadata

Every visualization carries descriptive metadata alongside its routing and
options, so a client can build a picker or an editor without hard-coding
anything about the library's contents:

```js
static label       = 'Radial Burst';
static description = 'Hits launch expanding rings and scatter ticks around a breathing core.';
static category    = CATEGORY.CLASSIC;
static layer       = LAYER.MAIN;          // draw order; see Layers
```

All three are optional. Without a `label` one is derived from the id
(`'my-strobe'` → `'My Strobe'`); without a `category` it files under `other`.

Two functions read it back as plain, JSON-safe copies:

```js
describe('thomas');
// {
//   id: 'thomas', label: 'Thomas', category: 'attractors', layer: 'main',
//   renderer: '2d', fallback: null,   // a 3D one: renderer: '3d', fallback: 'thomas'
//   description: 'Thomas attractor as a rotating 3D ribbon, …',
//   inputs:  [{ name: 'jolt', kind: 'event', default: 'bass' }, …],
//   options: [{ name: 'distance', kind: 'enum', values: ['near', 'med', 'far'], default: 'near' }],
// }

catalog();
// [{ id: 'classic', label: 'Classic', description: '…', visualizations: [ /* describe() of each */ ] },
//  { id: 'motion', … }, { id: 'chaos', … }, { id: 'attractors', … }]
```

`catalog()` lists categories in `CATEGORIES` order and visualizations in
registration order, skipping empty categories. It includes anything added via
`register()`; a custom category id that isn't in `CATEGORIES` gets a group of
its own (labelled from the id) after the built-in ones, with `other` always
last. `CATEGORY` holds the ids as constants, like `VIZ`. The demo's timeline
editor is built entirely from `catalog()`.

Enum defaults are reported per class, so `describe()` gives `thomas` a default
`distance` of `near` and the other flow attractors `med` — the value each will
actually use when the option is left out.

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

## 3D rendering

Some visualizations render with three.js (`renderer: '3d'` in `describe()`).
The library doesn't bundle three.js; to turn 3D on, pass the app's own copy:

```js
import * as THREE from 'three';   // any build ≥ r163

const viz = new GloamingKit({ canvas, three: THREE, timeline: [
  { from: 0, to: 30, visualizations: [VIZ.THOMAS_3D, VIZ.PERLIN_GLOW] },
] });
```

3D visualizations mix freely with 2D ones. The engine is still a Canvas 2D
compositor: a 3D visualization renders its scene on one WebGL renderer shared
by all of them ([src/three-stage.js](src/three-stage.js)), then draws the
result onto the 2D canvas as an image. So fades, [layers](#layers), window
styles and routing all work on it unchanged, and feedback backgrounds like
`kaleidoscope` echo 3D figures along with everything else. The cost is one
extra full-frame image copy per 3D visualization on screen.

**Turning it off.** Each 3D visualization names a 2D `fallback`, which is drawn
in its place when:

- no `three` was passed,
- `enable3D: false` was passed, or
- WebGL isn't available (the engine warns once and carries on in 2D).

`viz.set3D(false)` switches at runtime — say, from a quality setting or when
frames run slow. Anything on screen is swapped in place for its fallback,
keeping its fade (its animation restarts, since the two share no state), and
the WebGL context is released. `viz.set3D(true)` swaps back; `viz.is3D` says
which is in effect. A 3D visualization with no fallback is skipped while 3D
is off.

**Lowering the cost instead.** `resolution3D: 0.5` (or
`viz.setResolution3D(0.5)` at runtime) renders every 3D visualization at half
resolution and upscales it — roughly a quarter of the pixel work, for a softer
image, and nothing is re-created. It multiplies with each class's own
`RESOLUTION`, which `fractal-cathedral` already sets to 0.5 because it is
computed per pixel.

### Writing a 3D visualization

Extend `ThreeVisualization` and draw with `present()`:

```js
import { ThreeVisualization, register } from './src/engine.js';

class Cube extends ThreeVisualization {
  static id = 'cube';
  static fallback = 'polygon-pulse';   // class or id; drawn when 3D is off
  static inputs = { spin: { kind: 'level', default: { intensity: 'bass' } } };

  constructor(opts) {
    super(opts);
    const { THREE } = this;             // the app's three.js
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshNormalMaterial());
    this.scene.add(this.mesh);          // released automatically on dispose()
    this.camera.position.z = 3;
  }

  draw(ctx, dt) {
    this.mesh.rotation.y += dt * (0.5 + this.in('spin'));
    this.present(ctx);                  // render, and draw the result onto ctx
  }
}
register(Cube);
```

`present(ctx, { glow })` can add the 2D-style glow (a `shadowBlur` in
`style.shadowColor`) to the copy; it blurs the whole image, so render only what
should glow in that pass. `color(css)` turns a style colour into a
`THREE.Color` for shaders and materials. Anything else the visualization
allocates on the GPU should be released in `dispose()`.

[src/visualizations/three-shared.js](src/visualizations/three-shared.js) has
the pieces the Spaces visualizations share: the `palette` option with matching
GLSL and JS versions of the palette, `instanceGlow()` to make a lit instanced
material glow in each instance's own colour, `fogToAlpha()` so fog fades
distant geometry to transparent instead of painting a wall of fog colour over
the layers beneath, and `logSpectrum()`.

To give an existing 2D visualization a 3D renderer while keeping its
simulation, apply `withThree` to it instead of extending `ThreeVisualization`
— that's how the 3D attractors are built: `flowRibbon(Base)` in
[src/visualizations/flow-ribbon.js](src/visualizations/flow-ribbon.js) takes any
`FlowAttractor` subclass and replaces only its `draw()`, so a new flow
attractor gets a 3D version with one line:

```js
class Lorenz3D extends flowRibbon(Lorenz) { static id = 'lorenz-3d'; }
```

Point-cloud maps work the same way through `pointCloud3D(Base)` in
[src/visualizations/point-cloud-3d.js](src/visualizations/point-cloud-3d.js);
override its `depth(px, py, x, y)` to lift a map by something other than the
previous point's y.

## Writing a visualization

```js
import { Visualization, TRIGGER, register } from './src/engine.js';

class Strobe extends Visualization {
  static id = 'strobe';
  static description = 'Full-screen flash on every snare.';   // optional metadata
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
`resize(width, height)`. If the visualization holds anything the garbage
collector can't reclaim, release it in `dispose()`, which the engine calls
once the window has ended and faded out.

`static triggers = [...]` with `onTrigger(name, data)` still works for
visualizations that don't declare slots, but it can't be rerouted.

`afterFrame(ctx)` is called once every layer has drawn, with the finished
frame on the canvas — for effects that feed a frame into the next one.
`FeedbackVisualization` ([src/visualizations/feedback-base.js](src/visualizations/feedback-base.js))
captures it for you as `this.previous`; `infinity-mirror` and `kaleidoscope`
build on it. An overlay can read the current frame straight off
`ctx.canvas` in `draw`, since everything beneath it has already drawn.

For smooth organic fields, [src/noise.js](src/noise.js) has seeded 3D Perlin
noise (`createNoise3D(seed)`, about ±1) and `fbm()` for layered octaves;
the third coordinate is usually time. `rgba(color, alpha)` in
[src/style.js](src/style.js) turns a style colour into a translucent one.

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
