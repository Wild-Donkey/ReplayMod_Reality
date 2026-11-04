import type { Map } from "maplibre-gl";
import { elevationAppearance, WATER_SURFACE_OPACITY, type ElevationRange } from "./elevationRange";

// Reuse the provider's water geometry, filters and zoom ranges. Elevation alone
// cannot distinguish a lake from the surrounding terrain at the same height.
export function restoreWaterLayers(map: Map, range: ElevationRange = {minimum: 0, maximum: 9000}) {
  const layers = [...(map.getStyle().layers ?? [])];
  for (const layer of layers) {
    const sourceLayer = "source-layer" in layer ? layer["source-layer"] : "";
    const isWater = /^(water|waterway)$/.test(sourceLayer ?? "")
      || /(^|[-_ ])(water|waterway|ocean|lake|river|coastline)([-_ ]|$)/i.test(layer.id);
    if (!isWater || /shadow/i.test(layer.id)) continue;
    if (layer.type === "fill") {
      map.setLayoutProperty(layer.id, "visibility", "visible");
      map.setPaintProperty(layer.id, "fill-color", "#000000");
      // Dataviz Dark offsets Water by 2–3 pixels below z14 to fake depth.
      // Our terrain masks and shorelines use the unshifted source geometry.
      map.setPaintProperty(layer.id, "fill-translate", [0, 0]);
      map.setPaintProperty(layer.id, "fill-translate-anchor", "map");
      const fallback = elevationAppearance(NaN, range, true).alpha;
      map.setPaintProperty(layer.id, "fill-opacity", range.minimum < 0 && map.getLayer("ocean-elevation-glass")
        ? ["case", ["==", ["get", "class"], "ocean"], WATER_SURFACE_OPACITY, fallback] : fallback);
      map.setPaintProperty(layer.id, "fill-outline-color", "rgba(0,0,0,0)");
      // Separate line opacity keeps shores readable despite the faint fill.
      const outlineId = `${layer.id}-glass-shore`;
      if (!map.getLayer(outlineId)) {
        const nextLayer = layers[layers.indexOf(layer) + 1]?.id;
        map.addLayer({
          id: outlineId, type: "line", source: layer.source,
          "source-layer": layer["source-layer"], filter: layer.filter,
          minzoom: layer.minzoom, maxzoom: layer.maxzoom,
          paint: { "line-color": "#9eb4be", "line-opacity": 0.32, "line-width": 0.75 },
        }, nextLayer);
      }
    } else if (layer.type === "line") {
      map.setLayoutProperty(layer.id, "visibility", "visible");
      map.setPaintProperty(layer.id, "line-color", "#8a9ea8");
      map.setPaintProperty(layer.id, "line-opacity", 0.36);
    }
  }
}

// Only update paint during a depth-range change; do not rebuild shoreline layers.
export function updateWaterFallback(map: Map, range: ElevationRange, rawTerrain = Boolean(map.getLayer("terrain-raw-presentation"))) {
  const fallback = elevationAppearance(NaN, range, true).alpha;
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type !== "fill" || /shadow/i.test(layer.id)) continue;
    if (layer["source-layer"] !== "water") continue;
    map.setPaintProperty(layer.id, "fill-opacity", range.minimum < 0 && map.getLayer("ocean-elevation-glass")
        ? ["case", ["==", ["get", "class"], "ocean"], rawTerrain ? 0 : WATER_SURFACE_OPACITY, fallback] : fallback);
  }
}
