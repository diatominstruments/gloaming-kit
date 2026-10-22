/**
 * What a glyph tunnel is made of: each substance is a piece of GLSL that
 * shapes the wall and lights it, compiled into the tunnel's shader (see
 * glyph-tunnel.js for what it can read). A substance defines
 *
 *   float wall(vec3 w, vec3 p, float vd)
 *       the scene's distance at camera-relative `p` (world `w`), given
 *       `vd`, the distance to the passages' wall: negative inside a passage.
 *       Plain rock is `-vd`; a substance adds its relief. The route
 *       distance `gS` is set; anything that needs where on the wall it is
 *       (wallCoord(), wallUp()) calls nearest(p) first, which costs. A
 *       pattern on wall coordinates fades by seam() where passages meet.
 *   vec3 surface(vec3 w, vec3 p, vec3 n, vec3 rd, float t, float ao)
 *       the lit colour of the wall where a ray along `rd` met it, `t` away,
 *       facing `n`, with ambient occlusion `ao` (0 buried … 1 open)
 *   vec3 air(vec3 rd, float t)
 *       optional, with `air: true`: the light the air gives a ray along `rd`
 *       from the camera to `t` away, worked out whole rather than step by
 *       step, since the march is the expensive part
 *
 * and a few settings:
 *
 *   elong   the passages' height over their width (1 round)
 *   blend   how broadly passages fillet into each other where they meet, in
 *           radii
 *   step    march step as a fraction of the distance: under 1 for walls whose
 *           relief bends the distance field
 *   relief  how far the relief can stand out from the passages' wall into
 *           them, in radii; further off than that, the march takes whole
 *           steps without asking the substance
 *   ring    the colour of the rings of light announcing junctions (warm
 *           white unless given)
 *   palette 'style' for a substance that wears the window's colours unless
 *           told otherwise (palette 'auto', the default); 'natural' if
 *           left out. Either way, colours go through tint(natural, t), with
 *           t = LINE for the main light and ACCENT for the other
 *   period  world period, in radii, of anything tiled exactly (a lattice),
 *           so the camera's world position can be wrapped by it on the CPU
 *           and stay precise however far the flight has gone
 *   uses    which of the shared inputs the substance reads: 'record' (the
 *           music laid along the route), 'shafts' (beams of sun), 'field'
 *           (the drawing tiled as a smooth field), 'waves' (the drawing as
 *           wave vectors), 'profile' (the drawing's silhouette), 'flash'
 *           (a light somewhere ahead in the rock, lit by each flare)
 *
 * The glyph family's readings (glyph.js) each make one: `carved` is the
 * drawing as a field, cut into the wall; `cymatics` the drawing as a
 * spectrum of waves standing on it; `geode` the drawing's silhouette as the
 * habit of the crystals lining it. `lantern` casts it as shadow puppets on
 * the paper.
 */

