/**
 * Draw layers. The engine paints active visualizations back to front by
 * layer, and in the order they came on screen within a layer, so a
 * background that starts after a foreground figure still lands behind it.
 *
 * A visualization names its layer with `static layer = LAYER.BACKGROUND`;
 * one that names none, or names a layer not listed here, draws in MAIN.
 *
 * Layer is independent of category: category groups a picker, layer decides
 * what covers what.
 */
export const LAYER = Object.freeze({
  BACKGROUND: 'background',
  MAIN: 'main',
  OVERLAY: 'overlay',
});

/** Layer ids back to front. */
export const LAYERS = Object.freeze([LAYER.BACKGROUND, LAYER.MAIN, LAYER.OVERLAY]);

/** Sort rank of a layer id; unknown ids rank as MAIN. */
export const layerRank = (layer) => {
  const i = LAYERS.indexOf(layer);
  return i === -1 ? LAYERS.indexOf(LAYER.MAIN) : i;
};
