import { Deck, MapView, OrthographicView, WebMercatorViewport, type Layer, type View } from "@deck.gl/core";
import type { ReplayViewport } from "../ReplayViewport";
import type { ReplayRenderBackend } from "../RenderBackend";
import { FootprintDensityLayer, footprintLayerId } from "../layers/FootprintDensityLayer";
import { PickingController } from "../PickingController";
import type { ReplaySceneSnapshot, ReplayViewId } from "../ReplayScene";

import { annotationHandleLayerId } from "../layers/AnnotationLayer";
import { sameVisualOwnership, type ReplayVisualOwnership } from "../VisualOwnership";
import type { ReplayMetricSeries, ReplayMetricViewId } from "../MetricSeries";
import { RenderCompletion } from "../RenderCompletion";
import type { ReplayPickQuery } from "../ReplayPicking";

// DOM drag targets have one copy each. At whole-world zooms keep those
// markers visible so no second copy of a handle appears draggable.
function canDrawAnnotationHandles(viewport: unknown) {
  if (!(viewport instanceof WebMercatorViewport)) return false;
  const [west, , east] = viewport.getBounds();
  return east - west < 360;
}

class ReplayDeck extends Deck<View[]> {
  redrawSubmission() {
    // Deck.setProps queues layer changes. Apply them before the synchronous
    // redraw so its completion cannot acknowledge the preceding layer list.
    this.layerManager?.updateLayers();
    this.redraw("engine-sync");
  }
}

export class DeckRenderBackend implements ReplayRenderBackend<Layer> {
  private readonly deck: ReplayDeck;
  private readonly picking: PickingController;
  private snapshot: ReplaySceneSnapshot;
  private readonly completion = new RenderCompletion();
  private layers: readonly Layer[] = [];
  private submission = 0;
  private failed = false;
  private destroyed = false;
  private views: readonly ReplayViewport[] = [];
  private ownership: ReplayVisualOwnership = {timeline: false, elevation: false};
  private activeSeries: Partial<Record<ReplayMetricViewId, ReplayMetricSeries>> = {};
  private activePhotos?: ReplaySceneSnapshot["photos"];
  private activeDensity?: ReplaySceneSnapshot["timelineDensity"];
  private activeAnnotations?: ReplaySceneSnapshot["annotationGeometry"];
  get canvas() { return this.deck.getCanvas(); }
  private chartViewState: Record<string, {target: number[]; zoomX: number; zoomY: number}> = {};

  constructor(parent: HTMLDivElement, initialScene: ReplaySceneSnapshot, private readonly options: {onVisualOwnership?: (ownership: ReplayVisualOwnership) => void; onProjectionChange?: () => void; devicePixels?: boolean | number; canvas?: HTMLCanvasElement} = {}) {
    this.snapshot = initialScene;
    const width = options.canvas?.style.width || "100%";
    const height = options.canvas?.style.height || "100%";
    this.deck = new ReplayDeck({
      id: "replay-render-engine",
      parent,
      canvas: options.canvas,
      width,
      height,
      style: {position: "absolute", inset: "0", width, height, pointerEvents: "none"},
      views: [],
      viewState: {map: initialScene.mapViewState, ...this.chartViewState} as never,
      layers: [],
      controller: false,
      useDevicePixels: options.devicePixels ?? true,
      onLoad: () => {
        if (this.destroyed) return;
        this.deck.getCanvas()?.addEventListener("webglcontextlost", this.onContextLost);
        this.options.onProjectionChange?.();
      },
      onAfterRender: () => this.afterRender(),
      onError: error => this.fail(error),
      layerFilter: ({layer, viewport, isPicking}) => {
        if (!layer.id.startsWith(`${viewport.id as ReplayViewId}/`)) return false;
        if (layer.id === annotationHandleLayerId) return !isPicking && !this.failed && canDrawAnnotationHandles(viewport) && (!this.options.onVisualOwnership || Boolean(this.ownership.handles));
        if (layer.id === footprintLayerId) return !isPicking && !this.failed;
        if (isPicking) return true;
        if (layer.id === "map/photo-visual" && (this.failed || this.options.onVisualOwnership && !this.ownership.photos)) return false;
        if (layer.id.startsWith("map/annotation-visual") && (this.failed || this.options.onVisualOwnership && !this.ownership.annotations)) return false;
        if (layer.id.startsWith("map/trajectory-picking") || layer.id.startsWith("map/annotation-picking") || layer.id.includes("/metric-picking/")) return false;
        if (viewport.id === "timeline-density") return !this.failed && (!this.options.onVisualOwnership || Boolean(this.ownership["timeline-density"]));
        if (this.failed && (layer.id.includes("/metric-line/") || layer.id.includes("/metric-area/"))) return false;
        if (this.options.onVisualOwnership && (layer.id.includes("/metric-line/") || layer.id.includes("/metric-area/"))) return this.ownership[viewport.id as ReplayMetricViewId] ?? false;
        return true;
      },
    });
    this.picking = new PickingController(this.deck, () => this.snapshot);
  }

