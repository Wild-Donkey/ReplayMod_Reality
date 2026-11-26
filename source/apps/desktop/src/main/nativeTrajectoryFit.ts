import { processMotionGps, type MotionPoint } from "../../../../packages/media/src/gps-motion";
import type { OrientationSample } from "../../../../packages/media/src/types";
import { packMotionGpsResult, type PackedMotionGpsResult } from "../shared/motionGpsWire";
import { runNativeBinaryJob } from "./nativeBinaryJob";

const RADIANS = Math.PI / 180;
const METRES = 6_371_000 * RADIANS;
const CONTEXT_SECONDS = 4;
const ROW_BYTES = 5 * 8;

export async function fitNativeTrajectory(executable: string, samples: readonly OrientationSample[],
    points: readonly MotionPoint[], start: number, end: number, sampleRateHz: number, signal?: AbortSignal): Promise<PackedMotionGpsResult> {
  signal?.throwIfAborted();
  const baseline = processMotionGps([], points, start, end);
  const fixes = points.filter(point => Number.isFinite(point.timeSeconds) && Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) && Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180)
    .sort((a, b) => a.timeSeconds - b.timeSeconds)
    .filter((point, index, sorted) => index === 0 || point.timeSeconds > sorted[index - 1].timeSeconds);
  if (!fixes.length || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return packMotionGpsResult(baseline);
  const duration = end - start;
  if ((duration + 2 * CONTEXT_SECONDS) * 10 > 500_000) throw new Error("轨迹处理范围过大，请缩短视频片段。");
  const rate = Math.max(1, Math.min(60, Math.round(sampleRateHz)));
  const seeds = [...fixes, ...baseline.contextPoints, ...baseline.points].sort((a, b) => a.timeSeconds - b.timeSeconds);
  const attitude = samples.flatMap(sample => {
    const [w, x, y, z] = sample.quaternion;
    const length = Math.hypot(w, x, y, z);
    if (!(length > 1e-8) || !Number.isFinite(length) || !Number.isFinite(sample.timeSeconds)) return [];
    return [{ time: sample.timeSeconds, yaw: Math.atan2(2 * (w*z + x*y), length**2 - 2*(y*y + z*z)) }];
  }).sort((a, b) => a.time - b.time);
  const origin = fixes[0], scale = METRES * Math.max(.001, Math.cos(origin.latitude * RADIANS));
  const input = Buffer.allocUnsafe(8 * 8 + (fixes.length + seeds.length) * ROW_BYTES + attitude.length * 16);
  let offset = 0;
  const number = (value: number) => { offset = input.writeDoubleLE(value, offset); };
  for (const value of [1, start, duration, rate, origin.longitude, origin.latitude, fixes.length, seeds.length]) number(value);
  for (const series of [fixes, seeds]) {
    for (const point of series) {
      const angle = (point.longitude - origin.longitude) * RADIANS;
      number(point.timeSeconds - start);
      number(Math.atan2(Math.sin(angle), Math.cos(angle)) / RADIANS * scale);
      number((point.latitude - origin.latitude) * METRES);
      number(point.altitude ?? 0);
      number(point.altitude === undefined ? 0 : 1);
    }
  }
  for (const sample of attitude) {
    number(sample.time);
    number(sample.yaw);
  }

  const pointCount = Math.ceil(duration * rate) + 1;
  const beforeCount = CONTEXT_SECONDS * rate;
  const count = pointCount + 2 * beforeCount;
  const outputBytes = ROW_BYTES * (count + 1);
  const output = await runNativeBinaryJob(executable, "--fit-trajectory", input, {
    exactBytes: outputBytes, maxBytes: outputBytes, signal,
  });
  if (!output || output.readDoubleLE(0) !== 1 || output.readDoubleLE(8) !== pointCount ||
      output.readDoubleLE(16) !== count - pointCount) throw new Error("Invalid native trajectory header");
  const fittedWindows = output.readDoubleLE(24), attitudeConstraints = output.readDoubleLE(32);
  if (!Number.isSafeInteger(fittedWindows) || fittedWindows < 1 ||
      !Number.isSafeInteger(attitudeConstraints) || attitudeConstraints < 0) throw new Error("Invalid native trajectory diagnostics");
  const pointData = new Float64Array(count * 4);
  const altitudePresent = new Uint8Array(Math.ceil(count / 8));
  for (let row = 0; row < count; ++row) {
    const index = row < beforeCount ? pointCount + row : row < beforeCount + pointCount ? row - beforeCount : row;
    const offset = ROW_BYTES * (row + 1);
    for (let axis = 0; axis < 4; ++axis) pointData[index * 4 + axis] = output.readDoubleLE(offset + axis * 8);
    if (output.readDoubleLE(offset + 32) === 1) altitudePresent[index >>> 3] |= 1 << (index & 7);
  }
  const { points: _points, contextPoints: _context, ...summary } = baseline;
  return { ...summary, pointCount, pointData, altitudePresent, fittedWindows, attitudeConstraints,
    reason: attitudeConstraints ? "使用 DJI 姿态约束轨迹方向。" : "使用 GPS 和运动平滑约束拟合轨迹。" };
}
