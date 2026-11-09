import { useCallback, useSyncExternalStore } from "react";
import type { ReplayScene } from "./ReplayScene";
import type { ReplayVisualOwnership } from "./VisualOwnership";
export function useReplayVisual(scene: ReplayScene, view: keyof ReplayVisualOwnership) {
  const subscribe = useCallback((notify: () => void) => scene.visuals.subscribe(notify), [scene]);
  const snapshot = useCallback(() => scene.visuals.current[view], [scene, view]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
