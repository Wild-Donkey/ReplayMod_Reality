import type { MediaSource } from "../../../../packages/media/src/types";
import type { AlignmentPoint, MotionAlignmentResult } from "../../../../packages/media/src/motion-alignment";

export const ALIGN_MEDIA_CHANNEL = "media:align-time";
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
