export type MediaTrackKind =
  | "video"
  | "audio"
  | "subtitle"
  | "telemetry"
  | "coordinates";

export interface MediaTrack {
  readonly index: number;
  readonly trackId: number | null;
  readonly kind: MediaTrackKind;
  readonly codec: string;
  readonly codecTag: string | null;
  readonly durationSeconds: number | null;
  readonly sampleCount: number | null;
  readonly language: string | null;
  readonly title: string | null;
}

export type AccelerationBackend =
  | "videotoolbox"
  | "nvenc"
  | "qsv"
  | "amf"
  | "vaapi"
  | "cpu";

export interface EncoderCapability {
  readonly backend: AccelerationBackend;
  readonly codec: "h264" | "hevc";
  readonly encoder: string;
  readonly hardwareAccelerated: boolean;
}

export interface MediaCapabilityReport {
  readonly ffmpegAvailable: boolean;
  readonly ffprobeAvailable: boolean;
  readonly encoders: readonly EncoderCapability[];
  readonly diagnostics: readonly string[];
}

export interface MediaSource {
  readonly sourcePath: string;
  readonly sourceName: string;
  readonly format: string;
  readonly durationSeconds: number | null;
  readonly tracks: readonly MediaTrack[];
  readonly isLikelyDji: boolean;
  readonly djiMetadataTrackIndexes: readonly number[];
  readonly capabilities: MediaCapabilityReport;
}

export interface TimedTextCue {
  readonly startTimeSeconds: number;
  readonly endTimeSeconds: number;
  readonly text: string;
  readonly confidence?: number;
}

export interface SubtitleTrack {
  readonly kind: "subtitle";
  readonly language: string;
  readonly source: "speech-recognition" | "imported" | "generated";
  readonly cues: readonly TimedTextCue[];
}

export interface SpeechTranscriptionOptions {
  readonly whisperPath: string;
  readonly modelPath: string;
  readonly vadModelPath?: string;
  readonly ffmpegPath?: string;
  readonly language?: string;
}

export interface SavedSubtitleTrack {
  readonly jsonPath: string;
  readonly srtPath: string;
}

export interface ClockAnchor {
  readonly sourceTimeSeconds: number;
  readonly projectTimeSeconds: number;
}

export interface TimeAlignment {
  readonly sourceId: string;
  readonly anchors: readonly ClockAnchor[];
}

export interface TimedSample {
  readonly timeSeconds: number;
}

export interface PlaybackRateSample extends TimedSample {
  readonly rate: number;
  readonly angularSpeedDegreesPerSecond?: number;
  readonly rotationAmplitudeDegrees?: number;
}

export interface TimelineMetadataTrack<TSample extends TimedSample> {
  readonly id: string;
  readonly name: string;
  readonly timeBase: "source" | "project";
  readonly samples: readonly TSample[];
}

export interface MediaTimelineMetadata {
  readonly version: 1;
  readonly playbackRate: TimelineMetadataTrack<PlaybackRateSample> | null;
  readonly subtitles: readonly SubtitleTrack[];
}

export type CompressionCodec = "h264" | "hevc";

export interface CompressionOptions {
  readonly codec: CompressionCodec;
  readonly targetBitrateMbps: number;
  readonly encoder?: string;
  readonly mp4boxPath?: string;
  readonly overwrite?: boolean;
}

export interface CompressionResult {
  readonly outputPath: string;
  readonly encoder: string;
  readonly sourceBytes: number;
  readonly outputBytes: number;
  readonly compressionRatio: number;
  readonly sourceTrackCount: number;
  readonly outputTrackCount: number;
  readonly preservedDjiMetadata: boolean;
}

export interface OrientationSample extends TimedSample {
  readonly quaternion: readonly [number, number, number, number];
}

export interface PlaybackRateOptions {
  readonly minimumRate: number;
  readonly maximumRate: number;
  readonly angularSpeedForMaximumRate: number;
  readonly angularSpeedForMinimumRate: number;
  readonly featureMinimumDurationSeconds: number;
  readonly analysisWindowSeconds: readonly number[];
  readonly minimumRotationDegrees: number;
  readonly minimumAverageAngularSpeedAtOneSecond: number;
  readonly shortWindowThresholdPower: number;
  readonly minimumDirectionCoherence: number;
  readonly sampleIntervalSeconds: number;
  readonly speedUpTimeSeconds: number;
  readonly slowDownLookAheadSeconds: number;
}

export interface DynamicRenderOptions {
  readonly outputFps: number;
  readonly codec: CompressionCodec;
  readonly targetBitrateMbps: number;
  readonly encoder?: string;
  readonly overwrite?: boolean;
}

export interface DynamicRenderResult {
  readonly outputPath: string;
  readonly metadataPath: string;
  readonly encoder: string;
  readonly sourceDurationSeconds: number;
  readonly outputDurationSeconds: number;
  readonly averageRate: number;
  readonly outputFps: number;
  readonly playbackRateTrack: TimelineMetadataTrack<PlaybackRateSample>;
}
