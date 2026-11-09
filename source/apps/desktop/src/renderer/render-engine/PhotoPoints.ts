export const photoPointRadiusStops = [1, 0.6, 8, 1.1, 14, 2] as const;

export interface PhotoPoints {
  readonly length: number;
  readonly attributes: {readonly getPosition: {readonly value: Float64Array; readonly size: 2}};
}

const cache = new WeakMap<readonly number[], PhotoPoints>();
export function replayPhotoPoints(coordinates: readonly number[]) {
  const cached = cache.get(coordinates);
  if (cached) return cached;
  const length = Math.floor(coordinates.length / 2);
  const data: PhotoPoints = {length, attributes: {getPosition: {value: Float64Array.from(coordinates), size: 2}}};
  cache.set(coordinates, data);
  return data;
}
