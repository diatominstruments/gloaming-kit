/**
 * The route a glyph tunnel flies, and the passages that branch off it.
 *
 * Kept apart from the renderer so it can be stepped and checked without a
 * GPU. Everything is built from three kinds of piece the shader can measure
 * distance to exactly — straight lines, circular arcs and balls — each the
 * axis of a tube whose radius eases from one end to the other.
 *
 * The camera rides the route at a steady pace. Ahead of it the route
 * meanders on its own: long gentle arcs, mostly side to side, always
 * levelling out. A junction (junction()) cuts it a fixed distance ahead and
 * replaces what lay beyond with the exits the drawing gives. One exit
 * becomes the route; the rest open as side passages that are never taken,
 * and the stretch that was cut off closes. Vents (vent()) open small
 * dead-end alcoves along the way.
 *
 * So the music decides where the route goes but never how the camera moves:
 * a junction opens far enough ahead that the turn into it comes seconds
 * later, along an arc no tighter than MAX_TURN allows at the flight's pace,
 * and the camera never rolls.
 *
 * Two readings turn the drawing into a junction's exits:
 *
 *   end-on  the drawing held over the tunnel mouth. Every filled cell is an
 *           exit, leaving the wall in the direction of the cell from the
 *           drawing's centre (right is right, up is up), bending away the
 *           more sharply the further out the cell is; the centre cell is the
 *           way straight on. A junction takes a few cells at random, the
 *           stronger likelier, so each fork is a fragment of the drawing.
 *   walk    the drawing as a map, and the route a walk across it. The exits
 *           are the filled cells next to the one the walk is on, in their
 *           compass directions round the wall; carrying on the way the walk
 *           was already heading is straight on, and turning bends away as
 *           far as the walk turns. Taking an exit moves the walk onto that
 *           cell. The drawing is mirrored at its edges, so a walk never
 *           falls off it.
 *
 * Positions are world units; lengths that scale with the tunnel are given in
 * radii. Vectors are plain [x, y, z] arrays, y up.
 */

const TAU = Math.PI * 2;

export const UP = Object.freeze([0, 1, 0]);

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const madd = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a) => mul(a, 1 / (length(a) || 1));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = ([lo, hi], t) => lo + (hi - lo) * t;

/**
 * Up and right for a direction of travel `t`: world up with `t` taken out,
 * so a view along `t` is never rolled. Right is `t` × up.
 */
export function frame(t) {
  let up = madd(UP, t, -dot(UP, t));
  if (length(up) < 1e-4) up = madd([0, 0, 1], t, -t[2]);   // straight up or down: any will do
  up = normalize(up);
  return { up, right: cross(t, up) };
}

export const LINE = 0;
export const ARC = 1;
export const BALL = 2;

/**
 * One piece of a tunnel's axis. An arc starts at `p0` heading `t0` and
 * curves toward `bend` (a unit vector square to `t0`) at radius `R`, for
 * `len` units, which the route keeps under half a turn. A ball is a round
 * chamber at `p0` of radius `r0`.
 *
 *   s0      distance along the route (or along the passage it belongs to)
 *           at the piece's start, for texturing
 *   chain   pieces with the same chain join hard, end to end; different
 *           chains blend smoothly where they meet. The route is chain 0.
 *   attach  the route distance the piece hangs off, for pruning
 *   open    how far open, 0–1, eased toward `target` after `wait` seconds
 */
export class Piece {
  constructor({
    kind = LINE, p0, t0 = [0, 0, -1], len = 0, bend = null, R = 0,
    r0, r1 = r0, s0 = 0, chain = 0, attach = s0, vent = false,
  }) {
    this.kind = kind;
    this.p0 = p0;
    this.t0 = t0;
    this.len = len;
    this.bend = bend;
    this.R = R;
    this.r0 = r0;
    this.r1 = r1;
    this.s0 = s0;
    this.chain = chain;
    this.attach = attach;
    this.vent = vent;
    this.open = 0;
    this.target = 1;
    this.wait = 0;
    this.bound();
  }

  get s1() {
    return this.s0 + this.len;
  }

