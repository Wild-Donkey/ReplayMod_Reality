import { addProtocol, MercatorCoordinate, type ExpressionSpecification, type Map as GLMap } from "maplibre-gl";
import { daylightDisplayZones, type ObservationPoint } from "./astronomy";

const atlas = "https://djlorenz.github.io/astronomy";
export const lightPollutionSource = "astronomy-light-pollution";
export const lightPollutionColorKey = `${atlas}/lp/colors.html`;
const classTileProtocol = "light-pollution-class-tile";
const coverage = [-180, -65, 180, 75] as const;
const cellsPerTile = 600;
const maxTileZoom = 6;
const meterSize = 64;
const meterTarget = 0.7;
export const defaultLightPollutionExposure = meterTarget;
const encodedPeak = 224;
const meterTiles = new Map<string, Uint8Array>();
const rasterTiles = `${atlas}/image_tiles/tiles2025`;

addProtocol(classTileProtocol, async ({url}, {signal}) => {
  const tile = url.slice(url.lastIndexOf("/") + 1);
  let response = await fetch(`${rasterTiles}/${tile}`, {signal});
  // The atlas omits dark raster tiles and serves a separate black tile for them.
  if (response.status === 404) response = await fetch(`${rasterTiles}/black.png`, {signal});
  if (!response.ok) throw new Error(`光污染瓦片加载失败 (${response.status})`);
  const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: "none" });
  try {
    signal.throwIfAborted();
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法转换光污染瓦片");
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const {data} = image;
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      const gray = tileGrays.get(key) ?? Math.min(encodedPeak, data[i]);
      data[i] = data[i + 1] = 0;
      data[i + 2] = gray;
    }
    const samples = new Uint8Array(meterSize ** 2);
    for (let y = 0; y < meterSize; y++) {
      for (let x = 0; x < meterSize; x++) {
        const u = Math.floor((x + 0.5) * bitmap.width / meterSize);
        const v = Math.floor((y + 0.5) * bitmap.height / meterSize);
        samples[y * meterSize + x] = data[(v * bitmap.width + u) * 4 + 2];
      }
    }
    context.putImageData(image, 0, 0);
    const grayTile = await canvas.convertToBlob({ type: "image/png" });
    signal.throwIfAborted();
    const bytes = await grayTile.arrayBuffer();
    signal.throwIfAborted();
    meterTiles.delete(tile);
    meterTiles.set(tile, samples);
    if (meterTiles.size > 256) meterTiles.delete(meterTiles.keys().next().value!);
    return {data: bytes};
  } finally {
    bitmap.close();
  }
});

// Lorenz zones use the ratio of artificial to natural zenith brightness.
const atlasZones = [
  ["0", "#000000", 0.01],
  ["1a", "#222222", 0.06], ["1b", "#424242", 0.11],
  ["2a", "#142f72", 0.19], ["2b", "#2154d8", 0.33],
  ["3a", "#0f5714", 0.58], ["3b", "#1fa12a", 1],
  ["4a", "#6e641e", 1.73], ["4b", "#b8a625", 3],
  ["5a", "#bf641e", 5.2], ["5b", "#fd9650", 9],
  ["6a", "#fb5a49", 15.59], ["6b", "#fb998a", 27],
  ["7a", "#a0a0a0", 46.77], ["7b", "#f2f2f2", Infinity],
] as const;

const grayForZone = (index: number) => Math.round(index * encodedPeak / (atlasZones.length - 1));
const tileGrays = new Map(atlasZones.map(([, hex], index) => [Number.parseInt(hex.slice(1), 16), grayForZone(index)]));
export const lightPollutionZones = atlasZones.map(([zone, , upper], index) =>
  [zone, lightPollutionGray(index, defaultLightPollutionExposure), upper] as const
);

export function lightPollutionGray(index: number, exposure: number) {
  const gray = Math.round(255 * grayLevel(index, exposure));
  return `rgb(${gray}, ${gray}, ${gray})`;
}

// Interpolate ascending gray levels using endpoint slopes normalized to the segment.
function graySegment(t: number, startSlope: number, endSlope: number) {
  return t * (startSlope + t * (3 - 2 * startSlope - endSlope + t * (startSlope + endSlope - 2)));
}

