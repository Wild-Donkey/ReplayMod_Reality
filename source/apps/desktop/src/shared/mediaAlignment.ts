import type { MediaSource } from "../../../../packages/media/src/types";

export const ALIGN_MEDIA_CHANNEL = "media:apply-time-alignment";
export const normalizeAlignmentSeconds = (value: number) => Math.round(value * 1000) / 1000;
export const validAlignmentOffset = (value: number) =>
  Number.isFinite(value) && Math.abs(value) <= 86400 && value === normalizeAlignmentSeconds(value);
export const alignedMediaStart = (start: number, offset: number) =>
  (Math.round(start * 1000) + Math.round(offset * 1000)) / 1000;
export function splitAlignmentOffset(residualMs: number, offsetSeconds: number) {
  const totalMs = residualMs + Math.round(offsetSeconds * 1000);
  const wholeSeconds = Math.trunc(totalMs / 1000) || 0;
  return {wholeSeconds, residualMs: totalMs - wholeSeconds * 1000};
}
export interface MediaAlignmentRequest {
  sourcePath: string;
  offsetSeconds: number;
  creationTimeSeconds: number;
}
export interface MediaAlignmentResult {
  offsetSeconds: number;
  source: MediaSource;
  backupPath?: string;
  timecodeUpdated: boolean;
}

export const POST_GPS_CHANNEL = "media:post-gps";
export const GPS_RESULT_CHANNEL = "media:gps-result";
export const GPS_PROGRESS_CHANNEL = "media:gps-progress";
export type MotionGpsProgress = {readonly id: string; readonly completed: number; readonly total: number};
export interface MotionGpsRequest extends MediaAlignmentRequest {
  points: readonly import("../../../../packages/media/src/gps-motion").MotionPoint[];
}
export type {MotionGpsResult} from "../../../../packages/media/src/gps-motion";
export type MotionGpsUpdate = {id: string} & (
  {result: import("../../../../packages/media/src/gps-motion").MotionGpsResult} | {error: string}
);
