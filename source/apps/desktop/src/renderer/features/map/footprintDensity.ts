import maplibregl, { type CustomLayerInterface, type CustomRenderMethodInput } from "maplibre-gl";
import { FootprintDensityPass } from "../../render-engine/FootprintDensityPass";

export { footprintRadius } from "../../render-engine/FootprintDensityPass";

export class FootprintDensity extends FootprintDensityPass implements CustomLayerInterface {
  readonly id = "footprint-log-density";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;
  private map?: maplibregl.Map;

  constructor(coordinates: readonly number[], linePaths: readonly (readonly (readonly [number, number])[])[] = []) {
    super(coordinates, linePaths,
      (longitude, latitude) => maplibregl.MercatorCoordinate.fromLngLat([longitude, latitude]),
      () => this.map?.triggerRepaint(),
    );
  }

  onAdd(map: maplibregl.Map, context: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.attach(context);
  }

  prerender(_context: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput) {
    if (!this.map) return;
    this.accumulate({
      matrix: options.defaultProjectionData.mainMatrix,
      zoom: this.map.getZoom(),
      centerLongitude: this.map.getCenter().lng,
      cssWidth: this.map.getCanvas().clientWidth,
    });
  }

  render() { this.compositeToViewport(); }

  onRemove() {
    this.destroy();
    this.map = undefined;
  }
}