  at(u) {
    if (this.kind === ARC) {
      const a = u / this.R;
      return add(this.p0, add(mul(this.bend, this.R * (1 - Math.cos(a))), mul(this.t0, this.R * Math.sin(a))));
    }
    if (this.kind === LINE) return madd(this.p0, this.t0, u);
    return this.p0;
  }

  tangent(u) {
    if (this.kind !== ARC) return this.t0;
    const a = u / this.R;
    return normalize(add(mul(this.bend, Math.sin(a)), mul(this.t0, Math.cos(a))));
  }

  radius(u) {
    return this.len > 0 ? this.r0 + (this.r1 - this.r0) * clamp(u / this.len, 0, 1) : this.r0;
  }

  /** Where the axis is: `centre`, and how far it reaches from there. */
  bound() {
    if (this.kind === BALL) {
      this.centre = this.p0;
      this.reach = 0;
      return;
    }
    // An arc of under half a turn lies within its chord of its midpoint.
    this.centre = this.at(this.len / 2);
    this.reach = length(sub(this.p0, this.centre));
  }

  /** Cut this piece `u` along: it keeps the head, and returns the tail. */
  split(u) {
    const a = u / (this.R || 1);
    const tail = new Piece({
      kind: this.kind,
      p0: this.at(u),
      t0: this.tangent(u),
      len: this.len - u,
      bend: this.kind === ARC ? normalize(madd(mul(this.bend, Math.cos(a)), this.t0, -Math.sin(a))) : null,
      R: this.R,
      r0: this.radius(u),
      r1: this.r1,
      s0: this.s0 + u,
      chain: this.chain,
      attach: this.attach,
    });
    tail.open = this.open;
    tail.target = this.target;
    this.r1 = tail.r0;
    this.len = u;
    this.bound();
    return tail;
  }
}

/** Largest angle an exit bends away from straight on: a cell at the drawing's rim, or a right-angle turn. */
export const MAX_DEFLECT = 1.13;   // ~65°
/** Exits closer than this (radians between their directions) are one exit. */
const MIN_APART = 0.42;
/** An exit bending less than this is the way straight on. */
const STRAIGHT = 0.06;

/** An exit's direction in a frame looking down +z, right +x and up +y. */
const local = ({ around, deflect }) => {
  const d = deflect * MAX_DEFLECT;
  return [Math.cos(around) * Math.sin(d), Math.sin(around) * Math.sin(d), Math.cos(d)];
};

/**
 * End-on: every filled cell as an exit — `around` the wall from the right,
 * counterclockwise (up is π/2), `deflect` 0–1 of MAX_DEFLECT, `weight` its
 * strength 0–1.
 */
export function endOnExits(glyph) {
  const cx = (glyph.width - 1) / 2;
  const cy = (glyph.height - 1) / 2;
  const cells = glyph.filled().map(({ x, y, weight }) => {
    const dx = x - cx;
    const dy = cy - y;
    return { around: Math.atan2(dy, dx), reach: Math.hypot(dx, dy), weight };
  });
  const far = Math.max(1, ...cells.map((c) => c.reach));
  return cells.map(({ around, reach, weight }) => ({
    around, deflect: reach < 0.5 ? 0 : reach / far, weight,
  }));
}

/**
 * Up to `count` of `exits`, drawn at random with the stronger likelier,
 * none within MIN_APART of another.
 */
export function sampleExits(exits, count, random) {
  const pool = [...exits];
  const out = [];
  while (out.length < count && pool.length) {
    let total = 0;
    for (const e of pool) total += e.weight;
    let pick = random() * total;
    let i = 0;
    while (i < pool.length - 1 && (pick -= pool[i].weight) > 0) i++;
    const [e] = pool.splice(i, 1);
    const d = local(e);
    if (out.every((o) => Math.acos(clamp(dot(local(o), d), -1, 1)) >= MIN_APART)) out.push(e);
  }
  return out;
}

/**
 * Which exit the route takes:
 *
 *   strength   (default) the harder the hit, the sharper the turn
 *   strongest  the strongest cell, ties broken at random
 *   random
 *
 * `strength` is 0–1.
 */
