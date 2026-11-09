import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { AnnotationProject, MapCoordinate } from "../../../../../packages/data/src";
import { visibleAnnotations } from "../features/annotations/annotations";

export function committedAnnotationGeometry(geometry: FeatureCollection<Geometry>): FeatureCollection<Geometry> {
  return geometry.features.some(feature => feature.id === "draft")
    ? {...geometry, features: geometry.features.filter(feature => feature.id !== "draft")}
    : geometry;
}

export function compileAnnotationGeometry(
  project: AnnotationProject,
  selectedId: string | null,
  draft: readonly MapCoordinate[] = [],
): FeatureCollection<Geometry> {
  const features: FeatureCollection<Geometry> = {
    type: "FeatureCollection",
    features: visibleAnnotations(project).filter(node => node.kind === "route" && node.coordinates.length > 1 || node.kind === "point" && node.coordinates.length > 0).map(node => ({
      type: "Feature", id: node.id,
      properties: {id: node.id, name: node.name, color: node.color ?? "#55cfff", selected: node.id === selectedId},
      geometry: node.kind === "point" ? {type: "Point", coordinates: [...node.coordinates[0]]} : {type: "LineString", coordinates: node.coordinates.map(coordinate => [...coordinate])},
    })),
  };
  if (draft.length) features.features.push({
    type: "Feature", id: "draft", properties: {id: "draft", color: "#ffe36e", selected: false},
    geometry: draft.length > 1
      ? {type: "LineString", coordinates: draft.map(coordinate => [...coordinate])}
      : {type: "Point", coordinates: [...draft[0]]},
  });
  return features;
}

const legacyGeometry = new WeakMap<FeatureCollection<Geometry>, FeatureCollection<Geometry>>();
// Point labels currently own committed place markers. Keep the original map
// appearance until the GPU visual layer replaces that label/marker path.
export function legacyMapAnnotationGeometry(geometry: FeatureCollection<Geometry>): FeatureCollection<Geometry> {
  const cached = legacyGeometry.get(geometry);
  if (cached) return cached;
  const features = geometry.features.filter(feature => feature.geometry.type !== "Point" || feature.id === "draft");
  const result = features.length === geometry.features.length ? geometry : {...geometry, features};
  legacyGeometry.set(geometry, result);
  return result;
}

const visualGeometry = new WeakMap<FeatureCollection<Geometry>, FeatureCollection<Geometry>>();
const pickingGeometry = new WeakMap<FeatureCollection<Geometry>, FeatureCollection<Geometry>>();

// Annotation coordinates may contain survey elevations. Current map routes
// are drawn on the map plane; use the same XY geometry for GPU hit testing.
export function annotationVisualGeometry(geometry: FeatureCollection<Geometry>): FeatureCollection<Geometry> {
  let cached = visualGeometry.get(geometry);
  if (cached) return cached;
  cached = {type: "FeatureCollection", features: geometry.features.flatMap<Feature<Geometry>>(feature => {
    if (feature.geometry.type === "LineString") return [{...feature, geometry: {type: "LineString" as const, coordinates: feature.geometry.coordinates.map(coordinate => coordinate.slice(0, 2))}}];
    if (feature.geometry.type === "Point") return [{...feature, geometry: {type: "Point" as const, coordinates: feature.geometry.coordinates.slice(0, 2)}}];
    return [];
  })};
  visualGeometry.set(geometry, cached);
  return cached;
}

export function annotationPickingGeometry(geometry: FeatureCollection<Geometry>): FeatureCollection<Geometry> {
  let data = pickingGeometry.get(geometry);
  if (!data) { data = committedAnnotationGeometry(annotationVisualGeometry(geometry)); pickingGeometry.set(geometry, data); }
  return data;
}

export interface ReplayAnnotationLabel {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly selected: boolean;
  readonly coordinate: readonly number[];
}
const labelPoints = new WeakMap<FeatureCollection<Geometry>, readonly ReplayAnnotationLabel[]>();
export function annotationLabelPoints(geometry: FeatureCollection<Geometry>) {
  const cached = labelPoints.get(geometry);
  if (cached) return cached;
  const points: ReplayAnnotationLabel[] = [];
  for (const feature of geometry.features) {
    if (feature.id === "draft" || feature.geometry.type !== "Point") continue;
    const coordinate = feature.geometry.coordinates;
    if (!Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) continue;
    const id = String(feature.properties?.id ?? feature.id ?? "");
    if (!id) continue;
    points.push({id, name: String(feature.properties?.name ?? ""), color: String(feature.properties?.color ?? "#55cfff"), selected: feature.properties?.selected === true, coordinate});
  }
  labelPoints.set(geometry, points);
  return points;
}
