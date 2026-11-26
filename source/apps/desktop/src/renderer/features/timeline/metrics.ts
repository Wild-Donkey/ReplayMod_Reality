interface MetricPositionSamples {
  readonly footprintTimestamps: ArrayLike<number>;
  readonly footprintCoordinates: ArrayLike<number>;
}

export interface MetricDataset extends MetricPositionSamples {
  readonly processedMotion?: MetricPositionSamples & { readonly timeBounds: readonly [number, number] };
}

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
export function continuousDensity(timestamps: ArrayLike<number>, time: number, bandwidth: number): number {
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
  speed?: number | null;
}

// Only segments touched by the visible window are constructed. Each segment
// depends solely on its two endpoints, never on neighbouring segment speeds.
const positionCache = new WeakMap<MetricPositionSamples, Map<number, PositionSegment>>();
const EARTH_RADIUS = 6371000;
function position(dataset: MetricPositionSamples, index: number): Vector {
  const lon = dataset.footprintCoordinates[index * 2] * Math.PI / 180;
  const lat = dataset.footprintCoordinates[index * 2 + 1] * Math.PI / 180;
  return [EARTH_RADIUS * Math.cos(lat) * Math.cos(lon), EARTH_RADIUS * Math.cos(lat) * Math.sin(lon), EARTH_RADIUS * Math.sin(lat)];
}

function segmentIndex(times: ArrayLike<number>, time: number, maxGapMs: number) {
  if (times.length < 2 || time < times[0] || time > times[times.length - 1]) return -1;
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
  return index >= 0 && times[index + 1] > times[index] && times[index + 1] - times[index] <= maxGapMs ? index : -1;
}

function segmentAt(dataset: MetricPositionSamples, time: number, maxGapMs = Infinity): PositionSegment | null {
  const index = segmentIndex(dataset.footprintTimestamps, time, maxGapMs);
  if (index < 0) return null;
  return segmentFromIndex(dataset, index);
}

function segmentFromIndex(dataset: MetricPositionSamples, index: number): PositionSegment {
  const times = dataset.footprintTimestamps;
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
export function interpolatedMotion(dataset: MetricDataset, time: number): { position: Vector; velocity: Vector } | null {
  const processed = processedSamplesAt(dataset, time);
  const segment = processed ? segmentAt(processed, time, 10_000) : segmentAt(dataset, time);
  if (!segment) return null;
  const seconds = (segment.end - segment.start) / 1000;
  const u = (time - segment.start) / (segment.end - segment.start);
  const p = [0, 1, 2].map(axis => segment.origin[axis] + segment.delta[axis] * u);
  const v = [0, 1, 2].map(axis => segment.delta[axis] / seconds);
  return { position: p as unknown as Vector, velocity: v as unknown as Vector };
}

function processedSamplesAt(dataset: MetricDataset, time: number) {
  const processed = dataset.processedMotion;
  return processed && time >= processed.timeBounds[0] && time <= processed.timeBounds[1] ? processed : undefined;
}

export function hasProcessedCoverage(dataset: MetricDataset, time: number) {
  const processed = processedSamplesAt(dataset, time);
  return !processed || segmentAt(processed, time, 10_000) !== null;
}

export function continuousSpeed(dataset: MetricDataset, time: number): number | null {
  const processed = processedSamplesAt(dataset, time);
  return speedAt(processed ?? dataset, time, Boolean(processed));
}

function speedAt(samples: MetricPositionSamples, time: number, processed: boolean) {
  const index = segmentIndex(samples.footprintTimestamps, time, processed ? 10_000 : Infinity);
  if (index < 0) return null;
  const segment = positionCache.get(samples)?.get(index) ?? segmentFromIndex(samples, index);
  if (segment.speed === undefined) {
    segment.speed = segment.delta.every(Number.isFinite)
      ? Math.hypot(...segment.delta) * 3600 / (segment.end - segment.start) : null;
  }
  return segment.speed;
}

// Dataset ownership permits automatic reclamation. Both caches are bounded LRU;
// cached values are evaluations of continuous functions, not aggregated bins.
const curveCache = new WeakMap<MetricDataset, Map<string, Float64Array>>();
const densityCache = new WeakMap<MetricDataset, Map<string, Map<number, number>>>();
function remember<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): V {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > limit) cache.delete(cache.keys().next().value!);
  return value;
}

