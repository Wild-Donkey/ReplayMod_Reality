import type { Feature, FeatureCollection, Geometry, Point, Position } from "geojson";

export interface TransitFeature {
  source: string;
  sourceLayer?: string;
  geometry: Geometry;
  properties: Record<string, unknown> | null;
}

type Bounds = [number, number, number, number];
type Route = {id: string; color: string; paths: Position[][]; bounds: Bounds; connections: boolean};
type Station = {name: string; centers: Position[]; routes: Map<string, string>};
type StationProperties = {name: string; color: string; interchange: boolean};

function bounds(points: Position[]): Bounds {
  return points.reduce<Bounds>((box, point) => [
    Math.min(box[0], point[0]), Math.min(box[1], point[1]),
    Math.max(box[2], point[0]), Math.max(box[3], point[1]),
  ], [Infinity, Infinity, -Infinity, -Infinity]);
}

const overlaps = (a: Bounds, b: Bounds) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const cross = (a: Position, b: Position, p: Position) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);

function onSegment(a: Position, b: Position, p: Position) {
  return Math.abs(cross(a, b, p)) < 1e-12
    && p[0] >= Math.min(a[0], b[0]) - 1e-10 && p[0] <= Math.max(a[0], b[0]) + 1e-10
    && p[1] >= Math.min(a[1], b[1]) - 1e-10 && p[1] <= Math.max(a[1], b[1]) + 1e-10;
}

function inside(point: Position, ring: Position[]) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if (onSegment(a, b, point)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

function servesStation(route: Route, ring: Position[]) {
  return route.paths.some(path => {
    // External route segments only qualify at an endpoint. A line crossing a
    // station without stopping there must not create an interchange.
    if (!route.connections) return inside(path[0], ring) || inside(path[path.length - 1], ring);
    if (path.some(point => inside(point, ring))) return true;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      for (let j = 1; j < ring.length; j++) {
        const c = ring[j - 1], d = ring[j];
        if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true;
      }
    }
    return false;
  });
}

/** LOOM polygons describe station symbols, not station buildings. Use them
 * only to recover a site and its serving routes, then emit one point per site. */
export function transitStationPoints(stations: TransitFeature[], lines: TransitFeature[]): FeatureCollection<Point, StationProperties> {
  const routes: Route[] = [];
  for (const line of lines) {
    const properties = line.properties ?? {};
    const color = String(properties["line-color"] ?? "");
    if (properties.color !== color || !/^(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(color)) continue;
    const geometryPaths = line.geometry.type === "LineString" ? [line.geometry.coordinates]
      : line.geometry.type === "MultiLineString" ? line.geometry.coordinates : [];
    const paths = geometryPaths.filter(path => path.length >= 2);
    if (!paths.length) continue;
    routes.push({
      id: line.source + ":" + String(properties.line || properties.class || color),
      color: "#" + color, paths, bounds: bounds(paths.flat()),
      connections: line.sourceLayer === "inner-connections",
    });
  }

  const sites = new Map<string, Station[]>();
  const seen = new Set<string>();
  for (const feature of stations) {
    const name = String(feature.properties?.stationLabel ?? "").trim();
    const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates]
      : feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates : [];
    for (const polygon of polygons) {
      const ring = polygon[0];
      if (!ring?.length) continue;
      const box = bounds(ring);
      const center = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
      const identity = feature.source + ":" + name + ":" + center.map(value => value.toFixed(7)).join(",");
      if (seen.has(identity)) continue;
      seen.add(identity);
      // Merge duplicate tiles and co-located platforms across transit networks.
      const siteKey = name || String(feature.properties?.stationId || identity);
      const candidates = sites.get(siteKey) ?? [];
      let site = candidates.find(candidate => {
        const anchor = candidate.centers[0];
        const dx = (anchor[0] - center[0]) * Math.cos(center[1] * Math.PI / 180);
        return Math.hypot(dx, anchor[1] - center[1]) * 111_320 < 150;
      });
      if (!site) {
        site = {name, centers: [], routes: new Map()};
        candidates.push(site);
        sites.set(siteKey, candidates);
      }
      site.centers.push(center);
      for (const route of routes) {
        if (overlaps(box, route.bounds) && servesStation(route, ring)) site.routes.set(route.id, route.color);
      }
    }
  }

  const features: Feature<Point, StationProperties>[] = [];
  for (const site of [...sites.values()].flat()) {
    if (!site.routes.size) continue;
    const center = [0, 0];
    for (const point of site.centers) { center[0] += point[0]; center[1] += point[1]; }
    center[0] /= site.centers.length;
    center[1] /= site.centers.length;
    features.push({
      type: "Feature", id: site.name + ":" + center.map(value => value.toFixed(7)).join(","),
      geometry: {type: "Point", coordinates: center},
      properties: {name: site.name, color: site.routes.values().next().value!, interchange: site.routes.size > 1},
    });
  }
  features.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return {type: "FeatureCollection", features};
}
