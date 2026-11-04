import type { TimeBounds } from "../../../../../../packages/data/src";

/** Chromium trackpad pinch arrives as Ctrl+wheel. Pixel-normalized deltas also
 * support mouse wheels (lines) and page-mode devices. */
export function timelineWheelRange(
  range: TimeBounds, bounds: TimeBounds,
  gesture: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean },
  width: number, height: number, pointerRatio: number,
): TimeBounds {
  const span = range[1] - range[0];
  const dx = gesture.deltaX * (gesture.deltaMode === 1 ? 40 : gesture.deltaMode === 2 ? width : 1);
  const dy = gesture.deltaY * (gesture.deltaMode === 1 ? 40 : gesture.deltaMode === 2 ? height : 1);
  let nextSpan = span;
  let start = range[0];
  if (!gesture.ctrlKey && Math.abs(dx) > Math.abs(dy)) {
    start += dx / Math.max(1, width) * span;
  } else {
    // Twice the original 0.002 zoom sensitivity; clamp before anchoring.
    nextSpan = Math.max(1, Math.min(bounds[1] - bounds[0], span * Math.exp(Math.max(-50, Math.min(50, dy * 0.004)))));
    const anchor = Math.max(0, Math.min(1, pointerRatio));
    start += (span - nextSpan) * anchor;
  }
  start = Math.max(bounds[0], Math.min(bounds[1] - nextSpan, start));
  return [start, start + nextSpan];
}
