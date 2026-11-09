import { useCallback, useSyncExternalStore } from "react";
import type { ReplayScene } from "./ReplayScene";

// React shares the same visibility policy as native map and GPU channels.
export function useReplayVisibility(scene: ReplayScene) {
  const subscribe = useCallback((notify: () => void) => scene.subscribe(notify), [scene]);
  const snapshot = useCallback(() => scene.current.visibility, [scene]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
