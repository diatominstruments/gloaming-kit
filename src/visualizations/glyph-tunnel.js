import { ThreeVisualization } from './three-base.js';
import { approach, impact } from './base.js';
import { CATEGORY } from './categories.js';
import { TRIGGER } from '../analyzer.js';
import {
  PALETTE_OPTION, paletteColor, isPsychedelic, instanceGlow, fogToAlpha,
} from './three-shared.js';
import { mosaicOf } from './glyph-mosaic.js';
import { glyphOption, readGlyph, CHEVRONS } from './glyph.js';

const TAU = Math.PI * 2;

/**
 * How the drawing becomes a tunnel:
 *
 *   wall     the drawing is carved in relief on the tunnel's inside, wrapped
 *            round it and repeating along it: columns go round, rows run
 *            down the tunnel toward you. Strength sets how far a block
 *            stands out from the wall.
 *   section  every ring of the tunnel is the whole drawing bent into an
 *            annulus — columns round it, rows from the outer edge (top) to
 *            the inner (bottom) — so you fly through a stack of the drawing,
 *            twisting into a spiral.
 */
const WRAPS = {
  wall: { rings: 96, spacing: 0.42, twist: 0.012 },
  section: { rings: 40, spacing: 1.1, twist: 0.07 },
};

/**
 * GlyphTunnel — flight down a tunnel built out of the drawing.
 *
 * Black cells are solid lit blocks; grey cells are panes of translucent
 * light, so a drawing's two strengths read as stone and stained glass. The
 * drawing repeats `repeat` times round the tunnel, every other copy mirrored,
 * so any drawing closes into a kaleidoscopic ring with no seam.
 *
 * Travel speed is constant (see road); the music turns the tunnel and sends
 * waves down it.
 *
 * Reactions:
 *
 *   ripple  a hit sends a swell down the tunnel: blocks it passes stand out
 *           further, and flash
 *   spin    how fast the tunnel turns
 *   glow    how brightly the blocks shine in their own colour, and how
 *           bright the panes are
 *
 * Distant blocks fade to transparent, so a background layer shows through
 * the far end.
 */
export class GlyphTunnel extends ThreeVisualization {
  static id = 'glyph-tunnel';
  static label = 'Glyph Tunnel';
  static description = 'Flight down a tunnel built from the drawing, in stone and stained glass; hits send swells of light down it.';
  static category = CATEGORY.GLYPHS;

  static inputs = {
    ripple: { kind: 'event', default: TRIGGER.BASS },
    spin:   { kind: 'level', default: { intensity: 'mid', smooth: 0.6 } },
    glow:   { kind: 'level', default: {
      sum: [{ intensity: 'treble', gain: 0.75 }, { relative: 'treble', gain: 0.25 }],
      smooth: 0.1,
    } },
  };

  static options = {
    glyph: glyphOption({ width: 16, height: 12, value: CHEVRONS }),
    wrap: { kind: 'enum', values: Object.keys(WRAPS), default: 'wall' },
    repeat: { kind: 'number', default: 2, min: 1, max: 6, step: 1 },
    palette: PALETTE_OPTION,
  };
  // The mosaic, wearing this one's default drawing.
  static fallback = mosaicOf(this.options.glyph);

  static RADIUS = 3;          // tunnel radius (wall); outer radius (section)
  static INNER = 1.3;         // section: radius of the drawing's bottom row
  static DEPTH = 0.9;         // wall: relief at full strength
  static SPEED = 6;           // world units/s, constant
  static SPIN = [0.05, 0.5];  // turn rate, rad/s: [idle, added at full spin]
  static WAVE_SPEED = 22;
  static WAVE_DECAY = 0.9;

