import type { PointDataset } from "../../../../../../packages/data/src";

export interface TimelineMetricsSettings {
  mode: "speed" | "density";
  densitySmoothingSeconds: number;
}
export const defaultTimelineMetrics: TimelineMetricsSettings = {
  mode: "speed", densitySmoothingSeconds: 60,
};

/** Derivative of a smooth cumulative point count. Each point contributes unit
 * integral with CDF 1/2 + 15/16(u - 2u³/3 + u⁵/5), for -1 < u < 1.
 * No time buckets: bandwidth stays in milliseconds regardless of zoom.
 * Returns points per minute. Sorted timestamps permit exact support lookup.
 */
export function continuousDensity(timestamps: readonly number[], time: number, bandwidth: number): number {
  if (!Number.isFinite(bandwidth) || bandwidth <= 0) return 0;
  let low = 0;
  let high = timestamps.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (timestamps[middle] < time - bandwidth) low = middle + 1;
    else high = middle;
  }
  let density = 0;
  for (let i = low; i < timestamps.length && timestamps[i] < time + bandwidth; i++) {
    const u = (time - timestamps[i]) / bandwidth;
    density += 15 / 16 * (1 - u * u) ** 2;
  }
  return density / bandwidth * 60_000;
}

type Vector = readonly [number, number, number];
interface PositionSegment {
  start: number;
  end: number;
  origin: Vector;
  delta: Vector;
}

// Only segments touched by the visible window are constructed. Each segment
// depends solely on its two endpoints, never on neighbouring segment speeds.
const positionCache = new WeakMap<PointDataset, Map<number, PositionSegment>>();
const EARTH_RADIUS = 6371000;
function position(dataset: PointDataset, index: number): Vector {
  const lon = dataset.footprintCoordinates[index * 2] * Math.PI / 180;
  const lat = dataset.footprintCoordinates[index * 2 + 1] * Math.PI / 180;
  return [EARTH_RADIUS * Math.cos(lat) * Math.cos(lon), EARTH_RADIUS * Math.cos(lat) * Math.sin(lon), EARTH_RADIUS * Math.sin(lat)];
}

function segmentAt(dataset: PointDataset, time: number): PositionSegment | null {
  const times = dataset.footprintTimestamps;
  if (times.length < 2 || time < times[0] || time > times[times.length - 1]) return null;
  // Upper bound selects the last fix when multiple fixes share a timestamp.
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (times[middle] <= time) low = middle + 1;
    else high = middle;
  }
  let index = low - 1;
  if (low === times.length) {
    while (index > 0 && times[index - 1] === times[index]) index--;
    index--;
  }
  if (index < 0 || times[index + 1] <= times[index]) return null;
  let cache = positionCache.get(dataset);
  if (!cache) { cache = new Map(); positionCache.set(dataset, cache); }
  const hit = cache.get(index);
  if (hit) return remember(cache, index, hit, 4096);
  const p0 = position(dataset, index);
  const p1 = position(dataset, index + 1);
  const segment: PositionSegment = {
    start: times[index], end: times[index + 1], origin: p0,
    delta: [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]],
  };
  return remember(cache, index, segment, 4096);
}

/** Continuous piecewise-linear position P(u)=P0+(P1-P0)u.
 * Its time derivative is exactly (P1-P0)/duration, constant inside each
 * interval. At a GPS knot the derivative can jump; we use the right-hand
 * derivative (and the left-hand derivative at the final point).
 */
export function interpolatedMotion(dataset: PointDataset, time: number): { position: Vector; velocity: Vector } | null {
  const segment = segmentAt(dataset, time);
  if (!segment) return null;
  const seconds = (segment.end - segment.start) / 1000;
  const u = (time - segment.start) / (segment.end - segment.start);
  const p = [0, 1, 2].map(axis => segment.origin[axis] + segment.delta[axis] * u);
  const v = [0, 1, 2].map(axis => segment.delta[axis] / seconds);
  return { position: p as unknown as Vector, velocity: v as unknown as Vector };
}

export function continuousSpeed(dataset: PointDataset, time: number): number | null {
  const motion = interpolatedMotion(dataset, time);
  if (!motion || !motion.velocity.every(Number.isFinite)) return null;
  return Math.hypot(...motion.velocity) * 3.6;
}

// Dataset ownership permits automatic reclamation. Both caches are bounded LRU;
// cached values are evaluations of continuous functions, not aggregated bins.
const curveCache = new WeakMap<PointDataset, Map<string, Float64Array>>();
const densityCache = new WeakMap<PointDataset, Map<string, Map<number, number>>>();
function remember<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): V {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > limit) cache.delete(cache.keys().next().value!);
  return value;
}

