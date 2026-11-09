import { useCallback, useSyncExternalStore } from "react";
import type { ReplayScene } from "./ReplayScene";
export function useReplayAnnotations(scene: ReplayScene) {
  const subscribe = useCallback((notify: () => void) => scene.subscribe(notify), [scene]);
  const snapshot = useCallback(() => scene.current.annotationGeometry, [scene]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
