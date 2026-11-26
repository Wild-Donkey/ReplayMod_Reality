import type { CompositeCodec } from "../../../../packages/media/src/raw-video";
import type { MediaSource } from "../../../../packages/media/src/types";

export interface CompositeExportRequest {
  readonly sourcePath: string;
  readonly offsetSeconds: number;
  readonly codec: CompositeCodec;
  readonly preferHardware?: boolean;
  readonly hardwareQuality?: number;
}

export interface OfflineExportOptions {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly bitrate: number;
  readonly crf?: number;
  readonly cpuUsed?: 2 | 4 | 5;
  readonly start: number;
  readonly end: number;
  readonly segmentMilliseconds?: number;
}
export interface OfflineExportSession {
  readonly id: string;
  readonly segmentCount: number;
  readonly videoToolbox?: boolean;
}
export interface OfflineExportSegment {readonly path: string; readonly frames: number; readonly sampleBytes?: number}

/** All overlay elements are drawn below this line in the 1080 reference layout. */
export const compositeOverlayTop = (height: number) => 2 * Math.floor(height * 600 / 2160);

export function compositeSourceDuration(source: MediaSource) {
  const video = source.tracks.find(track => track.kind === "video");
  if (!video) return null;
  const duration = [video.durationSeconds, source.durationSeconds]
    .filter((value): value is number => value !== null && Number.isFinite(value) && value > 0);
  return duration.length ? Math.min(...duration) : null;
}

export class OfflineFramePlan {
  readonly totalFrames: number;
  readonly framesPerSegment: number;
  readonly segmentCount: number;
  constructor(readonly options: OfflineExportOptions) {
    this.options = Object.freeze({...options});
    const {width, height, fps, bitrate, crf, cpuUsed, start, end, segmentMilliseconds} = this.options;
    if (![width, height, fps, bitrate, start, end].every(Number.isFinite)
      || !Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 8192 || height > 8192 || width % 2 || height % 2
      || !Number.isInteger(fps) || fps < 1 || fps > 120 || end <= start
      || (segmentMilliseconds !== undefined && (!Number.isFinite(segmentMilliseconds) || segmentMilliseconds < 1000))) throw new Error("Invalid offline export options");
    const validRateControl = crf === undefined
      ? bitrate >= 100_000 && bitrate <= 200_000_000
      : bitrate === 0 && Number.isInteger(crf) && crf >= 0 && crf <= 63;
    if (!validRateControl) throw new Error("Invalid VP9 rate control settings");
    if (cpuUsed !== undefined && ![2, 4, 5].includes(cpuUsed)) throw new Error("Invalid VP9 encoding preset");
    const frames = (end - start) * fps / 1000;
    this.totalFrames = Math.max(1, Math.ceil(frames - Number.EPSILON * Math.max(1, frames) * 4));
    this.framesPerSegment = segmentMilliseconds === undefined
      ? this.totalFrames
      : Math.max(1, Math.round(segmentMilliseconds * fps / 1000));
    this.segmentCount = Math.ceil(this.totalFrames / this.framesPerSegment);
    if (!Number.isSafeInteger(this.totalFrames) || !Number.isSafeInteger(this.framesPerSegment)) throw new Error("Export frame count exceeds the supported range");
  }
  segmentFrames(segment: number) {
    this.checkSegment(segment);
    return Math.min(this.framesPerSegment, this.totalFrames - segment * this.framesPerSegment);
  }
  frame(segment: number, index: number) {
    const count = this.segmentFrames(segment);
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error("Export frame index is out of range");
    const frame = segment * this.framesPerSegment + index;
    return {frame, timestamp: this.options.start + frame * 1000 / this.options.fps, progress: (frame + 1) / this.totalFrames};
  }
  private checkSegment(segment: number) {
    if (!Number.isInteger(segment) || segment < 0 || segment >= this.segmentCount) throw new Error("Export segment index is out of range");
  }
}