export function chooseExit(exits, rule, strength, random) {
  if (exits.length <= 1) return 0;
  if (rule === 'random') return Math.floor(random() * exits.length);
  if (rule === 'strongest') {
    const top = Math.max(...exits.map((e) => e.weight));
    const best = exits.map((e, i) => (e.weight === top ? i : -1)).filter((i) => i >= 0);
    return best[Math.floor(random() * best.length)];
  }
  const order = exits.map((_, i) => i).sort((a, b) => exits[a].deflect - exits[b].deflect);
  return order[Math.round(clamp(strength, 0, 1) * (order.length - 1))];
}

// Compass steps in drawing coordinates (y down), counterclockwise from east.
const COMPASS = [[1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]];

/** The walk reading: a position on the drawing and the way it is heading. */
export class Walker {
  constructor(glyph, random) {
    this.glyph = glyph;
    const cells = glyph.filled();
    let pick = random() * cells.reduce((sum, c) => sum + c.weight, 0);
    const start = cells.find((c) => (pick -= c.weight) <= 0) ?? cells[0];
    this.x = start.x;
    this.y = start.y;
    this.heading = null;
    const first = this.exits();
    this.heading = first.length ? first[Math.floor(random() * first.length)].step : [1, 0];
  }

  /** A cell's strength, 0–1, with the drawing mirrored at its edges. */
  weight(x, y) {
    const fold = (v, n) => {
      const m = ((v % (2 * n)) + 2 * n) % (2 * n);
      return m < n ? m : 2 * n - 1 - m;
    };
    return this.glyph.weight(fold(x, this.glyph.width), fold(y, this.glyph.height));
  }

  /**
   * The filled cells next to this one, as exits (see endOnExits) with the
   * `step` and the cell they lead `to`. Turning back is an exit only when
   * there is no other; a cell with no filled neighbour looks further along
   * each compass direction for one.
   */
  exits() {
    const found = [];
    for (const step of COMPASS) {
      const weight = this.weight(this.x + step[0], this.y + step[1]);
      if (weight > 0) found.push({ step, to: [this.x + step[0], this.y + step[1]], weight });
    }
    if (!found.length) {
      const span = 2 * Math.max(this.glyph.width, this.glyph.height);
      for (const step of COMPASS) {
        for (let k = 2; k <= span; k++) {
          const weight = this.weight(this.x + step[0] * k, this.y + step[1] * k);
          if (weight > 0) {
            found.push({ step, to: [this.x + step[0] * k, this.y + step[1] * k], weight });
            break;
          }
        }
      }
    }
    const h = this.heading;
    const back = (f) => h && f.step[0] === -h[0] && f.step[1] === -h[1];
    const ahead = found.filter((f) => !back(f));
    return (ahead.length ? ahead : found).map((f) => {
      let turn = 1;
      if (h) {
        const c = (f.step[0] * h[0] + f.step[1] * h[1]) / (Math.hypot(...f.step) * Math.hypot(...h));
        turn = Math.min(1, Math.acos(clamp(c, -1, 1)) / (Math.PI / 2));
      }
      return { ...f, around: Math.atan2(-f.step[1], f.step[0]), deflect: turn };
    });
  }

  move(exit) {
    [this.x, this.y] = exit.to;
    this.heading = exit.step;
  }
}

