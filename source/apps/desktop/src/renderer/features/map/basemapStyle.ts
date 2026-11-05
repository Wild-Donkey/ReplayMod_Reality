import type { ExpressionSpecification, LayerSpecification, Map } from "maplibre-gl";

// Public cartography is achromatic. Colour is reserved for user-owned data.
export const BUILDING_HEIGHT_SCALE = 10;
export const ROAD_OPACITY_SCALE = 0.52;

type RoadLevel = 1 | 2 | 3 | 4 | 5;

const ROAD_APPEARANCE: Record<RoadLevel, {opacity: number; width: number; compositeColor: string}> = {
  1: {opacity: 0.80, width: 7.0, compositeColor: "#ffffff"},
  2: {opacity: 0.62, width: 5.0, compositeColor: "#e8e8e8"},
  3: {opacity: 0.44, width: 2.6, compositeColor: "#c6c6c6"},
  4: {opacity: 0.27, width: 1.2, compositeColor: "#929292"},
  5: {opacity: 0.14, width: 0.55, compositeColor: "#686868"},
};

const roadLevel = (layer: LayerSpecification): RoadLevel => {
  const name = `${layer.id} ${"source-layer" in layer ? layer["source-layer"] ?? "" : ""}`.toLowerCase();
  if (/motorway|freeway|trunk|highway|expressway/.test(name)) return 1;
  if (/primary|major|arterial/.test(name)) return 2;
  if (/secondary|tertiary/.test(name)) return 3;
  if (/minor|residential|street|service|living/.test(name)) return 4;
  return 5;
};

export const isRoadLayer = (layer: LayerSpecification) => {
  if (layer.type !== "line") return false;
  const sourceLayer = "source-layer" in layer ? layer["source-layer"] : undefined;
  if (sourceLayer === "transportation") return !/rail|ferry|aerialway/.test(layer.id.toLowerCase());
  const name = layer.id.toLowerCase();
  return /road|street|highway|motorway|trunk|primary|secondary|tertiary/.test(name)
    && !/rail|ferry|aerialway|building|boundary|outline|area/.test(name);
};

const zoomWidth = (width: number): ExpressionSpecification => [
  "interpolate", ["linear"], ["zoom"],
  2, width * 0.12,
  6, width * 0.22,
  10, width * 0.38,
  14, width * 0.62,
  18, width,
  22, width * 1.55,
];

export function styleRoadLayers(map: Map, composite = false) {
  for (const layer of map.getStyle().layers ?? []) {
    if (!isRoadLayer(layer)) continue;
    const level = roadLevel(layer);
    const appearance = ROAD_APPEARANCE[level];
    const tunnel = /tunnel/i.test(layer.id);
    const bridge = /bridge/i.test(layer.id);
    map.setPaintProperty(layer.id, "line-color", composite ? appearance.compositeColor : "#ffffff");
    map.setPaintProperty(layer.id, "line-opacity", composite ? 1 : Math.max(0.04, appearance.opacity * ROAD_OPACITY_SCALE * (tunnel ? 0.55 : bridge ? 1.08 : 1)));
    map.setPaintProperty(layer.id, "line-width", zoomWidth(appearance.width));
    map.setPaintProperty(layer.id, "line-dasharray", null);
  }
}

// Draw directly from the transportation source instead of restyling provider
// line layers. Provider styles also contain road-area outlines, casings and
// other boundaries; treating all of those as roads creates the rectangular
// and parallel-line artefacts seen around dense city blocks.
export function addCompositeRoadLayers(map: Map) {
  const template = (map.getStyle().layers ?? []).find(layer =>
    "source-layer" in layer && layer["source-layer"] === "transportation" &&
    "source" in layer && typeof layer.source === "string");
  if (!template || !("source" in template) || typeof template.source !== "string") return false;
  const groups: Array<[RoadLevel, string[]]> = [
    [1, ["motorway", "trunk"]],
    [2, ["primary"]],
    [3, ["secondary", "tertiary"]],
    [4, ["minor", "residential", "living_street"]],
  ];
  for (const [level, classes] of groups) {
    const appearance = ROAD_APPEARANCE[level];
    map.addLayer({
      id: `road-composite-${level}`,
      type: "line",
      source: template.source,
      "source-layer": "transportation",
      filter: ["all",
        ["==", ["geometry-type"], "LineString"],
        ["match", ["get", "class"], classes, true, false],
      ],
      layout: {"line-cap": "round", "line-join": "round"},
      paint: {
        "line-color": appearance.compositeColor,
        "line-opacity": 1,
        "line-width": zoomWidth(appearance.width),
      },
    });
  }
  return true;
}

export function hideRoadLayers(map: Map) {
  for (const layer of map.getStyle().layers ?? []) {
    if (isRoadLayer(layer)) map.setLayoutProperty(layer.id, "visibility", "none");
  }
}

const buildingHeight: ExpressionSpecification = [
  "max", 3,
  ["to-number", ["coalesce", ["get", "height"], ["get", "render_height"],
    ["*",3,["to-number",["coalesce",["get","levels"],["get","building:levels"],1]]],3]],
];

// A white overlay is the 2D equivalent of adding exaggerated height to the
// already shaded ground: local terrain remains the base and taller roofs move
// farther toward white. Buildings deliberately do not enter terrain metering.
export const buildingOpacity: ExpressionSpecification = [
  "interpolate", ["linear"], ["*", buildingHeight, BUILDING_HEIGHT_SCALE],
  0, 0.04,
  30, 0.07,
  100, 0.12,
  300, 0.22,
  600, 0.34,
  1200, 0.48,
  2500, 0.62,
  5000, 0.74,
  9000, 0.82,
];

export function addElevationBuildings(map: Map) {
  const layers = map.getStyle().layers ?? [];
  const candidates = layers.filter(layer =>
    "source-layer" in layer && layer["source-layer"] === "building" && "source" in layer && typeof layer.source === "string");
  const template = candidates.find(layer => layer.type === "fill" || layer.type === "fill-extrusion") ?? candidates[0];
  if (!template || !("source" in template) || typeof template.source !== "string") return false;

  for (const layer of candidates) map.setLayoutProperty(layer.id, "visibility", "none");
  if (map.getLayer("elevation-buildings")) return true;
  const firstSymbol = layers.find(layer => layer.type === "symbol")?.id;
  map.addLayer({
    id: "elevation-buildings",
    type: "fill",
    source: template.source,
    "source-layer": "building",
    // Keep one continuous vector layer across the zoom range. Inheriting the
    // provider style's minzoom/filter creates the exact one-level hole where
    // buildings disappear even though the source still has usable geometry.
    minzoom: 7,
    paint: {
      "fill-color": "#ffffff",
      "fill-opacity": buildingOpacity,
      "fill-antialias": false,
    },
  }, firstSymbol);
  return true;
}

export function stylePublicBasemap(map: Map) {
  hideRoadLayers(map);
  for(const layer of map.getStyle().layers??[])if("source-layer" in layer&&layer["source-layer"]==="building")map.setLayoutProperty(layer.id,"visibility","none");
}