const CANYON = /* glsl */ `
const float STRATUM = 0.3;              // a layer's thickness, in radii
const vec3 SUN = vec3(1.0, 0.8, 0.55);

// How far up through the layers: level on the whole, bent in folds large
// and small, so they swirl round the walls.
float layer(vec3 w) {
  vec3 q = w / uR;
  float fold = (noise(q * 0.04) - 0.5) * 7.0 + (noise(q * vec3(0.16, 0.1, 0.16) + 3.1) - 0.5) * 2.6;
  return (q.y + fold) / STRATUM;
}

float wall(vec3 w, vec3 p, float vd) {
  vec3 q = w / uR;
  // Swells carved by wind and water: broad, smooth, drawn out along the layers.
  float swell = (noise(q * vec3(0.13, 0.36, 0.13)) - 0.5) * 1.3;
  // Each layer stands out as a rounded ledge, further the louder its band
  // was when this stretch was laid down.
  float y = layer(w);
  float f = fract(y);
  float ledge = smoothstep(0.0, 0.3, f) * smoothstep(1.0, 0.55, f)
    * (0.025 + 0.07 * recordBand(gS, floor(y)) * (0.4 + uSwell));
  return -vd - (swell + ledge) * uR;
}

float sunlit(vec3 p) {
  float s = 0.0;
  for (int i = 0; i < SHAFTS; i++) {
    vec4 sh = uShafts[i];
    vec2 d = p.xz - sh.xy;
    s += sh.w * exp(-dot(d, d) / (sh.z * sh.z));
  }
  return s;
}

vec3 surface(vec3 w, vec3 p, vec3 n, vec3 rd, float t, float ao) {
  float y = layer(w);
  float k = floor(y);
  float shade = fract(sin(k * 91.7) * 43758.5453);
  // Orange to salmon sandstone, with the odd band of deep rose.
  vec3 rock = mix(vec3(0.86, 0.38, 0.15), vec3(0.98, 0.66, 0.4), shade);
  rock = mix(rock, vec3(0.6, 0.24, 0.28), smoothstep(0.82, 0.9, shade));
  rock *= 0.9 + 0.1 * sin(fract(y) * TAU * 3.0);
  rock *= 0.88 + 0.24 * noise(w / uR * 2.7);
  float band = recordBand(gS, k);
  rock *= 0.7 + 0.65 * band;
  rock = tint(rock, k * 0.11 + band * 0.25);
  // The light falls from a crack of sky far above, bouncing down the walls:
  // gold up high, deepening to violet shadow at the floor, more on faces
  // turned up toward it.
  float height = clamp(dot(gOff, wallUp()) / (gRad * ELONG), -1.0, 1.0);
  float sky = smoothstep(-1.2, 1.0, height);
  vec3 light = mix(vec3(0.32, 0.13, 0.26), vec3(1.3, 0.8, 0.46), sky);
  light *= (0.7 + 0.45 * max(n.y, 0.0)) * (0.6 + 0.55 * uGlow);
  vec3 col = rock * light * (0.35 + 0.65 * ao);
  col += rock * headlight(n, rd, t) * 0.12;
  // The crack itself, too bright to see into.
  float crack = smoothstep(0.84, 1.0, height) * (0.6 + 0.4 * noise(w / uR * vec3(0.6, 0.2, 0.6)));
  col += tint(vec3(1.0, 0.93, 0.8), 0.15) * crack * (0.7 + 0.6 * uGlow);
  // Where a shaft of sun lands.
  col += rock * SUN * sunlit(p) * max(n.y, 0.0) * (1.0 + 1.2 * uGlow);
  return col;
}

// erf, to within 2e-4.
float erf(float x) {
  float x2 = x * x;
  float k = 0.147 * x2;
  return sign(x) * sqrt(1.0 - exp(-x2 * (1.27324 + k) / (1.0 + k)));
}

vec3 air(vec3 rd, float t) {
  vec3 haze = vec3(0.0);
  float a = dot(rd.xz, rd.xz);
  for (int i = 0; i < SHAFTS; i++) {
    vec4 sh = uShafts[i];
    if (sh.w <= 0.0) continue;
    // A beam's glow integrated along the ray: its square distance from the
    // beam's axis is a quadratic in the distance along the ray, so the
    // Gaussian's integral is a difference of erfs.
    float b = dot(rd.xz, sh.xy);
    float glow;
    vec3 at;
    if (a < 1e-4) {
      glow = t * exp(-dot(sh.xy, sh.xy) / (sh.z * sh.z));
      at = rd * t * 0.5;
    } else {
      float t0 = b / a;
      float floor2 = dot(sh.xy, sh.xy) - b * t0;
      float k = sqrt(a) / sh.z;
      glow = exp(-floor2 / (sh.z * sh.z)) * 0.886227 / k * (erf(k * (t - t0)) - erf(-k * t0));
      at = rd * clamp(t0, 0.0, t);
    }
    // Dust hanging in it where the ray passes nearest, and on a hit, sand
    // pouring down it.
    vec3 q = (at + uOrigin) / uR;
    float dust = 0.5 + 0.5 * noise(q * 1.3 + vec3(0.0, uTime * 0.15, 0.0));
    float pour = uFlare > 0.02
      ? smoothstep(0.5, 0.85, noise(vec3(q.x * 5.0, q.y * 0.4 + uTime * 1.6, q.z * 5.0))) * uFlare * 2.5
      : 0.0;
    haze += SUN * sh.w * glow * (dust * (0.3 + 0.6 * uGlow) + pour) * 0.45 / uR;
  }
  // The warm air of the whole canyon, thickening into the distance.
  return haze + vec3(0.95, 0.52, 0.3) * t * 0.006 / uR * (0.6 + uGlow);
}
`;