export function metricCurve(dataset: PointDataset, mode: "speed" | "density", start: number, end: number, count: number, bandwidth: number): Float64Array {
  let curves = curveCache.get(dataset);
  if (!curves) { curves = new Map(); curveCache.set(dataset, curves); }
  const key = `${mode}:${start}:${end}:${count}:${mode === "density" ? bandwidth : ""}`;
  const hit = curves.get(key);
  if (hit) return remember(curves, key, hit, 16);
  let evaluations: Map<number, number> | undefined;
  if (mode === "density") {
    let scales = densityCache.get(dataset);
    if (!scales) { scales = new Map(); densityCache.set(dataset, scales); }
    evaluations = scales.get(String(bandwidth)) ?? new Map();
    remember(scales, String(bandwidth), evaluations, 4);
  }
  const values = new Float64Array(count + 1);
  for (let i = 0; i <= count; i++) {
    const time = start + i / count * (end - start);
    if (mode === "speed") values[i] = continuousSpeed(dataset, time) ?? NaN;
    else {
      const cached = evaluations!.get(time);
      values[i] = cached ?? continuousDensity(dataset.footprintTimestamps, time, bandwidth);
      remember(evaluations!, time, values[i], 32768);
    }
  }
  return remember(curves, key, values, 16);
}


const stepCache = new WeakMap<PointDataset, Map<string, [number, number | null][]>>();
/** Preserve exact GPS interval edges at detailed zoom. At overview scale use
 * bounded display samples; never load or derive the entire position track. */
export function speedStepCurve(dataset: PointDataset, start: number, end: number, count: number): [number, number | null][] {
  let cache = stepCache.get(dataset);
  if (!cache) { cache = new Map(); stepCache.set(dataset, cache); }
  const key = `${start}:${end}:${count}`;
  const hit = cache.get(key);
  if (hit) return remember(cache, key, hit, 16);
  const times = dataset.footprintTimestamps;
  const upper = (target: number) => {
    let low = 0, high = times.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (times[middle] <= target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const first = upper(start), last = upper(end);
  const data: [number, number | null][] = [];
  if (last - first <= count) {
    data.push([start, continuousSpeed(dataset, start)]);
    for (let i = first; i < last; i++) {
      const time = times[i];
      if (time >= end || (i > first && time === times[i - 1])) continue;
      data.push([time, continuousSpeed(dataset, time)]);
    }
    data.push([end, continuousSpeed(dataset, end)]);
  } else {
    const values = metricCurve(dataset, "speed", start, end, count, 0);
    values.forEach((value, i) => data.push([start + i / count * (end - start), Number.isFinite(value) ? value : null]));
  }
  return remember(cache, key, data, 16);
}

export interface PixelDensity {
  counts: Uint32Array;
  peak: number;
}
const pixelDensityCache = new WeakMap<readonly number[], Map<string, PixelDensity>>();
/** Exact count per display pixel, using sorted timestamp bounds rather than
 * scanning all points. Zero counts remain fully transparent when rendered. */
export function pixelDensity(timestamps: readonly number[], start: number, end: number, width: number): PixelDensity {
  width = Math.max(1, Math.ceil(width));
  let cache = pixelDensityCache.get(timestamps);
  if (!cache) { cache = new Map(); pixelDensityCache.set(timestamps, cache); }
  const key = `${start}:${end}:${width}`;
  const hit = cache.get(key);
  if (hit) return remember(cache, key, hit, 16);
  const bound = (time: number, inclusive = false) => {
    let low = 0, high = timestamps.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (timestamps[middle] < time || (inclusive && timestamps[middle] === time)) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const counts = new Uint32Array(width);
  let previous = bound(start);
  let peak = 0;
  for (let x = 0; x < width; x++) {
    const next = bound(start + (x + 1) / width * (end - start), x === width - 1);
    counts[x] = next - previous;
    peak = Math.max(peak, counts[x]);
    previous = next;
  }
  return remember(cache, key, { counts, peak }, 16);
}

/** Symmetric Gaussian display filter; leaves missing centres undefined and
 * never mutates source velocities. Positive weights prevent overshoot. */
export function smoothDisplayValues(values: Float64Array, sigma: number): Float64Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const weights = Array.from({ length: radius * 2 + 1 }, (_, i) => Math.exp(-0.5 * ((i - radius) / sigma) ** 2));
  const result = new Float64Array(values.length);
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) { result[index] = NaN; return; }
    let sum = 0, weight = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const neighbour = values[index + offset];
      if (!Number.isFinite(neighbour)) continue;
      const w = weights[offset + radius];
      sum += neighbour * w;
      weight += w;
    }
    result[index] = sum / weight;
  });
  return result;
}
const smoothSpeedCache = new WeakMap<PointDataset, Map<string, [number, number | null][]>>();
export function smoothSpeedCurve(dataset: PointDataset, start: number, end: number, count: number): [number, number | null][] {
  let cache = smoothSpeedCache.get(dataset);
  if (!cache) { cache = new Map(); smoothSpeedCache.set(dataset, cache); }
  const key = `${start}:${end}:${count}`;
  const hit = cache.get(key);
  if (hit) return remember(cache, key, hit, 16);
  // Two samples per pixel: sigma 2 samples is roughly one display pixel.
  const halo = 6;
  const step = (end - start) / count;
  const raw = metricCurve(dataset, "speed", start - step * halo, end + step * halo, count + halo * 2, 0);
  const filtered = smoothDisplayValues(raw, 2);
  const data: [number, number | null][] = [];
  for (let i = 0; i <= count; i++) {
    const value = filtered[i + halo];
    data.push([start + step * i, Number.isFinite(value) ? value : null]);
  }
  return remember(cache, key, data, 16);
}
