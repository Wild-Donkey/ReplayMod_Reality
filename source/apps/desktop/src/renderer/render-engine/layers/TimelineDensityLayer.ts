import { COORDINATE_SYSTEM, type Layer } from "@deck.gl/core";
import { SolidPolygonLayer } from "@deck.gl/layers";
import type { ReplayLayerFactory } from "../LayerRegistry";
import { timelineDensityBuffer } from "../TimelineDensity";

export const buildTimelineDensityLayer: ReplayLayerFactory<Layer> = scene => {
  if (!scene.timelineDensity) return [];
  return [new SolidPolygonLayer({
    id: "timeline-density/strip", data: timelineDensityBuffer(scene.timelineDensity),
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, _normalize: false,
    filled: true, extruded: false, pickable: false, parameters: {depthCompare: "always"},
  })];
};