const SPONGE = /* glsl */ `
float gyroid(vec3 q) {
  return dot(sin(q), cos(q.yzx));
}

// The lattice: a gyroid's sheet, thick where the music is quiet and opened
// to lace where it swells, with finer pores through it.
float lattice(vec3 p) {
  vec3 q = (p + uWrapped) * uLattice;
  float g = abs(gyroid(q)) - mix(1.0, 0.45, uSwell);
  g += gyroid(q * 3.0 + 1.7) * 0.12;
  return g / (uLattice * 1.7);
}

const float DEPTH = 2.0;   // radii of lattice seen through a passage's wall before it closes up

float wall(vec3 w, vec3 p, float vd) {
  // The passages are carved through it, their cut edges rounded off; past a
  // little depth it fills in solid, which looks the same from inside — the
  // hollows are dark by then — and spares rays wandering far into it.
  return min(smax(-vd, lattice(p), 0.3 * uR), DEPTH * uR - vd);
}

vec3 surface(vec3 w, vec3 p, vec3 n, vec3 rd, float t, float ao) {
  // How far beyond the passage's wall, into the lattice, this is: the
  // passage's own cut edges are lit, what lies past them sinks into shadow,
  // so the passage reads against the lattice it runs through.
  float beyond = clamp((metric(gOff) - gRad) / (DEPTH * uR), 0.0, 1.0);
  // Bone, flushing to coral and then dark down in the hollows.
  vec3 bone = mix(vec3(0.22, 0.07, 0.07), vec3(0.86, 0.46, 0.38), smoothstep(0.15, 0.55, ao));
  bone = mix(bone, vec3(0.98, 0.87, 0.72), smoothstep(0.5, 0.95, ao));
  bone *= 0.9 + 0.2 * noise(w / uR * 3.1);
  bone = tint(bone, ao * 0.5 + gS * 0.01);
  float facing = dot(n, -rd);
  float wrap = max(facing + 0.35, 0.0) / 1.35;
  float shadow = (1.0 - 0.75 * beyond) * (0.12 + 0.88 * ao);
  vec3 col = bone * (0.07 + 1.2 * wrap / (1.0 + t * t * 0.006 / (uR * uR))) * shadow;
  // Light from inside: hits fire a glow up out of the lattice beyond the
  // passage's walls, and the spectrum lies along it, bass nearest and
  // treble furthest.
  vec3 ember = peak(tint(vec3(1.0, 0.48, 0.16), 0.55), uFlare);
  float x = clamp((gS - uCamS) / uFar, 0.0, 1.0);
  float hollow = smoothstep(0.0, 0.6, beyond) * (0.4 + 0.6 * smoothstep(0.8, 0.2, ao));
  col += ember * hollow * (uFlare * 2.2 + spectrum(x) * uGlow * 0.5);
  // A sheen at the grazing edges.
  col += tint(vec3(1.0, 0.95, 0.85), 0.2) * pow(1.0 - max(facing, 0.0), 3.0) * (0.05 + 0.3 * uGlow) * ao * (1.0 - beyond);
  return col;
}
`;

const CARVED = /* glsl */ `
const float AROUND = 6.0;   // copies of the drawing round the wall; even, so the mirrored tiling closes
const float DEPTH = 0.09;   // radii

// The drawing's field here, 0–1, tiled round and along the wall.
float field() {
  vec2 c = wallCoord();
  return texture(uField, vec2(c.x * AROUND, c.y * AROUND / (TAU * uR))).r * seam();
}

// The carving: hollowed as deep as the field, which is gentle enough for
// the march to follow, and lit where the field is cut at a level, so the
// light lies in crisp-edged channels.
float channel(float f) {
  return smoothstep(0.38, 0.62, f);
}

float wall(vec3 w, vec3 p, float vd) {
  nearest(p);
  return -vd + field() * DEPTH * uR * (0.7 + 0.6 * uSwell);
}

vec3 surface(vec3 w, vec3 p, vec3 n, vec3 rd, float t, float ao) {
  float c = channel(field());
  // Dark slate, faintly veined.
  vec3 stone = vec3(0.11, 0.12, 0.14) * (0.75 + 0.5 * noise(w / uR * 3.0));
  float head = headlight(n, rd, t);
  // The stone stays slate whatever the palette; the light carries the colour.
  vec3 col = stone * (0.1 + 1.1 * head) * (0.4 + 0.6 * ao);
  col += vec3(0.45, 0.5, 0.58) * pow(head, 24.0) * 0.2 * ao;
  // Light runs in the channels: the spectrum down the tunnel, bass nearest,
  // each stretch lit as far as its band is loud.
  float x = clamp((gS - uCamS) / uFar, 0.0, 1.0);
  float band = spectrum(x);
  vec3 lamp = tint(vec3(1.0, 0.6, 0.22), mix(LINE, ACCENT, x));
  col += lamp * c * (0.03 + band * band * (0.12 + 0.9 * uGlow));
  // A hit burns them molten, from here out to a front running away down
  // the tunnel.
  col += peak(tint(vec3(1.0, 0.42, 0.1), ACCENT), uFlare) * c * flareFront(gS) * 1.4;
  return col;
}
`;

