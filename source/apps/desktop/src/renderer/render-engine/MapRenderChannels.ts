import type { RenderLayerId } from "./LayerVisibility";
import { RenderChannelRegistry } from "./RenderChannelRegistry";
import type { ReplayScene } from "./ReplayScene";

export interface StyleChannelMap {
  getStyle(): {layers?: readonly {id: string; type?: string}[]} | undefined;
  getLayoutProperty(id: string, name: string): unknown;
  setLayoutProperty(id: string, name: string, value: string): unknown;
  on(type: "styledata", listener: () => void): unknown;
  off(type: "styledata", listener: () => void): unknown;
}

// Share visibility and lifecycle between interactive and export map carriers.
// The carrier supplies only its layer classification; Scene owns the policy.
export function registerMapStyleChannels(
  scene: ReplayScene,
  map: StyleChannelMap,
  prefix: string,
  classify: (layer: {id: string; type?: string}) => RenderLayerId | null,
) {
  return registerStyleRenderChannels(scene, map, prefix, (group, visible) => {
    for (const layer of map.getStyle()?.layers ?? []) {
      if (classify(layer) !== group) continue;
      const value = visible ? "visible" : "none";
      if (map.getLayoutProperty(layer.id, "visibility") !== value) map.setLayoutProperty(layer.id, "visibility", value);
    }
  });
}

export function registerStyleRenderChannels(
  scene: ReplayScene,
  map: Pick<StyleChannelMap, "on" | "off">,
  prefix: string,
  applyVisibility: (group: RenderLayerId, visible: boolean) => void,
) {
  const registry = new RenderChannelRegistry(scene);
  let applying = false;
  for (const group of ["trajectory", "annotations", "airports", "buildings", "roads", "elevation"] as const) {
    registry.register({
      id: `${prefix}/${group}`, group,
      setVisible: visible => {
        if (applying) return;
        applying = true;
        try {
          applyVisibility(group, visible);
        } finally { applying = false; }
      },
      dispose() {},
    });
  }
  const refresh = () => { if (!applying) registry.refresh(); };
  map.on("styledata", refresh);
  return () => { map.off("styledata", refresh); registry.destroy(); };
}
