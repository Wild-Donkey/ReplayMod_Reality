import type { MotionGpsResult, MotionPoint } from "../../../../packages/media/src/gps-motion";

const POINT_STRIDE = 4;

export type PackedMotionGpsResult = Omit<MotionGpsResult, "points" | "contextPoints"> & {
  pointCount: number;
  pointData: Float64Array<ArrayBuffer>;
  altitudePresent: Uint8Array<ArrayBuffer>;
};

export type MotionGpsWireUpdate = { id: string } & ({ result: PackedMotionGpsResult } | { error: string });

export function packMotionGpsResult({ points, contextPoints, ...summary }: MotionGpsResult): PackedMotionGpsResult {
  const count = points.length + contextPoints.length;
  const pointData = new Float64Array(count * POINT_STRIDE);
  const altitudePresent = new Uint8Array(Math.ceil(count / 8));
  for (let index = 0; index < count; index++) {
    const point = index < points.length ? points[index] : contextPoints[index - points.length];
    const offset = index * POINT_STRIDE;
    pointData[offset] = point.timeSeconds;
    pointData[offset + 1] = point.longitude;
    pointData[offset + 2] = point.latitude;
    if (point.altitude !== undefined) {
      altitudePresent[index >>> 3] |= 1 << (index & 7);
      pointData[offset + 3] = point.altitude;
    }
  }
  return { ...summary, pointCount: points.length, pointData, altitudePresent };
}

export function unpackMotionGpsResult({ pointCount, pointData, altitudePresent, ...summary }: PackedMotionGpsResult): MotionGpsResult {
  const count = pointData.length / POINT_STRIDE;
  const points = new Array<MotionPoint>(pointCount);
  const contextPoints = new Array<MotionPoint>(count - pointCount);
  for (let index = 0; index < count; index++) {
    const offset = index * POINT_STRIDE;
    const point: MotionPoint = {
      timeSeconds: pointData[offset],
      longitude: pointData[offset + 1],
      latitude: pointData[offset + 2],
    };
    if (altitudePresent[index >>> 3] & (1 << (index & 7))) point.altitude = pointData[offset + 3];
    if (index < pointCount) points[index] = point;
    else contextPoints[index - pointCount] = point;
  }
  return { ...summary, points, contextPoints };
}
