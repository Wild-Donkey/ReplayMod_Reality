import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Layer } from "@deck.gl/core";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { ReplayLayerFactory } from "../LayerRegistry";
import { parseReplayColor } from "../ReplayColor";
import { annotationPickingGeometry, annotationVisualGeometry, legacyMapAnnotationGeometry } from "../AnnotationGeometry";

type AnnotationFeature = Feature<Geometry>;
const cachedFeatures = new WeakMap<FeatureCollection<Geometry>, ReadonlySet<AnnotationFeature>>();

// Identity validation rejects hits from a previous annotation edit even when
// the replacement feature happens to retain the same business ID.
export function isCurrentAnnotationFeature(geometry: FeatureCollection<Geometry>, feature: unknown): feature is AnnotationFeature {
  const data = annotationPickingGeometry(geometry);
  let features = cachedFeatures.get(data);
  if (!features) { features = new Set(data.features); cachedFeatures.set(data, features); }
  return features.has(feature as AnnotationFeature);
}

// Keep the verified MapLibre visuals during the picking migration. The same
// scene geometry feeds this pass, selection and export; drafts cannot be picked.
export const buildAnnotationPickingLayer: ReplayLayerFactory<Layer> = scene => {
  const data = annotationPickingGeometry(scene.annotationGeometry);
  if (!data.features.length) return [];
  return [new GeoJsonLayer({
    id: "map/annotation-picking", data, pickable: true,
    stroked: true, filled: true, lineWidthUnits: "pixels", pointRadiusUnits: "pixels",
    getLineWidth: feature => feature.properties?.selected ? 3 : 2,
    getPointRadius: feature => feature.properties?.selected ? 4 : 2.5,
    getLineColor: [255, 255, 255, 255], getFillColor: [255, 255, 255, 255],
    parameters: {depthCompare: "always"}, wrapLongitude: true,
  })];
};

export function annotationColor(value: unknown): [number, number, number, number] {
  return [...(typeof value === "string" ? parseReplayColor(value) : null) ?? [85, 207, 255, 255]] as [number, number, number, number];
}
const annotationVisualLayer = (includePlaceMarkers: boolean): ReplayLayerFactory<Layer> => scene => {
  const data = annotationVisualGeometry(includePlaceMarkers ? scene.annotationGeometry : legacyMapAnnotationGeometry(scene.annotationGeometry));
  if (!data.features.length) return [];
  return [new GeoJsonLayer({
    id: "map/annotation-visual", data, pickable: false, stroked: true, filled: true,
    lineCapRounded: true, lineJointRounded: true,
    lineWidthUnits: "pixels", pointRadiusUnits: "pixels",
    getLineWidth: feature => feature.geometry.type === "Point" ? 0.75 : feature.properties?.selected ? 3 : 2,
    getPointRadius: feature => feature.properties?.selected ? 4 : 2.5,
    getLineColor: feature => feature.geometry.type === "Point" ? [255, 255, 255, 255] : annotationColor(feature.properties?.color),
    getFillColor: feature => annotationColor(feature.properties?.color),
    parameters: {depthCompare: "always"}, wrapLongitude: true,
  })];
};
export const buildAnnotationVisualLayer = annotationVisualLayer(true);
export const buildAnnotationRouteVisualLayer = annotationVisualLayer(false);


export const annotationHandleLayerId = "map/annotation-handles";
export const buildAnnotationHandleLayer: ReplayLayerFactory<Layer> = scene => {
  if (!scene.annotationHandles.length) return [];
  return [new ScatterplotLayer({
    id: annotationHandleLayerId, data: scene.annotationHandles,
    getPosition: point => [point[0], point[1]], billboard: true, wrapLongitude: true,
    radiusUnits: "pixels", getRadius: 3, lineWidthUnits: "pixels", getLineWidth: 1,
    stroked: true, getFillColor: [41, 171, 223, 255], getLineColor: [255, 255, 255, 255],
    pickable: false, parameters: {depthCompare: "always"},
  })];
};