function grayLevel(index: number, exposure: number) {
  const level = index / (atlasZones.length - 1);
  const pivot = meterTarget / exposure;
  const highlightWidth = 1 - pivot;
  const highlightRange = Math.min(0.26, 0.8 * highlightWidth);
  const shadowSlope = meterTarget / pivot;
  const highlightSlope = highlightWidth > 0 ? highlightRange / highlightWidth : shadowSlope;
  const anchorSlope = 1.25 * Math.min(shadowSlope, highlightSlope);

  // Give the ends of the ramp more room while matching the slopes at P99.
  const gray = level <= pivot
    ? meterTarget * graySegment(level / pivot, 1.25, anchorSlope / shadowSlope)
    : meterTarget + highlightRange * graySegment((level - pivot) / highlightWidth, anchorSlope / highlightSlope, 1.25);
  return Math.round(255 * gray) / 255;
}

export function lightPollutionZoneGray(zone: typeof atlasZones[number][0], exposure: number) {
  return grayLevel(atlasZones.findIndex(([id]) => id === zone), exposure);
}

export function lightPollutionZoneCode(zone: typeof atlasZones[number][0]) {
  return grayForZone(atlasZones.findIndex(([id]) => id === zone));
}

export const lightPollutionMeterGrid = { width: 32, height: 24 };
export type LightPollutionMeter = { ambient?: Uint8ClampedArray; refresh?: () => void };

function exposureRamp(exposure: number): ExpressionSpecification {
  return ["interpolate", ["linear"], ["elevation"],
    ...atlasZones.flatMap((_, index) => [grayForZone(index), lightPollutionGray(index, exposure)]),
  ] as ExpressionSpecification;
}

function meterExposure(map: GLMap, ambient: Uint8ClampedArray | undefined) {
  const { clientWidth: width, clientHeight: height } = map.getContainer();
  const zoom = Math.min(maxTileZoom, Math.max(0, Math.round(map.getZoom() - 1)));
  const histogram = new Uint16Array(256);
  let available = 0;
  const { width: columns, height: rows } = lightPollutionMeterGrid;
  const daylightFloor = lightPollutionZoneCode(daylightDisplayZones.water);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const ambientCode = ambient?.[(row * columns + column) * 4] ?? 0;
      if (ambientCode >= daylightFloor) {
        histogram[ambientCode]++;
        available++;
        continue;
      }
      const point = map.unproject([(column + 0.5) * width / columns, (row + 0.5) * height / rows]).wrap();
      if (point.lat < coverage[1] || point.lat >= coverage[3]) {
        histogram[ambientCode]++;
        available++;
        continue;
      }
      const coordinate = MercatorCoordinate.fromLngLat(point);
      let pollution: number | undefined;
      for (let z = zoom; z >= 0; z--) {
        const scale = 2 ** z;
        const x = ((coordinate.x % 1) + 1) % 1 * scale;
        const y = coordinate.y * scale;
        const tile = meterTiles.get(`tile_${z}_${Math.floor(x)}_${Math.floor(y)}.png`);
        if (!tile) continue;
        pollution = tile[Math.floor((y % 1) * meterSize) * meterSize + Math.floor((x % 1) * meterSize)];
        break;
      }
      if (pollution !== undefined || ambientCode > 0) {
        histogram[Math.max(pollution ?? 0, ambientCode)]++;
        available++;
      }
    }
  }
  if (!available) return null;
  const rank = Math.ceil(available * 0.99);
  for (let gray = 0, count = 0; gray < histogram.length; gray++) {
    count += histogram[gray];
    if (count < rank) continue;
    return gray ? meterTarget * encodedPeak / gray : null;
  }
  return null;
}