  private readonly onContextLost = () => this.fail(new Error("WebGL context is lost"), false);

  private fail(error: Error, redraw = true) {
    if (this.failed) return;
    this.failed = true;
    this.completion.fail();
    this.setOwnership({timeline: false, elevation: false});
    this.options.onProjectionChange?.();
    if (redraw) this.deck?.redraw("visual-fallback");
    console.error("Replay GPU renderer failed", error);
  }

  setViews(views: readonly ReplayViewport[]) {
    this.views = views;
    this.chartViewState = Object.fromEntries(views.filter(view => view.kind === "orthographic").map(view => [view.id, {target: [0.5, 0.5, 0], zoomX: Math.log2(Math.max(1, view.width)), zoomY: Math.log2(Math.max(1, view.height))}]));
    this.releaseChangedVisuals();
    this.applyViews();
  }

  private applyViews() {
    const views: View[] = [];
    const drawnBackdrops = new Set<string>();
    for (const {kind, backdrop, ...rect} of this.views) {
      if (backdrop && rect.id !== "map" && (!this.options.onVisualOwnership || this.ownership[rect.id])) {
        const {color, ...bounds} = backdrop, alpha = color[3] / 255;
        const key = [bounds.x, bounds.y, bounds.width, bounds.height, ...color].join(":");
        if (!drawnBackdrops.has(key)) {
          drawnBackdrops.add(key);
          views.push(new OrthographicView({...bounds, id: `${rect.id}-backdrop`, controller: false, clear: true, clearColor: [color[0] * alpha, color[1] * alpha, color[2] * alpha, color[3]], viewState: {target: [0, 0, 0], zoom: 0}}));
        }
      }
      // MapLibre repeats the world. Deck must render and pick those copies
      // too, otherwise points across the antimeridian cannot be hit.
      views.push(kind === "map" ? new MapView({...rect, controller: false, repeat: true}) : new OrthographicView({...rect, controller: false}));
    }
    this.deck?.setProps({views});
  }
  private setOwnership(ownership: ReplayVisualOwnership) {
    if (sameVisualOwnership(ownership, this.ownership)) return false;
    this.ownership = ownership;
    this.activePhotos = ownership.photos ? this.snapshot.photos : undefined;
    this.activeDensity = ownership["timeline-density"] ? this.snapshot.timelineDensity : undefined;
    this.activeAnnotations = ownership.annotations ? this.snapshot.annotationGeometry : undefined;
    for (const view of ["timeline", "elevation"] as const) {
      if (ownership[view]) this.activeSeries[view] = this.snapshot.metricSeries[view];
      else delete this.activeSeries[view];
    }
    this.applyViews();
    this.options.onVisualOwnership?.(ownership);
    return true;
  }
  private releaseChangedVisuals() {
    if (!this.options.onVisualOwnership) return;
    const next = {...this.ownership};
    if (next["timeline-density"] && (this.activeDensity !== this.snapshot.timelineDensity || !this.views.some(view => view.id === "timeline-density" && view.backdrop))) next["timeline-density"] = false;
    if (next.handles && (!this.snapshot.visibility.annotations || !this.snapshot.annotationHandles.length)) next.handles = false;
    if (next.footprint && (!this.snapshot.visibility.trajectory || !this.snapshot.footprint || !this.views.some(view => view.id === "map"))) next.footprint = false;
    if (next.photos && (!this.snapshot.visibility.trajectory || this.activePhotos !== this.snapshot.photos || !this.views.some(view => view.id === "map"))) next.photos = false;
    if (next.annotations && (!this.snapshot.visibility.annotations || this.activeAnnotations !== this.snapshot.annotationGeometry || !this.views.some(view => view.id === "map"))) next.annotations = false;
    for (const view of ["timeline", "elevation"] as const) if (next[view] && (this.activeSeries[view] !== this.snapshot.metricSeries[view] || !this.views.some(layout => layout.id === view && layout.backdrop))) next[view] = false;
    this.setOwnership(next);
  }
  private afterRender() {
    if (this.failed) return;
    if (this.options.onVisualOwnership) {
      const next = {...this.ownership};
      const handles = this.layers.find(layer => layer.id === annotationHandleLayerId);
      next.handles = Boolean(handles?.isLoaded && canDrawAnnotationHandles(this.deck.getViewports().find(view => view.id === "map")));
      const footprint = this.layers.find(layer => layer instanceof FootprintDensityLayer) as FootprintDensityLayer | undefined;
      next.footprint = Boolean(this.views.some(view => view.id === "map") && footprint?.hasRendered);
      if (!next["timeline-density"] && this.views.some(view => view.id === "timeline-density" && view.backdrop)) {
        next["timeline-density"] = Boolean(this.layers.find(layer => layer.id === "timeline-density/strip")?.isLoaded);
      }
      if (!next.photos && this.views.some(view => view.id === "map")) next.photos = Boolean(this.layers.find(layer => layer.id === "map/photo-visual")?.isLoaded);
      const annotationLayers = this.layers.filter(layer => layer.id.startsWith("map/annotation-visual"));
      if (!next.annotations && this.views.some(view => view.id === "map") && annotationLayers.length > 0 && annotationLayers.every(layer => layer.isLoaded)) next.annotations = true;
      for (const view of ["timeline", "elevation"] as const) {
        if (next[view] || !this.snapshot.metricSeries[view] || !this.views.some(layout => layout.id === view && layout.backdrop)) continue;
        const layers = this.layers.filter(layer => layer.id.startsWith(`${view}/metric-line/`) || layer.id.startsWith(`${view}/metric-area/`));
        const visible = view === "timeline" || this.snapshot.visibility.annotations;
        if ((!visible || layers.length > 0) && layers.every(layer => layer.isLoaded)) next[view] = true;
      }
      if (this.setOwnership(next)) this.deck.redraw("visual-handoff");
    }
    if (this.layers.every(layer => layer.isLoaded)) this.completion.complete(this.submission);
  }

