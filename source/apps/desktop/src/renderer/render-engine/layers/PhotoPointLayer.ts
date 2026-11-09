import { ScatterplotLayer } from "@deck.gl/layers";
import type { Layer } from "@deck.gl/core";
import type { ReplayLayerFactory } from "../LayerRegistry";
import { photoPointRadiusStops } from "../PhotoPoints";

class PhotoPointLayer extends ScatterplotLayer {
  static layerName = "PhotoPointLayer";

  getShaders() {
    const shaders = super.getShaders();
    const [lowZoom, lowRadius, midZoom, midRadius, highZoom, highRadius] = photoPointRadiusStops.map(value => value.toFixed(2));
    // Read the viewport's zoom at draw time. Camera changes leave the
    // binary position attributes untouched, including repeated worlds.
    return {...shaders, inject: {
      ...shaders.inject,
      "vs:DECKGL_FILTER_SIZE": `
        float zoom = log2(project.scale);
        float radius = zoom < ${midZoom}
          ? mix(${lowRadius}, ${midRadius}, clamp((zoom - ${lowZoom}) / (${midZoom} - ${lowZoom}), 0.0, 1.0))
          : mix(${midRadius}, ${highRadius}, clamp((zoom - ${midZoom}) / (${highZoom} - ${midZoom}), 0.0, 1.0));
        size *= radius;
      `,
    }};
  }
}

export const buildPhotoPointLayer: ReplayLayerFactory<Layer> = scene => {
  if (!scene.photos?.length) return [];
  return [new PhotoPointLayer({
    id: "map/photo-visual", data: scene.photos, radiusUnits: "pixels", getRadius: 1,
    getFillColor: [255, 227, 110, 209], billboard: true, pickable: false, wrapLongitude: true,
    parameters: {depthCompare: "always"},
  })];
};