const CYMATICS = /* glsl */ `
const float RELIEF = 0.05;   // radii
const float NODE = 0.1;      // how wide the sand lines are, of the waves' full sum

// The sum of the drawing's waves standing on the wall, about -1..1.
float plate() {
  vec2 c = wallCoord();
  float sum = 0.0;
  for (int i = 0; i < MAX_WAVES; i++) {
    if (i >= uWaveCount) break;
    vec4 k = uWaves[i];
    sum += k.z * cos(TAU * (k.x * c.x + k.y * c.y) + k.w);
  }
  // Where two passages meet the waves die away, leaving a line of sand.
  return sum * seam();
}

float wall(vec3 w, vec3 p, float vd) {
  nearest(p);
  return -vd - plate() * RELIEF * uR * (0.5 + 0.8 * uSwell);
}

vec3 surface(vec3 w, vec3 p, vec3 n, vec3 rd, float t, float ao) {
  float a = plate();
  // Sand gathers on the nodal lines, where the waves cancel; far off, where
  // the lines are finer than a pixel, it evens out rather than glitter.
  float sand = 1.0 - smoothstep(0.0, NODE, abs(a));
  sand = mix(sand, 0.3, smoothstep(0.25, 0.8, t / uFar));
  float head = headlight(n, rd, t);
  vec3 metal = tint(vec3(0.2, 0.13, 0.08), ACCENT);
  vec3 col = metal * (0.06 + head) * ao;
  col += vec3(0.9, 0.7, 0.45) * pow(head, 18.0) * 0.35 * ao;
  col += tint(vec3(0.95, 0.88, 0.7), LINE) * sand * (0.25 + 0.9 * uGlow + 0.8 * uFlare) * (0.35 + 0.8 * head) * ao;
  return col;
}
`;

const GEODE = /* glsl */ `
const float RING = 13.0;     // crystals round the wall; whole, so the cells close
const float LENGTH = 0.36;   // the longest crystal, in radii

const float FACETS = 6.0;    // faces round a crystal

// The drawing's silhouette at angle a, 0–1.
float outline(float a) {
  float f = fract(a / TAU) * 72.0;
  int i = int(f);
  int j = i == 71 ? 0 : i + 1;
  return mix(uProfile[i >> 2][i & 3], uProfile[j >> 2][j & 3], fract(f));
}

// A crystal's cross-section: a FACETS-sided polygon with its corners on the
// silhouette, so it has a few broad faces, proportioned like the drawing.
float habit(float a) {
  float k = a / (TAU / FACETS);
  float c = floor(k);
  float corner = mix(outline(c * TAU / FACETS), outline((c + 1.0) * TAU / FACETS), k - c);
  // Straight sides between the corners: a polygon's reach falls off as the
  // secant of the angle from the middle of a side.
  return corner * cos(3.14159 / FACETS) / cos((k - c - 0.5) * TAU / FACETS);
}

vec3 cellHash(vec2 c) {
  uvec2 q = uvec2(ivec2(c) + 65536);
  uint h = (q.x * 1597334677u) ^ (q.y * 3812015801u);
  h ^= h >> 16u; h *= 2246822519u; h ^= h >> 13u;
  uint h2 = h * 3266489917u; h2 ^= h2 >> 15u;
  uint h3 = h2 * 668265263u; h3 ^= h3 >> 16u;
  return vec3(h & 0xffffu, h2 & 0xffffu, h3 & 0xffffu) / 65535.0;
}

// Crystals lining the wall, one to a cell, each a pyramid with the
// drawing's silhouette for its cross-section: how far the tallest one here
// stands out, 0–1, and a number to tell it from its neighbours. A crystal
// sits near its cell's middle and reaches at most 0.65 of a cell, so only
// the four cells round the nearest corner can cover a point.
float crystal(out float which) {
  vec2 c = wallCoord();
  vec2 g = vec2(c.x * RING, c.y * RING / (TAU * uR));
  vec2 i = floor(g - 0.5);
  vec2 f = g - i;
  float h = 0.0;
  which = 0.0;
  for (int y = 0; y <= 1; y++) {
    for (int x = 0; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 cell = i + o;
      vec3 r = cellHash(vec2(mod(cell.x, RING), cell.y));
      vec2 d = f - o - (0.35 + 0.3 * r.xy);
      float size = 0.5 + 0.15 * r.z;
      float k = 1.0 - length(d) / (size * (0.35 + 0.65 * habit(atan(d.y, d.x) + r.z * TAU)));
      float ht = k * (0.4 + 0.6 * r.y);
      if (ht > h) { h = ht; which = r.x; }
    }
  }
  return h * seam();
}

float wall(vec3 w, vec3 p, float vd) {
  nearest(p);
  float which;
  return -vd - crystal(which) * LENGTH * uR * (0.6 + 0.6 * uSwell);
}

vec3 surface(vec3 w, vec3 p, vec3 n, vec3 rd, float t, float ao) {
  float which;
  float h = crystal(which);
  // Deep violet at the roots, lavender at the tips, over dull host rock.
  vec3 amethyst = mix(vec3(0.22, 0.06, 0.32), vec3(0.78, 0.6, 0.95), smoothstep(0.05, 0.9, h));
  // Each crystal takes the line colour or the accent; the rock they grow
  // from stays dull.
  float hue = which < 0.5 ? LINE : ACCENT;
  vec3 base = mix(vec3(0.16, 0.14, 0.14), tint(amethyst, hue), smoothstep(0.0, 0.08, h));
  float head = headlight(n, rd, t);
  vec3 col = base * (0.12 + 1.15 * head) * (0.3 + 0.7 * ao);
  // Light held inside the crystals, strongest toward the tips.
  col += tint(amethyst, hue) * h * (0.12 + 0.2 * uGlow) * smoothstep(0.0, 0.08, h);
  // Facets catch the light; each crystal twinkles with its own band.
  float glint = pow(head, 12.0) * (0.25 + spectrum(which) * 2.5 * uGlow) * smoothstep(0.1, 0.5, h);
  col += tint(vec3(0.95, 0.9, 1.0), hue) * glint * ao;
  // A hit lights them from within, tips first.
  col += peak(tint(vec3(0.85, 0.5, 1.0), hue), uFlare) * uFlare * h * h * 1.6;
  return col;
}
`;

