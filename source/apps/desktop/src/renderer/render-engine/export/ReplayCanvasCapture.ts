import type { ReplayCamera } from "../ReplayCamera";
import type { ReplayScene } from "../ReplayScene";
import type { ReplayViewport } from "../ReplayViewport";
import { ReplayRenderEngine } from "../ReplayRenderEngine";
import { DeckRenderBackend } from "../backends/DeckRenderBackend";
import { createDeckLayerRegistry } from "../backends/DeckLayerRegistry";
import type { Layer } from "@deck.gl/core";

// Explicit export views do not observe workspace DOM or replace its picking.
// Preview and offline callers can use this same layer graph at a fixed size.
export class ReplayCanvasCapture {
  private readonly surface: HTMLDivElement;
  private readonly backend: DeckRenderBackend;
  private readonly engine: ReplayRenderEngine<Layer>;
  private readonly pixelWidth: number;
  private readonly pixelHeight: number;
  private destroyed = false;
  private busy = false;
  constructor(parent: HTMLElement, private readonly scene: ReplayScene, options: {
    width: number; height: number; views?: readonly ReplayViewport[]; annotations?: boolean; metrics?: boolean; pixelRatio?: number;
  }) {
    if (!Number.isInteger(options.width) || !Number.isInteger(options.height) || options.width <= 0 || options.height <= 0) throw new Error("Invalid capture dimensions");
    if (options.pixelRatio !== undefined && (!Number.isFinite(options.pixelRatio) || options.pixelRatio <= 0 || options.pixelRatio > 8)) throw new Error("Invalid capture pixel ratio");
    const pixelRatio = options.pixelRatio ?? 1;
    this.pixelWidth = Math.floor(options.width * pixelRatio);
    this.pixelHeight = Math.floor(options.height * pixelRatio);
    if (this.pixelWidth < 1 || this.pixelHeight < 1) throw new Error("Capture drawing buffer must be at least one pixel");
    this.surface = document.createElement("div");
    Object.assign(this.surface.style, {position: "absolute", left: "0", top: "0", width: `${options.width}px`, height: `${options.height}px`, pointerEvents: "none"});
    // Seed both sizes before Deck creates its device. A hidden window can
    // draw before ResizeObserver delivers its first measurement.
    const canvas = document.createElement("canvas");
    canvas.width = this.pixelWidth;
    canvas.height = this.pixelHeight;
    canvas.style.width = this.surface.style.width;
    canvas.style.height = this.surface.style.height;
    this.surface.appendChild(canvas);
    parent.appendChild(this.surface);
    let backend: DeckRenderBackend | undefined;
    try {
      // Offline resolution is explicit and must not change with the monitor.
      this.backend = backend = new DeckRenderBackend(this.surface, scene.current, {canvas, devicePixels: pixelRatio});
      this.engine = new ReplayRenderEngine(this.surface, scene, this.backend, createDeckLayerRegistry({annotations: options.annotations ?? true, metrics: options.metrics ?? true, picking: false}), {
        views: options.views ?? [{id: "map", kind: "map", x: 0, y: 0, width: options.width, height: options.height}], picking: false, syncCamera: false,
      });
    } catch (error) { try { backend?.destroy(); } finally { this.surface.remove(); } throw error; }
  }
  async capture(timestamp: number, frame: number, camera: ReplayCamera, signal: AbortSignal) {
    if (this.destroyed || signal.aborted) return null;
    if (!Number.isFinite(timestamp) || !Number.isInteger(frame) || frame < 0) throw new Error("Invalid capture frame");
    if (this.busy) throw new Error("Concurrent frame captures are not allowed");
    this.busy = true;
    try {
      this.scene.clock.step(timestamp, frame);
      this.scene.setMapViewState(camera);
      const revision = this.scene.current.revision;
      if (!await this.engine.renderComplete(signal) || this.destroyed || signal.aborted || this.scene.current.revision !== revision || this.scene.clock.current.frame !== frame) return null;
      const canvas = this.backend.canvas;
      if (canvas && (canvas.width !== this.pixelWidth || canvas.height !== this.pixelHeight)) {
        throw new Error(`Capture drawing buffer is ${canvas.width}×${canvas.height}; expected ${this.pixelWidth}×${this.pixelHeight}`);
      }
      return canvas;
    } finally { this.busy = false; }
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    try { this.engine.destroy(); } finally { this.surface.remove(); }
  }
}
