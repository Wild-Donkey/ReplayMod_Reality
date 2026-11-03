import type { ClockAnchor, TimeAlignment } from "./types";

const interpolate = (time: number, left: ClockAnchor, right: ClockAnchor) => {
  const sourceSpan = right.sourceTimeSeconds - left.sourceTimeSeconds;
  if (sourceSpan === 0) return left.projectTimeSeconds;
  const ratio = (time - left.sourceTimeSeconds) / sourceSpan;
  return left.projectTimeSeconds + ratio * (right.projectTimeSeconds - left.projectTimeSeconds);
};

export const alignToProjectTime = (
  sourceTimeSeconds: number,
  alignment: TimeAlignment,
): number => {
  const anchors = [...alignment.anchors].sort(
    (left, right) => left.sourceTimeSeconds - right.sourceTimeSeconds,
  );
  if (anchors.length === 0) return sourceTimeSeconds;
  if (anchors.length === 1) {
    const anchor = anchors[0];
    return sourceTimeSeconds + anchor.projectTimeSeconds - anchor.sourceTimeSeconds;
  }

  if (sourceTimeSeconds <= anchors[0].sourceTimeSeconds) {
    return interpolate(sourceTimeSeconds, anchors[0], anchors[1]);
  }

  for (let index = 1; index < anchors.length; index += 1) {
    if (sourceTimeSeconds <= anchors[index].sourceTimeSeconds) {
      return interpolate(sourceTimeSeconds, anchors[index - 1], anchors[index]);
    }
  }

  return interpolate(
    sourceTimeSeconds,
    anchors[anchors.length - 2],
    anchors[anchors.length - 1],
  );
};
