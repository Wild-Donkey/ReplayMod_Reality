import type { ReplayLayerHandle, ReplayLayerRegistry } from "./LayerRegistry";
import type { ReplayPickQuery, ReplayPickResult } from "./ReplayPicking";
import { RenderScheduler } from "./RenderScheduler";
import type { ReplayRenderBackend } from "./RenderBackend";
import type { ReplayScene, ReplaySceneSnapshot } from "./ReplayScene";
import type { ReplayClockSnapshot } from "./ReplayClock";
import type { ReplayViewport } from "./ReplayViewport";
import { ViewLayoutController } from "./ViewLayoutController";

export class ReplayRenderEngine<LayerType extends ReplayLayerHandle> {
  private readonly backend: ReplayRenderBackend<LayerType>;
  private readonly scheduler: RenderScheduler;
  private readonly viewLayout: ViewLayoutController | null;
  private readonly unsubscribeScene: () => void;
  private readonly unsubscribeClock: () => void;
  private readonly unsubscribePicking: () => void;
  private readonly unsubscribeProjection: () => void;
  private mapViewState: ReplaySceneSnapshot["mapViewState"];
  private builtSceneRevision = -1;
  private builtClockFrame = -1;
  private layers: readonly LayerType[] = [];
  private destroyed = false;

  constructor(parent: HTMLDivElement, private readonly scene: ReplayScene, backend: ReplayRenderBackend<LayerType>, registry: ReplayLayerRegistry<LayerType>, options?: {views: readonly ReplayViewport[]; picking?: boolean; syncCamera?: boolean}) {
    this.backend = backend;
    this.mapViewState = scene.current.mapViewState;
    this.scheduler = new RenderScheduler(() => this.renderFrame(registry));
    if (options) {
      this.viewLayout = null;
      this.backend.setViews(options.views);
      this.scheduler.invalidate("layout");
    } else this.viewLayout = new ViewLayoutController(parent, views => {
      this.backend.setViews(views);
      scene.projection.invalidate();
      this.scheduler.invalidate("layout");
    });
    this.unsubscribeScene = scene.subscribe(snapshot => {
      this.scheduler.invalidate("scene");
      // Camera updates originate from the map's own move events: drawing on the
      // next frame would leave the engine trajectory one frame behind the base
      // map (visible as jelly/separation during pan and zoom). Draw now.
      if (snapshot.mapViewState !== this.mapViewState) {
        this.mapViewState = snapshot.mapViewState;
        if (options?.syncCamera !== false) this.scheduler.flushSync();
        scene.projection.invalidate();
      }
    });
    this.unsubscribeClock = scene.clock.subscribe(() => this.scheduler.invalidate("clock"));
    this.unsubscribePicking = options?.picking === false ? () => {} : scene.picking.attach(query => {
      const rect = parent.getBoundingClientRect();
      return this.pick({...query, x: query.x - rect.left, y: query.y - rect.top});
    });
    this.unsubscribeProjection = options?.picking === false ? () => {} : scene.projection.attach(view => {
      const project = this.backend.getProjection?.(view);
      if (!project) return project;
      const rect = parent.getBoundingClientRect();
      return coordinate => { const point = project(coordinate); return point ? {x: point.x + rect.left, y: point.y + rect.top} : null; };
    });
  }

  async renderComplete(signal: AbortSignal) {
    if (this.destroyed || signal.aborted) return false;
    if (!this.backend.waitForFrame) throw new Error("This render backend cannot acknowledge completed frames");
    this.scheduler.invalidate("scene");
    this.scheduler.flushSync();
    return this.backend.waitForFrame(signal);
  }

  pick(query: ReplayPickQuery): ReplayPickResult | null {
    if (this.destroyed) return null;
    this.scheduler.flushSync();
    return this.backend.pick(query);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    const errors: unknown[] = [];
    for (const dispose of [this.unsubscribeScene, this.unsubscribeClock, this.unsubscribePicking, this.unsubscribeProjection, () => this.viewLayout?.destroy(), () => this.scheduler.destroy(), () => this.backend.destroy()]) {
      try { dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Replay renderer cleanup failed");
  }

  // Layers only depend on scene content and the clock frame; camera-only
  // invalidations reuse the previously built layer instances so repeated move
  // events within a frame never rebuild them.
  private renderFrame(registry: ReplayLayerRegistry<LayerType>) {
    const snapshot = this.scene.current;
    const clock: ReplayClockSnapshot = this.scene.clock.current;
    if (snapshot.contentRevision !== this.builtSceneRevision || clock.frame !== this.builtClockFrame) {
      this.layers = registry.build(snapshot, clock);
      this.builtSceneRevision = snapshot.contentRevision;
      this.builtClockFrame = clock.frame;
    }
    this.backend.render(snapshot, this.layers);
  }
}
