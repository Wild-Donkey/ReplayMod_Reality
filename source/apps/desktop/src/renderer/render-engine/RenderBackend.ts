import type { ReplayProjector } from "./ReplayProjection";
import type { ReplayViewId } from "./ReplayScene";
import type { ReplayViewport } from "./ReplayViewport";
import type { ReplayPickQuery, ReplayPickResult } from "./ReplayPicking";
import type { ReplaySceneSnapshot } from "./ReplayScene";

export interface ReplayRenderBackend<LayerType> {
  setViews(views: readonly ReplayViewport[]): void;
  render(scene: ReplaySceneSnapshot, layers: readonly LayerType[]): void;
  getProjection?(viewId: ReplayViewId): ReplayProjector | null | undefined;
  waitForFrame?(signal: AbortSignal): Promise<boolean>;
  pick(query: ReplayPickQuery): ReplayPickResult | null;
  destroy(): void;
}
