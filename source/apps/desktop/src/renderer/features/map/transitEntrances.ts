import type { GeoJSONSource, Map as GLMap, MapSourceDataEvent } from "maplibre-gl";
import { ENTRANCE_ZOOM, mergeTransitEntrances } from "../../../shared/transitEntrances";

const SOURCE = "urban-transit-entrances";
const DETAILS = "urban-transit-entrance-details";

function entranceImage(numbered: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = 40;
  canvas.height = 32;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#355e75";
  context.strokeStyle = "#b8d2df";
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(1, 1, 38, 30, 5);
  context.fill();
  context.stroke();
  if (!numbered) {
    context.strokeStyle = "#ffffff";
    context.lineWidth = 2.5;
    context.beginPath();
    context.moveTo(9, 24);
    context.lineTo(15, 24);
    context.lineTo(15, 18);
    context.lineTo(21, 18);
    context.lineTo(21, 12);
    context.lineTo(28, 12);
    context.moveTo(9, 10);
    context.lineTo(18, 10);
    context.lineTo(18, 4);
    context.moveTo(18, 10);
    context.lineTo(10, 4);
    context.stroke();
  }
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

export function addTransitEntranceLayers(map: GLMap, before?: string, apiKey?: string) {
  const layers = map.getStyle().layers;
  const template = layers.find(layer => "source-layer" in layer && layer["source-layer"] === "poi")
    ?? layers.find(layer => "source-layer" in layer && layer["source-layer"] === "transportation");
  if (!template || !("source" in template) || typeof template.source !== "string") return;
  const basemapSource = template.source;
  const textFont = layers.find(layer => layer.type === "symbol" && Array.isArray(layer.layout?.["text-font"])
    && layer.layout["text-font"].every(item => typeof item === "string"));
  const font = textFont?.type === "symbol" ? textFont.layout?.["text-font"] : undefined;
  map.addImage("urban-transit-entrance-icon", entranceImage(false), {pixelRatio: 2});
  map.addImage("urban-transit-entrance-badge", entranceImage(true), {pixelRatio: 2});
  map.addSource(SOURCE, {type: "geojson", data: {type: "FeatureCollection", features: []}});
  const detailSource = map.getSource("urban-transit-current") ? "urban-transit-current" : DETAILS;
  if (apiKey) {
    if (!map.getSource(detailSource)) map.addSource(detailSource, {type: "vector", url: `https://api.maptiler.com/tiles/v4/tiles.json?key=${encodeURIComponent(apiKey)}`});
    // Activate only the entrance feed at street scale. Its points are merged
    // with the existing POIs before rendering either a number or an icon.
    map.addLayer({
      id: "urban-transit-entrance-feed", type: "circle", source: detailSource, "source-layer": "poi_station", minzoom: ENTRANCE_ZOOM,
      filter: ["==", ["get", "subclass"], "subway_entrance"],
      paint: {"circle-radius": 0, "circle-opacity": 0},
    }, before);
  }

  map.addLayer({
    id: "urban-transit-entrance-icons", type: "symbol", source: SOURCE, minzoom: ENTRANCE_ZOOM,
    filter: ["==", ["get", "ref"], ""],
    layout: {"icon-image": "urban-transit-entrance-icon", "icon-padding": 2},
  }, before);
  map.addLayer({
    id: "urban-transit-entrance-numbers", type: "symbol", source: SOURCE, minzoom: ENTRANCE_ZOOM,
    filter: ["!=", ["get", "ref"], ""],
    layout: {
      "icon-image": "urban-transit-entrance-badge", "icon-text-fit": "both", "icon-text-fit-padding": [3, 4, 3, 4],
      "text-field": ["get", "ref"], "text-size": 10, "text-padding": 2,
      ...(font ? {"text-font": font} : {}),
    },
    paint: {"text-color": "#ffffff"},
  }, before);

  let signature = "";
  let frame: number | undefined;
  const publish = () => {
    if (map.getZoom() < ENTRANCE_ZOOM) return;
    const base = map.querySourceFeatures(basemapSource, {sourceLayer: "poi"});
    const detailed = apiKey ? map.querySourceFeatures(detailSource, {sourceLayer: "poi_station"}) : [];
    const points = mergeTransitEntrances(base, detailed);
    const next = JSON.stringify(points);
    if (next === signature) return;
    signature = next;
    map.getSource<GeoJSONSource>(SOURCE)?.setData(points);
  };
  const onSource = (event: MapSourceDataEvent) => {
    if ((event.sourceId !== basemapSource && event.sourceId !== detailSource) || frame !== undefined) return;
    frame = requestAnimationFrame(() => { frame = undefined; publish(); });
  };
  map.on("sourcedata", onSource);
  map.on("idle", publish);
  map.once("remove", () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    map.off("sourcedata", onSource);
    map.off("idle", publish);
  });
}
