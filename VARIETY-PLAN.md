# Plan: more distinct visualizations from fewer changes

Goal: raise the number of visibly different results users can get out of
GloamingKit, with the smallest set of library changes. Ordered by leverage:
distinct outputs unlocked per line changed. Nothing here adds a new
visualization; with 51 already, sameness is not a shortage of parts.

## Why users converge today

Measured against the current registry (51 visualizations, 138 level slots,
51 event slots, 274 declared options):

1. **Everything is drawn the same way.** `engine.js` `step()` paints each
   active visualization full-frame, centred, at the same scale, with
   `source-over` compositing and one fixed 0.6 s crossfade. Two users who
   pick the same ids get the same picture, however many they stack.
2. **One palette for everything on screen.** Style is global (README,
   "Window styles"): three colours shared by every layer. A background,
   a figure and an overlay can't be coloured apart, so compositions all
   read as "line colour on dark".
3. **The variety that exists is invisible.** Every slot is rebindable and
   every option has a range, but the demo editor exposes no `bind` UI at
   all, and defaults rule. Most users never leave the defaults.
4. **The defaults all share one choreography.** Nearly every visualization
   kicks on `bass`, drifts on `mid`, glows on `treble`. Different ids,
   same dance. Signals can only follow the music; nothing evolves on its
   own or changes state discretely.
5. **The richest generators are locked.** The 7 attractor systems (14 ids)
   take their parameter vectors from class statics; harmonograph's ratio
   set, kaleidoscope's wedge counts and the physics behind particles are
   constants. The glyph drawing, the single strongest source of
   uniqueness, reaches only 5 of 51 visualizations.
6. **Five visualizations have two or fewer options:** `eq-bars`,
   `waveform`, `starfield`, `harmonograph`, `kaleidoscope`. Three of those
   are the ones most users reach for first.

## Tier 1: engine-level multipliers (every visualization at once)

One change in the compositor multiplies all 51. Roughly 150 lines in
`engine.js` and `timeline.js`, no per-visualization edits.

### 1a. Per-entry placement, clipping and blend

Extend a timeline entry:

```js
{ id: 'tunnel',
  place: { x: 0.5, y: 0, w: 0.5, h: 1, rotate: 0, flip: 'x' },  // fractions of the canvas
  clip:  'circle',                 // 'rect' | 'circle' | 'left' | 'right' | 'top' | 'bottom' | { ... }
  blend: 'lighter',                // any globalCompositeOperation
  opacity: 0.8 }                   // number, or a level spec (see Tier 2)
```

Implementation: in `step()`, around `viz.draw()`, save the context, apply
the clip path, translate and rotate to the region, set
`globalCompositeOperation`, multiply `globalAlpha`. Spawn the
visualization at the region's size rather than scaling a full-frame
render, so bars and grids lay out to the region. Include `place`, `clip`
and `blend` in `keyOf` so a changed placement is a new instance, and
report them from `describe()` as universal options.

Unlocks: split screens, quadrants, mirrored twins, picture-in-picture,
additive stacking (`lighter`, `screen`), knockouts (`destination-out`,
`xor`), difference-mode psychedelia. Feedback and treatment bases
snapshot the whole canvas, so they compose with placed entries unchanged;
3D visualizations already draw through `present()` as an image, so the
transform applies to them too.

Keep `rotate` static. Steady camera and placement, music driving shape and
colour, is the house style; `opacity` is the one field worth binding to a
signal, since presence is colour, not motion.

### 1b. Per-entry style

```js
{ id: 'particles', style: { lineColor: '#ffb347', shadowBlur: 0 } }
```

Today `spawn()` hands every instance the one live `this.style` object.
Give each entry its own live style, eased by `updateStyle()` toward base
style, then window style, then entry style. About 40 lines. This is the
change that lets a composition look like a particular person's: a cool
background under a warm figure under a neutral overlay.

### 1c. Configurable transitions

Replace the `FADE_SECONDS` constant with a per-window or per-entry `fade`
(seconds) and `transition: 'fade' | 'cut' | 'wipe-left' | ...`, wipes
built from the clip in 1a. About 20 lines. Small on its own, but every
section change in a music video is a transition.

## Tier 2: a slightly larger signal vocabulary

`signals.js` is deliberately a closed set. Keep it closed, but add the
few primitives that let a mapping evolve or change state. About 60 lines,
applied across 138 level slots at once.

