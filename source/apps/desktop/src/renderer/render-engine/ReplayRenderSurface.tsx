import { flushSync } from "react-dom";
import type { ReplayVisualOwnership } from "./VisualOwnership";
import { useEffect, useRef } from "react";
import { ReplayRenderEngine } from "./ReplayRenderEngine";
import type { ReplayScene } from "./ReplayScene";
import { DeckRenderBackend } from "./backends/DeckRenderBackend";
import { createDeckLayerRegistry } from "./backends/DeckLayerRegistry";

export function ReplayRenderSurface({scene}: {scene: ReplayScene}) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    let disposed = false, queued = false;
    let pending: ReplayVisualOwnership = {timeline: false, elevation: false};
    const publish = (ownership: ReplayVisualOwnership) => {
      pending = ownership;
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; if (!disposed) flushSync(() => scene.visuals.set(pending)); });
    };
    const engine = new ReplayRenderEngine(container.current, scene, new DeckRenderBackend(container.current, scene.current, {onVisualOwnership: publish, onProjectionChange: () => scene.projection.invalidate()}), createDeckLayerRegistry({annotations: true, annotationPoints: false, annotationHandles: true, photos: true, footprint: true, metrics: true}));
    return () => { disposed = true; try { engine.destroy(); } finally { scene.visuals.set({timeline: false, elevation: false}); } };
  }, [scene]);

  return <div ref={container} className="render-engine-surface" aria-hidden="true"/>;
}
