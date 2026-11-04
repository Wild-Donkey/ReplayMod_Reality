// Raw elevation remains in metres until the GPU computes scene-linear radiance.
// 2000 m = one stop; exposure changes do not alter spatial elevation ordering.
export const elevationRadiance = (height: number) => 0.03 * 2 ** (height / 2000);
export const METER_BINS = 256;
export const METER_RANGE_OFFSET = METER_BINS*2;
export const METER_BYTES = (METER_RANGE_OFFSET+4)*4;
export const METER_MIN = -12000;
export const METER_MAX = 10000;
export function exposureFromHistogram(histogram: Uint32Array): number | null {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  if (!total) return null; // unloaded pixels never steer exposure
  const percentile = (fraction: number) => {
    let sum = 0;
    for (let i = 0; i < histogram.length; i++) {
      sum += histogram[i];
      if (sum >= total * fraction) return METER_MIN + (i + 0.5) / histogram.length * (METER_MAX - METER_MIN);
    }
    return METER_MAX;
  };
  // Meter the broad surface, not tiny mountain highlights or labels. Limit the
  // bright 10% as well as the median so a mixed coast cannot wash out land.
  const scale = Math.min(0.1 / elevationRadiance(percentile(0.5)), 0.6 / elevationRadiance(percentile(0.9)));
  return Math.max(-4, Math.min(10, Math.log2(scale)));
}
export function adaptExposure(current: number, target: number, elapsedMs: number) {
  return current + (target - current) * (1 - Math.exp(-Math.max(0, elapsedMs) / 450));
}
export function terrainLuminance(height: number, exposure: number, headroom: number) {
  const limit = Math.max(1, headroom);
  return limit * (1 - Math.exp(-elevationRadiance(height) * 2 ** exposure / limit));
}
export function decodeElevation(rgba: Uint8ClampedArray) {
  const heights = new Float32Array(rgba.length / 4);
  for (let i = 0; i < heights.length; i++) {
    const offset = i * 4;
    heights[i] = (rgba[offset] * 65536 + rgba[offset + 1] * 256 + rgba[offset + 2]) * 0.1 - 10000;
  }
  return heights;
}

export type TerrainRange = readonly [number, number];
export interface TerrainAppearance {
  land: TerrainRange | null;
  depth: TerrainRange | null;
  black: number;
  white: number;
  headroom: number;
  oceanBlack: number;
  oceanWhite: number;
}
export function toneWindowFromHistogram(histogram: Uint32Array, anchorLow = false): readonly [number,number] | null {
  const bins = histogram.subarray(0,METER_BINS);
  const total = bins.reduce((sum,count) => sum+count,0);
  if (!total) return null;
  const percentile = (fraction:number) => {
    let sum = 0;
    for (let i=0;i<bins.length;i++) {
      sum += bins[i];
      if (sum >= total*fraction) return METER_MIN+(i+.5)/METER_BINS*(METER_MAX-METER_MIN);
    }
    return METER_MAX;
  };
  const land = rangeFromMeter(histogram), depth = rangeFromMeter(histogram,true);
  const minimum = Math.min(land?.[0] ?? Infinity,depth ? -depth[1] : Infinity);
  const maximum = Math.max(land?.[1] ?? -Infinity,depth ? -depth[0] : -Infinity);
  const low = Math.max(minimum === Infinity ? METER_MIN : minimum,percentile(.02));
  const high = Math.min(maximum === -Infinity ? METER_MAX : maximum,percentile(.999));
  const actualLow = Math.min(low,high), actualHigh = Math.max(low,high);
  // Do not amplify tiny DEM noise into black/white on nearly flat ground.
  const span = Math.max(400, actualHigh-actualLow);
  const center = Number.isFinite(minimum) && Number.isFinite(maximum) && maximum-minimum < 400 ? (minimum+maximum)/2 : (actualLow+actualHigh)/2;
  if (anchorLow) {
    // Expand only the white side: a flat-ground guard must not move the
    // visible low ground away from its 10% gray anchor.
    const black = Number.isFinite(minimum) && maximum-minimum < 400 ? minimum : actualLow;
    return [black,Math.max(black+400,actualHigh)];
  }
  return [center-span/2,center+span/2];
}
export function rangeFromMeter(meter: Uint32Array, ocean=false): TerrainRange | null {
  const offset = METER_RANGE_OFFSET+(ocean?2:0);
  if (!meter[offset+1]) return null;
  const value = (bits:number) => new Float32Array(new Uint32Array([bits]).buffer)[0];
  return [20000-value(meter[offset]),value(meter[offset+1])-(ocean?1:20000)];
}
// Bounds are sRGB 10% and 8%, converted to linear light and rounded inward
// to representable float16 values so final storage cannot cross the limits.
// Darken the terrain by one photographic stop before the output shoulder.
export const TERRAIN_EXPOSURE_STOPS = -1;
// Include final float16 sRGB encoding in the inward rounding.
export const LAND_MIN_LINEAR = 0.01003265380859375;
export const OCEAN_MAX_LINEAR = 0.007190704345703125;
export function mappedTerrainLuminance(height: number, black: number, white: number, headroom: number, ocean = height < 0) {
  const limit = Math.max(1,headroom);
  const t = .25 + .5*(height-black)/Math.max(1,white-black);
  const radiance = Math.exp(Math.log(.01)+(Math.log(-limit*Math.log(.04))-Math.log(.01))*t)*2**TERRAIN_EXPOSURE_STOPS;
  const normalized = 1-Math.exp(-radiance/limit);
  const luminance = limit*normalized;
  if (ocean) return OCEAN_MAX_LINEAR*luminance/(OCEAN_MAX_LINEAR+luminance);
  const anchorRadiance = Math.exp(Math.log(.01)+(Math.log(-limit*Math.log(.04))-Math.log(.01))*.25)*2**TERRAIN_EXPOSURE_STOPS;
  const anchored = 1-Math.exp(-Math.max(0,radiance-anchorRadiance)/limit);
  return LAND_MIN_LINEAR+(limit-LAND_MIN_LINEAR)*anchored;
}

export function materialToneWindow(meter: Uint32Array, ocean=false) {
  const isolated = new Uint32Array(METER_RANGE_OFFSET+4);
  const start = ocean ? METER_BINS : 0;
  isolated.set(meter.subarray(start,start+METER_BINS));
  const offset = METER_RANGE_OFFSET+(ocean?2:0);
  isolated[offset] = meter[offset]; isolated[offset+1] = meter[offset+1];
  return toneWindowFromHistogram(isolated,!ocean);
}
