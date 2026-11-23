import type { Map as MapLibreMap } from "maplibre-gl";
import type { ScrollSource } from "../../../shared/scrollInput";

type ChromiumWheelEvent = WheelEvent & { readonly wheelDeltaY?: number };

function isNotchedWheel(event: ChromiumWheelEvent) {
  if (event.deltaX || !event.deltaY) return false;
  if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return true;
  // Windows reports 120 units per notch. Blink may expose the count in
  // native or CSS pixels depending on which path produced the wheel event.
  const ticks = Math.abs((event.wheelDeltaY ?? 0) / 120);
  const wholeNotch = (value: number) => value >= 0.98 && Math.abs(value - Math.round(value)) < 0.02;
  return wholeNotch(ticks) || wholeNotch(ticks * window.devicePixelRatio);
}

export function installMapScrollInput(map: MapLibreMap) {
  const canvas = map.getCanvasContainer();
  const desktop = window.replaymod;
  let source: ScrollSource = "unknown";
  const stopSource = desktop?.onScrollSource(next => { source = next; });
  const pan = (dx: number, dy: number) => map.panBy([dx, dy], { duration: 0 });
  const stopGesture = desktop?.onMapScrollGesture?.(({ dx, dy, zoomDelta, x, y }) => {
    if (!zoomDelta) { pan(dx, dy); return; }
    const rect = canvas.getBoundingClientRect();
    map.easeTo({ zoom: map.getZoom() + 2 * zoomDelta, around: map.unproject([x - rect.left, y - rect.top]), duration: 0 });
  });

  const listeners = new AbortController();
  const { signal } = listeners;
  const setTarget = desktop?.setMapScrollTarget;
  let active = false;
  const target = (next: boolean) => {
    if (!setTarget || active === next) return;
    active = next;
    setTarget(next);
  };
  canvas.addEventListener("wheel", event => {
    target(true);
    // Chromium emits trackpad pinch as Ctrl+wheel. MapLibre handles zoom.
    if (event.ctrlKey || source === "mouse-wheel" ||
        (source === "unknown" && desktop?.identifyWheelFromDeltas && isNotchedWheel(event))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const mode = event.deltaMode;
    const lineScale = mode === WheelEvent.DOM_DELTA_LINE ? 40 : 1;
    const page = mode === WheelEvent.DOM_DELTA_PAGE;
    pan(event.deltaX * (page ? canvas.clientWidth : lineScale), event.deltaY * (page ? canvas.clientHeight : lineScale));
  }, { capture: true, passive: false, signal });

  if (setTarget) {
    const enter = () => target(true);
    const leave = () => target(false);
    const focus = () => target(canvas.matches(":hover"));
    canvas.addEventListener("pointerenter", enter, { signal });
    canvas.addEventListener("pointermove", enter, { signal });
    canvas.addEventListener("pointerleave", leave, { signal });
    window.addEventListener("focus", focus, { signal });
    window.addEventListener("blur", leave, { signal });
    focus();
  }
  return () => {
    listeners.abort();
    target(false);
    stopGesture?.();
    stopSource?.();
  };
}
