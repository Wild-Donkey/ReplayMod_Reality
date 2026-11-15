import type { FeatureCollection, Point, Position } from "geojson";
import type { TransitFeature } from "./transitStations";

export const operationalTransit = (properties: Record<string, unknown> | null) =>
  properties?.construction !== true && properties?.construction !== "true" && properties?.construction !== 1
  && !properties?.service;

/** Current provider stations are real POIs; route proximity supplies their colour. */
export function currentTransitStationPoints(stations: TransitFeature[], lines: TransitFeature[]): FeatureCollection<Point, {name: string; color: string; interchange: boolean}> {
  const routes = lines.filter(line => operationalTransit(line.properties) && line.properties?.main === true
    && /^#[\da-f]{6}$/i.test(String(line.properties?.colour)));
  const features: FeatureCollection<Point, {name: string; color: string; interchange: boolean}>["features"] = [];
  for (const station of stations) {
    const properties = station.properties ?? {};
    if (station.geometry.type !== "Point" || properties.subclass !== "subway" || !operationalTransit(properties)) continue;
    const name = String(properties.name ?? "").trim();
    if (!name) continue;
    const center = station.geometry.coordinates;
    const cos = Math.cos(center[1] * Math.PI / 180);
    if (features.some(feature => feature.properties.name === name && Math.hypot(
      (feature.geometry.coordinates[0] - center[0]) * cos, feature.geometry.coordinates[1] - center[1],
    ) * 111320 < 150)) continue;
    const distance = (a: Position, b: Position) => {
      const ax = (a[0] - center[0]) * cos * 111320, ay = (a[1] - center[1]) * 111320;
      const bx = (b[0] - center[0]) * cos * 111320, by = (b[1] - center[1]) * 111320;
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(ax + t * dx, ay + t * dy);
    };
    const serving = new Map<string, string>();
    for (const route of routes) {
      const paths = route.geometry.type === "LineString" ? [route.geometry.coordinates]
        : route.geometry.type === "MultiLineString" ? route.geometry.coordinates : [];
      if (!paths.some(path => path.some((point, i) => i > 0 && distance(path[i - 1], point) <= 120))) continue;
      const p = route.properties!;
      serving.set(`${p.network ?? ""}:${p.ref ?? p.colour}`, String(p.colour));
    }
    if (!serving.size) continue;
    features.push({type: "Feature", geometry: {type: "Point", coordinates: center}, properties: {
      name, color: serving.values().next().value!, interchange: serving.size > 1,
    }});
  }
  return {type: "FeatureCollection", features};
}
