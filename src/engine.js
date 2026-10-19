import { Emitter } from './emitter.js';
import { SongPlayer } from './player.js';
import { Analyzer, DEFAULT_TRIGGERS } from './analyzer.js';
import { Timeline } from './timeline.js';
import { registry, fallbackOf } from './visualizations/index.js';
import { layerRank } from './visualizations/layers.js';
import { compileLevel, resolveEvent, referencedTriggers } from './signals.js';
import { easeStyle } from './style.js';
import { ThreeStage } from './three-stage.js';
import { approach, clamp01 } from './util.js';
import {
  regionOf, enterRegion, clipOf, blendOf, transitionOf, revealOf,
} from './placement.js';

const FADE_SECONDS = 0.6;   // default transition length
const STYLE_TAU = 0.3;   // seconds; time constant for style transitions

/**
 * The style an entry eases toward: `shared` (base plus window styles) with
 * the entry's own style over it. `shadowColor: null` means "track lineColor";
 * it is resolved here, after the entry's style, so the glow travels with
 * whichever line colour the entry ends up with instead of snapping when a
 * window changes it. `peakColor: null` stays null: it means "no third
 * colour", and every visualization then draws exactly what it drew before
 * there was one.
 */
const styleTarget = (shared, spec) => {
  const target = spec?.style ? { ...shared, ...spec.style } : { ...shared };
  if (target.shadowColor == null) target.shadowColor = target.lineColor;
  return target;
};

/**
 * GloamingKit — the framework entry point. Wires player → analyzer → active
 * visualizations onto a canvas, driven by a timeline config.
 *
 *   const viz = new GloamingKit({
 *     canvas,
 *     style: { background: '#0a0a12', lineColor: '#7fffd4', accentColor: '#ff5d8f', peakColor: '#ffffff', ... },
 *     timeline: [{ from: 0, to: 60, visualizations: ['eq-bars'] }],
 *     triggers: [{ name: TRIGGER.BASS, band: [40, 130], threshold: 0.6, cooldown: 0.15 }],
 *   });
 *   await viz.load(fileOrUrl);
 *   viz.play();
 *
 * Re-emits player events ('load', 'play', 'pause', 'ended', 'seek') and
 * analyzer events ('frame', 'trigger:<name>') for app-level UI.
 *
 * 3D visualizations (`renderer: '3d'` in describe()) need three.js, which the
 * library doesn't bundle — pass the app's own copy as `three`:
 *
 *   import * as THREE from 'three';
 *   new GloamingKit({ canvas, three: THREE, ... });
 *
 * Without it, with `enable3D: false`, or where WebGL is unavailable, each 3D
 * visualization draws its 2D fallback instead (or nothing, if it has none).
 * set3D() switches at runtime, e.g. to shed load on a slow device.
 */
export class GloamingKit extends Emitter {
  constructor({
    canvas, style = {}, timeline = [], triggers = DEFAULT_TRIGGERS, styleFade = STYLE_TAU,
    fade = FADE_SECONDS, transition = 'fade',
    audioContext, monitor = true, three = null, enable3D = true, resolution3D = 1,
  } = {}) {
    super();
    this.canvas = canvas;
    // How entries come and go when neither they nor their window say.
    this.fade = fade;
    this.transition = transition;
    this.ctx2d = canvas.getContext('2d');

    // The shared WebGL renderer, created when the first 3D visualization
    // spawns: undefined until then, null once creation has failed.
    this.three = three;
    this.enable3D = enable3D;
    this.resolution3D = resolution3D;
    this.stage = undefined;
    this.warned = new Set();   // ids already warned about, so a warning isn't per-frame

    // `baseStyle` is what the app configured; `style` is the live, animated
    // one that windows pull around, and what the background is filled with.
    // Each active entry has a live style of its own as well (`entry.style`),
    // eased toward base, window and entry style in turn, which is what its
    // visualization holds a reference to. All of them are mutated in place,
    // never replaced — swapping one would orphan a visualization's
    // `this.style`.
    this.baseStyle = {
      background: '#0a0a12',
      lineColor: '#7fffd4',
      accentColor: '#ff5d8f',
      peakColor: null,       // third colour, shown only at the extremes; null = off
      peakAbove: 0.8,        // the level (hit impact, 0..1) above which it shows
      lineWidth: 2,
      shadowBlur: 0,
      shadowColor: null,
      ...style,
    };
    this.style = { ...this.baseStyle };
    this.styleFade = styleFade;
    this.styleDirty = true;   // snap on the first frame and after a seek

    this.player = new SongPlayer(audioContext, { monitor });
    this.analyzer = new Analyzer(this.player, { triggers });
    this.timeline = new Timeline(timeline);

    // instance key -> { viz, spec, style, region, progress, leaving, … } for
    // everything on screen.
    this.active = new Map();
    this.time = 0;   // song time of the current tick, for entries spawned in it
    this.rafId = null;
    this.lastTick = 0;

    for (const ev of ['load', 'play', 'pause', 'ended', 'seek']) {
      this.player.on(ev, (d) => this.emit(ev, d));
    }
    // Jumping across the song shouldn't glide through the styles it skipped.
    this.player.on('seek', () => { this.styleDirty = true; });
    this.analyzer.on('frame', (d) => this.emit('frame', d));

    this.resize();
  }

