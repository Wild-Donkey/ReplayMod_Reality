import type { ReplayClockSnapshot } from "./ReplayClock";
import type { ReplaySceneSnapshot, ReplayViewId } from "./ReplayScene";
import type { RenderLayerId } from "./LayerVisibility";

export interface ReplayLayerHandle {readonly id: string}

export type ReplayLayerFactory<LayerType extends ReplayLayerHandle = ReplayLayerHandle> = (
  scene: ReplaySceneSnapshot,
  clock: ReplayClockSnapshot,
) => readonly LayerType[];

export interface ReplayLayerDefinition<LayerType extends ReplayLayerHandle = ReplayLayerHandle> {
  readonly id: string;
  readonly views: readonly ReplayViewId[];
  readonly order: number;
  readonly visibilityGroup?: RenderLayerId;
  readonly build: ReplayLayerFactory<LayerType>;
}

export class ReplayLayerRegistry<LayerType extends ReplayLayerHandle = ReplayLayerHandle> {
  private readonly definitions = new Map<string, ReplayLayerDefinition<LayerType>>();

  register(definition: ReplayLayerDefinition<LayerType>) {
    if (this.definitions.has(definition.id)) throw new Error(`Replay layer definition already registered: ${definition.id}`);
    if (definition.views.length === 0) throw new Error(`Replay layer definition requires at least one view: ${definition.id}`);
    this.definitions.set(definition.id, definition);
    return () => this.definitions.delete(definition.id);
  }

  build(scene: ReplaySceneSnapshot, clock: ReplayClockSnapshot) {
    const generated = [...this.definitions.values()]
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .flatMap(definition => {
        if (definition.visibilityGroup && !scene.visibility[definition.visibilityGroup]) return [];
        const layers = definition.build(scene, clock);
        for (const layer of layers) {
          const viewId = layer.id.split("/", 1)[0] as ReplayViewId;
          if (!definition.views.includes(viewId)) {
            throw new Error(`Layer ${layer.id} targets an undeclared view in ${definition.id}`);
          }
        }
        return layers;
      });
    return generated;
  }
}