const LANTERN = /* glsl */ `
const float RIB = 1.1;       // radii between the bamboo hoops
const float BATTENS = 8.0;   // battens round the frame, outside the paper
const float AROUND = 2.0;    // copies of the drawing round the wall; even, so the mirrored tiling closes
const float LAMP = 3.2;      // radii between the lamps outside, along the tunnel

// 1 on a hoop, falling to 0 a little way off it.
float hoop(float s) {
  float f = fract(s / (RIB * uR));
  return smoothstep(0.09, 0.0, min(f, 1.0 - f) * RIB);
}

float wall(vec3 w, vec3 p, float vd) {
  // Hoops stand in from the paper, which billows out a little between them.
  float billow = sin(fract(gS / (RIB * uR)) * 3.14159) * 0.05 * (0.6 + 0.8 * uSwell);
  return -vd + (billow - hoop(gS) * 0.07) * seam() * uR;
}

vec3 surface(vec3 w, vec3 p, vec3 n, vec3 rd, float t, float ao) {
  vec2 c = wallCoord();
  // Lamps outside, each at its own place round the tunnel, glow through the
  // paper in warm pools, as bright as their stretch of the spectrum is loud:
  // bass nearest, treble furthest.
  float s = gS / (LAMP * uR);
  float k = floor(s);
  float light = 0.0;
  for (int j = 0; j <= 1; j++) {
    float lamp = k + float(j);
    float place = fract(sin(lamp * 12.9898) * 43758.5453);
    float along = (s - lamp) * LAMP;
    float aside = abs(fract(c.x - place + 0.5) - 0.5) * TAU;
    float x = clamp((lamp * LAMP * uR - uCamS) / uFar, 0.0, 1.0);
    light += (0.35 + 1.1 * spectrum(x)) * exp(-along * along * 0.7 - aside * aside * 0.8);
  }
  // A hit turns every lamp up, from here out to a front running away.
  light *= 1.0 + 2.5 * flareFront(gS);
  // Paper, fibrous, glowing with what comes through it: amber where the
  // light is faint, warming to cream in a lamp's pool.
  float fibre = 0.85 + 0.3 * noise(w / uR * 9.0);
  float lit = 0.45 + light * (0.85 + 0.8 * uGlow);
  vec3 paper = mix(vec3(1.0, 0.52, 0.14), vec3(1.0, 0.93, 0.78), smoothstep(0.6, 1.8, lit));
  vec3 glow = tint(paper * fibre, c.x * 0.5) * lit;
  // Shadows on it: the frame's battens, and the drawing as shadow puppets
  // pressed against the paper outside, drifting slowly along.
  float batten = smoothstep(0.035, 0.0, abs(fract(c.x * BATTENS + 0.5) - 0.5));
  vec2 uv = vec2(c.x * AROUND, (c.y + uTime * 0.12 * uR) * AROUND / (TAU * uR));
  float puppet = smoothstep(0.55, 0.6, texture(uField, uv).r) * seam();
  glow *= (1.0 - 0.6 * batten) * (1.0 - 0.85 * puppet);
  // The hoops are bamboo, inside the paper: lit only from in here.
  vec3 bamboo = tint(vec3(0.3, 0.18, 0.07), 0.8) * (0.12 + 0.8 * headlight(n, rd, t) + 0.25 * light);
  // The paper glows the same in a corner as anywhere; only the bamboo is
  // shaded by its surroundings.
  return mix(glow, bamboo * (0.5 + 0.5 * ao), hoop(gS) * seam());
}
`;

