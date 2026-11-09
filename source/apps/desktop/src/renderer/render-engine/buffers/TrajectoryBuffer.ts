import type { PointDataset } from "../../../../../../packages/data/src";
import { directionBearing } from "../../shared/trajectoryDirection";
import type { FlightRouteSegment } from "../../features/map/flights";

const EARTH_RADIUS_METRES = 6_371_000;

const segmentDistance = (a: readonly number[], b: readonly number[]) => {
  const radians = Math.PI / 180;
  const latitude = (b[1] - a[1]) * radians;
  const longitude = (b[0] - a[0]) * radians;
  const value = Math.sin(latitude / 2) ** 2
    + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(longitude / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(Math.min(1, Math.max(0, value))));
};

export class TrajectoryBuffer {
  private static readonly cache = new WeakMap<PointDataset, TrajectoryBuffer>();
  readonly length: number;
  readonly positions: Float64Array;
  readonly timestamps: Float64Array;
  readonly altitudes: Float32Array;
  readonly distances: Float64Array;
  readonly headings: Float32Array;

  sample(time: number | null) {
    if (time === null || !Number.isFinite(time) || this.length === 0) return null;
    let low = 0, high = this.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.timestamps[middle] < time) low = middle + 1;
      else high = middle;
    }
    const right = Math.min(this.length - 1, low);
    const left = Math.max(0, right - 1);
    const duration = this.timestamps[right] - this.timestamps[left];
    const ratio = right === left || duration <= 0 ? 0 : Math.max(0, Math.min(1, (time - this.timestamps[left]) / duration));
    const longitudeDelta = ((this.positions[right * 2] - this.positions[left * 2] + 540) % 360) - 180;
    return {
      position: [
        this.positions[left * 2] + longitudeDelta * ratio,
        this.positions[left * 2 + 1] + (this.positions[right * 2 + 1] - this.positions[left * 2 + 1]) * ratio,
      ] as [number, number],
      heading: this.headings[Math.min(left, this.headings.length - 1)] || 0,
      index: ratio < 0.5 ? left : right,
    };
  }

  private constructor(length: number, timestamps: Float64Array = new Float64Array(length)) {
    this.length = length;
    this.positions = new Float64Array(length * 2);
    this.timestamps = timestamps;
    this.altitudes = new Float32Array(length);
    this.distances = new Float64Array(length);
    this.headings = new Float32Array(length);
  }

  static fromPointDataset(dataset: PointDataset) {
    const cached = this.cache.get(dataset);
    if (cached) return cached;
    const length = Math.min(
      dataset.timelineTimestamps.length,
      dataset.timelineAltitudes.length,
      Math.floor(dataset.timelineCoordinates.length / 2),
    );
    const buffer = new TrajectoryBuffer(length);
    for (let index = 0; index < length; index += 1) {
      const coordinateIndex = index * 2;
      const current: [number, number] = [
        dataset.timelineCoordinates[coordinateIndex],
        dataset.timelineCoordinates[coordinateIndex + 1],
      ];
      buffer.positions[coordinateIndex] = current[0];
      buffer.positions[coordinateIndex + 1] = current[1];
      buffer.timestamps[index] = dataset.timelineTimestamps[index];
      buffer.altitudes[index] = dataset.timelineAltitudes[index];
      if (index === 0) continue;
      const previous: [number, number] = [
        buffer.positions[coordinateIndex - 2],
        buffer.positions[coordinateIndex - 1],
      ];
      buffer.distances[index] = buffer.distances[index - 1] + segmentDistance(previous, current);
      buffer.headings[index - 1] = directionBearing(previous, current);
    }
    if (length > 1) buffer.headings[length - 1] = buffer.headings[length - 2];
    this.cache.set(dataset, buffer);
    return buffer;
  }

  /**
   * 保留原时间轴，但把已确认飞行时段的位置改为风格化航线上的等距插值点。
   * 因此播放、拖动时间轴和共享游标都消费同一套替换后几何。
   */
  static fromPointDatasetWithFlightRoutes(dataset: PointDataset, segments: readonly FlightRouteSegment[]) {
    const base = this.fromPointDataset(dataset);
    if (!segments.length) return base;
    const buffer = new TrajectoryBuffer(base.length, base.timestamps);
    buffer.positions.set(base.positions);
    buffer.altitudes.set(base.altitudes);
    const prepared = [...segments]
      .filter(segment => segment.endTime > segment.startTime && segment.path.length > 1)
      .sort((a, b) => a.startTime - b.startTime)
      .map(segment => {
        const lengths = [0];
        for (let index = 1; index < segment.path.length; index += 1) {
          lengths[index] = lengths[index - 1] + segmentDistance(segment.path[index - 1], segment.path[index]);
        }
        return {...segment, lengths, total: lengths.at(-1)!};
      });
    let segmentIndex = 0;
    for (let index = 0; index < buffer.length && segmentIndex < prepared.length; index += 1) {
      const time = buffer.timestamps[index];
      while (segmentIndex < prepared.length && time > prepared[segmentIndex].endTime) segmentIndex += 1;
      const segment = prepared[segmentIndex];
      if (!segment || time < segment.startTime || !(segment.total > 0)) continue;
      const target = segment.total * Math.max(0, Math.min(1,
        (time - segment.startTime) / (segment.endTime - segment.startTime)));
      let right = 1;
      while (right < segment.lengths.length - 1 && segment.lengths[right] < target) right += 1;
      const left = right - 1;
      const span = segment.lengths[right] - segment.lengths[left] || 1;
      const ratio = (target - segment.lengths[left]) / span;
      const start = segment.path[left];
      const end = segment.path[right];
      const longitudeDelta = ((end[0] - start[0] + 540) % 360) - 180;
      buffer.positions[index * 2] = start[0] + longitudeDelta * ratio;
      buffer.positions[index * 2 + 1] = start[1] + (end[1] - start[1]) * ratio;
    }
    for (let index = 1; index < buffer.length; index += 1) {
      const previous: [number, number] = [buffer.positions[index * 2 - 2], buffer.positions[index * 2 - 1]];
      const current: [number, number] = [buffer.positions[index * 2], buffer.positions[index * 2 + 1]];
      buffer.distances[index] = buffer.distances[index - 1] + segmentDistance(previous, current);
      buffer.headings[index - 1] = directionBearing(previous, current);
    }
    if (buffer.length > 1) buffer.headings[buffer.length - 1] = buffer.headings[buffer.length - 2];
    return buffer;
  }
}
