import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chooseEncoder, codecArguments } from "./compress";
import { probeMediaFile } from "./probe";
import type {
  DynamicRenderOptions,
  DynamicRenderResult,
  PlaybackRateSample,
  TimelineMetadataTrack,
} from "./types";

const execFileAsync = promisify(execFile);

const atempoChain = (rate: number): string => {
  const factors: number[] = [];
  let remaining = rate;
  while (remaining > 2) {
    factors.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  factors.push(remaining);
  return factors.map((factor) => `atempo=${factor.toFixed(8)}`).join(",");
};

interface RenderSegment {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly outputStart: number;
  readonly rate: number;
}

const buildSegments = (
  track: TimelineMetadataTrack<PlaybackRateSample>,
  durationSeconds: number,
): RenderSegment[] => {
  if (track.timeBase !== "source") {
    throw new Error("动态渲染需要基于源时间轴的播放倍率轨。");
  }
  const points = [...track.samples]
    .filter((sample) => sample.timeSeconds < durationSeconds && sample.rate > 0)
    .sort((left, right) => left.timeSeconds - right.timeSeconds);
  if (points.length === 0) throw new Error("播放倍率轨没有有效样本。");
  if (points[0].timeSeconds > 0) points.unshift({ ...points[0], timeSeconds: 0 });
  const segments: RenderSegment[] = [];
  let outputStart = 0;

  for (let index = 0; index < points.length; index += 1) {
    const sourceStart = points[index].timeSeconds;
    const sourceEnd = Math.min(
      durationSeconds,
      points[index + 1]?.timeSeconds ?? durationSeconds,
    );
    if (sourceEnd <= sourceStart) continue;
    segments.push({ sourceStart, sourceEnd, outputStart, rate: points[index].rate });
    outputStart += (sourceEnd - sourceStart) / points[index].rate;
  }
  return segments;
};

const buildFilterGraph = (
  segments: readonly RenderSegment[],
  outputFps: number,
  hasAudio: boolean,
) => {
  const filters: string[] = [];
  const videoInputs: string[] = [];
  const audioInputs: string[] = [];

  segments.forEach((segment, index) => {
    const start = segment.sourceStart.toFixed(6);
    const end = segment.sourceEnd.toFixed(6);
    const rate = segment.rate.toFixed(8);
    filters.push(
      `[0:v:0]trim=start=${start}:end=${end},setpts=(PTS-STARTPTS)/${rate}[v${index}]`,
    );
    videoInputs.push(`[v${index}]`);
    if (hasAudio) {
      filters.push(
        `[0:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,${atempoChain(segment.rate)}[a${index}]`,
      );
      audioInputs.push(`[a${index}]`);
    }
  });

  filters.push(
    `${videoInputs.join("")}concat=n=${segments.length}:v=1:a=0,` +
      `minterpolate=fps=${outputFps}:mi_mode=blend[vout]`,
  );
  if (hasAudio) {
    const outputDuration = segments.reduce(
      (sum, segment) => sum + (segment.sourceEnd - segment.sourceStart) / segment.rate,
      0,
    );
    filters.push(
      `${audioInputs.join("")}concat=n=${segments.length}:v=0:a=1,` +
        `atrim=end=${outputDuration.toFixed(6)},asetpts=PTS-STARTPTS[aout]`,
    );
  }
  return filters.join(";\n");
};

export const renderDynamicVideo = async (
  inputPath: string,
  outputPath: string,
  playbackRateTrack: TimelineMetadataTrack<PlaybackRateSample>,
  options: DynamicRenderOptions,
): Promise<DynamicRenderResult> => {
  const source = await probeMediaFile(inputPath);
  if (!source.durationSeconds) throw new Error("无法确定输入视频时长。");
  const encoder = await chooseEncoder(options.codec, options.encoder);
  const segments = buildSegments(playbackRateTrack, source.durationSeconds);
  const outputDurationSeconds = segments.reduce(
    (sum, segment) => sum + (segment.sourceEnd - segment.sourceStart) / segment.rate,
    0,
  );
  const outputTrack: TimelineMetadataTrack<PlaybackRateSample> = {
    id: playbackRateTrack.id,
    name: playbackRateTrack.name,
    timeBase: "project",
    samples: segments.map((segment) => ({
      timeSeconds: segment.outputStart,
      rate: segment.rate,
    })),
  };
  const metadataPath = `${outputPath}.replay.json`;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "replaymod-render-"));
  const filterPath = path.join(temporaryDirectory, "filter.txt");
  const hasAudio = source.tracks.some((track) => track.kind === "audio");
  await writeFile(filterPath, buildFilterGraph(segments, options.outputFps, hasAudio));

  const args = [
    "-hide_banner", options.overwrite ? "-y" : "-n", "-i", inputPath,
    "-/filter_complex", filterPath,
    "-map", "[vout]",
    ...(hasAudio ? ["-map", "[aout]"] : []),
    ...codecArguments(options.codec, encoder, options.targetBitrateMbps),
    ...(hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
    ...(hasAudio ? ["-shortest"] : []),
    "-map_metadata", "0",
    "-metadata", `replaymod_average_rate=${(source.durationSeconds / outputDurationSeconds).toFixed(6)}`,
    "-movflags", "+faststart+use_metadata_tags",
    outputPath,
  ];

  let renderedDurationSeconds = outputDurationSeconds;
  try {
    await execFileAsync("ffmpeg", args, { maxBuffer: 64 * 1024 * 1024 });
    const rendered = await probeMediaFile(outputPath);
    renderedDurationSeconds = rendered.tracks.find(
      (track) => track.kind === "video",
    )?.durationSeconds ?? rendered.durationSeconds ?? outputDurationSeconds;
    await writeFile(metadataPath, JSON.stringify({
      version: 1,
      sourcePath: inputPath,
      sourceDurationSeconds: source.durationSeconds,
      outputDurationSeconds: renderedDurationSeconds,
      outputFps: options.outputFps,
      playbackRate: outputTrack,
    }, null, 2));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  return {
    outputPath,
    metadataPath,
    encoder,
    sourceDurationSeconds: source.durationSeconds,
    outputDurationSeconds: renderedDurationSeconds,
    averageRate: source.durationSeconds / renderedDurationSeconds,
    outputFps: options.outputFps,
    playbackRateTrack: outputTrack,
  };
};