const CLOUD = /* glsl */ `
// Heaped cloud: rounded billows on billows on billows, churning slowly.
float billows(vec3 w) {
  vec3 q = w / uR + vec3(uTime * 0.04, 0.0, uTime * 0.03);
  float a = noise(q * 0.45);
  float b = noise(q * 1.3 + 4.1);
  float c = noise(q * 3.4 + 9.3);
  return a * a * 1.2 + b * b * 0.5 + c * c * 0.18;
}

float wall(vec3 w, vec3 p, float vd) {
  return -vd - (billows(w) - 0.6) * 0.4 * (0.7 + 0.6 * uSwell) * uR;
}

// How bright lightning somewhere in the cloud makes p: it glows through the
// vapour all round it, so no need to face it. Flickers while it lasts.
float lightning(vec3 p) {
  float flicker = 0.35 + 0.65 * step(0.45, fract(sin(floor(uTime * 22.0) * 78.233) * 43758.5453));
  vec3 d = p - uFlash.xyz;
  return uFlash.w * flicker / (1.0 + dot(d, d) / (uR * uR * 1.8));
}

vec3 surface(vec3 w, vec3 p, vec3 n, vec3 rd, float t, float ao) {
  // Lit from above: silver on top, slate-blue beneath, and soft — the light
  // wraps round it rather than stopping at the edge of a shadow.
  float up = n.y * 0.5 + 0.5;
  vec3 vapour = mix(vec3(0.26, 0.3, 0.42), vec3(1.0, 0.98, 0.95), smoothstep(0.25, 0.95, up));
  float wrap = (dot(n, -rd) + 0.7) / 1.7;
  vec3 col = tint(vapour, up * 0.3 + gS * 0.005) * (0.25 + 0.75 * ao * ao) * (0.5 + 0.5 * wrap) * (0.65 + 0.5 * uGlow);
  // A silver lining where it turns away.
  col += vec3(0.9, 0.93, 1.0) * pow(1.0 - max(dot(n, -rd), 0.0), 4.0) * 0.2 * ao;
  col += peak(tint(vec3(0.75, 0.82, 1.0), 0.6), uFlash.w) * lightning(p) * 2.2;
  return col;
}

vec3 air(vec3 rd, float t) {
  // Mist in the passage, thickening into the distance, lit up where the
  // ray passes near the lightning.
  vec3 haze = vec3(0.62, 0.66, 0.76) * (1.0 - exp(-t * 0.025 / uR)) * (0.35 + 0.3 * uGlow);
  float near = clamp(dot(uFlash.xyz, rd), 0.0, t);
  return haze + vec3(0.7, 0.78, 1.0) * lightning(rd * near) * 0.5;
}
`;