export class Route {
  // Distances, in radii.
  static AHEAD = 14;          // how far ahead a junction opens
  static AHEAD_MAX = 26;      // the furthest one may, queued behind another
  static GAP = 11;            // junctions at least this far apart
  static LOOK = 36;           // route kept built ahead of the camera, past the view
  static BEHIND = 2;          // and behind it
  static KEEP = 6;            // side passages kept until their junction is this far behind
  static SPUR = 14;           // how far a side passage runs, narrowing, before it ends
  static LEAD = 2;            // the camera looks at the route this far ahead
  static CHAMBER = 1.45;      // a junction's swell, as a radius
  static CAVERN = 3.6;        // a cavern's
  static NARROW = 0.62;       // an exit's radius from its weakest cell (full at the strongest)
  static TURN_RADIUS = 4;     // tightest turn into an exit
  static MEANDER = {
    straight: 0.4,            // chance of a straight stretch when level
    line: [5, 10],            // its length
    radius: [14, 28],         // a bend's radius: gentle, so the junctions' turns are the events
    angle: [0.3, 0.7],        // and how far it turns, radians
    vertical: 0.3,            // how much bends lean up or down, against side to side
  };
  static VENT = {
    near: 6,                  // radii ahead, at the nearest
    width: [0.35, 0.55],      // radius, in radii
    depth: [1.6, 2.4],        // from the axis, in radii
    tilt: [1.15, 1.45],       // radians from straight ahead: into the wall, facing you a little
    gap: 0.3,                 // seconds between vents, at least
    max: 3,
  };
  static MAX_TURN = 0.45;     // radians per second the flight may turn
  static MAX_PITCH = 0.6;     // how steeply a taken exit may climb or dive, radians
  static EXITS = [2, 4];      // end-on: exits at a junction, from the softest hit to the hardest
  static CAVERN_EXITS = 8;
  static WALK_EXITS = 5;
  static OPEN_TIME = 1.6;     // seconds a passage takes to open
  static CLOSE_TIME = 1.2;    // and to close
  static CLOSE_WAIT = 0.6;    // after its replacement starts opening

  constructor({ glyph, random = Math.random, radius = 1.5, speed = 3.5, reading = 'end-on', choose = 'strength' }) {
    this.glyph = glyph;
    this.random = random;
    this.radius = radius;
    this.speed = speed;
    this.reading = reading;
    this.choose = choose;
    this.walker = reading === 'walk' ? new Walker(glyph, random) : null;
    this.turnRadius = Math.max(Route.TURN_RADIUS * radius, speed / Route.MAX_TURN);
    this.s = 0;               // the camera's distance along the route
    this.time = 0;
    this.chains = 1;          // next free chain id; the route is 0
    this.nodes = [];          // route distances of junctions, oldest first
    this.lastVent = -Infinity;
    const first = new Piece({ p0: [0, 0, radius * 2], t0: [0, 0, -1], len: radius * 4, r0: radius, s0: -radius * 2 });
    first.open = 1;
    this.route = [first];
    this.side = [];
    this.extend();
  }

  get end() {
    return this.route[this.route.length - 1].s1;
  }

  /** The piece of route at distance `s`, and how far into it. */
  locate(s) {
    for (const p of this.route) if (s < p.s1) return [p, Math.max(0, s - p.s0)];
    const last = this.route[this.route.length - 1];
    return [last, s - last.s0];
  }

  pointAt(s) {
    const [p, u] = this.locate(s);
    return u > p.len ? madd(p.at(p.len), p.tangent(p.len), u - p.len) : p.at(u);
  }

  tangentAt(s) {
    const [p, u] = this.locate(s);
    return p.tangent(Math.min(u, p.len));
  }

  /** Where the camera is, and where it looks: along the route, level. */
  camera() {
    const position = this.pointAt(this.s);
    const forward = normalize(sub(this.pointAt(this.s + Route.LEAD * this.radius), position));
    return { position, forward, ...frame(forward) };
  }

  /** Every piece, route first. */
  pieces() {
    return [...this.route, ...this.side];
  }

  update(dt) {
    const R = this.radius;
    this.time += dt;
    this.s += this.speed * dt;
    this.extend();
    for (const p of this.pieces()) {
      if (p.wait > 0) {
        p.wait -= dt;
        continue;
      }
      const rate = p.target > p.open ? 1 / Route.OPEN_TIME : -1 / Route.CLOSE_TIME;
      p.open = clamp(p.open + rate * dt, Math.min(p.open, p.target), Math.max(p.open, p.target));
    }
    while (this.route.length > 1 && this.route[0].s1 < this.s - Route.BEHIND * R) this.route.shift();
    this.side = this.side.filter((p) => !(p.target === 0 && p.open <= 0) && p.attach > this.s - Route.KEEP * R);
    while (this.nodes.length && this.nodes[0] < this.s - Route.KEEP * R) this.nodes.shift();
  }

