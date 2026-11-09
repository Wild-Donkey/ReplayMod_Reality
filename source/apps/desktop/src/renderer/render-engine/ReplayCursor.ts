export type ReplayCursorSource = "map" | "timeline" | "elevation" | "annotation";

export interface ReplayCursor {
  readonly source: ReplayCursorSource;
  readonly timestamp: number | null;
  readonly trajectoryIndex: number | null;
  readonly coordinate: readonly [number, number] | null;
}

export const sameReplayCursor = (left: ReplayCursor | null, right: ReplayCursor | null) =>
  left === right || (
    left !== null && right !== null &&
    left.source === right.source &&
    left.timestamp === right.timestamp &&
    left.trajectoryIndex === right.trajectoryIndex &&
    left.coordinate?.[0] === right.coordinate?.[0] &&
    left.coordinate?.[1] === right.coordinate?.[1]
  );