const ICE = /* glsl */ `
// Melt scallops: a net of sharp ridges between shallow dishes.
float scallops(vec3 q) {
  float r = 1.0 - abs(2.0 * noise(q) - 1.0);
  r *= r;
  return r * r;
}

float wall(vec3 w, vec3 p, float vd) {
  vec3 q = w / uR;
  return -vd - (scallops(q * 1.1) * 0.1 + (noise(q * 0.2) - 0.5) * 0.5) * uR;
}

vec3 surface(vec3 w, vec3 p, vec3 n, vec3 rd, float t, float ao) {
  vec3 q = w / uR;
  float ridge = scallops(q * 1.1);
  float facing = max(dot(n, -rd), 0.0);
  // Light comes through the ice from outside: deep blue where it is thick,
  // pale where it thins along the ridges and wherever it faces you, and
  // brightest down the spectrum's loud stretches.
  float x = clamp((gS - uCamS) / uFar, 0.0, 1.0);
  float thin = clamp(ridge * 0.8 + (1.0 - facing) * 0.25 + 0.1 * noise(q * 3.0), 0.0, 1.0);
  vec3 ice = mix(vec3(0.0, 0.1, 0.3), vec3(0.45, 0.82, 0.98), thin);
  vec3 col = tint(ice, thin * 0.4) * (0.5 + 0.45 * uGlow + 0.45 * spectrum(x)) * (0.45 + 0.55 * ao);
  col += vec3(0.75, 0.92, 1.0) * pow(1.0 - facing, 4.0) * 0.18 * ao;
  col += vec3(1.0) * pow(facing, 40.0) * 0.5 / (1.0 + t * t * 0.01 / (uR * uR));
  // Frost feathers over it in the quiet, and melts back as the bass comes in.
  float frost = smoothstep(0.62, 0.85, noise(q * 2.3) * 0.8 + (1.0 - uSwell) * 0.4);
  vec3 rime = vec3(0.86, 0.93, 1.0) * (0.25 + 0.5 * ao) * (0.45 + headlight(n, rd, t));
  col = mix(col, tint(rime, 0.1), frost * 0.85);
  // A hit cracks it, the fractures lighting from here out to a front
  // running away down the tunnel.
  float crack = smoothstep(0.03, 0.0, abs(noise(q * 0.9 + 2.3) - 0.5)) + smoothstep(0.025, 0.0, abs(noise(q * 2.1 + 7.7) - 0.5)) * 0.6;
  col += peak(tint(vec3(0.7, 0.95, 1.0), 0.5), uFlare) * crack * flareFront(gS) * 2.2;
  return col;
}
`;

const NEON = /* glsl */ `
const float RINGS = 1.0;     // radii between the grid's rings
const float LINES = 16.0;    // lines round; even, so the grid closes

// Brightness of a grid line at offset d from it (in cells), half-width hw:
// a sharp core and a soft halo. Far off the line widens, so it never breaks
// up between pixels, and dims to keep the same light.
float gridLine(float d, float hw) {
  return smoothstep(hw, 0.0, d) * (0.03 / hw) + exp(-d / (hw * 3.0)) * 0.12;
}

float wall(vec3 w, vec3 p, float vd) {
  return -vd;
}

vec3 surface(vec3 w, vec3 p, vec3 n, vec3 rd, float t, float ao) {
  vec2 c = wallCoord();
  float s = c.y / (RINGS * uR);
  float a = c.x * LINES;
  float widen = 1.0 + t * 0.06 / uR;
  float ring = gridLine(abs(fract(s + 0.5) - 0.5), 0.03 * widen);
  float line = gridLine(abs(fract(a + 0.5) - 0.5), 0.03 * widen);
  // The rings carry the spectrum down the tunnel, bass nearest.
  float x = clamp((gS - uCamS) / uFar, 0.0, 1.0);
  vec3 magenta = tint(vec3(1.0, 0.18, 0.72), ACCENT);
  vec3 cyan = tint(vec3(0.1, 0.88, 1.0), LINE);
  // Dashes of data race away along the lines, as bright as the hihats.
  float lane = floor(a + 0.5);
  float dash = smoothstep(0.82, 1.0, fract(s * 0.25 - uTime * 1.6 + fract(sin(lane * 7.13) * 43.71)));
  float grid = seam();
  vec3 col = tint(vec3(0.02, 0.012, 0.04), ACCENT) * (0.25 + headlight(n, rd, t)) * ao;
  col += magenta * ring * grid * (0.3 + 1.3 * spectrum(x));
  col += cyan * line * grid * (0.45 + dash * (0.4 + 3.0 * uGlow));
  // A hit flashes the rings as a front races away past them.
  col += peak(magenta, uFlare) * ring * grid * flareFront(gS) * 2.5;
  return col;
}
`;