  async load(song) {
    await this.player.load(song);
  }

  play() {
    this.player.play();
    this.startLoop();
  }

  pause() {
    this.player.pause();
  }

  seek(time) {
    this.player.seek(time);
  }

  setStyle(patch) {
    // Applied to the base, which window patches layer on top of, and to the
    // live copies, snapped so a UI colour picker responds immediately rather
    // than easing. A window override still wins on the next frame, and an
    // entry's own style keeps the keys it sets.
    Object.assign(this.baseStyle, patch);
    Object.assign(this.style, patch);
    for (const entry of this.active.values()) {
      const own = entry.spec.style;
      for (const [key, value] of Object.entries(patch)) {
        if (!own || !(key in own)) entry.style[key] = value;
      }
      entry.viz.style = entry.style;
    }
  }

  /**
   * Ease the live styles toward whatever the timeline asks for at time t:
   * the shared one, and each entry's with its own style on top.
   */
  updateStyle(time, dt) {
    const shared = { ...this.baseStyle, ...this.timeline.styleAt(time) };
    const snap = this.styleDirty;
    this.styleDirty = false;
    this.easeTo(this.style, styleTarget(shared, null), snap, dt);
    for (const entry of this.active.values()) {
      this.easeTo(entry.style, styleTarget(shared, entry.spec), snap, dt);
      if (snap) entry.opacityValue = entry.opacityTarget;
    }
  }

  easeTo(live, target, snap, dt) {
    // Drop keys that a since-ended window introduced beyond the base style:
    // easeStyle only walks the target's keys, so nothing would ever update
    // them again and they'd shadow the base forever.
    for (const key of Object.keys(live)) {
      if (!(key in target)) delete live[key];
    }
    if (snap) Object.assign(live, target);
    else easeStyle(live, target, this.styleFade, dt);
  }

  setTimeline(windows) {
    this.timeline.setWindows(windows);
  }

  setTriggers(triggers) {
    this.analyzer.setTriggers(triggers);
  }

  /** Whether 3D visualizations are drawing in 3D right now. */
  get is3D() {
    return this.threeStage() !== null;
  }

  /**
   * Turn 3D rendering on or off. Anything on screen whose rendering changes
   * is swapped in place for its 3D version or 2D fallback, keeping its fade;
   * the swap restarts its animation, since the two share no state. Turning
   * it off also releases the WebGL context.
   */
  set3D(enabled) {
    if (enabled === this.enable3D) return;
    this.enable3D = enabled;
    if (!enabled && this.stage) {
      // Retire the 3D visualizations before the context they draw with goes.
      this.respawnChanged();
      this.stage.dispose();
      this.stage = undefined;
      return;
    }
    this.respawnChanged();
  }

  /**
   * Render 3D visualizations at `scale` × their usual resolution (0–1) and
   * upscale the result — a softer image for less GPU work. Takes effect on
   * the next frame; nothing is re-created.
   */
  setResolution3D(scale) {
    this.resolution3D = Math.max(0.1, Math.min(1, scale));
    if (this.stage) this.stage.scale = this.resolution3D;
  }