export function metricCurve(dataset: MetricDataset, mode: "speed" | "density", start: number, end: number, count: number, bandwidth: number): Float64Array {
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


const stepCache = new WeakMap<MetricDataset, Map<string, [number, number | null][]>>();
/** Preserve exact GPS interval edges at detailed zoom. At overview scale use
 * bounded display samples; never load or derive the entire position track. */
export function speedStepCurve(dataset: MetricDataset, start: number, end: number, count: number): [number, number | null][] {
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
const pixelDensityCache = new WeakMap<ArrayLike<number>, Map<string, PixelDensity>>();
/** Exact count per display pixel, using sorted timestamp bounds rather than
 * scanning all points. */
export function pixelDensity(timestamps: ArrayLike<number>, start: number, end: number, width: number): PixelDensity {
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
const smoothSpeedCache = new WeakMap<MetricDataset, Map<string, [number, number | null][]>>();
const speedDisplayCache = new WeakMap<MetricPositionSamples, Map<number, number>>();
const SPEED_SAMPLE_MS = 250;
const SPEED_WEIGHTS = Array.from({length: 13}, (_, index) => Math.exp(-0.5 * (index / 5) ** 2));

export function smoothedSpeed(dataset: MetricDataset, time: number): number | null {
  const processed = processedSamplesAt(dataset, time);
  const samples = processed ?? dataset;
  const sampleSpeed = (timeMs: number) => speedAt(samples, timeMs, Boolean(processed));
  const center = sampleSpeed(time);
  if (center === null || center === 0) return center;
  let cache = speedDisplayCache.get(samples);
  if (!cache) { cache = new Map(); speedDisplayCache.set(samples, cache); }
  const gridSpeed = (timeMs: number) => {
    const existing = cache.get(timeMs);
    if (existing !== undefined) return existing;
    const speed = sampleSpeed(timeMs);
    if (speed === null) return NaN;
    if (speed === 0) return remember(cache, timeMs, 0, 32768);
    let sum = speed, weight = 1;
    for (const direction of [-1, 1]) {
      for (let index = 1; index < SPEED_WEIGHTS.length; index++) {
        const sample = sampleSpeed(timeMs + direction * index * SPEED_SAMPLE_MS);
        if (sample === null) break;
        sum += sample * SPEED_WEIGHTS[index];
        weight += SPEED_WEIGHTS[index];
      }
    }
    return remember(cache, timeMs, sum / weight, 32768);
  };
  const lowerTime = Math.floor(time / SPEED_SAMPLE_MS) * SPEED_SAMPLE_MS;
  const lower = gridSpeed(lowerTime), upper = gridSpeed(lowerTime + SPEED_SAMPLE_MS);
  if (!Number.isFinite(lower)) return Number.isFinite(upper) ? upper : center;
  if (!Number.isFinite(upper)) return lower;
  return lower + (upper - lower) * (time - lowerTime) / SPEED_SAMPLE_MS;
}

export function smoothSpeedCurve(dataset: MetricDataset, start: number, end: number, count: number): [number, number | null][] {
  let cache = smoothSpeedCache.get(dataset);
  if (!cache) { cache = new Map(); smoothSpeedCache.set(dataset, cache); }
  const key = `${start}:${end}:${count}`;
  const hit = cache.get(key);
  if (hit) return remember(cache, key, hit, 16);
  const step = (end - start) / count;
  const data: [number, number | null][] = [];
  for (let i = 0; i <= count; i++) {
    const time = start + step * i;
    data.push([time, smoothedSpeed(dataset, time)]);
  }
  return remember(cache, key, data, 16);
}
