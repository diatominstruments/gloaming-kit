/**
 * Timeline — maps song time to the set of visualizations that should be on
 * screen, and how each one is wired to the audio. Config is a list of
 * windows:
 *
 *   [{ from: 0, to: 60, visualizations: ['eq-bars'] },
 *    { from: 60, to: 120, visualizations: [
 *        'waveform',
 *        { id: 'radial-burst', bind: { ring: 'hihat', core: 'treble' } },
 *      ] }]
 *
 * An entry is either a bare id or `{ id, bind, options }`, where `bind`
 * overrides individual input slots declared by that visualization (see
 * base.js for slots and signals.js for what a binding may contain) and
 * `options` carries per-instance settings unrelated to audio. Slots left
 * unbound use their declared defaults.
 *
 *   { id: 'thomas', options: { distance: 'far' } }
 *
 * A window may also carry a partial `style`, which overrides the engine's
 * base style while the window is running:
 *
 *   { from: 60, to: 90, visualizations: ['tunnel'], style: { lineColor: '#ffb347' } }
 *
 * An entry may also be placed, clipped, blended and styled on its own (see
 * placement.js for the first three):
 *
 *   { id: 'tunnel', place: { x: 0.5, w: 0.5 }, clip: 'circle', blend: 'screen',
 *     opacity: 0.8, style: { lineColor: '#ffb347' } }
 *
 * An entry's `style` layers over the window's and the base style, for that
 * instance only.
 *
 * How entries come and go is set by `transition` (see placement.js) and
 * `fade` (seconds), on a window for all its entries or on an entry for
 * itself; the entry's own win:
 *
 *   { from: 30, to: 60, transition: 'wipe-left', fade: 1.2, visualizations: [
 *       'tunnel', { id: 'scanlines', transition: 'cut' } ] }
 *
 * Windows may overlap; the active set is the union of all matching windows.
 * Overlapping styles cascade in config order, so a later window's keys win
 * over an earlier one's. `to: Infinity` (or omitted) runs to the end.
 */

/**
 * Stable identity for an entry — the same id wired, configured or placed two
 * ways is two instances, so both can be on screen at once. `style` and
 * `opacity` are left out on purpose: an instance that carries on into the
 * next window with a different colour or opacity eases to it, as window
 * styles do, rather than crossfading into a new instance. Nor are `fade`
 * and `transition`: they say how an instance comes and goes, not which one
 * it is.
 */
const keyOf = (entry) => {
  let key = entry.id;
  if (entry.bind) key += `#${JSON.stringify(entry.bind)}`;
  if (entry.options) key += `@${JSON.stringify(entry.options)}`;
  if (entry.place) key += `[${JSON.stringify(entry.place)}]`;
  if (entry.clip) key += `|${JSON.stringify(entry.clip)}`;
  if (entry.blend) key += `~${entry.blend}`;
  return key;
};

const normalize = (entry, window) => {
  const src = typeof entry === 'string' ? { id: entry } : entry;
  const e = {
    id: src.id,
    bind: src.bind ?? null,
    options: src.options ?? null,
    place: src.place ?? null,
    clip: src.clip ?? null,
    blend: src.blend ?? null,
    opacity: src.opacity ?? null,
    style: src.style ?? null,
    fade: src.fade ?? window.fade ?? null,
    transition: src.transition ?? window.transition ?? null,
  };
  return { ...e, key: keyOf(e) };
};

export class Timeline {
  constructor(windows = []) {
    this.setWindows(windows);
  }

  setWindows(windows) {
    this.windows = windows.map((w) => ({
      from: w.from ?? 0,
      to: w.to ?? Infinity,
      visualizations: (w.visualizations ?? []).map((entry) => normalize(entry, w)),
      style: w.style ?? null,
    }));
  }

  /**
   * Merged style patch from every window covering time t, or null if none
   * carry one. Later windows override earlier ones key by key.
   */
  styleAt(t) {
    let merged = null;
    for (const w of this.windows) {
      if (w.style && t >= w.from && t < w.to) {
        merged = merged ? { ...merged, ...w.style } : w.style;
      }
    }
    return merged;
  }

  /**
   * Entries active at song time t (seconds), keyed by instance identity.
   * Two windows naming the same visualization with different bindings yield
   * two entries, so both can be on screen at once.
   */
  activeAt(t) {
    const active = new Map();
    for (const w of this.windows) {
      if (t >= w.from && t < w.to) {
        for (const entry of w.visualizations) {
          if (!active.has(entry.key)) active.set(entry.key, entry);
        }
      }
    }
    return active;
  }
}
