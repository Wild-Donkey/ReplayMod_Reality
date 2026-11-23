export const SCROLL_SOURCE_CHANNEL = "input:scroll-source";
export const MAP_SCROLL_TARGET_CHANNEL = "input:map-scroll-target";
export const MAP_SCROLL_GESTURE_CHANNEL = "input:map-scroll-gesture";
export type ScrollSource = "mouse-wheel" | "trackpad" | "unknown";
export type MapScrollGesture = { dx: number; dy: number; zoomDelta: number; x: number; y: number };

