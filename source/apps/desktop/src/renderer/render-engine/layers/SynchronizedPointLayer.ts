import { ScatterplotLayer } from "@deck.gl/layers";
import type { Layer } from "@deck.gl/core";
import type { ReplayLayerFactory } from "../LayerRegistry";
import { synchronizedPoint } from "../SynchronizedPoint";

// One engine-owned map layer consumes every view's shared cursor and clock.
export const buildSynchronizedPointLayer: ReplayLayerFactory<Layer> = (scene, clock) => {
  const coordinate = synchronizedPoint(scene, clock);
  if (!coordinate) return [];
  return [new ScatterplotLayer({
    id: "map/synchronized-point",
    data: [coordinate],
    getPosition: point => [point[0], point[1]],
    radiusUnits: "pixels",
    getRadius: 5,
    stroked: true,
    getFillColor: [255, 149, 140, 255],
    getLineColor: [255, 255, 255, 255],
    lineWidthUnits: "pixels",
    getLineWidth: 2,
    pickable: false,
    parameters: {depthCompare: "always"},
  })];
};