  render(scene: ReplaySceneSnapshot, layers: readonly Layer[]) {
    this.snapshot = scene;
    this.layers = layers;
    this.releaseChangedVisuals();
    this.submission = this.completion.submit();
    this.deck.setProps({
      viewState: {map: scene.mapViewState, ...this.chartViewState} as never,
      layers: [...layers],
    });
    // Draw within the current task. Camera updates arrive synchronously from
    // the map move event and must reach the canvas before the next paint,
    // instead of waiting for Deck's own animation-frame pass.
    if (this.deck.isInitialized && !this.failed) this.deck.redrawSubmission();
  }

  getProjection(viewId: ReplayViewId) {
    if (this.failed || !this.deck.isInitialized || this.views.length === 0) return undefined;
    const viewport = this.deck.getViewports().find(view => view.id === viewId);
    if (!viewport) return null;
    return (coordinate: readonly number[]) => { const point = viewport.project([...coordinate]); return {x: point[0] + viewport.x, y: point[1] + viewport.y}; };
  }

  waitForFrame(signal: AbortSignal) { return this.completion.wait(signal); }

  pick(query: ReplayPickQuery) {
    return this.failed ? null : this.picking.pick(query);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.failed = true;
    this.completion.fail();
    this.deck.getCanvas()?.removeEventListener("webglcontextlost", this.onContextLost);
    try { this.setOwnership({timeline: false, elevation: false}); } finally { this.deck.finalize(); }
  }
}
