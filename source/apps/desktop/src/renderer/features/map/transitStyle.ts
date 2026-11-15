import type { ExpressionSpecification, Map as MapLibreMap, MapSourceDataEvent, GeoJSONSource } from "maplibre-gl";
import { transitStationPoints, type TransitFeature } from "./transitStations";
import { addCurrentTransit } from "./currentTransit";
import { networkHull, networkFillsViewport, type NetworkPoint } from "./transitNetworkScale";
import { addTransitEntranceLayers } from "./transitEntrances";
import { TRANSIT_MAX_ZOOM, TRANSIT_MIN_ZOOM, TRANSIT_NETWORKS, TRANSIT_TILE_ORIGIN } from "../../../shared/transitTiles";

const STATION_ZOOM = 11;
const TRANSFER_RADIUS = 3;
const REGULAR_RADIUS = 2.5;
const STATION_LABEL_ZOOM = 15;
const STATION_SOURCE = "urban-transit-station-points";
const ATTRIBUTION = '<a href="https://loom.cs.uni-freiburg.de/tiles" target="_blank" rel="noopener">LOOM</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

export function addUrbanTransitLayers(map: MapLibreMap, apiKey?: string) {
  const symbols = map.getStyle().layers.filter(layer => layer.type === "symbol");
  const before = symbols[0]?.id;
  const textFont = symbols.find(layer => Array.isArray(layer.layout?.["text-font"])
    && layer.layout["text-font"].every(item => typeof item === "string"))?.layout?.["text-font"];
  const sources = TRANSIT_NETWORKS.map(network => {
    const source = `urban-transit-${network}`;
    map.addSource(source, {
      type: "vector",
      tiles: [`${TRANSIT_TILE_ORIGIN}/tiles/${network}/geo/{z}/{x}/{y}.mvt`],
      minzoom: TRANSIT_MIN_ZOOM,
      maxzoom: TRANSIT_MAX_ZOOM,
      attribution: ATTRIBUTION,
    });
    return source;
  });

  const lineLayers = new Map<string, string[]>();
  // LOOM includes its own black outline features. Use just the colored strokes
  // and draw a thinner casing so parallel routes stay readable on the dark map.
  for (const casing of [true, false]) {
    const width: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"],
      TRANSIT_MIN_ZOOM, casing ? 2.45 : 1.35, 14, casing ? 3.2 : 2,
      16, casing ? 3.95 : 2.55, 19, casing ? 4.75 : 3.25];
    for (const source of sources) {
      for (const part of ["lines", "inner-connections"]) {
        const id = `${source}-${part}${casing ? "-casing" : ""}`;
        lineLayers.set(source, [...(lineLayers.get(source) ?? []), id]);
        map.addLayer({
          id,
          type: "line", source, "source-layer": part, minzoom: TRANSIT_MIN_ZOOM,
          filter: ["all", ["==", ["get", "color"], ["get", "line-color"]], ["in", ["to-string", ["get", "component"]], ["literal", []]]],
          layout: {"line-cap": "round", "line-join": "round"},
          paint: {
            "line-color": casing ? "#181b22"
              : ["to-color", ["concat", "#", ["to-string", ["get", "line-color"]]], "#a49ce0"],
            "line-width": width,
          },
        }, before);
      }
    }
  }

  const current = apiKey ? addCurrentTransit(map, apiKey, before) : undefined;
  map.addSource(STATION_SOURCE, {type: "geojson", data: {type: "FeatureCollection", features: []}});
  map.addLayer({
    id: "urban-transit-stations",
    type: "circle", source: STATION_SOURCE, minzoom: STATION_ZOOM,
    paint: {
      "circle-radius": ["case", ["get", "interchange"], TRANSFER_RADIUS, REGULAR_RADIUS],
      "circle-color": ["case", ["get", "interchange"], "#ffffff", ["get", "color"]],
      // MapLibre places the stroke outside the fill radius.
      "circle-stroke-width": ["case", ["get", "interchange"], TRANSFER_RADIUS / 2, REGULAR_RADIUS / 2],
      "circle-stroke-color": "#000000",
      "circle-pitch-scale": "viewport",
      "circle-pitch-alignment": "viewport",
    },
  }, before);
  map.addLayer({
    id: "urban-transit-station-labels",
    type: "symbol", source: STATION_SOURCE, minzoom: STATION_LABEL_ZOOM,
    layout: {
      "text-field": ["get", "name"],
      ...(textFont ? {"text-font": textFont} : {}),
      "text-size": ["interpolate", ["linear"], ["zoom"], STATION_LABEL_ZOOM, 10, 18, 12],
      "text-variable-anchor": ["top", "bottom", "left", "right"],
      "text-radial-offset": 0.65,
      "text-padding": 3,
      "text-max-width": 9,
    },
    paint: {"text-color": "#e6e9ef", "text-halo-color": "#191c23", "text-halo-width": 1.25},
  }, before);

  const boundaries = new Map<string, Map<string, NetworkPoint[]>>();
  const visibleComponents = new Map<string, string[]>();
  const updateNetworkScale = (collect = false) => {
    let changed = current?.update(collect) ?? false;
    const canvas = map.getCanvas();
    for (const source of sources) {
      const networks = boundaries.get(source) ?? new Map<string, NetworkPoint[]>();
      boundaries.set(source, networks);
      if (collect) {
        const additions = new Map<string, NetworkPoint[]>();
        for (const feature of map.querySourceFeatures(source, {sourceLayer: "lines"})) {
          const component = String(feature.properties.component ?? "");
          if (!component || feature.properties.color !== feature.properties["line-color"]) continue;
          const geometry = feature.geometry;
          const coordinates = geometry.type === "LineString" ? geometry.coordinates
            : geometry.type === "MultiLineString" ? geometry.coordinates.flat() : [];
          const points = additions.get(component) ?? [];
          for (const coordinate of coordinates) points.push([coordinate[0], coordinate[1]]);
          additions.set(component, points);
        }
        for (const [component, points] of additions) {
          networks.set(component, networkHull([...(networks.get(component) ?? []), ...points]));
        }
      }
      const preferCurrent = source === "urban-transit-subway-lightrail" && current?.available();
      const visible = preferCurrent ? [] : [...networks].filter(([, hull]) => networkFillsViewport(hull.map(coordinate => {
        const point = map.project(coordinate);
        return [point.x, point.y];
      }), canvas.clientWidth, canvas.clientHeight)).map(([component]) => component).sort();
      if (JSON.stringify(visible) === JSON.stringify(visibleComponents.get(source))) continue;
      changed = true;
      visibleComponents.set(source, visible);
      for (const id of lineLayers.get(source) ?? []) map.setFilter(id, ["all",
        ["==", ["get", "color"], ["get", "line-color"]],
        ["in", ["to-string", ["get", "component"]], ["literal", visible]],
      ]);
    }
    return changed;
  };
  const onMove = () => { if (updateNetworkScale()) updateStations(); };
  const onIdle = () => { updateNetworkScale(true); updateStations(); };
  map.on("move", onMove);
  map.on("resize", onMove);
  let signature = "";
  let frame: number | undefined;
  const updateStations = () => {
    if (map.getZoom() < STATION_ZOOM) return;
    const stations: TransitFeature[] = [];
    const lines: TransitFeature[] = [];
    for (const source of sources) {
      for (const sourceLayer of ["stations", "inner-connections", "lines"]) {
        const target = sourceLayer === "stations" ? stations : lines;
        for (const feature of map.querySourceFeatures(source, {sourceLayer})) {
          const currentFallback = source === "urban-transit-subway-lightrail" && current?.available();
          if (currentFallback && !current?.visible()) continue;
          if (!currentFallback && !visibleComponents.get(source)?.includes(String(feature.properties.component ?? ""))) continue;
          target.push({source, sourceLayer, geometry: feature.geometry, properties: feature.properties});
        }
      }
    }
    const points = transitStationPoints(stations, lines);
    if (current?.available()) {
      const fresh = current.stations().features;
      points.features = points.features.filter(feature => !fresh.some(replacement =>
        replacement.properties.name === feature.properties.name && Math.hypot(
          (replacement.geometry.coordinates[0] - feature.geometry.coordinates[0]) * Math.cos(feature.geometry.coordinates[1] * Math.PI / 180),
          replacement.geometry.coordinates[1] - feature.geometry.coordinates[1],
        ) * 111320 < 150));
      points.features.push(...fresh);
    }
    const next = JSON.stringify(points);
    if (next === signature) return;
    signature = next;
    map.getSource<GeoJSONSource>(STATION_SOURCE)?.setData(points);
  };
  const schedule = (event: MapSourceDataEvent) => {
    if (!event.sourceId || !(sources.includes(event.sourceId) || event.sourceId === current?.source) || frame !== undefined) return;
    frame = requestAnimationFrame(() => { frame = undefined; updateNetworkScale(true); updateStations(); });
  };
  map.on("sourcedata", schedule);
  map.on("idle", onIdle);
  addTransitEntranceLayers(map, before, apiKey);
  map.once("remove", () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    map.off("sourcedata", schedule);
    map.off("idle", onIdle);
    map.off("move", onMove);
    map.off("resize", onMove);
  });
}
