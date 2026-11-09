import type { ReplayMetricSeries } from "../../render-engine/MetricSeries";

const distanceMetres = (a: readonly number[], b: readonly number[]) => {
  const radians = Math.PI / 180, latitude = (b[1] - a[1]) * radians, longitude = (b[0] - a[0]) * radians;
  const value = Math.sin(latitude / 2) ** 2 + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(longitude / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, value))));
};
export function routeLengthKm(coordinates: readonly (readonly number[])[]) {
  let metres = 0;
  for (let index = 1; index < coordinates.length; index++) metres += distanceMetres(coordinates[index - 1], coordinates[index]);
  return metres / 1000;
}

export interface ElevationProfileData {
  readonly series: ReplayMetricSeries;
  readonly totalKm: number;
  readonly minimum: number;
  readonly maximum: number;
}
const cache = new WeakMap<readonly (readonly number[])[], ElevationProfileData | null>();
export function elevationProfileData(coordinates: readonly (readonly number[])[]): ElevationProfileData | null {
  if (cache.has(coordinates)) return cache.get(coordinates)!;
  const x = new Float64Array(coordinates.length), values = new Float64Array(coordinates.length), geographic = new Float64Array(coordinates.length * 2);
  let minimum = Infinity, maximum = -Infinity;
  for (let index = 0; index < coordinates.length; index++) {
    const point = coordinates[index];
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) { cache.set(coordinates, null); return null; }
    values[index] = Number.isFinite(point[2]) ? point[2] : Number.NaN;
    if (Number.isFinite(values[index])) { minimum = Math.min(minimum, values[index]); maximum = Math.max(maximum, values[index]); }
    geographic[index * 2] = point[0]; geographic[index * 2 + 1] = point[1];
    if (index) x[index] = x[index - 1] + distanceMetres(coordinates[index - 1], point);
  }
  const total = x.at(-1) ?? 0;
  const result: ElevationProfileData | null = coordinates.length > 1 && total > 0 && maximum - minimum >= 0.1 ? {
    totalKm: total / 1000, minimum, maximum,
    series: {id: "route-elevation", space: "distanceProfile", color: [85, 207, 255, 255], lineWidth: 2, x, values, xDomain: [0, total], yDomain: [minimum, maximum], coordinates: geographic, padding: {left: 42 / 1000, right: 12 / 1000, top: 12 / 150, bottom: 24 / 150}},
  } : null;
  cache.set(coordinates, result);
  return result;
}
