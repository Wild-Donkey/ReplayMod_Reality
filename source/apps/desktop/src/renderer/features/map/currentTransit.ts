import type { ExpressionSpecification, Map as GLMap } from "maplibre-gl";
import { networkHull, networkFillsViewport, type NetworkPoint } from "./transitNetworkScale";
import { currentTransitStationPoints, operationalTransit } from "./currentTransitStations";
import type { TransitFeature } from "./transitStations";

export const CURRENT_TRANSIT_SOURCE = "urban-transit-current";
const key: ExpressionSpecification = ["coalesce", ["get", "network"], ["get", "operator"], "unnamed"];
const operational: ExpressionSpecification = ["all", ["!=", ["get", "construction"], true],
  ["!=", ["get", "construction"], "true"], ["!", ["has", "service"]], ["==", ["get", "main"], true]];

export function addCurrentTransit(map: GLMap, apiKey: string, before?: string) {
  map.addSource(CURRENT_TRANSIT_SOURCE, {type: "vector", url: `https://api.maptiler.com/tiles/v4/tiles.json?key=${encodeURIComponent(apiKey)}`});
  const layers: string[] = [];
  for (const casing of [true, false]) {
    const id = `urban-transit-current-${casing ? "casing" : "lines"}`;
    layers.push(id);
    map.addLayer({id, type: "line", source: CURRENT_TRANSIT_SOURCE, "source-layer": "subway", minzoom: 10,
      filter: ["all", operational, ["in", key, ["literal", []]]],
      layout: {"line-cap": "round", "line-join": "round"},
      paint: {
        "line-color": casing ? "#181b22" : ["to-color", ["get", "colour"], "#a49ce0"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, casing ? 2.45 : 1.35, 14, casing ? 3.2 : 2, 19, casing ? 4.75 : 3.25],
        "line-offset": ["*", ["coalesce", ["get", "offset"], 0], 3],
      },
    }, before);
  }
  // Retain route refs and station POIs for deriving the shared station circles.
  map.addLayer({id: "urban-transit-current-route-feed", type: "line", source: CURRENT_TRANSIT_SOURCE, "source-layer": "subway_label", minzoom: 10,
    filter: operational, paint: {"line-width": 0, "line-opacity": 0}}, before);
  map.addLayer({id: "urban-transit-current-station-feed", type: "circle", source: CURRENT_TRANSIT_SOURCE, "source-layer": "poi_station", minzoom: 11,
    filter: ["==", ["get", "subclass"], "subway"], paint: {"circle-radius": 0, "circle-opacity": 0}}, before);
  const hulls = new Map<string, NetworkPoint[]>();
  let available = false, signature = "", visible: string[] = [];
  const query = (sourceLayer: string): TransitFeature[] => map.querySourceFeatures(CURRENT_TRANSIT_SOURCE, {sourceLayer})
    .map(feature => ({source: CURRENT_TRANSIT_SOURCE, sourceLayer, geometry: feature.geometry, properties: feature.properties}));
  const update = (collect: boolean) => {
    if (collect) {
      const points = new Map<string, NetworkPoint[]>();
      const lines = query("subway").filter(feature => operationalTransit(feature.properties) && feature.properties?.main === true);
      available = map.getZoom() >= 10 && lines.length > 0;
      for (const line of lines) {
        const network = String(line.properties?.network ?? line.properties?.operator ?? "unnamed");
        const vertices = points.get(network) ?? [];
        const geometry = line.geometry;
        const coordinates = geometry.type === "LineString" ? geometry.coordinates : geometry.type === "MultiLineString" ? geometry.coordinates.flat() : [];
        for (const point of coordinates) vertices.push([point[0], point[1]]);
        points.set(network, vertices);
      }
      for (const [network, vertices] of points) hulls.set(network, networkHull([...(hulls.get(network) ?? []), ...vertices]));
    }
    const canvas = map.getCanvas();
    const next = [...hulls].filter(([, hull]) => networkFillsViewport(hull.map(coordinate => {
      const point = map.project(coordinate); return [point.x, point.y];
    }), canvas.clientWidth, canvas.clientHeight)).map(([network]) => network).sort();
    const serialized = JSON.stringify(next);
    if (serialized === signature) return false;
    signature = serialized; visible = next;
    for (const id of layers) map.setFilter(id, ["all", operational, ["in", key, ["literal", visible]]]);
    return true;
  };
  return {
    source: CURRENT_TRANSIT_SOURCE,
    available: () => map.getZoom() >= 10 && available,
    visible: () => visible.length > 0,
    update,
    stations: () => currentTransitStationPoints(query("poi_station"), query("subway_label").filter(line =>
      visible.includes(String(line.properties?.network ?? line.properties?.operator ?? "unnamed")))),
  };
}
