import type {Map as GLMap} from "maplibre-gl";
import type {MapLanguage} from "../../../shared/settings";
import {restoreWaterLayers} from "./water";
import {stylePublicBasemap} from "./basemapStyle";
import {addUrbanTransitLayers} from "./transitStyle";
import {applyMapLanguage} from "./mapLanguage";
import {RoadOverlay} from "./RoadOverlay";
import {BuildingHeightOverlay} from "./BuildingHeightOverlay";
import {addElevationGlass} from "./elevation";
import type {RawTerrain} from "./RawTerrain";
import type {TerrainAppearance} from "./terrainExposure";

export const publicBasemapStyle = (key: string) => `https://api.maptiler.com/maps/dataviz-dark/style.json?key=${encodeURIComponent(key)}`;

/** Both map views use these same surfaces, road composition, buildings and terrain. */
export function createPublicBasemap(map: GLMap, key: string, signal: AbortSignal, options: {
  language: MapLanguage; buildingCacheLimitMB?: number; boundaries?: boolean;
  onAppearance?: (appearance: TerrainAppearance | null) => void;
  onRaw?: (raw: RawTerrain | null) => void;
  onUnavailable?: () => void;
}) {
  const style = structuredClone(map.getStyle());
  const surfaces = style.layers.filter(layer => ["background","fill","fill-extrusion","raster","hillshade","color-relief"].includes(layer.type));
  for (const layer of surfaces) map.setLayoutProperty(layer.id,"visibility","none");
  restoreWaterLayers(map);
  stylePublicBasemap(map);
  if (options.boundaries === false) {
    for (const layer of style.layers) {
      if (layer.type === "line" && (/boundary|border/i.test(layer.id) || ("source-layer" in layer && /boundary|border/i.test(layer["source-layer"] ?? "")))) {
        map.setLayoutProperty(layer.id,"visibility","none");
      }
    }
  }
  const roads = new RoadOverlay(map,style);
  const buildings = new BuildingHeightOverlay(map,style,options.buildingCacheLimitMB);
  addUrbanTransitLayers(map, key);
  applyMapLanguage(map,options.language);
  let terrain: RawTerrain | null = null;
  const ready = addElevationGlass(map,key,signal,options.onAppearance,raw=>{
    terrain=raw;options.onRaw?.(raw);
  }).catch(error=>{
    if(signal.aborted)return;
    options.onUnavailable?.();
    for(const layer of surfaces) {
      if ("source-layer" in layer && layer["source-layer"] === "building") continue;
      map.setLayoutProperty(layer.id,"visibility",layer.layout?.visibility ?? "visible");
    }
    // Resource failures remain visible to export callers rather than silently capturing placeholders.
    throw error;
  });
  return {roads,buildings,ready,get terrain(){return terrain;}};
}
