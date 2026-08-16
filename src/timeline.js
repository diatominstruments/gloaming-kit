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
 * An entry is either a bare id or `{ id, bind }`, where `bind` overrides
 * individual input slots declared by that visualization (see base.js for
 * slots and signals.js for what a binding may contain). Slots left unbound
 * use their declared defaults.
 *
 * A window may also carry a partial `style`, which overrides the engine's
 * base style while the window is running:
 *
 *   { from: 60, to: 90, visualizations: ['tunnel'], style: { lineColor: '#ffb347' } }
 *
 * Windows may overlap; the active set is the union of all matching windows.
 * Overlapping styles cascade in config order, so a later window's keys win
 * over an earlier one's. `to: Infinity` (or omitted) runs to the end.
 */

/** Stable identity for an entry — the same id wired two ways is two instances. */
const keyOf = (entry) =>
  (entry.bind ? `${entry.id}#${JSON.stringify(entry.bind)}` : entry.id);

const normalize = (entry) => {
  const e = typeof entry === 'string'
    ? { id: entry, bind: null }
    : { id: entry.id, bind: entry.bind ?? null };
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
      visualizations: (w.visualizations ?? []).map(normalize),
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