const CHROME = /* glsl */ `
// Standing waves round the passage, one to a part of the spectrum: the bass
// long and slow, the treble short and quick.
float ripples(float s) {
  float h = 0.0;
  for (int i = 0; i < 4; i++) {
    float k = float(i);
    h += spectrum(0.08 + k * 0.27) * sin(TAU * s / ((2.4 - k * 0.5) * uR)) * cos(uTime * (1.3 + k * 0.9));
  }
  return h;
}

float wall(vec3 w, vec3 p, float vd) {
  float h = ripples(gS) * 0.03 * (0.5 + uSwell);
  // A hit sends a swell running away down the passage.
  float d = (gS - uFlareS) / uR;
  h += uFlare * exp(-d * d * 1.2) * 0.12;
  // Both run along each passage, so they die away where passages meet,
  // where a mirror would show the join.
  h *= seam();
  // And the whole of it heaves slowly, like something poured.
  h += (noise(w / uR * 0.35 + vec3(0.0, uTime * 0.05, 0.0)) - 0.5) * 0.25;
  return -vd - h * uR;
}

// What the chrome mirrors: the passage itself, in rings round it, dark
// behind and blazing at the far end ahead. Set by the way you look and by
// world up rather than by the nearest passage, so the reflections run on
// unbroken where passages meet.
vec3 surroundings(vec3 r) {
  float ahead = dot(r, uFw);
  float rise = dot(r, UP);
  vec3 col = tint(mix(vec3(0.015, 0.015, 0.025), vec3(0.4, 0.42, 0.48), smoothstep(-0.8, 0.9, rise) * 0.75 + 0.1), ACCENT);
  col *= 0.65 + 0.35 * (0.5 + 0.5 * sin(ahead * 11.0));
  col += tint(vec3(1.0, 0.93, 0.85), LINE) * smoothstep(0.7, 1.0, ahead) * 0.9;
  // The spectrum, bass behind to treble ahead, in coloured bands.
  vec3 band = mix(vec3(1.0, 0.5, 0.2), vec3(0.25, 0.55, 1.0), 0.5 + 0.5 * ahead);
  col += tint(band, mix(ACCENT, LINE, 0.5 + 0.5 * ahead)) * spectrum(0.5 + 0.5 * ahead) * (0.1 + 0.3 * uGlow) * (0.6 + 0.4 * sin(ahead * 23.0));
  return col;
}

vec3 surface(vec3 w, vec3 p, vec3 n, vec3 rd, float t, float ao) {
  vec3 r = reflect(rd, n);
  float facing = max(dot(n, -rd), 0.0);
  float fresnel = 0.6 + 0.4 * pow(1.0 - facing, 5.0);
  // The metal itself stays silver; only what it mirrors takes the colours.
  vec3 col = surroundings(r) * fresnel * vec3(0.92, 0.94, 0.98) * (0.35 + 0.65 * ao);
  col += vec3(1.0) * pow(facing, 60.0) * 0.6 / (1.0 + t * t * 0.01 / (uR * uR));
  col += peak(tint(vec3(1.0, 0.9, 0.8), ACCENT), uFlare) * flareFront(gS) * 0.5 * fresnel;
  return col;
}
`;

export const SUBSTANCES = {
  canyon:   { elong: 1.8, blend: 0.5, step: 0.7, relief: 0.76, uses: ['record', 'shafts'], air: true, glsl: CANYON },
  sponge:   { elong: 1, blend: 0.3, step: 0.55, relief: 0, period: 1.6, uses: [], glsl: SPONGE },
  carved:   { elong: 1, blend: 0.35, step: 0.7, relief: 0, palette: 'style', uses: ['field'], glsl: CARVED },
  cymatics: { elong: 1, blend: 0.35, step: 0.75, relief: 0.07, palette: 'style', uses: ['waves'], glsl: CYMATICS },
  geode:    { elong: 1, blend: 0.4, step: 0.55, relief: 0.44, ring: [0.85, 0.6, 1], palette: 'style', uses: ['profile'], glsl: GEODE },
  lantern:  { elong: 1, blend: 0.3, step: 0.75, relief: 0.08, uses: ['field'], glsl: LANTERN },
  cloud:    { elong: 1.15, blend: 0.6, step: 0.65, relief: 0.67, ring: [0.8, 0.86, 1], uses: ['flash'], air: true, glsl: CLOUD },
  ice:      { elong: 1, blend: 0.35, step: 0.7, relief: 0.35, ring: [0.6, 0.9, 1], uses: [], glsl: ICE },
  neon:     { elong: 1, blend: 0.12, step: 1, relief: 0, ring: [1, 0.3, 0.85], palette: 'style', uses: [], glsl: NEON },
  chrome:   { elong: 1, blend: 0.7, step: 0.75, relief: 0.43, ring: [0.95, 0.97, 1], palette: 'style', uses: [], glsl: CHROME },
};
