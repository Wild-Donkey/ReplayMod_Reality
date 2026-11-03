import { execFile } from "node:child_process";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { detectMediaCapabilities, probeMediaFile } from "./probe";
import type {
  CompressionCodec,
  CompressionOptions,
  CompressionResult,
  EncoderCapability,
} from "./types";

const execFileAsync = promisify(execFile);

const backendPriority: readonly EncoderCapability["backend"][] = [
  "videotoolbox",
  "nvenc",
  "qsv",
  "amf",
  "vaapi",
  "cpu",
];

export const chooseEncoder = async (
  codec: CompressionCodec,
  requestedEncoder?: string,
): Promise<string> => {
  const capabilities = await detectMediaCapabilities();

  if (!capabilities.ffmpegAvailable) {
    throw new Error("未找到 FFmpeg，无法压缩视频。");
  }

  if (requestedEncoder) {
    const supported = capabilities.encoders.some(
      (candidate) => candidate.encoder === requestedEncoder,
    );
    if (!supported) throw new Error(`FFmpeg 不支持编码器 ${requestedEncoder}。`);
    return requestedEncoder;
  }

  for (const backend of backendPriority) {
    const match = capabilities.encoders.find(
      (candidate) => candidate.codec === codec && candidate.backend === backend,
    );
    if (match) return match.encoder;
  }

  throw new Error(`没有找到可用的 ${codec.toUpperCase()} 编码器。`);
};

export const codecArguments = (
  codec: CompressionCodec,
  encoder: string,
  targetBitrateMbps: number,
): string[] => {
  const bitrateKbps = Math.round(targetBitrateMbps * 1000);
  const arguments_: string[] = [
    "-c:v:0",
    encoder,
    "-b:v:0",
    `${bitrateKbps}k`,
    "-maxrate:v:0",
    `${Math.round(bitrateKbps * 1.5)}k`,
    "-bufsize:v:0",
    `${bitrateKbps * 2}k`,
  ];

  if (codec === "hevc") {
    arguments_.push("-tag:v:0", "hvc1");
    if (encoder.includes("videotoolbox")) {
      arguments_.push("-profile:v:0", "main10", "-pix_fmt:v:0", "p010le");
    }
  }

  return arguments_;
};

export const compressMedia = async (
  inputPath: string,
  outputPath: string,
  options: CompressionOptions,
): Promise<CompressionResult> => {
  if (!Number.isFinite(options.targetBitrateMbps) || options.targetBitrateMbps <= 0) {
    throw new Error("目标码率必须是大于零的 Mbps 数值。");
  }

  if (!options.overwrite) {
    try {
      await access(outputPath);
      throw new Error(`输出文件已存在：${outputPath}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("输出文件已存在")) {
        throw error;
      }
    }
  }

  const [source, encoder, sourceStats] = await Promise.all([
    probeMediaFile(inputPath),
    chooseEncoder(options.codec, options.encoder),
    stat(inputPath),
  ]);
  const primaryVideo = source.tracks.find(
    (track) => track.kind === "video" && track.trackId !== null,
  );
  if (!primaryVideo || primaryVideo.trackId === null) {
    throw new Error("输入文件没有可替换的主视频轨。");
  }

  const mp4boxPath = options.mp4boxPath ?? "MP4Box";
  try {
    await execFileAsync(mp4boxPath, ["-version"]);
  } catch {
    throw new Error("未找到 MP4Box；DJI 私有元数据轨不能由 FFmpeg 安全封装。");
  }

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "replaymod-compress-"));
  const encodedVideoPath = path.join(temporaryDirectory, "video-only.mp4");
  const replacementTrackId = Math.max(
    ...source.tracks.map((track) => track.trackId ?? 0),
  ) + 1;
  const timecodeTrackId = source.tracks.find(
    (track) => track.codecTag === "tmcd" && track.trackId !== null,
  )?.trackId;
  const ffmpegArgs = [
    "-hide_banner",
    "-y",
    "-i",
    inputPath,
    "-map", "0:v:0",
    "-an", "-sn", "-dn",
    ...codecArguments(options.codec, encoder, options.targetBitrateMbps),
    "-movflags", "+faststart",
    encodedVideoPath,
  ];

  try {
    await execFileAsync("ffmpeg", ffmpegArgs, { maxBuffer: 32 * 1024 * 1024 });
    const mp4boxArgs = [
      "-add",
      `${encodedVideoPath}#video:ID=${replacementTrackId}:tkidx=1`,
      "-rem",
      String(primaryVideo.trackId),
      "-set-track-id",
      `${replacementTrackId}:${primaryVideo.trackId}`,
    ];
    if (timecodeTrackId !== undefined && timecodeTrackId !== null) {
      mp4boxArgs.push("-ref", `${primaryVideo.trackId}:tmcd:${timecodeTrackId}`);
    }
    mp4boxArgs.push("-keep-utc", inputPath, "-out", outputPath);
    await execFileAsync(mp4boxPath, mp4boxArgs, { maxBuffer: 32 * 1024 * 1024 });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  const [output, outputStats] = await Promise.all([
    probeMediaFile(outputPath),
    stat(outputPath),
  ]);
  const sourceDjiTags = new Set(
    source.tracks
      .filter((track) => source.djiMetadataTrackIndexes.includes(track.index))
      .map((track) => track.codecTag),
  );
  const outputDjiTags = new Set(
    output.tracks
      .filter((track) => output.djiMetadataTrackIndexes.includes(track.index))
      .map((track) => track.codecTag),
  );
  const preservedDjiMetadata = [...sourceDjiTags].every((tag) =>
    outputDjiTags.has(tag),
  );
  const sourcePreservedTracks = source.tracks
    .filter((track) => track.index !== primaryVideo.index)
    .map((track) => ({
      trackId: track.trackId,
      codecTag: track.codecTag,
      durationSeconds: track.durationSeconds,
      sampleCount: track.sampleCount,
    }));
  const outputPreservedTracks = output.tracks
    .filter((track) => track.trackId !== primaryVideo.trackId)
    .map((track) => ({
      trackId: track.trackId,
      codecTag: track.codecTag,
      durationSeconds: track.durationSeconds,
      sampleCount: track.sampleCount,
    }));

  if (
    output.tracks.length !== source.tracks.length ||
    !preservedDjiMetadata ||
    JSON.stringify(outputPreservedTracks) !== JSON.stringify(sourcePreservedTracks)
  ) {
    throw new Error("压缩完成，但输出文件没有完整保留输入轨道或 DJI 元数据。");
  }

  return {
    outputPath,
    encoder,
    sourceBytes: sourceStats.size,
    outputBytes: outputStats.size,
    compressionRatio: outputStats.size / sourceStats.size,
    sourceTrackCount: source.tracks.length,
    outputTrackCount: output.tracks.length,
    preservedDjiMetadata,
  };
};
