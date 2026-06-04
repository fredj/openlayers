import {getWidth} from '../../extent.js';
import {apply as applyTransform} from '../../transform.js';

const tmpCoord_ = [0, 0];

/**
 * Applies an affine transform to the min and max corners of an extent, writing
 * the result into `dest`. Only the two corners are transformed, so the transform
 * must be axis-aligned (no rotation) — which is the case for the world↔buffer-local
 * transforms used by the WebGL renderers to express the render extent uniform.
 * @param {import("../../extent.js").Extent} extent Extent to transform.
 * @param {import("../../transform.js").Transform} transform Affine transform to apply.
 * @param {import("../../extent.js").Extent} dest Destination extent, written in place.
 * @return {import("../../extent.js").Extent} The `dest` extent.
 */
export function transformExtent2D(extent, transform, dest) {
  tmpCoord_[0] = extent[0];
  tmpCoord_[1] = extent[1];
  applyTransform(transform, tmpCoord_);
  dest[0] = tmpCoord_[0];
  dest[1] = tmpCoord_[1];
  tmpCoord_[0] = extent[2];
  tmpCoord_[1] = extent[3];
  applyTransform(transform, tmpCoord_);
  dest[2] = tmpCoord_[0];
  dest[3] = tmpCoord_[1];
  return dest;
}

/**
 * Compute world params
 * @param {import("../../Map.js").FrameState} frameState Frame state.
 * @param {any} layer The layer
 * @return {Array<number>} The world start, end and width.
 */
export function getWorldParameters(frameState, layer) {
  const projection = frameState.viewState.projection;

  const vectorSource = layer.getSource();
  const multiWorld = vectorSource.getWrapX() && projection.canWrapX();
  const projectionExtent = projection.getExtent();

  const extent = frameState.extent;
  const worldWidth = multiWorld ? getWidth(projectionExtent) : null;
  const endWorld = multiWorld
    ? Math.ceil((extent[2] - projectionExtent[2]) / worldWidth) + 1
    : 1;

  const startWorld = multiWorld
    ? Math.floor((extent[0] - projectionExtent[0]) / worldWidth)
    : 0;

  return [startWorld, endWorld, worldWidth];
}
