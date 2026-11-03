import type { Map } from "maplibre-gl";
import { worldPoint } from "./elevationRange";

// Apply the water classification to DEM pixels before GPU color relief. This
// removes white high-altitude land material from lakes without any native blur
// mask, screen-space overlay or per-frame image upload.
export async function maskTerrainWater(map: Map, canvas: HTMLCanvasElement, tile: {z:number;x:number;y:number}, signal: AbortSignal, keep: "land" | "water" = "land") {
  const sources = new Set((map.getStyle().layers ?? []).filter(layer => layer.type === "fill" && layer["source-layer"] === "water").map(layer => "source" in layer ? layer.source : "").filter(Boolean));
  if (!sources.size) return;
  const ready = () => [...sources].every(source => !map.getSource(source) || map.isSourceLoaded(source));
  if (!ready()) {
    await new Promise<void>((resolve, reject) => {
      const clear = () => {map.off("sourcedata", check);signal.removeEventListener("abort", abort);};
      const check = () => {if (ready()) {clear();resolve();}};
      const abort = () => {clear();reject(signal.reason ?? new DOMException("Aborted", "AbortError"));};
      map.on("sourcedata", check);signal.addEventListener("abort", abort, {once:true});
      if (signal.aborted) abort(); else check();
    });
  }
  signal.throwIfAborted();
  const context = canvas.getContext("2d");
  if (!context) return;
  // Rasterize coverage separately. Antialiasing encoded RGB bytes would
  // invent elevations at the boundary (0/4500 m can become -1565.8 m).
  const coverage = document.createElement("canvas");
  coverage.width = canvas.width; coverage.height = canvas.height;
  const mask = coverage.getContext("2d");
  if (!mask) return;
  mask.fillStyle = "white";
  const size = 2 ** tile.z;
  for (const source of sources) {
    if (!map.getSource(source)) continue;
    for (const feature of map.querySourceFeatures(source, {sourceLayer:"water"})) {
      const geometry = feature.geometry;
      const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
      for (const polygon of polygons) {
        mask.beginPath();
        for (const ring of polygon) {
          ring.forEach((coordinate, index) => {
            const point = worldPoint(coordinate[0], coordinate[1]);
            point.x += Math.round((tile.x + .5) / size - point.x);
            const x = (point.x * size - tile.x) * canvas.width;
            const y = (point.y * size - tile.y) * canvas.height;
            if (index) mask.lineTo(x,y); else mask.moveTo(x,y);
          });
          mask.closePath();
        }
        mask.fill("evenodd");
      }
    }
  }
  const alpha = mask.getImageData(0,0,canvas.width,canvas.height).data;
  const terrain = context.getImageData(0,0,canvas.width,canvas.height);
  for (let i=0; i<terrain.data.length; i+=4) {
    const water = alpha[i+3] >= 128;
    if ((keep === "land" && water) || (keep === "water" && !water)) {
      // Exact Terrain RGB representation of 0 m, with no channel mixing.
      terrain.data[i]=1;terrain.data[i+1]=134;terrain.data[i+2]=160;terrain.data[i+3]=255;
    }
  }
  context.putImageData(terrain,0,0);
}
