import maplibregl, {type Map as GLMap, type StyleSpecification} from "maplibre-gl";
import {addCompositeRoadLayers} from "./basemapStyle";
import {cachedMapRequest} from "../../shared/cache";

// Roads are first composed opaquely into their own canvas. Applying opacity to
// the completed canvas prevents parallel and crossing lines from accumulating
// alpha and becoming brighter than an isolated road.
export class RoadOverlay {
  readonly container = document.createElement("div");
  private overlay: GLMap;
  private disposed = false;
  private syncing = false;
  private sync = () => this.synchronize();

  constructor(private base: GLMap, style: StyleSpecification) {
    this.container.dataset.roadComposite = "true";
    Object.assign(this.container.style, {
      position: "absolute", inset: "0", pointerEvents: "none", opacity: "0.52",
      mixBlendMode: "screen", visibility: "hidden",
    });
    this.base.getCanvasContainer().before(this.container);
    const center = base.getCenter();
    this.overlay = new maplibregl.Map({
      container: this.container,
      style,
      center: [center.lng, center.lat], zoom: base.getZoom(), bearing: base.getBearing(), pitch: base.getPitch(),
      interactive: false, attributionControl: false,
      transformRequest: cachedMapRequest,
      canvasContextAttributes: {alpha: true},
    });
    this.overlay.once("load", () => {
      for (const layer of this.overlay.getStyle().layers ?? []) {
        this.overlay.setLayoutProperty(layer.id, "visibility", "none");
      }
      addCompositeRoadLayers(this.overlay);
      this.overlay.triggerRepaint();
      this.container.style.visibility = "visible";
      this.synchronize();
    });
    base.on("move", this.sync);
    base.on("resize", this.sync);
    base.on("render", this.sync);
  }

  private synchronize() {
    if (this.disposed || this.syncing) return;
    this.syncing = true;
    try {
      const terrain = this.base.getContainer().querySelector<HTMLCanvasElement>("canvas[data-terrain-precision]");
      if (terrain) terrain.after(this.container);
      else this.base.getCanvasContainer().before(this.container);
      const center = this.base.getCenter();
      this.overlay.jumpTo({center: [center.lng, center.lat], zoom: this.base.getZoom(), bearing: this.base.getBearing(), pitch: this.base.getPitch()});
      this.overlay.resize();
    } finally { this.syncing = false; }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.base.off("move", this.sync);
    this.base.off("resize", this.sync);
    this.base.off("render", this.sync);
    this.overlay.remove();
    this.container.remove();
  }
}
