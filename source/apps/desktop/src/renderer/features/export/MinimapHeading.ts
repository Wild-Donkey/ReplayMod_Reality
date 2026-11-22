import type { TimeBounds } from "../../../../../../packages/data/src";
import type { TrajectoryBuffer } from "../../render-engine/buffers/TrajectoryBuffer";
import { directionBearing } from "../../shared/trajectoryDirection";

export const HEADING_HALF_WINDOW_MS = 1_500;

export function minimapHeading(trajectory: TrajectoryBuffer, time: number, bounds: TimeBounds, fallback: number) {
  const before = trajectory.sample(Math.max(bounds[0], time - HEADING_HALF_WINDOW_MS));
  const after = trajectory.sample(Math.min(bounds[1], time + HEADING_HALF_WINDOW_MS));
  if (!before || !after) return fallback;
  const [west, south] = before.position;
  const [east, north] = after.position;
  const longitudeDelta = ((east - west + 540) % 360) - 180;
  // At a stop, a sub-metre displacement is not enough to infer a new heading.
  const displacement = Math.hypot(longitudeDelta * Math.cos((north + south) * Math.PI / 360), north - south) * 111_195;
  return displacement >= .3 ? directionBearing(before.position, after.position) : fallback;
}