  extend() {
    while (this.end < this.s + Route.LOOK * this.radius) this.route.push(this.meander());
  }

  /** The next stretch of route on its own: a gentle bend or a straight. */
  meander() {
    const R = this.radius;
    const M = Route.MEANDER;
    const rnd = this.random;
    const prev = this.route[this.route.length - 1];
    const p0 = prev.at(prev.len);
    const t0 = prev.tangent(prev.len);
    const r0 = prev.r1;
    const r1 = r0 + (R - r0) * 0.7;
    const pitch = Math.asin(clamp(dot(t0, UP), -1, 1));
    const base = { p0, t0, r0, r1, s0: prev.s1 };
    if (Math.abs(pitch) < 0.08 && rnd() < M.straight) {
      const piece = new Piece({ ...base, len: R * lerp(M.line, rnd()) });
      piece.open = 1;
      return piece;
    }
    // Mostly side to side; any climb or dive is bent back toward level.
    const { up, right } = frame(t0);
    const a = rnd() * TAU;
    let bend = madd(mul(right, Math.cos(a)), up, Math.sin(a) * M.vertical);
    bend = normalize(madd(bend, up, -Math.sign(pitch) * Math.min(1.5, Math.abs(pitch) / 0.25)));
    const radius = R * lerp(M.radius, rnd());
    const piece = new Piece({ ...base, kind: ARC, bend, R: radius, len: radius * lerp(M.angle, rnd()) });
    piece.open = 1;
    return piece;
  }

