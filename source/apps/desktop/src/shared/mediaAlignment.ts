import type { MediaSource } from "../../../../packages/media/src/types";
import type { AlignmentPoint, MotionAlignmentResult } from "../../../../packages/media/src/motion-alignment";

export const ALIGN_MEDIA_CHANNEL = "media:align-time";
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
  /** GPS timestamps in Unix seconds, before converting to the video clock. */
  points: readonly AlignmentPoint[];
}
export interface MediaAlignmentResult extends MotionAlignmentResult {
  source: MediaSource;
  backupPath: string;
  timecodeUpdated: boolean;
}

export const PROCESS_GPS_CHANNEL = "media:process-gps";
export interface MotionGpsRequest {sourcePath:string;points:readonly import("../../../../packages/media/src/gps-motion").MotionPoint[]}
export type {MotionGpsResult} from "../../../../packages/media/src/gps-motion";
