export interface OfflineExportOptions {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly bitrate: number;
  readonly start: number;
  readonly end: number;
  readonly segmentMilliseconds: number;
}
export interface OfflineExportSession {readonly id: string; readonly segmentCount: number}
export interface OfflineExportSegment {readonly path: string; readonly frames: number}

export class OfflineFramePlan {
  readonly totalFrames: number;
  readonly framesPerSegment: number;
  readonly segmentCount: number;
  constructor(readonly options: OfflineExportOptions) {
    this.options = Object.freeze({...options});
    const {width, height, fps, bitrate, start, end, segmentMilliseconds} = this.options;
    if (![width, height, fps, bitrate, start, end, segmentMilliseconds].every(Number.isFinite)
      || !Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 8192 || height > 8192 || width % 2 || height % 2
      || !Number.isInteger(fps) || fps < 1 || fps > 120 || bitrate < 100000 || bitrate > 200000000 || end <= start || segmentMilliseconds < 1000) throw new Error("Invalid offline export options");
    const frames = (end - start) * fps / 1000;
    this.totalFrames = Math.max(1, Math.ceil(frames - Number.EPSILON * Math.max(1, frames) * 4));
    this.framesPerSegment = Math.max(1, Math.round(segmentMilliseconds * fps / 1000));
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
