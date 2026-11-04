import { RawTerrain } from "./RawTerrain";
import { type TerrainAppearance, decodeElevation } from "./terrainExposure";
import maplibregl from "maplibre-gl";
import type { ExpressionSpecification } from "maplibre-gl";
import { updateWaterFallback } from "./water";
import { maskTerrainWater } from "./terrainWaterMask";
import { compressedRatio, DEFAULT_OCEAN_DEPTH, type ElevationRange } from "./elevationRange";
import type { MapCoordinate } from "../../../../../../packages/data/src";

export type TerrainProfilePoint = [number, number, number];

type Session = { map: maplibregl.Map; signal: AbortSignal; raw?: RawTerrain };
const sessions = new Map<string, Session>();
let sequence = 0;

// Cache raw DEM resources through the normal disk cache. View-dependent colors
// belong in a GPU color ramp, never in a persistent precolored tile cache.
async function loadElevationDEM(request: {url: string}, controller: {signal: AbortSignal}) {
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
  if (session && match && (session.raw || match[1] === "terrain-rgb-v2" || maskOceanOverview)) {
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
      // Raw display retains the physical altitude of alpine lakes. Only the
      // legacy white-alpha colour relief needs water pixels flattened to 0 m;
      // provider water geometry above the raw canvas supplies the material.
      const surfaceHeights = session.raw && match[1] === "terrain-rgb-v2"
        ? decodeElevation(context.getImageData(0,0,canvas.width,canvas.height).data) : undefined;
      let materials: Uint8Array | undefined;
      if (match[1] === "terrain-rgb-v2" || maskOceanOverview) {
        materials = await maskTerrainWater(session.map, canvas, {z:+match[2],x:+match[3],y:+match[4]}, controller.signal, match[1] === "ocean-rgb" ? "water" : "land");
      }
      session.raw?.addTile({ z:+match[2], x:+match[3], y:+match[4], ocean:match[1] === "ocean-rgb",
        width:canvas.width, height:canvas.height,
        materials,
        heights:surfaceHeights ?? decodeElevation(context.getImageData(0,0,canvas.width,canvas.height).data),
        reload: async () => { await loadElevationDEM(request,{signal:session.signal}); },
      });
      const masked = await new Promise<Blob>((resolve,reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("水域地形遮罩编码失败")), "image/png"));
      renderBytes = await masked.arrayBuffer();
      controller.signal.throwIfAborted();
    } finally { bitmap.close(); }
  }
  return {data: renderBytes};
}
maplibregl.addProtocol("elevation-dem",loadElevationDEM);

export async function sampleTerrainProfile(coordinates: readonly MapCoordinate[], apiKey: string, signal: AbortSignal): Promise<TerrainProfilePoint[]> {
  if (coordinates.length < 2) return [];
  const metadataUrl=`https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${encodeURIComponent(apiKey)}`;
  const metadataBytes=window.replaymod?new Uint8Array(await window.replaymod.loadMapResource(metadataUrl)):new Uint8Array(await (await fetch(metadataUrl,{signal})).arrayBuffer());
  signal.throwIfAborted();
  const metadata=JSON.parse(new TextDecoder().decode(metadataBytes)) as {tiles:string[];maxzoom?:number};
  if(!metadata.tiles[0])throw new Error("地形服务未返回图块地址");
  const sampleCount = Math.min(500, coordinates.length);
  const indexes = Array.from({length:sampleCount},(_,index)=>Math.round(index*(coordinates.length-1)/Math.max(1,sampleCount-1)));
  const zoom = Math.min(12,metadata.maxzoom??12), scale = 2 ** zoom;
  const samples = indexes.map(index => {
    const coordinate=coordinates[index],longitude=((coordinate[0]+180)%360+360)%360-180,latitude=Math.max(-85.05112878,Math.min(85.05112878,coordinate[1]));
    const worldX=(longitude+180)/360*scale;
    const worldY=(1-Math.asinh(Math.tan(latitude*Math.PI/180))/Math.PI)/2*scale;
    return {coordinate,tileX:Math.floor(worldX),tileY:Math.floor(worldY),u:worldX-Math.floor(worldX),v:worldY-Math.floor(worldY)};
  });
  const tiles=new Map<string,Promise<{width:number;height:number;data:Uint8ClampedArray}>>();
  const loadTile=(x:number,y:number)=>{
    const key=`${x}/${y}`;
    let tile=tiles.get(key);
    if(!tile){tile=(async()=>{
      const url=metadata.tiles[0].replace("{z}",String(zoom)).replace("{x}",String(x)).replace("{y}",String(y));
      const bytes=window.replaymod?new Uint8Array(await window.replaymod.loadMapResource(url)):new Uint8Array(await (await fetch(url,{signal})).arrayBuffer());
      signal.throwIfAborted();
      const bitmap=await createImageBitmap(new Blob([bytes]));
      try{const canvas=document.createElement("canvas");canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext("2d");if(!context)throw new Error("无法读取海拔图块");context.drawImage(bitmap,0,0);return {width:canvas.width,height:canvas.height,data:context.getImageData(0,0,canvas.width,canvas.height).data};}finally{bitmap.close();}
    })();tiles.set(key,tile);}
    return tile;
  };
  return Promise.all(samples.map(async sample=>{
    const tile=await loadTile(sample.tileX,sample.tileY);signal.throwIfAborted();
    const x=Math.min(tile.width-1,Math.floor(sample.u*tile.width)),y=Math.min(tile.height-1,Math.floor(sample.v*tile.height)),offset=(y*tile.width+x)*4;
    const elevation=-10000+(tile.data[offset]*65536+tile.data[offset+1]*256+tile.data[offset+2])*0.1;
    return [sample.coordinate[0],sample.coordinate[1],elevation];
  }));
}

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

export async function addElevationGlass(map: maplibregl.Map, apiKey: string, signal: AbortSignal, onAppearance?: (appearance: TerrainAppearance | null) => void) {
  const id = String(++sequence);
  const session: Session = {map,signal};
  sessions.set(id, session);
  const domain = {minimum:-DEFAULT_OCEAN_DEPTH, maximum:9000};
  let rawFailed = false;
  const restoreLegacy = () => {
    rawFailed = true;
    const raw = session.raw; session.raw = undefined;
    if (raw) queueMicrotask(() => raw.dispose());
    updateWaterFallback(map,domain,false);
    for (const ocean of [false,true]) {
      const source = ocean ? "ocean-elevation-glass" : "elevation-glass";
      if (map.getLayer(source)) map.setPaintProperty(source,"color-relief-opacity",1);
    }
  };
  signal.addEventListener("abort", () => { sessions.delete(id); session.raw?.dispose(); }, {once:true});
  try {
    const raw = await RawTerrain.create(map,restoreLegacy,onAppearance);
    if (signal.aborted) { raw.dispose(); return; }
    if (rawFailed) raw.dispose(); else session.raw = raw;
  } catch (error) {
    console.warn("浮点地形不可用，保留标准地形显示",error);
  }
  if (signal.aborted) return;
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
      "color-relief-opacity": session.raw ? 0 : 1,
    }}, before);
  };
  await addSource("terrain-rgb-v2");
  await addSource("ocean-rgb").catch(error => {
    if (!signal.aborted) map.fire("error", {error, sourceId: "ocean-elevation-glass"});
  });
  if (!signal.aborted) updateWaterFallback(map, domain);
}
