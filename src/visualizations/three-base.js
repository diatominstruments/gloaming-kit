import { Visualization } from './base.js';

/**
 * withThree — gives any visualization class a three.js scene to draw with.
 *
 * A 3D visualization is still an ordinary visualization as far as the engine
 * is concerned: same input slots, options, style, layer and lifecycle. The
 * only difference is how it paints — it renders a scene on the shared
 * ThreeStage (three-stage.js) and draws the result onto the 2D context with
 * present(), which is why fades, layers and feedback need nothing new.
 *
 * It is a mixin rather than only a base class so a 3D version can extend the
 * 2D one it re-renders and inherit its whole simulation — see flow-ribbon.js,
 * where the 3D attractors are their 2D selves with a different draw(). For a
 * visualization that has no 2D parent, extend ThreeVisualization below.
 *
 * Statics:
 *
 *   static renderer = '3d'        how the engine knows to hand it the stage
 *   static fallback = SomeClass   drawn instead when 3D is off or unavailable
 *                                 (a class or registry id); with none, the
 *                                 visualization is simply left out
 *   static RESOLUTION = 1         render scale; below 1 renders fewer pixels
 *                                 and upscales, for per-pixel-heavy shaders.
 *                                 The engine's setResolution3D() multiplies in.
 *
 * Instances get `this.THREE`, `this.scene` and `this.camera` (a perspective
 * camera, which subclasses position and configure as they like). Anything
 * added to `this.scene` is released on dispose().
 */
export const withThree = (Base) => class extends Base {
  static renderer = '3d';
  static fallback = null;
  static RESOLUTION = 1;

  constructor(opts) {
    super(opts);
    if (!opts.stage) {
      throw new Error(`GloamingKit: '${this.constructor.id}' is a 3D visualization and needs the engine's ThreeStage`);
    }
    this.stage = opts.stage;
    this.THREE = opts.stage.THREE;
    this.scene = new this.THREE.Scene();
    this.camera = new this.THREE.PerspectiveCamera(50, this.width / this.height, 0.1, 1000);
    this.colors = new Map();   // css string -> parsed THREE.Color, see color()
  }

  resize(width, height) {
    super.resize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Render the scene and draw it onto `ctx` at full size. The engine's
   * crossfade is already on `ctx.globalAlpha`, so it applies as-is.
   *
   * `glow` is a Canvas 2D shadow blur (in CSS px) applied to the copy, in
   * `style.shadowColor` — the same glow 2D visualizations get from
   * applyStyle(). It blurs the whole rendered image, so it costs a pass over
   * the canvas; render only the parts that should glow when using it.
   */
  present(ctx, { glow = 0 } = {}) {
    const image = this.stage.render(
      this.scene, this.camera, this.width, this.height, this.constructor.RESOLUTION,
    );
    const r = this.stage.region;
    ctx.shadowBlur = glow;
    if (glow > 0) ctx.shadowColor = this.style.shadowColor ?? this.style.lineColor;
    ctx.drawImage(image, r.x, r.y, r.w, r.h, 0, 0, this.width, this.height);
    ctx.shadowBlur = 0;
  }

  /**
   * Device pixels per CSS pixel in what present() renders: the screen's pixel
   * ratio times the render resolution. For shaders that size things in
   * pixels, like gl_PointSize.
   */
  pixelScale() {
    return (window.devicePixelRatio || 1) * Math.min(1, this.constructor.RESOLUTION * this.stage.scale);
  }

  /**
   * A style colour as a THREE.Color holding its sRGB channels unconverted,
   * to match the stage's pass-through output. Accepts anything CSS does
   * (hex, rgb(), named colours). Cached, since style colours are read every
   * frame but only change while a window's style is easing.
   */
  color(css) {
    let c = this.colors.get(css);
    if (!c) {
      c = new this.THREE.Color().setStyle(css, this.THREE.LinearSRGBColorSpace);
      // The live style eases through a new hex every frame during a
      // transition; don't let those pile up.
      if (this.colors.size > 64) this.colors.clear();
      this.colors.set(css, c);
    }
    return c;
  }

  dispose() {
    super.dispose();
    this.scene.traverse((obj) => {
      obj.geometry?.dispose();
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of materials) m?.dispose();
    });
  }
};

/** Base class for a 3D visualization with no 2D parent to extend. */
export class ThreeVisualization extends withThree(Visualization) {}
