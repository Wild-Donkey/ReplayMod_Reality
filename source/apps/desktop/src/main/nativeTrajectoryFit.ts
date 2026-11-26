import { processMotionGps, type MotionPoint } from "../../../../packages/media/src/gps-motion";
import { normalizeTrajectorySampleRate } from "../../../../packages/media/src/trajectory-fit";
import type { OrientationSample } from "../../../../packages/media/src/types";
import { packMotionGpsResult, type PackedMotionGpsResult } from "../shared/motionGpsWire";
import { runNativeBinaryJob, type NativeJobProgress } from "./nativeBinaryJob";

const CONTEXT_SECONDS = 4;
const HEADER_BYTES = 8 * 8;
const ROW_BYTES = 5 * 8;

export async function fitNativeTrajectory(executable: string, samples: readonly OrientationSample[],
    points: readonly MotionPoint[], start: number, end: number, sampleRateHz: number, signal?: AbortSignal,
    onProgress?: (progress: NativeJobProgress) => void): Promise<PackedMotionGpsResult> {
  signal?.throwIfAborted();
  const fixes = points.filter(point => Number.isFinite(point.timeSeconds) && Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) && Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180)
    .sort((a, b) => a.timeSeconds - b.timeSeconds)
    .filter((point, index, sorted) => index === 0 || point.timeSeconds > sorted[index - 1].timeSeconds);
  if (!fixes.length || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return packMotionGpsResult(processMotionGps([], points, start, end));
  }
  const duration = end - start;
  if ((duration + 2 * CONTEXT_SECONDS) * 10 > 500_000) throw new Error("轨迹处理范围过大，请缩短视频片段。");
  const rate = normalizeTrajectorySampleRate(sampleRateHz);
  const attitude = samples.flatMap(sample => {
    const [w, x, y, z] = sample.quaternion;
    const length = Math.hypot(w, x, y, z);
    if (!(length > 1e-8) || !Number.isFinite(length) || !Number.isFinite(sample.timeSeconds)) return [];
    return [{ time: sample.timeSeconds, yaw: Math.atan2(2 * (w*z + x*y), length**2 - 2*(y*y + z*z)) }];
  }).sort((a, b) => a.time - b.time);
  const input = Buffer.allocUnsafe(5 * 8 + fixes.length * ROW_BYTES + attitude.length * 16);
  let offset = 0;
  const number = (value: number) => { offset = input.writeDoubleLE(value, offset); };
  for (const value of [2, start, end, rate, fixes.length]) number(value);
  for (const point of fixes) {
    number(point.timeSeconds);
    number(point.longitude);
    number(point.latitude);
    number(point.altitude ?? 0);
    number(point.altitude === undefined ? 0 : 1);
  }
  for (const sample of attitude) {
    number(sample.time);
    number(sample.yaw);
  }

  const pointCount = Math.ceil(duration * rate) + 1;
  const beforeCount = CONTEXT_SECONDS * rate;
  const count = pointCount + 2 * beforeCount;
  const outputBytes = HEADER_BYTES + ROW_BYTES * count;
  const output = await runNativeBinaryJob(executable, "--fit-trajectory", input, {
    exactBytes: outputBytes, maxBytes: outputBytes, signal, onProgress,
  });
  if (!output || output.readDoubleLE(0) !== 2 || output.readDoubleLE(8) !== pointCount ||
      output.readDoubleLE(16) !== count - pointCount) throw new Error("Invalid native trajectory header");
  const fittedWindows = output.readDoubleLE(24), attitudeConstraints = output.readDoubleLE(32);
  const correctedPoints = output.readDoubleLE(40), smoothedIntervals = output.readDoubleLE(48), bridgedIntervals = output.readDoubleLE(56);
  if (fittedWindows < 1 || [fittedWindows, attitudeConstraints, correctedPoints, smoothedIntervals, bridgedIntervals]
    .some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("Invalid native trajectory diagnostics");
  const pointData = new Float64Array(count * 4);
  const altitudePresent = new Uint8Array(Math.ceil(count / 8));
  for (let row = 0; row < count; ++row) {
    const index = row < beforeCount ? pointCount + row : row < beforeCount + pointCount ? row - beforeCount : row;
    const offset = HEADER_BYTES + ROW_BYTES * row;
    for (let axis = 0; axis < 4; ++axis) pointData[index * 4 + axis] = output.readDoubleLE(offset + axis * 8);
    if (output.readDoubleLE(offset + 32) === 1) altitudePresent[index >>> 3] |= 1 << (index & 7);
  }
  return { videoStartSeconds: start, videoEndSeconds: end,
    pointCount, pointData, altitudePresent, fittedWindows, attitudeConstraints, correctedPoints,
    smoothedIntervals, bridgedIntervals, curvedIntervals: 0,
    reason: attitudeConstraints ? "使用 DJI 姿态约束轨迹方向。" : "使用 GPS 和运动平滑约束拟合轨迹。" };
}
