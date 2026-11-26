export interface MapFrameTarget {
  on(event: "idle" | "error", listener: () => void): unknown;
  off(event: "idle" | "error", listener: () => void): unknown;
  loaded(): boolean;
  isStyleLoaded(): boolean | void;
  areTilesLoaded(): boolean;
  triggerRepaint(): void;
  redraw?(): unknown;
}

/** A render event can contain placeholders. Only an idle, fully loaded frame is capturable. */
export function waitForMapFrame(map: MapFrameTarget, signal: AbortSignal, timeout = 60_000, immediate = false): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(false); return; }
    let finished = false;
    const finish = (rendered: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      map.off("idle", onIdle);
      map.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      resolve(rendered);
    };
    const onIdle = () => { if (map.loaded() && map.isStyleLoaded() && map.areTilesLoaded()) finish(true); };
    const onError = () => finish(false);
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeout);
    map.on("idle", onIdle);
    map.on("error", onError);
    signal.addEventListener("abort", onAbort, {once: true});
    if (immediate && map.redraw) {
      try { map.redraw(); }
      catch { finish(false); }
    }
    if (!finished) map.triggerRepaint();
  });
}
