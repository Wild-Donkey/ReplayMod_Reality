import type { TrajectoryBuffer } from "./buffers/TrajectoryBuffer";

export type ReplayMetricViewId = "timeline" | "elevation";
export interface ReplayMetricSeries {
  readonly id: string;
  readonly space: "timeline" | "distanceProfile";
  readonly x: Float64Array;
  readonly values: Float64Array;
  readonly xDomain: readonly [number, number];
  readonly yDomain: readonly [number, number];
  readonly coordinates?: Float64Array;
  readonly sourceTrajectory?: TrajectoryBuffer;
  readonly color?: readonly [number, number, number, number];
  readonly lineWidth?: number;
  readonly areaOpacity?: number;
  readonly padding?: {readonly left: number; readonly right: number; readonly top: number; readonly bottom: number};
}

export interface MetricSegments {
  readonly length: number;
  readonly positions: Float32Array;
  readonly sampleIndices: Uint32Array;
  readonly attributes: {
    readonly getSourcePosition: {readonly value: Float32Array; readonly size: 3; readonly stride: 24; readonly offset: 0};
    readonly getTargetPosition: {readonly value: Float32Array; readonly size: 3; readonly stride: 24; readonly offset: 12};
  };
}

const buffers = new WeakMap<ReplayMetricSeries, MetricSegments>();
export function metricSegments(series: ReplayMetricSeries): MetricSegments {
  const cached = buffers.get(series);
  if (cached) return cached;
  const spanX = series.xDomain[1] - series.xDomain[0], spanY = series.yDomain[1] - series.yDomain[0];
  const padding = series.padding ?? {left: 0, right: 0, top: 0, bottom: 0};
  const width = 1 - padding.left - padding.right, height = 1 - padding.top - padding.bottom;
  const count = Math.min(series.x.length, series.values.length), positions = new Float32Array(Math.max(0, count - 1) * 6), indices = new Uint32Array(Math.max(0, count - 1));
  let length = 0;
  if (Number.isFinite(spanX) && Number.isFinite(spanY) && spanX > 0 && spanY > 0 && width > 0 && height > 0) {
    for (let index = 0; index < count - 1; index++) {
      const x0 = series.x[index], x1 = series.x[index + 1], y0 = series.values[index], y1 = series.values[index + 1];
      if (![x0, x1, y0, y1].every(Number.isFinite) || x1 < x0 || x1 < series.xDomain[0] || x0 > series.xDomain[1]) continue;
      const start = Math.max(x0, series.xDomain[0]), end = Math.min(x1, series.xDomain[1]);
      const valueAt = (x: number) => x1 === x0 ? y0 : y0 + (y1 - y0) * (x - x0) / (x1 - x0);
      const offset = length * 6;
      positions[offset] = padding.left + (start - series.xDomain[0]) / spanX * width;
      positions[offset + 1] = padding.top + (1 - (valueAt(start) - series.yDomain[0]) / spanY) * height;
      positions[offset + 3] = padding.left + (end - series.xDomain[0]) / spanX * width;
      positions[offset + 4] = padding.top + (1 - ((x0 === x1 ? y1 : valueAt(end)) - series.yDomain[0]) / spanY) * height;
      indices[length++] = index;
    }
  }
  const value = positions.subarray(0, length * 6);
  const compiled: MetricSegments = {length, positions: value, sampleIndices: indices.subarray(0, length), attributes: {getSourcePosition: {value, size: 3, stride: 24, offset: 0}, getTargetPosition: {value, size: 3, stride: 24, offset: 12}}};
  buffers.set(series, compiled);
  return compiled;
}

// Normalizing before Float32 conversion preserves millisecond differences at
// modern Unix timestamps. Camera/resize changes reuse the same segment buffer.
export function metricXAt(series: ReplayMetricSeries, normalizedX: number) {
  const padding = series.padding ?? {left: 0, right: 0};
  const ratio = Math.max(0, Math.min(1, (normalizedX - padding.left) / (1 - padding.left - padding.right)));
  return series.xDomain[0] + ratio * (series.xDomain[1] - series.xDomain[0]);
}

const areaBuffers = new WeakMap<ReplayMetricSeries, {length: number; startIndices: Uint32Array; attributes: {getPolygon: {value: Float32Array; size: 3}; indices: {value: Uint32Array; size: 1}}}>();
export function metricArea(series: ReplayMetricSeries) {
  const cached = areaBuffers.get(series);
  if (cached) return cached;
  const segments = metricSegments(series), positions = new Float32Array(segments.length * 18);
  const padding = series.padding ?? {top: 0, bottom: 0};
  const zero = Math.max(series.yDomain[0], Math.min(series.yDomain[1], 0));
  const baseline = padding.top + (1 - (zero - series.yDomain[0]) / (series.yDomain[1] - series.yDomain[0])) * (1 - padding.top - padding.bottom);
  let cursor = 0;
  const triangle = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
    if (Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) < 1e-15) return;
    positions.set([ax, ay, 0, bx, by, 0, cx, cy, 0], cursor); cursor += 9;
  };
  for (let index = 0; index < segments.length; index++) {
    const offset = index * 6, x0 = segments.positions[offset], y0 = segments.positions[offset + 1], x1 = segments.positions[offset + 3], y1 = segments.positions[offset + 4];
    if ((y0 - baseline) * (y1 - baseline) < 0) {
      const crossing = x0 + (x1 - x0) * (baseline - y0) / (y1 - y0);
      triangle(x0, y0, crossing, baseline, x0, baseline);
      triangle(crossing, baseline, x1, y1, x1, baseline);
    } else {
      triangle(x0, y0, x1, y1, x1, baseline);
      triangle(x0, y0, x1, baseline, x0, baseline);
    }
  }
  const vertexCount = cursor / 3, length = vertexCount / 3;
  const result = {length, startIndices: Uint32Array.from({length: length + 1}, (_, index) => index * 3), attributes: {getPolygon: {value: positions.subarray(0, cursor), size: 3 as const}, indices: {value: Uint32Array.from({length: vertexCount}, (_, index) => index), size: 1 as const}}};
  areaBuffers.set(series, result);
  return result;
}