  constructor(opts) {
    super(opts);
    const THREE = this.THREE;
    this.psychedelic = isPsychedelic(this);
    this.glyph = readGlyph(this);

    const wrap = this.options.wrap ?? 'wall';
    if (!(wrap in WRAPS)) console.warn(`GloamingKit: glyph-tunnel wrap '${wrap}'; expected ${Object.keys(WRAPS).join('|')}`);
    this.wrap = wrap in WRAPS ? wrap : 'wall';
    Object.assign(this, WRAPS[this.wrap]);
    this.repeat = Math.max(1, Math.min(6, Math.round(Number(this.options.repeat ?? 2)) || 2));
    this.columns = this.glyph.width * this.repeat;
    this.length = this.rings * this.spacing;

    // Filled cells by row, each column already expanded round the tunnel
    // with every other copy mirrored.
    const { width, height, levels } = this.glyph;
    this.rows = Array.from({ length: height }, (_, y) => {
      const cells = [];
      for (let c = 0; c < this.columns; c++) {
        const copy = Math.floor(c / width);
        const x = copy % 2 ? width - 1 - (c % width) : c % width;
        const level = this.glyph.get(x, y);
        if (level) cells.push({ c, y, solid: level === levels, weight: level / levels });
      }
      return cells;
    });
    const perRing = this.wrap === 'wall'
      ? Math.max(1, ...this.rows.map((r) => r.length))
      : this.rows.reduce((n, r) => n + r.length, 0);
    const capacity = Math.max(1, Math.min(40000, perRing * this.rings));

    const box = new THREE.BoxGeometry(1, 1, 1);
    const stone = new THREE.MeshStandardMaterial({ metalness: 0.15, roughness: 0.4, flatShading: true });
    this.glow = instanceGlow(stone, 0.25);
    fogToAlpha(stone);
    const glass = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    fogToAlpha(glass);
    this.glass = glass;
    const instanced = (material) => {
      const mesh = new THREE.InstancedMesh(box, material, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.scene.add(mesh);
      return mesh;
    };
    this.stone = instanced(stone);
    this.panes = instanced(glass);
    this.capacity = capacity;

    this.scene.fog = new THREE.Fog(0x000000, this.length * 0.35, this.length * 0.95);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    this.headlight = new THREE.PointLight(0xffffff, 2.5, 0, 0.6);
    this.scene.add(this.headlight);
    this.lamps = [0, 1].map(() => {
      const lamp = new THREE.PointLight(0xffffff, 6, 0, 1);
      this.scene.add(lamp);
      return lamp;
    });

    this.camera.fov = 78;
    this.camera.near = 0.05;
    this.camera.far = this.length + 10;
    this.camera.position.set(0, 0, 0);

    this.travel = 0;
    this.turn = Math.random() * TAU;
    this.turnRate = GlyphTunnel.SPIN[0];
    this.time = 0;
    this.hue = Math.random();
    this.waves = [];   // { dist, strength }

    // Scratch, so the per-instance loop never allocates.
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.p = new THREE.Vector3();
    this.s = new THREE.Vector3();
    this.c = new THREE.Color();
    this.z = new THREE.Vector3(0, 0, 1);
  }

  onInput(slot, data) {
    if (slot !== 'ripple') return;
    this.waves.push({ dist: 0, strength: impact(data) });
    if (this.waves.length > 4) this.waves.shift();
  }

  /** Place one block, in the stone or the panes. */
  place(solid, angle, radius, radial, tangential, along, ahead, tone, light) {
    const mesh = solid ? this.stone : this.panes;
    const i = mesh.count;
    if (i >= this.capacity) return;
    const { m, q, p, s, c } = this;
    p.set(Math.cos(angle) * radius, Math.sin(angle) * radius, -ahead);
    q.setFromAxisAngle(this.z, angle);
    s.set(radial, tangential, along);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    paletteColor(this, tone, c);
    c.multiplyScalar(light);
    mesh.setColorAt(i, c);
    mesh.count = i + 1;
  }

  draw(ctx, dt) {
    const { RADIUS, INNER, DEPTH, SPEED, SPIN, WAVE_SPEED, WAVE_DECAY } = GlyphTunnel;
    const spin = this.in('spin');
    this.time += dt;
    this.travel += SPEED * dt;
    this.turnRate = approach(this.turnRate, SPIN[0] + spin * SPIN[1], 0.4, dt);
    this.turn += this.turnRate * dt;
    this.hue += dt * 0.03;
    for (const w of this.waves) {
      w.dist += WAVE_SPEED * dt;
      w.strength *= Math.exp(-dt * WAVE_DECAY);
    }
    this.waves = this.waves.filter((w) => w.dist < this.length + 5);

    const { columns, spacing, rings, length: L } = this;
    const height = this.glyph.height;
    const step = TAU / columns;
    // The corkscrew winds and unwinds rather than turning forever, so the
    // drawing on the wall shears a little and straightens again.
    const twist = this.twist * (0.4 + 0.6 * Math.sin(this.time * 0.13));
    this.stone.count = 0;
    this.panes.count = 0;

    for (let k = 0; k < rings; k++) {
      // Distance ahead, wrapping as helix-corridor does; `index` is the
      // ring's fixed position along the tunnel, so its content and angle
      // don't change as it approaches.
      const ahead = ((k * spacing - this.travel) % L + L) % L;
      const index = Math.round((ahead + this.travel) / spacing);
      const along = index * spacing;

      let swell = 0;
      for (const w of this.waves) {
        const d = ahead - w.dist;
        swell += Math.exp(-d * d * 0.1) * w.strength;
      }
      const base = this.turn + along * twist;
      const tone = this.hue + along * 0.012;

      if (this.wrap === 'wall') {
        // One row of the drawing per ring, the rows marching down the tunnel.
        const row = this.rows[((index % height) + height) % height];
        for (const { c, solid, weight } of row) {
          const depth = DEPTH * (0.35 + 0.65 * weight) * (1 + swell * 0.8);
          const angle = base + (c + 0.5) * step;
          this.place(
            solid, angle, RADIUS - depth / 2,
            depth, RADIUS * step * 0.86, spacing * 0.86, ahead,
            tone + c / columns * 0.5, 1 + swell * 1.5,
          );
        }
      } else {
        // The whole drawing per ring, as an annulus; every other ring turned
        // half a column, so the stack braids rather than lining up.
        const dr = (RADIUS * 1.5 - INNER) / height;
        const offset = index % 2 ? step / 2 : 0;
        for (const row of this.rows) {
          for (const { c, y, solid } of row) {
            const radius = (INNER + (height - 0.5 - y) * dr) * (1 + swell * 0.25);
            const angle = base + offset + (c + 0.5) * step;
            this.place(
              solid, angle, radius,
              dr * 0.86, radius * step * 0.86, 0.22 + swell * 0.3, ahead,
              tone + y / height * 0.4, 1 + swell * 1.5,
            );
          }
        }
      }
    }
    for (const mesh of [this.stone, this.panes]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }

    const glow = this.in('glow');
    this.glow.value = 0.1 + glow * 0.35;
    this.glass.opacity = 0.12 + glow * 0.25;
    this.lamps.forEach((lamp, n) => {
      const a = this.time * (0.5 + n * 0.23) + n * Math.PI;
      lamp.position.set(Math.cos(a) * 1.2, Math.sin(a) * 1.2, -(6 + (Math.sin(this.time * 0.3 + n * 2) * 0.5 + 0.5) * 20));
      paletteColor(this, this.hue + 0.33 + n * 0.33, lamp.color);
    });

    this.camera.rotation.z = Math.sin(this.turn * 0.5) * 0.2;
    if (this.camera.aspect !== this.width / this.height) {
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
    }
    this.present(ctx);
  }
}