  /**
   * `dir`, turned back toward `t` until its climb or dive is within
   * MAX_PITCH, so the exit still leaves on the same side of the wall, only
   * more gently.
   */
  levelled(dir, t) {
    const pitch = (d) => Math.abs(Math.asin(clamp(dot(d, UP), -1, 1)));
    if (pitch(dir) <= Route.MAX_PITCH) return dir;
    const angle = Math.acos(clamp(dot(t, dir), -1, 1));
    const toward = (k) => {
      // Slerp from t to dir, k of the way.
      const a = angle * k;
      const s = Math.sin(angle) || 1;
      return normalize(add(mul(t, Math.sin(angle - a) / s), mul(dir, Math.sin(a) / s)));
    };
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (pitch(toward(mid)) <= Route.MAX_PITCH) lo = mid; else hi = mid;
    }
    return toward(lo);
  }

  /**
   * Open a junction ahead. `strength` (0–1) is how hard the hit was: under
   * the end-on reading, how many exits it opens, and under the `strength`
   * rule, which one the route takes. A cavern opens every exit round a
   * great chamber. Returns { s, exits } or null if there's no room for one
   * yet.
   */
  junction({ strength = 1, cavern = false } = {}) {
    const R = this.radius;
    const rnd = this.random;
    const last = this.nodes.length ? this.nodes[this.nodes.length - 1] : -Infinity;
    const at = Math.max(this.s + Route.AHEAD * R, last + Route.GAP * R);
    if (at > this.s + Route.AHEAD_MAX * R) return null;

    let exits;
    if (this.walker) {
      exits = sampleExits(this.walker.exits(), cavern ? Route.CAVERN_EXITS : Route.WALK_EXITS, rnd);
    } else {
      const count = cavern ? Route.CAVERN_EXITS : Math.round(lerp(Route.EXITS, clamp(strength, 0, 1)));
      exits = sampleExits(endOnExits(this.glyph), count, rnd);
    }
    if (!exits.length) return null;

    // Cut the route at the junction: what lay beyond is replaced.
    const k = this.route.findIndex((p) => p.s1 > at);
    const piece = this.route[k];
    const rest = [piece.split(at - piece.s0), ...this.route.slice(k + 1)];
    this.route.length = k + 1;
    const node = piece.at(piece.len);
    const t = piece.tangent(piece.len);
    const { up, right } = frame(t);
    const taken = chooseExit(exits, this.choose, strength, rnd);

    this.side.push(new Piece({
      kind: BALL, p0: node, t0: t, r0: R * (cavern ? Route.CAVERN : Route.CHAMBER), s0: at, chain: this.chains++,
    }));
    let reused = false;
    let kept = false;
    exits.forEach((e, i) => {
      const [x, y, z] = local(e);
      let dir = normalize(add(add(mul(right, x), mul(up, y)), mul(t, z)));
      if (i === taken) dir = this.levelled(dir, t);
      const width = R * (Route.NARROW + (1 - Route.NARROW) * e.weight);
      const angle = Math.acos(clamp(dot(t, dir), -1, 1));
      if (angle < STRAIGHT) {
        // Straight on is the way that was already there.
        reused = true;
        if (i === taken) {
          kept = true;
          this.route.push(...rest);
        } else {
          this.side.push(...this.trim(rest, Route.SPUR * R, this.chains++));
        }
        return;
      }
      if (i === taken) {
        // The route turns into its exit along an arc the flight can take.
        this.route.push(new Piece({
          kind: ARC, p0: node, t0: t, bend: normalize(madd(dir, t, -dot(t, dir))), R: this.turnRadius,
          len: this.turnRadius * angle, r0: piece.r1, r1: width, s0: at,
        }));
      } else {
        // Nobody flies the others, so they leave straight, narrowing away.
        this.side.push(new Piece({
          p0: node, t0: dir, len: Route.SPUR * R, r0: width, r1: width * 0.45, s0: at, chain: this.chains++,
        }));
      }
    });
    if (!reused) {
      // Only the start of what's cut off closes in view; the rest is
      // beyond it and can simply go.
      rest.length = Math.min(rest.length, rest[0].len < R * 6 ? 2 : 1);
      const chain = this.chains++;
      for (const p of rest) {
        p.chain = chain;
        p.attach = at;
        p.target = 0;
        p.wait = Route.CLOSE_WAIT;
      }
      this.side.push(...rest);
    }
    // Vents further on hung off the stretch that was replaced.
    for (const p of this.side) {
      if (!kept && p.vent && p.attach > at) {
        p.target = 0;
        p.wait = Route.CLOSE_WAIT;
      }
    }
    this.nodes.push(at);
    this.walker?.move(exits[taken]);
    this.extend();
    return { s: at, exits: exits.length };
  }

  /** `pieces` cut to `len` in all, re-chained as a side passage. */
  trim(pieces, len, chain) {
    const out = [];
    let left = len;
    for (const p of pieces) {
      if (left <= 0) break;
      if (p.len > left) p.split(left);
      left -= p.len;
      p.chain = chain;
      p.attach = pieces[0].s0;
      out.push(p);
    }
    return out;
  }

  /** Open a small dead-end alcove in the wall ahead, in a drawn cell's direction. */
  vent(strength = 0.5) {
    const R = this.radius;
    const V = Route.VENT;
    const rnd = this.random;
    if (this.time - this.lastVent < V.gap) return false;
    if (this.side.filter((p) => p.vent && p.target > 0).length >= V.max) return false;
    const at = this.s + R * (V.near + rnd() * (Route.AHEAD - V.near));
    if (this.nodes.some((n) => Math.abs(n - at) < R * 3)) return false;
    const cells = endOnExits(this.glyph).filter((e) => e.deflect > 0);
    const [cell] = sampleExits(cells.length ? cells : [{ around: rnd() * TAU, deflect: 1, weight: 1 }], 1, rnd);
    const t = this.tangentAt(at);
    const { up, right } = frame(t);
    const tilt = lerp(V.tilt, rnd());
    const side = add(mul(right, Math.cos(cell.around)), mul(up, Math.sin(cell.around)));
    const dir = normalize(add(mul(t, Math.cos(tilt)), mul(side, Math.sin(tilt))));
    const width = R * lerp(V.width, rnd()) * (0.7 + 0.3 * Math.max(cell.weight, strength));
    this.side.push(new Piece({
      p0: this.pointAt(at), t0: dir, len: R * lerp(V.depth, rnd()),
      r0: width, r1: width * 0.6, s0: at, chain: this.chains++, vent: true,
    }));
    this.lastVent = this.time;
    return true;
  }
}
