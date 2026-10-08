# GloamingKit

A small framework for building music visualizations with Canvas 2D and the
WebAudio API. A song plays in the browser, an analyzer emits per-frame band
energies and adaptive trigger events (drum hits by band, transients, loud
and quiet passages), and a timeline decides which visualizations are on screen for each time window of
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
  Configured triggers fire `trigger:<name>` events when what they measure —
  a band, spectral flux, overall loudness — jumps out of its recent dynamics
  (or, for a lull, drops away), with a cooldown, a relative 0–1 `strength`
  and an absolute 0–1 `intensity`. See [Triggers](#triggers).
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
    peakColor: '#ffffff',  // optional third colour, shown only at extremes
    peakAbove: 0.8,        // how extreme: the hit impact where it starts to show
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
  // optional — defaults to DEFAULT_TRIGGERS (see Triggers below):
  triggers: [
    { name: TRIGGER.BASS,  band: [40, 130],     threshold: 0.6, cooldown: 0.15 },
    { name: TRIGGER.SNARE, band: [1500, 4000],  threshold: 0.7, cooldown: 0.15 },
    { name: TRIGGER.ONSET, kind: 'onset', threshold: 0.6, cooldown: 0.1 },
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

## Triggers

Nine triggers ship in `DEFAULT_TRIGGERS`, all named in `TRIGGER`:

| name | kind | listens to | fires on |
|------|------|------------|----------|
| `sub` | band | 20–60 Hz | sub-bass drops, 808 tails |
| `bass` | band | 40–130 Hz | kick drums |
| `tom` | band | 150–400 Hz | toms, low-mid stabs |
| `snare` | band | 1.5–4 kHz | snares |
| `clap` | band | 4–8 kHz | claps, rimshots, the snare's crack |
| `hihat` | band | 8–14 kHz | hats, shakers |
| `onset` | onset | the whole spectrum | any transient, wherever it lands |
| `loud` | rms | overall loudness | a jump in the whole mix, only once it's already loud (`minIntensity: 0.6`) |
| `lull` | lull | overall loudness | once, when the song drops into a quiet passage |

A trigger is a plain object; every field but `name` is optional:

```js
{
  name: 'riser',
  kind: 'band',          // 'band' | 'onset' | 'rms' | 'lull'
  band: [4000, 12000],   // Hz; needed for 'band', optional for 'onset' and 'lull'
  threshold: 0.6,        // 0–1, relative (see Dynamics)
  cooldown: 0.15,        // seconds between hits
  hold: 0.5,             // seconds it must stay over threshold before firing
  minIntensity: 0.5,     // 0–1; only fire once the source is at least this loud
  rearm: 0.5,            // fall back under threshold × rearm before firing again
}
```

The kinds measure different things and share everything else:

- **`band`** — energy in `band`. The default, and the drum triggers above.
- **`onset`** — spectral flux over `band` (the whole spectrum if left out):
  how much the spectrum *rose* since the last frame, counting only bins that
  got louder. A transient lifts many bins at once and a sustained tone lifts
  none, so it fires on hits however they are voiced and never on a held
  pad, however loud. Its `intensity` is the band's ordinary loudness.
- **`rms`** — overall loudness from the time-domain signal: a hit in the
  mix as a whole.
- **`lull`** — the inverse: fires once when the source's slow `intensity`
  (its band, or overall loudness without one) falls under `threshold`
  after having been above it, then waits for the song to come back up
  before it can fire again. Its `strength` is the size of the drop from the
  loudest point before it, so a breakdown out of a loud chorus hits harder
  than a fade. Intensity is smoothed, so it lands a few seconds into the
  quiet.

`hold` turns a hit detector into a sustain detector — a swell, a riser, a
chord that stays — and `minIntensity` keeps a trigger to the loud parts of a
song without changing what counts as a hit within them. Each hit reports its
`kind` alongside `strength` and `intensity`.

Any of these can drive any event slot, and through an envelope any level
slot, so `bind: { ring: 'onset', scatter: 'clap' }` or
`{ trigger: 'lull', decay: 0.3 }` are as valid as the drum names.
`setTriggers()` replaces the set at runtime.

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
speed is constant in all three (set it with the `speed` option): audio-driven
speed makes the approach visibly stutter, because loudness swings frame to
frame. The sound shapes what you fly past, not how fast you fly.

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
| `fractal-cathedral` | flight down an endless Menger-sponge fractal, ray-marched per pixel: arches opening onto arches, lit by a headlight and fogged into the background colour. Hits fire rings of light down the nave ahead and kick the deformation; the `warp` input (bass by default — rebind it to tie the walls to another band) sets how deformed the walls are, mid how fast the deformation cycles, treble lights the haze. Options: `speed` (0.1–1.5; the old names `slow`, `med`, `fast` still work), `deform` (`twist` wrings each cell, `ripple` makes walls flow like liquid, `breathe` opens and closes the holes at every scale until walls thin to lace), `deformAmount` (0–2.5; or `off`, `low`, `med`, `high`). Draws in the background layer, at half resolution by default (`RESOLUTION`) | `perlin-glow` |
| `spectrum-terrain` | low flight along a valley made of the song's history: rows laid at the horizon from the live spectrum scroll toward the camera, treble rippling the floor and bass heaving the canyon walls, over noise ridges. Hits roll waves of light out to the horizon; the sky is left transparent for a background layer to fill | `road` |
| `nebula` | a cloud of 150k motes (option `count`), watched from `distance`; motes swell and soften with nearness, so the close pass of `orbit` skims through blurred structure. Option `shape`: `spiral` (default) and `barred` galaxies (with `arms`, 1–6), `ring` (a core inside a detached ring), `vortex` (a whirlpool spiralling down a funnel into a drain), `quasar` (a thin disc firing two corkscrewing jets from its poles), `shell` (a planetary nebula's hourglass lobes round a hot star). Bands of colour flow outward through it at a rate, and brightness, set by the `color` input — upper mids by default, rebindable to any band. Hits launch shockwave shells from the core that shove and light the motes they pass; mid turns it, treble sparkles | `particles` |
| `helix-corridor` | flight down the axis of intertwined helical strands of lit, tumbling solids. Hits send swells rippling down the corridor that push shapes outward and flash them; mid turns the helix, treble makes the solids glow. Options `shape` (`octahedron`, `cube`, `torus`, `tetrahedron`) and `strands` | `tunnel` |
| `tesseract` | a 4D polytope rotating through all six of its planes, projected into 3D and drawn as lit tubes and glowing beads sized by their depth in w — rotations through w turn it inside out. Hits whip it through w and swell it. Option `shape`: `tesseract`, `24-cell` (default), or `600-cell` (720 edges); and `distance` | `rolling-ball` |

**Glyphs** — textures, tessellations and growth built from a small drawing
the viewer makes. Each takes a `glyph` option, a coarse grid of cells at a
few strengths; see [Glyphs](#glyphs) for the format and for building an
editor. The drawing is never put on screen: each one reads it as something
else — a field, a crystal's habit, a branching rule, a map of chemistry, a
spectrum of waves — and fills the screen with what that structure makes of
it, so there is never one copy of the drawing to find and never a grid.
`glyph-crystal`, `glyph-reaction` and `glyph-cymatics` fill the screen and
draw in the background layer; the other two are transparent and draw in
main. `glyph-dendrite` is a native 3D scene, so it needs three.js and is
drawn as `glyph-crystal` when 3D is off.

| id | what it does |
|----|--------------|
| `glyph-current` | the drawing as a stream function: tiled and blurred into a smooth field, its filled cells are hills, and a current runs along their contours — circling every drawn shape, fast on the steep rims and slow in the flats between. Thousands of motes ride it, leaving fading trails, and what builds up is a grain of eddies whose whorls are the drawing's shapes, repeated and mirrored across the screen under a slow turn, so no two line up. Hits quicken and brighten the current; `flow` sets its pace, `turn` how fast the field turns beneath it. Options `count` (motes), `scale` (size of one copy of the drawing), `seed` |
| `glyph-crystal` | the drawing as a crystal habit: its silhouette, seen from its centre, is how fast a crystal grows in each direction, so a cross grows as a four-pointed star, a ring as a disc, a diagonal stroke as a long lozenge. Seeds land across the screen and grow at that shape, each at its own turn, and where two fronts meet they stop — the screen tessellates into cells whose every edge is where two of the drawing's shapes collided. A pixel keeps whichever front reached it first, in the colour of that moment, so each crystal carries rings: a bright nucleus fading outward, hue turning as it grows, and a bright band for every hit that landed while it grew. When the screen is full a new generation seeds on top and grows over the old, which sinks into dusk. Options `size` (`small`, `med`, `large`: how many seeds a generation gets), `grain` (`rings`, `flat`), `edges` (`smooth`, `faceted`) |
| `glyph-dendrite` | the drawing as a branching rule, grown in 3D: each row is one generation of growth — a filled cell is a child branch, its column the angle it leaves the stem at (left of centre to one side, right to the other), its strength how long and thick it grows; a centre cell carries the trunk on, a row with no centre forks it, an empty row grows straight. Each generation's children leave in a plane turned the golden angle round the stem from the last, so a flat drawing grows as a spiralling 3D plant; tips follow the rows in turn, over and over, finer each cycle, wandering through noise and stopping dead when they meet anything already grown, so the branches pack into a coral without crossing. Drawn as glowing filaments, wider and brighter nearer the camera and dimmed toward the back, while the camera circles it or swoops through it. The sound runs along the branches: distance from the root is frequency, so the spectrum lights the coral from the trunks (bass) out to the twigs (treble); hits fire a pulse of light out along every branch that shoves them outward as it passes, make tips branch at once, land a seed and lurch the coral round; `sway` streams the outer branches in a current. When growth stops it stands a few seconds, then burns back from its twigs and blows apart while a new one grows. 3D: falls back to `glyph-crystal`. Options `spread` (`narrow`, `wide`), `from` (`centre`: a coral radiating from a core; `ground`: a thicket growing up from a floor; `scatter`), `seed`, `palette`, `distance` |
| `glyph-reaction` | the drawing as a map of chemistry: two substances react and diffuse across the screen (Gray–Scott reaction–diffusion), and the texture that grows — spots, worms, coral, a maze — depends on two rates. The drawing, tiled and softened, sets them: one texture grows where it is empty, another where it is black, and grey is the country between where the two fight, so the drawing shows only as the weather of the texture, several copies across the screen, turning slowly. Hits drop new seeds of growth; `flow` is how fast the chemistry runs. Options `regime` (`coral`, `maze`, `worms`, `spots`: which pair of textures), `scale` |
| `glyph-cymatics` | the drawing as a spectrum: each filled cell is a plane wave — its offset from the centre the wave's direction and frequency, its strength the amplitude — and the screen shows their sum as a plate dusted with sand would, bright along the nodal lines where the waves cancel. Cells on a square make a square lattice of ripples, cells on a hexagon a honeycomb, a single cell plain stripes; every drawing tessellates the whole screen and none looks like the dots that made it. The waves drift in phase at their own rates so the pattern crawls, `detail` (treble) lifts the finer waves, `turn` turns the spectrum, and hits lurch every phase at once. Options `render` (`nodes`, `relief`, `terraces`), `scale` (wavelength of the drawing's unit frequency) |

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
| `glyph-current` | `surge` ← bass | `flow` ← int rms, `turn` ← int mid, `glow` ← mix treble |
| `glyph-crystal` | `seed` ← bass | `grow` ← int mid, `glow` ← mix treble |
| `glyph-dendrite` | `sprout` ← bass | `grow` ← int mid, `glow` ← mix treble, `sway` ← int rms (and the whole spectrum, root to tip) |
| `glyph-reaction` | `bloom` ← bass | `flow` ← int mid, `glow` ← int rms |
| `glyph-cymatics` | `pulse` ← bass | `glow` ← int rms, `turn` ← int mid, `detail` ← mix treble |
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

Structural settings — counts, sizes, speeds, densities, spacing — are
options rather than constants wherever changing them makes a different
picture, so an editor can offer them as sliders (see
[Options by visualization](#options-by-visualization)). A changed option is
a new instance that crossfades in, so they are read once, at construction.

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

Read one with `this.option(name)`. It checks the value against its
declaration and falls back to the default: numbers are clamped to
`min`–`max` and rounded to an integer `step`, enums must be one of `values`,
strings are cut to `maxLength`, and anything unreadable gives the default.

### Options by visualization

Numbers show their default and slider range. The 3D attractors take their 2D
parent's options, and a 3D visualization drawn as its 2D fallback passes its
options on, so names they share carry over.

| id | options |
|----|---------|
| `eq-bars` | `bars` 28 (8–96), `gap` 4 (0–12) |
| `waveform` | `gain` 1 (0.25–3) |
| `radial-burst` | `speed` 1 (0.25–3), `ticks` 6 (0–30), `fade` 1.4 (0.3–5) |
| `polygon-pulse` | `minSides` 3 (3–12), `sideRange` 6 (0–12), `size` 0.22 (0.05–0.45), `echo` 0.62 (0–0.95) |
| `particles` | `count` 110 (20–600), `size` 1 (0.3–4), `trail` 0.07 (0–0.3) |
| `road` | `speed` 9 (1–30), `spacing` 1.2 (0.3–4), `segments` 64 (16–256), `horizon` 0.42 (0.2–0.7) |
| `tunnel` | `speed` 0.75 (0.1–3), `spacing` 0.34 (0.1–1), `segments` 48 (8–128) |
| `rolling-ball` | `latitudes` 7 (1–20), `meridians` 12 (2–32), `radius` 0.3 (0.1–0.6) |
| `starfield` | `count` 240 (50–1500), `speed` 0.5 (0.1–3) |
| `lightning` | `bolts` 6 (1–12), `roughness` 0.55 (0.3–0.8), `forking` 0.1 (0–0.4) |
| `harmonograph` | `damping` 0.12 (0–0.5), `loops` 5 (2–12) |
| `text` | `text`, `threshold` 0.6 (0–1), `size` 0.12 (0.03–0.4) |
| `attractor`, `clifford`, `bedhead` (and `-3d`) | `rotation`, `speed` 1 (0–3), `points` 3200 (500–20000), `scale` 1 (0.4–2.5), `dot` 1.4 (0.5–4) |
| `thomas`, `aizawa`, `rossler`, `halvorsen` (and `-3d`) | `distance`, `trail` 1400 (200–6000), `substeps` 32 (4–96), `scale` 1 (0.4–2.5) |
| `fractal-cathedral` | `palette`, `speed` 0.55 (0.1–1.5), `deform`, `deformAmount` 1 (0–2.5) |
| `spectrum-terrain` | `palette`, `speed` 11 (2–30), `height` 7.5 (1–20), `mountains` 7 (0–20) |
| `nebula` | `palette`, `distance`, `shape`, `arms` 3 (1–6), `count` 150000 (10000–400000), `size` 1 (0.3–3), `swirl` 1 (0–3) |
| `helix-corridor` | `palette`, `shape`, `strands` 4 (1–8), `density` 150 (30–400), `radius` 2.4 (0.8–6), `twist` 0.32 (0–1.5), `size` 0.24 (0.05–0.8), `speed` 9 (1–30) |
| `tesseract` | `palette`, `shape`, `distance`, `wDistance` 2.2 (1.3–5), `tube` 0.028 (0.005–0.08), `bead` 0.065 (0.01–0.15) |
| `glyph-current` | `glyph`, `count` 2200 (200–6000), `scale` 1 (0.4–3), `seed`, `trail` 1.6 (0.2–6) |
| `glyph-crystal` | `glyph`, `size`, `grain`, `edges`, `nucleus` 0.12 (0.03–0.4), `hueRate` 0.9 (0–3) |
| `glyph-dendrite` | `glyph`, `spread`, `from`, `seed`, `width` 1 (0.3–3), `wander` 1 (0–3), `palette`, `distance` |
| `glyph-reaction` | `glyph`, `regime`, `scale` 1 (0.4–3), `seeds` 10 (1–40) |
| `glyph-cymatics` | `glyph`, `render`, `scale` 1 (0.3–3), `nodeWidth` 0.16 (0.05–0.5), `terraces` 5 (2–12) |
| `perlin-glow` | `react`, `scale` 1 (0.25–4), `seed`, `octaves` 3 (1–5), `warp` 0.9 (0–3) |
| `infinity-mirror` | `shape`, `shrink` 0.9 (0.7–0.98), `margin` 0.06 (0–0.3) |
| `kaleidoscope` | `segments`, `zoom` 0.94 (0.8–1.05) |
| `text-ghosts` | `text`, `count` 24 (0–80), `seed`, `size` 0.09 (0.03–0.3), `field` 2.2 (0.5–6) |
| `dot-grid` | `mode`, `spacing` 26 (10–80), `field` 3 (0.5–10), `maxSize` 0.42 (0.1–0.5), `seed` |
| `moire` | `pattern`, `spacing` 9 (4–30), `alpha` 0.28 (0.05–1) |
| `light-leaks` | `discs` 14 (0–60), `leaks` 2 (0–6), `seed` |
| `scanlines` | `strength` 0.5 (0–1), `pitch` 3 (2–10), `vignette` 0.7 (0–1) |

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

The Glyphs visualizations take a drawing as input: a coarse grid of cells,
each empty or filled at one of a few strengths. The idea is that a client
gives the viewer a small canvas to click on — once for grey, again for black
— and passes the result in as an option:

```js
{ id: VIZ.GLYPH_CRYSTAL, options: { glyph: [
  '....2....',
  '....2....',
  '.1..2..1.',
  '..1.2.1..',
  '222222222',
  '..1.2.1..',
  '.1..2..1.',
  '....2....',
  '....2....',
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
{ name: 'glyph', kind: 'grid', width: 9, height: 9, levels: 2, default: [ /* rows */ ] }
```

`levels` is the number of strengths above empty (2: grey and black). The size
is a suggestion — each visualization fits whatever drawing it is given, up
to 32 cells a side — and an empty or unreadable drawing falls back to the
visualization's own default, so there is always something on screen.

The demo's timeline editor shows an editor for every option a checked
visualization declares, built from `describe()`: a select per enum, a slider
per number, a text box per string, and for a `grid` option a grid editor:
click to step a cell's strength, drag to
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

### Readings

The drawing is an abstract input, not a picture to reproduce. None of the
visualizations copies cells onto the screen or shows one copy of the
drawing; each reads it as the input to some other structure and shows what
that structure does with it, everywhere at once. The readings are:

| visualization | the drawing is read as | what fills the screen |
|---------------|------------------------|-----------------------|
| `glyph-current` | a stream function — a smooth, tiled field whose hills are the filled cells | a texture: the grain of motes riding the field's curl |
| `glyph-crystal` | a crystal habit — how far the filled cells reach in each direction from the centre | a tessellation, grown: fronts of that shape advancing until they meet |
| `glyph-dendrite` | a branching rule — each row the children a branch splits into | a growth pattern in 3D: a coral following the rule, packing a sphere |
| `glyph-reaction` | a map of two reaction rates, tiled and softened | a texture: reaction–diffusion growth changing character region by region |
| `glyph-cymatics` | a spectrum — each filled cell a plane wave, by its offset from the centre | a tessellation: the interference pattern of the waves |

Two of the readings are shared, in
[src/visualizations/glyph.js](src/visualizations/glyph.js), for any
visualization to use:

- `glyphField(glyph)` returns `field(u, v)`, 0–1 for any real `(u, v)`
  where one unit is one copy of the drawing: each filled cell a round
  Gaussian blot, the drawing mirrored at every border so copies join without
  seams. Sampled under a rotation and a drift, no copy lines up with any
  other on screen. `field.gradMax` is its steepest slope, for scaling
  anything that follows its gradient.
- `radialProfile(glyph, { n, kappa, ratio })` returns `n` speeds round the
  compass: how far the filled cells reach in each direction from the centre,
  smoothed with a kernel of sharpness `kappa` and scaled so the slowest
  direction is 1 and the fastest at most `ratio`.

To write one, declare the option with `glyphOption()` and read it with
`readGlyph(this)`, both in the same file; that file also holds every
built-in default drawing.

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
//  { id: 'motion', … }, { id: 'spots', … }, { id: 'attractors', … }]
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

### Peak colour

`lineColor` and `accentColor` are always on screen; `peakColor` is a third
colour that only shows at the extremes of the sound. Almost every
visualization pushes some part of itself toward it as a hit's `impact` (or a level slot)
rises past `peakAbove`, reaching it at 1: radial-burst rings from the
hardest kicks, the attractors' cloud on the biggest jolts, the brightest
nodal lines of `glyph-cymatics`, a tesseract's beads, the crest of a
helix-corridor swell. Lower `peakAbove` and it shows more often; raise it
and only the heaviest hits reach it.

```js
style: { lineColor: '#7fffd4', accentColor: '#ff5d8f', peakColor: '#ffffff', peakAbove: 0.75 }
```

It is off by default (`peakColor: null`), and with it off every
visualization draws exactly what it drew before it existed. It eases between
window styles like any other colour, and snaps on when a window first sets it.

A custom visualization opts in with `this.peak(base, level)`, which returns
`base` pushed toward the peak colour by how far `level` is past
`peakAbove`, or `base` unchanged; `this.peakAmount(level)` gives the 0–1
blend itself. In 3D, the palette GLSL has a matching `peak(color, level)`,
and `peakTint(viz, color, level)` in three-shared.js tints a `THREE.Color`.

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
GLSL and JS versions of the palette (and of the peak colour: `peak()` in GLSL,
`peakTint()` in JS), `instanceGlow()` to make a lit instanced
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
import { Visualization, TRIGGER, register, impact } from './src/engine.js';

class Strobe extends Visualization {
  static id = 'strobe';
  static description = 'Full-screen flash on every snare.';   // optional metadata
  static inputs = {
    hit:  { kind: 'event', default: TRIGGER.SNARE },
    tint: { kind: 'level', default: { band: 'treble', smooth: 0.1 } },
  };

  static options = {
    decay: { kind: 'number', default: 4, min: 0.5, max: 12, step: 0.5 },
  };

  constructor(opts) {
    super(opts);
    this.decay = this.option('decay');   // validated, clamped, or the default
  }

  onInput(slot, data) { this.flash = data.strength; this.hit = impact(data); }

  draw(ctx, dt) {
    this.flash = Math.max(0, (this.flash ?? 0) - dt * this.decay);
    this.applyStyle(ctx);        // strokeStyle/fillStyle/lineWidth/shadow from style
    ctx.fillStyle = this.peak(this.style.lineColor, this.hit ?? 0);   // peak colour on hard hits
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
