import maplibregl from "maplibre-gl";
import type { ExpressionSpecification } from "maplibre-gl";
import { updateWaterFallback } from "./water";
import { maskTerrainWater } from "./terrainWaterMask";
import { compressedRatio, DEFAULT_OCEAN_DEPTH, type ElevationRange } from "./elevationRange";

type Session = { map: maplibregl.Map };
const sessions = new Map<string, Session>();
let sequence = 0;

// Cache raw DEM resources through the normal disk cache. View-dependent colors
// belong in a GPU color ramp, never in a persistent precolored tile cache.
maplibregl.addProtocol("elevation-dem", async (request, controller) => {
  const url = new URL(request.url.replace(/^elevation-dem:/, "https:"));
  const session = sessions.get(url.searchParams.get("replayElevation") ?? "");
  url.searchParams.delete("replayElevation");
  const bytes = window.replaymod
    ? new Uint8Array(await window.replaymod.loadMapResource(url.href))
    : new Uint8Array(await (await fetch(url, {signal: controller.signal})).arrayBuffer());
  controller.signal.throwIfAborted();
  const match = url.pathname.match(/\/tiles\/(terrain-rgb-v2|ocean-rgb)\/(\d+)\/(\d+)\/(\d+)/);
  let renderBytes = bytes.buffer;
  const maskOceanOverview = session && match && match[1] === "ocean-rgb" && Math.floor(session.map.getZoom()) <= +match[2];
  if (session && match && (match[1] === "terrain-rgb-v2" || maskOceanOverview)) {
    const bitmap = await createImageBitmap(new Blob([bytes]));
    try {
      const canvas = document.createElement("canvas");
      // MapLibre backfills neighbouring DEM borders and requires identical
      // pixel dimensions. Keep the provider's native size at every zoom.
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建海拔画布");
      context.imageSmoothingEnabled = false;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      await maskTerrainWater(session.map, canvas, {z:+match[2],x:+match[3],y:+match[4]}, controller.signal, match[1] === "ocean-rgb" ? "water" : "land");
      const masked = await new Promise<Blob>((resolve,reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("水域地形遮罩编码失败")), "image/png"));
      renderBytes = await masked.arrayBuffer();
      controller.signal.throwIfAborted();
    } finally { bitmap.close(); }
  }
  return {data: renderBytes};
});

export function elevationRamp(range: ElevationRange, ocean = false): ExpressionSpecification {
  const stops: (number | string)[] = [];
  const extent = ocean ? DEFAULT_OCEAN_DEPTH : 9000;
  // Sample the mild normalized gamma curve into MapLibre color-ramp stops.
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) ** 2;
    const value = ocean ? -extent * (1 - i / 64) ** 2 : extent * t;
    const alpha = compressedRatio(Math.abs(value), extent);
    const color = ocean ? 0 : 255;
    stops.push(value, `rgba(${color},${color},${color},${alpha})`);
  }
  return ["interpolate", ["linear"], ["elevation"], ...stops] as ExpressionSpecification;
}

export async function addElevationGlass(map: maplibregl.Map, apiKey: string, signal: AbortSignal) {
  const id = String(++sequence);
  sessions.set(id, {map});
  const domain = {minimum:-DEFAULT_OCEAN_DEPTH, maximum:9000};
  signal.addEventListener("abort", () => sessions.delete(id), {once:true});
  const addSource = async (dataset: "terrain-rgb-v2" | "ocean-rgb") => {
    const url = `https://api.maptiler.com/tiles/${dataset}/tiles.json?key=${encodeURIComponent(apiKey)}`;
    const metadata: {tiles: string[]; minzoom?: number; maxzoom?: number; attribution?: string} = window.replaymod
      ? JSON.parse(new TextDecoder().decode(new Uint8Array(await window.replaymod.loadMapResource(url))))
      : await (await fetch(url, {signal})).json();
    if (signal.aborted) return;
    const source = dataset === "ocean-rgb" ? "ocean-elevation-glass" : "elevation-glass";
    map.addSource(source, {
      type: "raster-dem", encoding: "mapbox",
      tiles: metadata.tiles.map(tile => {
        const request = new URL(tile);
        request.searchParams.set("replayElevation", id);
        // URL serializes placeholders, restore them for MapLibre substitution.
        return request.href.replace(/^https:/, "elevation-dem:").replace(/%7B/gi, "{").replace(/%7D/gi, "}");
      }),
      tileSize: 512, minzoom: metadata.minzoom ?? 0,
      maxzoom: metadata.maxzoom ?? (dataset === "ocean-rgb" ? 7 : 14), attribution: metadata.attribution,
    });
    const before = (map.getStyle().layers ?? []).find(layer => layer.id !== "elevation-glass")?.id;
    map.addLayer({id: source, type: "color-relief", source, paint: {
      "color-relief-color": elevationRamp(domain, dataset === "ocean-rgb"),
    }}, before);
  };
  await addSource("terrain-rgb-v2");
  await addSource("ocean-rgb").catch(error => {
    if (!signal.aborted) map.fire("error", {error, sourceId: "ocean-elevation-glass"});
  });
  if (!signal.aborted) updateWaterFallback(map, domain);
}
