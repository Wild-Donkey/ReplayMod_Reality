export interface ElevationRange { minimum: number; maximum: number }
export type WorldPoint = {x: number; y: number};

export function worldPoint(longitude: number, latitude: number): WorldPoint {
  const sin = Math.sin(Math.max(-85.051129, Math.min(85.051129, latitude)) * Math.PI / 180);
  return {x: (longitude + 180) / 360, y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)};
}
export const WATER_SURFACE_OPACITY = 0.2;
export const FALLBACK_WATER_DEPTH = 100;
export const DEFAULT_OCEAN_DEPTH = 11000;

// Normalize to [0,1] first, then apply a mild gamma curve.
// A fixed domain keeps the same elevation/depth stable during panning.
export function compressedRatio(value: number, extent: number) {
  const ratio = Math.min(1, Math.max(0, value) / Math.max(1, extent));
  return Math.pow(ratio, 0.92);
}
export function elevationAppearance(elevation: number, range: ElevationRange, water = false) {
  if (water) {
    const depth = Number.isFinite(elevation) ? Math.max(0, -elevation) : FALLBACK_WATER_DEPTH;
    const deepest = DEFAULT_OCEAN_DEPTH;
    return {gray: 0, alpha: WATER_SURFACE_OPACITY + (1 - WATER_SURFACE_OPACITY) * compressedRatio(depth, deepest)};
  }
  return {gray: 255, alpha: compressedRatio(elevation, 9000)};
}
