import { Emitter } from './emitter.js';
import { SongPlayer } from './player.js';
import { Analyzer, DEFAULT_TRIGGERS } from './analyzer.js';
import { Timeline } from './timeline.js';
import { registry } from './visualizations/index.js';
import { resolveEvent, referencedTriggers } from './signals.js';
import { easeStyle } from './style.js';

const FADE_SECONDS = 0.6;
const STYLE_TAU = 0.3;   // seconds; time constant for style transitions

/**
 * MusicViz — the framework entry point. Wires player → analyzer → active
 * visualizations onto a canvas, driven by a timeline config.
 *
 *   const viz = new MusicViz({
 *     canvas,
 *     style: { background: '#0a0a12', lineColor: '#7fffd4', ... },
 *     timeline: [{ from: 0, to: 60, visualizations: ['eq-bars'] }],
 *     triggers: [{ name: TRIGGER.BASS, band: [40, 130], threshold: 0.55, cooldown: 0.15 }],
 *   });
 *   await viz.load(fileOrUrl);
 *   viz.play();
 *
 * Re-emits player events ('load', 'play', 'pause', 'ended', 'seek') and
 * analyzer events ('frame', 'trigger:<name>') for app-level UI.
 */
export class MusicViz extends Emitter {
  constructor({
    canvas, style = {}, timeline = [], triggers = DEFAULT_TRIGGERS, styleFade = STYLE_TAU,
  } = {}) {
    super();
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');

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

    this.player = new SongPlayer();
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

    for (const [key, entry] of this.active) {
      entry.alpha += (entry.leaving ? -1 : 1) * (dt / FADE_SECONDS);
      if (entry.leaving && entry.alpha <= 0) {
        entry.offs.forEach((off) => off());
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

  spawn(key, { id, bind }) {
    const VizClass = registry.get(id);
    if (!VizClass) {
      console.warn(`MusicViz: unknown visualization '${id}'`);
      return;
    }
    const viz = new VizClass({
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
      style: this.style,
      bind,
    });
    const entry = { viz, alpha: 0, leaving: false, offs: [] };

    // Subscribe each declared event slot to whatever trigger it's bound to.
    // Level slots need no subscription — they're polled during the frame —
    // but any envelope in them still references a trigger by name, and one
    // that isn't configured would silently read 0 forever, so check those too.
    for (const [slot, def] of Object.entries(VizClass.inputs ?? {})) {
      const spec = bind && bind[slot] !== undefined ? bind[slot] : def.default;
      if (def.kind !== 'event') {
        for (const name of referencedTriggers(spec)) {
          if (!this.analyzer.hasTrigger(name)) {
            console.warn(`MusicViz: '${id}.${slot}' references trigger '${name}', which is not configured — its envelope will stay at 0`);
          }
        }
        continue;
      }
      const name = resolveEvent(spec, `${id}.${slot}`);
      if (!name) continue;
      if (!this.analyzer.hasTrigger(name)) {
        console.warn(`MusicViz: '${id}.${slot}' is bound to trigger '${name}', which is not configured — it will never fire`);
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
export { register, registry, VIZ } from './visualizations/index.js';
export { BANDS, TRIGGER, DEFAULT_TRIGGERS } from './analyzer.js';