  /** Re-create any active visualization that now resolves to another class. */
  respawnChanged() {
    for (const [key, entry] of [...this.active]) {
      if (this.resolveClass(entry.spec.id) === entry.viz.constructor) continue;
      this.retire(entry);
      this.spawn(key, entry.spec);
      const next = this.active.get(key);
      if (next === entry) {
        // Nothing to draw in its place.
        this.active.delete(key);
      } else {
        next.progress = entry.progress;
        next.leaving = entry.leaving;
        next.opacityValue = entry.opacityValue;
        Object.assign(next.style, entry.style);
      }
    }
  }

  /** The shared 3D stage, or null when 3D is off or can't run here. */
  threeStage() {
    if (!this.enable3D || !this.three) return null;
    if (this.stage === undefined) {
      try {
        this.stage = new ThreeStage(this.three);
        this.stage.scale = this.resolution3D;
      } catch (err) {
        console.warn('GloamingKit: WebGL is unavailable; 3D visualizations will use their 2D fallbacks', err);
        this.stage = null;
      }
    }
    return this.stage;
  }

  /**
   * The class to instantiate for a timeline id: the registered one, or for a
   * 3D visualization while 3D is off, its fallback. Null if there is nothing
   * to draw.
   */
  resolveClass(id) {
    const V = registry.get(id);
    if (!V || V.renderer !== '3d' || this.threeStage()) return V ?? null;
    return fallbackOf(V);
  }

