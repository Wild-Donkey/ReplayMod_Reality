export interface MapFrameTarget {
  on(event: "render", listener: () => void): unknown;
  off(event: "render", listener: () => void): unknown;
  triggerRepaint(): void;
}

export function waitForMapFrame(map: MapFrameTarget, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(false); return; }
    let finished = false;
    const finish = (rendered: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      map.off("render", onRender);
      signal.removeEventListener("abort", onAbort);
      resolve(rendered);
    };
    const onRender = () => finish(true);
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), 3000);
    map.on("render", onRender);
    signal.addEventListener("abort", onAbort, {once: true});
    map.triggerRepaint();
  });
}
