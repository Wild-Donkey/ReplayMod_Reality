import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AccelerationBackend,
  EncoderCapability,
  MediaCapabilityReport,
  MediaSource,
  MediaTrack,
  MediaTrackKind,
} from "./types";

const execFileAsync = promisify(execFile);

interface ProbeStream {
  readonly index?: number;
  readonly id?: string;
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly codec_tag_string?: string;
  readonly duration?: string;
  readonly nb_frames?: string;
  readonly tags?: Record<string, string>;
}

interface ProbeDocument {
  readonly format?: {
    readonly format_name?: string;
    readonly duration?: string;
    readonly tags?: Record<string, string>;
  };
  readonly streams?: readonly ProbeStream[];
}

const numericOrNull = (value: string | undefined): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const trackIdOrNull = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Number.parseInt(value, value.startsWith("0x") ? 16 : 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const classifyTrack = (stream: ProbeStream): MediaTrackKind => {
  if (stream.codec_type === "video") return "video";
  if (stream.codec_type === "audio") return "audio";
  if (stream.codec_type === "subtitle") return "subtitle";
  return "telemetry";
};

const encoderCandidates: readonly [
  encoder: string,
  backend: AccelerationBackend,
  codec: "h264" | "hevc",
  hardwareAccelerated: boolean,
][] = [
  ["h264_videotoolbox", "videotoolbox", "h264", true],
  ["hevc_videotoolbox", "videotoolbox", "hevc", true],
  ["h264_nvenc", "nvenc", "h264", true],
  ["hevc_nvenc", "nvenc", "hevc", true],
  ["h264_qsv", "qsv", "h264", true],
  ["hevc_qsv", "qsv", "hevc", true],
  ["h264_amf", "amf", "h264", true],
  ["hevc_amf", "amf", "hevc", true],
  ["h264_vaapi", "vaapi", "h264", true],
  ["hevc_vaapi", "vaapi", "hevc", true],
  ["libx264", "cpu", "h264", false],
  ["libx265", "cpu", "hevc", false],
];

export const detectMediaCapabilities = async (): Promise<MediaCapabilityReport> => {
  const diagnostics: string[] = [];
  let ffmpegAvailable = false;
  let ffprobeAvailable = false;
  let encoderOutput = "";

  try {
    await execFileAsync("ffprobe", ["-version"]);
    ffprobeAvailable = true;
  } catch {
    diagnostics.push("未找到 ffprobe；无法读取媒体轨道。");
  }

  try {
    const result = await execFileAsync("ffmpeg", ["-hide_banner", "-encoders"], {
      maxBuffer: 8 * 1024 * 1024,
    });
    ffmpegAvailable = true;
    encoderOutput = `${result.stdout}\n${result.stderr}`;
  } catch {
    diagnostics.push("未找到 ffmpeg；分析结果暂时无法渲染输出。");
  }

  const encoders: EncoderCapability[] = encoderCandidates
    .filter(([encoder]) => new RegExp(`\\b${encoder}\\b`).test(encoderOutput))
    .map(([encoder, backend, codec, hardwareAccelerated]) => ({
      encoder,
      backend,
      codec,
      hardwareAccelerated,
    }));

  if (ffmpegAvailable && encoders.length === 0) {
    diagnostics.push("FFmpeg 未报告受支持的 H.264/HEVC 编码器。");
  }

  return { ffmpegAvailable, ffprobeAvailable, encoders, diagnostics };
};

export const probeMediaFile = async (sourcePath: string): Promise<MediaSource> => {
  const capabilities = await detectMediaCapabilities();

  if (!capabilities.ffprobeAvailable) {
    throw new Error(capabilities.diagnostics.join(" "));
  }

  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_format",
    "-show_streams",
    "-of",
    "json",
    sourcePath,
  ], { maxBuffer: 32 * 1024 * 1024 });
  const document = JSON.parse(stdout) as ProbeDocument;
  const streams = document.streams ?? [];
  const tracks: MediaTrack[] = streams.map((stream, position) => ({
    index: stream.index ?? position,
    trackId: trackIdOrNull(stream.id),
    kind: classifyTrack(stream),
    codec: stream.codec_name ?? "unknown",
    codecTag: stream.codec_tag_string ?? null,
    durationSeconds: numericOrNull(stream.duration),
    sampleCount: numericOrNull(stream.nb_frames),
    language: stream.tags?.language ?? null,
    title: stream.tags?.title ?? stream.tags?.handler_name ?? null,
  }));
  const djiMetadataTrackIndexes = tracks
    .filter((track) => {
      const signature = `${track.codec} ${track.codecTag ?? ""} ${track.title ?? ""}`;
      return /\b(djmd|dbgi|dvtm)\b|dji/i.test(signature);
    })
    .map((track) => track.index);
  const formatTags = document.format?.tags ?? {};
  const makeSignature = Object.values(formatTags).join(" ");

  return {
    sourcePath,
    sourceName: path.basename(sourcePath),
    format: document.format?.format_name ?? "unknown",
    durationSeconds: numericOrNull(document.format?.duration),
    tracks,
    isLikelyDji: djiMetadataTrackIndexes.length > 0 || /dji/i.test(makeSignature),
    djiMetadataTrackIndexes,
    capabilities,
  };
};
