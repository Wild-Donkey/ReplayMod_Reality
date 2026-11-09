import maplibregl, {type Map as GLMap, type StyleSpecification} from "maplibre-gl";
import {addCompositeRoadLayers, ROAD_OPACITY_SCALE} from "./basemapStyle";
import {cachedMapRequest} from "../../shared/cache";

// Roads are first composed opaquely into their own canvas. Applying opacity to
// the completed canvas prevents parallel and crossing lines from accumulating
// alpha and becoming brighter than an isolated road.
export class RoadOverlay {
  readonly container = document.createElement("div");
  private overlay: GLMap;
  private disposed = false;
  private visible = true;
  private previousFrame: readonly number[] | null = null;
  setVisible(visible: boolean) {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    this.previousFrame = null;
    this.container.style.display = visible ? "" : "none";
    if (visible) this.synchronize();
  }
  private syncing = false;
  private sync = () => this.synchronize();

  constructor(private base: GLMap, style: StyleSpecification) {
    this.container.dataset.roadComposite = "true";
    Object.assign(this.container.style, {
      position: "absolute", inset: "0", pointerEvents: "none", opacity: String(ROAD_OPACITY_SCALE),
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
    if (this.disposed || this.syncing || !this.visible) return;
    this.syncing = true;
    try {
      const terrain = this.base.getContainer().querySelector<HTMLCanvasElement>("canvas[data-terrain-precision]");
      if (terrain) {
        if (this.container.previousSibling !== terrain) terrain.after(this.container);
      } else {
        const canvasContainer = this.base.getCanvasContainer();
        if (canvasContainer.previousSibling !== this.container) canvasContainer.before(this.container);
      }
      const center = this.base.getCenter();
      const frame = [center.lng, center.lat, this.base.getZoom(), this.base.getBearing(), this.base.getPitch(), this.base.getContainer().clientWidth, this.base.getContainer().clientHeight];
      const previous = this.previousFrame;
      if (!previous || frame.slice(0, 5).some((value, index) => value !== previous[index])) {
        this.overlay.jumpTo({center: [frame[0], frame[1]], zoom: frame[2], bearing: frame[3], pitch: frame[4]});
      }
      if (!previous || frame[5] !== previous[5] || frame[6] !== previous[6]) this.overlay.resize();
      this.previousFrame = frame;
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
