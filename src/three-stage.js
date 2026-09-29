/**
 * ThreeStage — the one WebGL renderer every 3D visualization shares.
 *
 * The engine stays a Canvas 2D compositor. A 3D visualization renders its
 * scene here, into an offscreen canvas, and then draws that canvas onto the
 * engine's 2D context like any other image — so the crossfade, layer order,
 * glow and feedback captures all apply to it exactly as they do to 2D work.
 *
 * Shared rather than per-visualization because a WebGL context is expensive
 * and browsers cap how many a page may hold (16 in Chrome, fewer on mobile),
 * dropping the oldest when the cap is hit. Sharing is safe because each
 * visualization renders and then immediately copies the result out, one at a
 * time, before the next one clears it.
 *
 * three.js is never imported here — the app hands its own copy to the engine
 * (`new GloamingKit({ three: THREE })`), which keeps the core bundle free of
 * dependencies and lets the app choose the version and how it loads it.
 */
export class ThreeStage {
  /** Throws if WebGL is unavailable; the engine catches that and goes 2D. */
  constructor(THREE) {
    this.THREE = THREE;
    this.canvas = document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,        // transparent where nothing drew, so layers beneath show
      antialias: true,
    });
    this.renderer.setClearColor(0x000000, 0);
    // Style colours arrive as sRGB hex and are passed to shaders untouched, so
    // there is nothing to convert on the way out either.
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.width = 0;
    this.height = 0;
    this.dpr = 0;
    // Engine-wide render resolution, multiplied into each visualization's
    // own. See GloamingKit.setResolution3D().
    this.scale = 1;
    // Where the last render landed on `canvas`, in device pixels.
    this.region = { x: 0, y: 0, w: 0, h: 0 };
  }

  /**
   * Render `scene` through `camera` at CSS size `width` × `height`, at
   * `scale` × full resolution, and return the canvas holding the result; the
   * part of it that holds the image is `this.region`. Its contents are only
   * good until the next render call, so draw it out straight away.
   *
   * A reduced scale renders into a corner of the full-size canvas rather than
   * resizing it, so visualizations at different scales can share the stage
   * in one frame without reallocating the drawing buffer each time.
   */
  render(scene, camera, width, height, scale = 1) {
    const dpr = window.devicePixelRatio || 1;
    if (width !== this.width || height !== this.height || dpr !== this.dpr) {
      this.renderer.setPixelRatio(dpr);
      this.renderer.setSize(width, height, false);
      this.width = width;
      this.height = height;
      this.dpr = dpr;
    }
    const s = Math.min(1, scale * this.scale);
    // In CSS px; three.js applies the pixel ratio. GL's origin is bottom-left,
    // so the image sits at the bottom of the canvas.
    this.renderer.setViewport(0, 0, width * s, height * s);
    this.renderer.render(scene, camera);

    const r = this.region;
    r.w = Math.max(1, Math.round(width * s * dpr));   // rounded as three.js rounds the viewport
    r.h = Math.max(1, Math.round(height * s * dpr));
    r.x = 0;
    r.y = this.canvas.height - r.h;
    return this.canvas;
  }

  dispose() {
    this.renderer.dispose();
    // Release the context now rather than whenever the canvas is collected,
    // so turning 3D off actually hands the GPU memory back.
    this.renderer.forceContextLoss();
  }
}
