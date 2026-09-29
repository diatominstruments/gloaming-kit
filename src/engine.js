import { Emitter } from './emitter.js';
import { SongPlayer } from './player.js';
import { Analyzer, DEFAULT_TRIGGERS } from './analyzer.js';
import { Timeline } from './timeline.js';
import { registry, fallbackOf } from './visualizations/index.js';
import { layerRank } from './visualizations/layers.js';
import { resolveEvent, referencedTriggers } from './signals.js';
import { easeStyle } from './style.js';
import { ThreeStage } from './three-stage.js';

const FADE_SECONDS = 0.6;
const STYLE_TAU = 0.3;   // seconds; time constant for style transitions

/**
 * GloamingKit — the framework entry point. Wires player → analyzer → active
 * visualizations onto a canvas, driven by a timeline config.
 *
 *   const viz = new GloamingKit({
 *     canvas,
 *     style: { background: '#0a0a12', lineColor: '#7fffd4', ... },
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
    audioContext, monitor = true, three = null, enable3D = true, resolution3D = 1,
  } = {}) {
    super();
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');

    // The shared WebGL renderer, created when the first 3D visualization
    // spawns: undefined until then, null once creation has failed.
    this.three = three;
    this.enable3D = enable3D;
    this.resolution3D = resolution3D;
    this.stage = undefined;
    this.warned = new Set();   // ids already warned about, so a warning isn't per-frame

    // `baseStyle` is what the app configured; `style` is the live, animated
    // one that windows pull around and that visualizations hold a reference
    // to. It is mutated in place, never replaced — swapping it would orphan
    // every active visualization's `this.style`.
    this.baseStyle = {
      background: '#0a0a12',
      lineColor: '#7fffd4',
      accentColor: '#ff5d8f',
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

    // instance key -> { viz, alpha, leaving } for everything on screen.
    this.active = new Map();
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
    // Applied to both: the base is what window patches layer on top of, and
    // the live copy is snapped so a UI colour picker responds immediately
    // rather than easing. A window override still wins on the next frame.
    Object.assign(this.baseStyle, patch);
    Object.assign(this.style, patch);
    for (const entry of this.active.values()) entry.viz.style = this.style;
  }

  /** Ease the live style toward whatever the timeline asks for at time t. */
  updateStyle(time, dt) {
    const target = { ...this.baseStyle, ...this.timeline.styleAt(time) };
    // `shadowColor: null` means "track lineColor"; resolve it so the glow
    // travels with the line instead of snapping when a window changes it.
    if (target.shadowColor == null) target.shadowColor = target.lineColor;

    // Drop keys that a since-ended window introduced beyond the base style:
    // easeStyle only walks the target's keys, so nothing would ever update
    // them again and they'd shadow the base forever.
    for (const key of Object.keys(this.style)) {
      if (!(key in target)) delete this.style[key];
    }

    if (this.styleDirty) {
      Object.assign(this.style, target);
      this.styleDirty = false;
    } else {
      easeStyle(this.style, target, this.styleFade, dt);
    }
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
        next.alpha = entry.alpha;
        next.leaving = entry.leaving;
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
    for (const entry of this.active.values()) entry.viz.resize(w, h);
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
      entry.alpha += (entry.leaving ? -1 : 1) * (dt / FADE_SECONDS);
      if (entry.leaving && entry.alpha <= 0) {
        this.retire(entry);
        this.active.delete(key);
        continue;
      }
      entry.alpha = Math.min(entry.alpha, 1);

      entry.viz.onFrame(frame);
      entry.viz.updateInputs(frame, dt, events);
      ctx.save();
      ctx.globalAlpha = entry.alpha;
      entry.viz.draw(ctx, dt);
      ctx.restore();
    }

    // The finished frame, for visualizations that feed it back into the
    // next one. Skipped entries were deleted above, so this is what drew.
    for (const entry of this.active.values()) entry.viz.afterFrame(ctx);
  }

  /** Reconcile on-screen visualizations with what the timeline wants. */
  syncActive(wanted) {
    for (const [key, spec] of wanted) {
      const entry = this.active.get(key);
      if (entry) {
        entry.leaving = false;
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
    const viz = new VizClass({
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
      style: this.style,
      bind,
      options,
      stage: VizClass.renderer === '3d' ? this.stage : null,
    });
    const entry = {
      viz, spec, alpha: 0, leaving: false, offs: [], rank: layerRank(VizClass.layer),
    };

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
export {
  register, registry, VIZ, describe, catalog, CATEGORY, CATEGORIES, LAYER, LAYERS,
} from './visualizations/index.js';
export { BANDS, TRIGGER, DEFAULT_TRIGGERS } from './analyzer.js';
export { impact } from './util.js';
