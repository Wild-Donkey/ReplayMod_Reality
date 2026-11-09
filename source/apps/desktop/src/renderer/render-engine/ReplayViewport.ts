import type { ReplayColor } from "./ReplayColor";
import type { ReplayViewId } from "./ReplayScene";

export interface ReplayViewport {
  readonly id: ReplayViewId;
  readonly kind: "map" | "orthographic";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly backdrop?: {readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly color: ReplayColor};
}
