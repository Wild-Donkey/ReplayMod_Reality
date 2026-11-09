import { ScatterplotLayer } from "@deck.gl/layers";
import type { Layer } from "@deck.gl/core";
import type { ReplayLayerFactory } from "../LayerRegistry";
import type { TrajectoryBuffer } from "../buffers/TrajectoryBuffer";

const binaryData = new WeakMap<TrajectoryBuffer, {length: number; attributes: {getPosition: {value: Float64Array; size: 2}}}>();

// Until the float-density pass migrates, this layer participates only in the
// picking pass. It must not add a second visible trajectory or alter its tone.
export const buildTrajectoryPickingLayer: ReplayLayerFactory<Layer> = scene => {
  const trajectory = scene.trajectory;
  if (!trajectory?.length) return [];
  let data = binaryData.get(trajectory);
  if (!data) {
    data = {length: trajectory.length, attributes: {getPosition: {value: trajectory.positions, size: 2}}};
    binaryData.set(trajectory, data);
  }
  return [new ScatterplotLayer({
    id: "map/trajectory-picking", data, pickable: true, radiusUnits: "pixels", getRadius: 1,
    getFillColor: [255, 255, 255, 255], antialiasing: false, wrapLongitude: true,
    parameters: {depthCompare: "always"},
  })];
};
