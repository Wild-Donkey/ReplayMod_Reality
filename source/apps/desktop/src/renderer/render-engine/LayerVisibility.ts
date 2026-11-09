export const renderLayerLabels = {
  trajectory: "轨迹", annotations: "标注", airports: "机场",
  buildings: "建筑", roads: "路网", elevation: "海拔",
} as const;
export type RenderLayerId = keyof typeof renderLayerLabels;
export type LayerVisibility = Record<RenderLayerId, boolean>;
export const defaultLayerVisibility: LayerVisibility = {
  trajectory: true, annotations: true, airports: true,
  buildings: true, roads: true, elevation: true,
};