| spec | what it gives |
|------|---------------|
| `{ lfo: 0.05, shape: 'sine' }` | a slow oscillator, so shape or colour drifts on its own; phase from the seed so no two runs match |
| `{ progress: true }` | song position 0..1, so a visualization changes over the whole track |
| `{ hold: 'snare', pick: 'random' }` | sample-and-hold: each hit picks a new value and keeps it. Discrete state changes are what make a video feel composed |
| `{ mul: [a, b] }`, `{ min: [...] }` | gating and intersection (treble only while bass is live) |
| modifiers `invert`, `offset`, `quantize` | 1 − x, bias, stepped levels |

`referencedTriggers()` learns `hold`. Nothing else in the engine changes.

Then vary the shipped defaults so not every visualization kicks on bass:
some on `onset`, some on `snare`, backgrounds on `lull` and `loud`. This
is a defaults-only edit but defaults are what most users ship.

## Tier 3: unlock the generators

Per-visualization, but each is small and the figure space it opens is
large.

- **Attractors (14 ids, one edit).** In `attractor-base.js`, generate a
  number option per parameter from `PARAMS` and `DRIFT`, plus `drift` and
  `jolt` scale options, and read them in the constructor. About 25 lines.
  Every attractor becomes a family of figures instead of one.
- **harmonograph**: `ratios` (a string like `1:2,3:5`) and `pendulums`
  (2–4). **kaleidoscope**: free `segments` number and an off-centre
  `origin`. **eq-bars**: `layout` (`linear`, `radial`, `mirrored`) and
  `shape` (`bars`, `dots`, `line`). **waveform**: `layout` (`line`,
  `circle`, `lissajous`) and `mirror`. **starfield**: `streak` and
  `spread`. Each 20–40 lines; these are the five visualizations with the
  fewest options and the ones beginners pick first.
- **Glyph in two more places.** `particles` spawns its homes from the
  glyph field's density; `radial-burst` and `polygon-pulse` take the
  glyph's radial profile as their outline (`radialProfile()` exists in
  `glyph.js`). About 15 lines each, and the user's own drawing now shapes
  the most-used classics.
- **Seed everything.** Declare `seed` in the base class, give instances a
  seeded `this.random()` from `noise.js`'s `mulberry32`, and replace the
  22 files' `Math.random` calls. This is for reproducibility rather than
  variety: a music video rendered twice should match, and "reroll" becomes
  a real control.

## Tier 4: expose the space (where users actually diverge)

- **`randomEntry()` and `mutate()` in the library.** `describe()` already
  reports every option's range and enum values and every slot's kind, so
  a new `src/variety.js` can produce a valid random entry (random options
  within range, a random binding from bands and triggers, random placement,
  blend and colours) and a small mutation of an existing one. About 80
  lines, exported. Two users who press "surprise me" never start from the
  same place, and the button teaches what the option space contains.
- **Demo editor.** A `bind` editor per slot (a select of triggers for event
  slots; band, dynamics kind, gain and smooth for level slots), placement,
  blend and per-entry colour controls, "Surprise me" and "Mutate" buttons,
  and JSON export and import so compositions travel as text. `demo.js`
  only, but any editor built on `catalog()` can copy it.

## Order and size

| step | files | approx. lines | multiplies |
|------|-------|---------------|------------|
| 1a placement, clip, blend | engine.js, timeline.js, index.js | 90 | 51 visualizations |
| 1b per-entry style | engine.js | 40 | 51 |
| 1c transitions | engine.js, timeline.js | 20 | every window |
| 2 signals + defaults | signals.js, defaults in ~20 files | 60 + 20 | 138 slots |
| 3 generators | attractor-base, 5 classics, 3 glyph hosts | ~200 | the most-used ids |
| 3 seeds | base.js + 22 one-line edits | 40 | reproducibility |
| 4 randomize | new variety.js | 80 | discovery |
| 4 demo editor | demo.js, index.html | ~250 | what users can reach |

Do 1a and 1b first; they change what a composition can be. Tier 2 next,
since it changes how any composition moves. Tiers 3 and 4 can run in
parallel with each other.

## Deliberately not in the plan

- No new visualizations. Combination, not count, is the shortfall.
- No expression language in `signals.js`; the new specs are primitives.
- No per-pixel palette or gradient system; per-entry style gets most of
  the benefit for a fraction of the work.
- No audio-driven rotation or travel speed anywhere; see 1a.
