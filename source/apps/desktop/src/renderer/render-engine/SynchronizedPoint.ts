import type { ReplaySceneSnapshot } from "./ReplayScene";
import type { ReplayClockSnapshot } from "./ReplayClock";

export function synchronizedPoint(scene: ReplaySceneSnapshot, clock: ReplayClockSnapshot) {
  const cursor = scene.cursor;
  const group = cursor?.source === "elevation" || cursor?.source === "annotation" ? "annotations" : "trajectory";
  if (!scene.visibility[group]) return null;
  const coordinate = cursor?.coordinate ?? scene.trajectory?.sample(clock.time)?.position;
  if (!coordinate || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) return null;
  return coordinate;
}