  /** Let go of an entry's subscriptions and resources. */
  retire(entry) {
    entry.offs.forEach((off) => off());
    entry.viz.dispose();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = this.canvas;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const entry of this.active.values()) {
      entry.region = this.regionFor(entry.spec);
      entry.viz.frameView = entry.region.view;
      entry.viz.resize(entry.region.w, entry.region.h);
    }
  }

  /** Where an entry draws on the canvas at its current size; see placement.js. */
  regionFor(spec) {
    return regionOf(
      spec.place, this.canvas.clientWidth, this.canvas.clientHeight,
      window.devicePixelRatio || 1, this.canvas,
    );
  }

  startLoop() {
    if (this.rafId !== null) return;
    this.lastTick = performance.now();
    const tick = (now) => {
      const dt = Math.min((now - this.lastTick) / 1000, 0.1);
      this.lastTick = now;
      this.step(dt);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stopLoop() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  /** Stop drawing and let go of the audio graph. The AudioContext is left open. */
  dispose() {
    this.stopLoop();
    this.player.teardown();
    this.player.output.disconnect();
    this.analyzer.node.disconnect();
    for (const entry of this.active.values()) this.retire(entry);
    this.active.clear();
    this.stage?.dispose();
    this.stage = undefined;
  }

  /** One animation-loop tick: analyze, sync active set, fade, draw. */
  step(dt) {
    // Catch size/zoom changes that don't fire a resize event (dpr changes).
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(this.canvas.clientWidth * dpr) ||
        this.canvas.height !== Math.round(this.canvas.clientHeight * dpr)) {
      this.resize();
    }

    const frame = this.analyzer.update();
    this.time = frame.time;
    this.syncActive(this.timeline.activeAt(frame.time));
    this.updateStyle(frame.time, dt);
    const events = this.analyzer.fired;
    // Re-emit this tick's triggers for app-level listeners. Sourced from the
    // fired map rather than per-name subscriptions so setTriggers() can rename
    // triggers without any re-wiring here.
    for (const data of events.values()) this.emit(`trigger:${data.name}`, data);

    const ctx = this.ctx2d;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.fillStyle = this.style.background;
    ctx.shadowBlur = 0;
    ctx.fillRect(0, 0, w, h);

    // Back to front by layer. The sort is stable, so within a layer the
    // Map's insertion order (spawn order) still decides.
    const ordered = [...this.active].sort(([, a], [, b]) => a.rank - b.rank);
    for (const [key, entry] of ordered) {
      // Progress through the transition: 0 off, 1 fully on.
      const { spec } = entry;
      const transition = entry.transition;
      const fade = transition === 'cut' ? 0 : (spec.fade ?? this.fade);
      const rate = fade > 0 ? dt / fade : 1;
      entry.progress += (entry.leaving ? -1 : 1) * rate;
      if (entry.leaving && entry.progress <= 0) {
        this.retire(entry);
        this.active.delete(key);
        continue;
      }
      entry.progress = Math.min(entry.progress, 1);
      const reveal = revealOf(transition, entry.progress, entry.leaving, entry.region.w, entry.region.h);

      entry.viz.onFrame(frame);
      entry.viz.updateInputs(frame, dt, events);
      const opacity = this.opacityOf(entry, frame, dt, events);
      this.drawEntry(ctx, entry, reveal.alpha * opacity, dt, reveal.clip);
    }

    // The finished frame, for visualizations that feed it back into the
    // next one. Skipped entries were deleted above, so this is what drew.
    for (const entry of this.active.values()) entry.viz.afterFrame(ctx);
  }

  /**
   * Draw one entry into its region: clipped, at `alpha`, and through its
   * blend. A blended entry draws into a layer of its own first and is
   * composited whole, so the blend applies to the picture rather than to
   * each stroke against the last — and a visualization that sets its own
   * composite operation can't override it.
   */
  drawEntry(ctx, entry, alpha, dt, reveal = null) {
    const { viz, region, clip, blend } = entry;
    if (!blend) {
      ctx.save();
      enterRegion(ctx, region, clip, reveal);
      ctx.globalAlpha = alpha;
      viz.draw(ctx, dt);
      ctx.restore();
      return;
    }

    const layer = entry.layer ??= document.createElement('canvas');
    const { width, height } = region.view;
    if (layer.width !== width || layer.height !== height) {
      layer.width = width;
      layer.height = height;
    }
    const lc = layer.getContext('2d');
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, width, height);
    lc.setTransform(width / region.w, 0, 0, height / region.h, 0, 0);
    lc.save();
    viz.draw(lc, dt);
    lc.restore();

    ctx.save();
    enterRegion(ctx, region, clip, reveal);
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = blend;
    ctx.drawImage(layer, 0, 0, region.w, region.h);
    ctx.restore();
  }

  /**
   * (Re)compile an entry's `opacity` if it changed: a number is a target the
   * entry eases toward like style; anything else is a level spec, read raw.
   */
  setOpacity(entry, spec) {
    const o = spec.opacity;
    const key = JSON.stringify(o ?? 1);
    if (entry.opacityKey === key) return;
    entry.opacityKey = key;
    const constant = o == null || typeof o === 'number';
    entry.opacityTarget = typeof o === 'number' ? clamp01(o) : 1;
    entry.opacitySignal = constant ? null : compileLevel(o, `${spec.id}.opacity`);
    entry.opacityValue ??= entry.opacityTarget;
    if (!constant) {
      for (const name of referencedTriggers(o)) {
        if (!this.analyzer.hasTrigger(name)) {
          console.warn(`GloamingKit: '${spec.id}.opacity' references trigger '${name}', which is not configured — its envelope will stay at 0`);
        }
      }
    }
  }

  /** This tick's opacity for an entry, 0..1, multiplied into its fade. */
  opacityOf(entry, frame, dt, events) {
    if (entry.opacitySignal) return clamp01(entry.opacitySignal(frame, dt, events));
    entry.opacityValue = approach(entry.opacityValue, entry.opacityTarget, this.styleFade, dt);
    return entry.opacityValue;
  }

  /** An entry's transition, else the engine's default; see placement.js. */
  transitionFor(spec) {
    return transitionOf({ ...spec, transition: spec.transition ?? this.transition }, this.warnOnce);
  }

  warnOnce = (message) => {
    if (!this.warned.has(message)) {
      this.warned.add(message);
      console.warn(message);
    }
  };

  /** Reconcile on-screen visualizations with what the timeline wants. */
  syncActive(wanted) {
    for (const [key, spec] of wanted) {
      const entry = this.active.get(key);
      if (entry) {
        entry.leaving = false;
        // Same instance, but style and opacity aren't part of its identity,
        // so the window now running may ask for different ones.
        if (entry.spec !== spec) {
          entry.spec = spec;
          entry.transition = this.transitionFor(spec);
          this.setOpacity(entry, spec);
        }
      } else {
        this.spawn(key, spec);
      }
    }
    for (const [key, entry] of this.active) {
      if (!wanted.has(key)) entry.leaving = true;
    }
  }

  spawn(key, spec) {
    const { id, bind, options } = spec;
    const VizClass = this.resolveClass(id);
    if (!VizClass) {
      if (!this.warned.has(id)) {
        this.warned.add(id);
        console.warn(registry.has(id)
          ? `GloamingKit: '${id}' needs 3D, which is off or unavailable, and has no 2D fallback — skipping it`
          : `GloamingKit: unknown visualization '${id}'`);
      }
      return;
    }
    const region = this.regionFor(spec);
    // An unstyled entry starts from the shared live style, mid-ease and all,
    // so it matches everything else on screen; a styled one starts at its
    // own colours.
    const style = spec.style
      ? styleTarget({ ...this.baseStyle, ...this.timeline.styleAt(this.time) }, spec)
      : { ...this.style };
    const viz = new VizClass({
      width: region.w,
      height: region.h,
      style,
      bind,
      options,
      stage: VizClass.renderer === '3d' ? this.stage : null,
    });
    viz.frameView = region.view;
    const entry = {
      viz, spec, style, region, progress: 0, leaving: false, offs: [], rank: layerRank(VizClass.layer),
      clip: clipOf(spec),
      blend: blendOf(spec, this.warnOnce),
      transition: this.transitionFor(spec),
      layer: null,
    };
    this.setOpacity(entry, spec);

    // Subscribe each declared event slot to whatever trigger it's bound to.
    // Level slots need no subscription — they're polled during the frame —
    // but any envelope in them still references a trigger by name, and one
    // that isn't configured would silently read 0 forever, so check those too.
    for (const [slot, def] of Object.entries(VizClass.inputs ?? {})) {
      const spec = bind && bind[slot] !== undefined ? bind[slot] : def.default;
      if (def.kind !== 'event') {
        for (const name of referencedTriggers(spec)) {
          if (!this.analyzer.hasTrigger(name)) {
            console.warn(`GloamingKit: '${id}.${slot}' references trigger '${name}', which is not configured — its envelope will stay at 0`);
          }
        }
        continue;
      }
      const name = resolveEvent(spec, `${id}.${slot}`);
      if (!name) continue;
      if (!this.analyzer.hasTrigger(name)) {
        console.warn(`GloamingKit: '${id}.${slot}' is bound to trigger '${name}', which is not configured — it will never fire`);
      }
      entry.offs.push(
        this.analyzer.on(`trigger:${name}`, (data) => {
          if (this.active.get(key) === entry) viz.onInput(slot, data);
        }),
      );
    }

    // Legacy path: visualizations that declare `static triggers` instead of
    // slots still work, they just can't be rerouted.
    for (const trigger of VizClass.triggers ?? []) {
      entry.offs.push(
        this.analyzer.on(`trigger:${trigger}`, (data) => {
          if (this.active.get(key) === entry) viz.onTrigger(trigger, data);
        }),
      );
    }

    this.active.set(key, entry);
  }
}

export { Visualization } from './visualizations/base.js';
export { FeedbackVisualization } from './visualizations/feedback-base.js';
export { ThreeVisualization, withThree } from './visualizations/three-base.js';
export { flowRibbon } from './visualizations/flow-ribbon.js';
export { Glyph, GLYPH_LEVELS } from './visualizations/glyph.js';
export {
  register, registry, VIZ, describe, catalog, CATEGORY, CATEGORIES, LAYER, LAYERS,
} from './visualizations/index.js';
export { BANDS, TRIGGER, TRIGGER_KINDS, DEFAULT_TRIGGERS } from './analyzer.js';
export { BLENDS, CLIPS, TRANSITIONS } from './placement.js';
export { impact } from './util.js';
