import type { LayerVisibility, RenderLayerId } from "./LayerVisibility";

export interface MapLayerVisibilityTarget {
  getStyle(): {layers?: readonly {id: string}[]};
  getLayoutProperty(id: string, property: string): unknown;
  setLayoutProperty(id: string, property: string, value: string): unknown;
}

// Existing MapLibre passes participate in the same visibility state while
// their rendering adapters are migrated. LOD owns the two fallback passes.
export function applyMapLayerVisibility(
  map: MapLayerVisibilityTarget,
  visibility: LayerVisibility,
  footprint: {density: boolean; line: boolean; photosInEngine?: boolean},
  group?: RenderLayerId,
) {
  for (const {id} of map.getStyle().layers ?? []) {
    const owner = id.startsWith("footprint-") || id.startsWith("photo-") ? "trajectory"
      : id.startsWith("annotation-") ? "annotations"
      : id.startsWith("airport-flight-") ? "airports"
      : id.startsWith("elevation-buildings") ? "buildings"
      : id === "elevation-glass" || id === "ocean-elevation-glass" ? "elevation" : undefined;
    if (group && owner !== group) continue;
    const visible = id === "footprint-points-circle" ? visibility.trajectory && !footprint.density && !footprint.line
      : id === "footprint-route-line" ? visibility.trajectory && !footprint.density && footprint.line
      : id.startsWith("photo-") ? visibility.trajectory && !footprint.photosInEngine
      : id.startsWith("annotation-") ? visibility.annotations
      : id.startsWith("airport-flight-") ? visibility.airports
      : id.startsWith("elevation-buildings") ? visibility.buildings
      : id === "elevation-glass" || id === "ocean-elevation-glass" ? visibility.elevation
      : undefined;
    if (visible === undefined) continue;
    const desired = visible ? "visible" : "none";
    if (map.getLayoutProperty(id, "visibility") !== desired) map.setLayoutProperty(id, "visibility", desired);
  }
}
