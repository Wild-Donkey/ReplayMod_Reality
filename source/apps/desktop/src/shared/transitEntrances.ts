import type { Feature, FeatureCollection, Geometry, Point } from "geojson";

export const ENTRANCE_ZOOM = 17;
export type TransitEntrances = FeatureCollection<Point, {ref: string}>;

/** Prefer numbered points from Planet v4 while retaining older anonymous POIs
 * when the newer source has not loaded or lacks a matching entrance. */
export function mergeTransitEntrances(base: Feature<Geometry>[], detailed: Feature<Geometry>[]): TransitEntrances {
  const features: TransitEntrances["features"] = [];
  const seen = new Set<string>();
  const detailedPoints = detailed.filter(feature => feature.geometry.type === "Point" && feature.properties?.subclass === "subway_entrance");
  const detailedSet = new Set(detailedPoints);
  for (const feature of [...detailed, ...base]) {
    if (feature.geometry.type !== "Point" || feature.properties?.subclass !== "subway_entrance") continue;
    const coordinate = feature.geometry.coordinates;
    const key = coordinate.map(value => value.toFixed(6)).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    const ref = String(feature.properties?.ref ?? feature.properties?.local_ref ?? "").trim().slice(0, 32);
    // Tile buffers repeat features. Prefer explicit numbered entrances over an
    // anonymous copy from the older source, without merging distinct exits.
    if (!detailedSet.has(feature) && detailedPoints.some(entrance => {
      const point = (entrance.geometry as Point).coordinates;
      return Math.hypot((point[0] - coordinate[0]) * Math.cos(coordinate[1] * Math.PI / 180), point[1] - coordinate[1]) * 111_320 < 8;
    })) continue;
    features.push({
      type: "Feature", id: "entrance-" + key,
      geometry: {type: "Point", coordinates: coordinate}, properties: {ref},
    });
  }
  features.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return {type: "FeatureCollection", features};
}
