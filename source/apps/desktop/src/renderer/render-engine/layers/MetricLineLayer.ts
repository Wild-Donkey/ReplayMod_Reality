import { COORDINATE_SYSTEM, type Layer } from "@deck.gl/core";
import { LineLayer, SolidPolygonLayer } from "@deck.gl/layers";
import type { ReplayLayerFactory } from "../LayerRegistry";
import { metricArea, metricSegments, type ReplayMetricViewId } from "../MetricSeries";

export const buildMetricPickingLayer = (viewId: ReplayMetricViewId): ReplayLayerFactory<Layer> => scene => {
  const series = scene.metricSeries[viewId];
  if (!series) return [];
  const data = metricSegments(series);
  if (!data.length) return [];
  return [new LineLayer({
    id: `${viewId}/metric-picking/${series.id}`, data, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    pickable: true, widthUnits: "pixels", getWidth: 1.5, getColor: [255, 255, 255, 255],
    parameters: {depthCompare: "always"},
  })];
};

// Visible and picking layers consume the same normalized segment attributes.
// Rollout is separate from implementation so verified legacy plots can remain
// available while the real-pixel acceptance suite runs.
export const buildMetricVisualLayers = (viewId: ReplayMetricViewId): ReplayLayerFactory<Layer> => scene => {
  const series = scene.metricSeries[viewId];
  if (!series) return [];
  const data = metricSegments(series);
  if (!data.length) return [];
  const color: [number, number, number, number] = [...(series.color ?? (viewId === "timeline" ? [115, 200, 255, 255] : [85, 207, 255, 255]))] as [number, number, number, number];
  const layers: Layer[] = [];
  if ((series.areaOpacity ?? (viewId === "timeline" ? 0.1 : 0)) > 0) {
    const area = metricArea(series);
    if (area.length) layers.push(new SolidPolygonLayer({id: `${viewId}/metric-area/${series.id}`, data: area, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, _normalize: false, filled: true, extruded: false, pickable: false, getFillColor: [color[0], color[1], color[2], Math.round(color[3] * (series.areaOpacity ?? 0.1))], parameters: {depthCompare: "always"}}));
  }
  layers.push(new LineLayer({id: `${viewId}/metric-line/${series.id}`, data, coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, pickable: false, widthUnits: "pixels", getWidth: series.lineWidth ?? (viewId === "timeline" ? 1.5 : 2), getColor: color, parameters: {depthCompare: "always"}}));
  return layers;
};