export function addLightPollutionLayer(map: GLMap, onExposure: (exposure: number) => void, meter: LightPollutionMeter) {
  map.addSource(lightPollutionSource, {
    // Use the DEM color-ramp renderer for the encoded class values.
    type: "raster-dem",
    encoding: "custom",
    redFactor: 65536, greenFactor: 256, blueFactor: 1, baseShift: 0,
    tiles: [`${classTileProtocol}://tiles/tile_{z}_{x}_{y}.png`],
    attribution: '<a href="https://djlorenz.github.io/astronomy/lp/" target="_blank" rel="noreferrer">David Lorenz · Light Pollution Atlas 2025</a>',
    tileSize: 1024,
    // The source uses 1024 px tiles, with URL zoom two levels below Leaflet’s.
    maxzoom: maxTileZoom,
    bounds: [...coverage],
  });
  const before = map.getStyle().layers.find(layer => layer.type !== "background")?.id;
  map.addLayer({
    id: lightPollutionSource,
    type: "color-relief",
    source: lightPollutionSource,
    paint: { resampling: "nearest", "color-relief-color": exposureRamp(meterTarget) },
  }, before);

  let target = meterTarget;
  let exposure = meterTarget;
  let presented = meterTarget;
  let lastFrame = 0;
  let frame = 0;
  let needsMetering = false;
  onExposure(meterTarget);
  const animate = (now: number) => {
    frame = 0;
    if (needsMetering) {
      needsMetering = false;
      target = meterExposure(map, meter.ambient) ?? target;
    }
    const elapsed = lastFrame ? Math.min(100, now - lastFrame) : 16;
    exposure += (target - exposure) * (1 - Math.exp(-elapsed / 350));
    if (Math.abs(target - exposure) < 0.01) exposure = target;
    const quantized = exposure === target ? target : Math.round(exposure * 50) / 50;
    if (quantized !== presented) {
      presented = quantized;
      map.setPaintProperty(lightPollutionSource, "color-relief-color", exposureRamp(presented));
      onExposure(presented);
    }
    lastFrame = exposure === target ? 0 : now;
    if (lastFrame) frame = requestAnimationFrame(animate);
  };
  const schedule = () => {
    needsMetering = true;
    if (!frame) frame = requestAnimationFrame(animate);
  };
  const sourceChanged = (event: { sourceId?: string }) => {
    if (event.sourceId === lightPollutionSource) schedule();
  };
  meter.refresh = schedule;
  map.on("sourcedata", sourceChanged);
  map.on("moveend", schedule);
  map.on("resize", schedule);
  schedule();
  return () => {
    delete meter.refresh;
    cancelAnimationFrame(frame);
    map.off("sourcedata", sourceChanged);
    map.off("moveend", schedule);
    map.off("resize", schedule);
  };
}

export async function sampleLightPollution([longitude, latitude]: ObservationPoint, signal: AbortSignal) {
  if (latitude < coverage[1] || latitude >= coverage[3]) return null;
  const east = ((longitude + 180) % 360 + 360) % 360;
  const north = latitude - coverage[1];
  const tileX = Math.floor(east / 5);
  const tileY = Math.floor(north / 5);
  const x = Math.min(cellsPerTile - 1, Math.floor((east - tileX * 5) * 120));
  const y = Math.min(cellsPerTile - 1, Math.floor((north - tileY * 5) * 120));

  const response = await fetch(`${atlas}/binary_tiles/2025/binary_tile_${tileX + 1}_${tileY + 1}.dat.gz`, { signal });
  if (!response.ok || !response.body) throw new Error(`光污染数据加载失败 (${response.status})`);
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  const data = new Int8Array(await new Response(stream).arrayBuffer());
  signal.throwIfAborted();
  if (data.length !== cellsPerTile ** 2 + 1) throw new Error("光污染图块格式异常");

  // The first cell is absolute. The first cell of each subsequent row
  // stores a delta from the row below, and other cells store eastward deltas.
  let compressed = 128 * data[0] + data[1];
  for (let row = 1; row <= y; row++) compressed += data[row * cellsPerTile + 1];
  for (let column = 1; column <= x; column++) compressed += data[y * cellsPerTile + 1 + column];
  const ratio = Math.expm1(0.0195 * compressed) / 39;
  const zone = lightPollutionZones.find(([, , upper]) => ratio < upper) ?? lightPollutionZones.at(-1)!;
  return { zone: zone[0], color: zone[1] };
}
