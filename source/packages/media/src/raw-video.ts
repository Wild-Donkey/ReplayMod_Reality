import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { assertCanStartChild, runChild, stopChild, trackChild } from "./childProcesses";

async function findFFmpeg(requiredEncoders: readonly string[], searchPath: string): Promise<string | null> {
  const names = process.platform === "win32" ? ["ffmpeg.exe"] : ["ffmpeg"];
  const directories = searchPath.split(path.delimiter)
    .map(directory => process.platform === "win32" ? directory.replace(/^"|"$/g, "") : directory)
    .filter(Boolean);
  const candidates = new Set(directories.flatMap(directory => names.map(name => path.join(directory, name))));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const {stdout} = await runChild(candidate, ["-hide_banner", "-encoders"], {maxBuffer: 4 * 1024 * 1024, timeout: 10000});
      const encoders = new Set(stdout.split("\n").map(line => line.trim().split(/\s+/)[1]));
      if (requiredEncoders.every(name => encoders.has(name))) return candidate;
    } catch { /* Try the next installed binary, including the bundled fallback. */ }
  }
  return null;
}

export function findTransparentVideoEncoder(searchPath = process.env.PATH ?? "") {
  return findFFmpeg(["libvpx-vp9"], searchPath);
}

export type CompositeCodec = "h264" | "hevc";
const compositeEncoders = {h264: "libx264", hevc: "libx265"} as const;
export type CompositeHardwareBackend = "videotoolbox" | "nvenc" | "qsv" | "amf";
const windowsHardwareBackends = ["nvenc", "qsv", "amf"] as const;
const encoderThreads = process.platform === "win32" ? Math.min(16, availableParallelism()) : 4;
const filterThreads = process.platform === "win32" ? Math.min(4, encoderThreads) : 2;

export function findCompositeVideoEncoder(codec: CompositeCodec, searchPath = process.env.PATH ?? "") {
  return findFFmpeg([compositeEncoders[codec], "aac"], searchPath);
}

export async function findHardwareCompositeEncoder(
  codec: CompositeCodec,
  {width, height, fps, bitrate}: Pick<RawVideoOptions, "width" | "height" | "fps" | "bitrate">,
  quality?: number,
  totalFrames = 1,
) {
  const backends: readonly CompositeHardwareBackend[] = process.platform === "win32" ? windowsHardwareBackends
    : process.platform === "darwin" && (quality === undefined || process.arch === "arm64") ? ["videotoolbox"] : [];
  for (const backend of backends) {
    const executable = await findFFmpeg([`${codec}_${backend}`, "aac"], process.env.PATH ?? "");
    if (!executable) continue;
    // A one-frame probe can miss delayed-frame flush failures on Windows drivers.
    const probeFrames = backend === "videotoolbox" ? 1 : Math.min(8, totalFrames);
    try {
      await runChild(executable, [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", `color=size=${width}x${height}:rate=${fps}`,
        "-frames:v", String(probeFrames), ...hardwareArguments(codec, backend, bitrate, quality), "-f", "null", "-",
      ], {timeout: 5000, maxBuffer: 256 * 1024});
      return {executable, backend};
    } catch { /* The binary can advertise encoders without usable hardware. */ }
  }
  return null;
}

function hardwareArguments(codec: CompositeCodec, backend: CompositeHardwareBackend, bitrate: number, quality?: number) {
  const args = ["-c:v", `${codec}_${backend}`, "-pix_fmt", "nv12"];
  if (backend === "videotoolbox") {
    args.push("-allow_sw", "0");
    if (quality !== undefined) return [...args, "-q:v", String(quality)];
  }
  if (quality === undefined) return [...args, "-b:v", String(bitrate)];
  const quantizer = String(Math.round(51 - quality * 0.4));
  if (backend === "nvenc") return [...args, "-rc", "vbr", "-cq", quantizer, "-b:v", "0"];
  if (backend === "qsv") return [...args, "-global_quality", quantizer];
  return [...args, "-rc", "cqp", "-qp_i", quantizer, "-qp_p", quantizer];
}

export interface VideoCompositeInput {
  readonly sourcePath: string;
  readonly offsetSeconds: number;
  readonly durationSeconds: number;
  readonly codec: CompositeCodec;
  readonly hardware?: CompositeHardwareBackend;
  readonly hardwareQuality?: number;
  readonly overlayTop?: number;
}

export interface RawVideoOptions {
  readonly encoder: string;
  readonly output: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly bitrate: number;
  readonly crf?: number;
  readonly cpuUsed?: number;
  readonly composite?: VideoCompositeInput;
}

function compositeArguments(options: RawVideoOptions, input: VideoCompositeInput) {
  const {width, height, fps, bitrate, crf, cpuUsed} = options;
  const preset = cpuUsed === 5 ? "veryfast" : cpuUsed === 2 ? "slow" : "medium";
  const base = `[1:V:0]fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[base]`;
  const encoding = input.hardware
    ? hardwareArguments(input.codec, input.hardware, bitrate, input.hardwareQuality)
    : ["-c:v", compositeEncoders[input.codec], "-preset", preset, "-threads", String(encoderThreads), "-pix_fmt", "yuv420p",
      ...(crf === undefined ? ["-b:v", String(bitrate)] : ["-crf", String(crf)]),
      ...(input.codec === "hevc" ? ["-x265-params", `pools=${encoderThreads}:log-level=error`] : [])];
  return [
    "-ss", String(input.offsetSeconds), "-i", input.sourcePath,
    "-filter_complex_threads", String(filterThreads),
    "-filter_complex", `${base};[base][0:v:0]overlay=y=${input.overlayTop ?? 0}:shortest=1:format=yuv420[video]`,
    "-map", "[video]", "-map", "1:a?", "-t", String(input.durationSeconds),
    ...encoding, ...(input.codec === "hevc" ? ["-tag:v", "hvc1"] : []),
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4",
  ];
}

// One awaited RGBA write at a time bounds memory independently of duration.
// CFR timestamps come from the input frame rate, never from rendering latency.
export class RawVideoEncoder {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly closed: Promise<void>;
  private readonly ready: Promise<void>;
  private stderr = "";
  private busy = false;
  private ending = false;
  private cancelled = false;
  private failure: Error | null = null;
  private readonly inputHeight: number;
  frames = 0;
  constructor(private readonly options: RawVideoOptions) {
    assertCanStartChild();
    this.inputHeight = options.height - (options.composite?.overlayTop ?? 0);
    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
      "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${options.width}x${this.inputHeight}`,
      "-framerate", String(options.fps), "-i", "pipe:0",
    ];
    if (options.composite) args.push(...compositeArguments(options, options.composite));
    else args.push(
      "-an",
      "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0",
      "-row-mt", "1", "-threads", String(encoderThreads), "-deadline", "good", "-cpu-used", String(options.cpuUsed ?? 4),
      "-b:v", String(options.bitrate),
      ...(options.crf === undefined ? [] : ["-crf", String(options.crf)]),
      "-f", "webm",
    );
    args.push(options.output);
    this.process = trackChild(spawn(options.encoder, args, {stdio: ["pipe", "pipe", "pipe"], windowsHide: true}));
    this.process.stdout.resume();
    this.process.stderr.on("data", chunk => { this.stderr = (this.stderr + String(chunk)).slice(-65536); });
    this.process.stdin.on("error", error => { this.failure = error; });
    this.closed = new Promise<void>((resolve, reject) => {
      this.process.once("error", error => { this.failure = error; reject(error); });
      this.process.once("close", (code, signal) => {
        if (this.cancelled) resolve();
        else if (code === 0 && !this.failure) resolve();
        else { this.failure ??= new Error(this.stderr.trim() || `Video encoder exited (${code ?? signal})`); reject(this.failure); }
      });
    });
    this.ready = new Promise<void>((resolve, reject) => { this.process.once("spawn", resolve); this.process.once("error", reject); });
    void this.ready.catch(() => {});
    // A process may fail before its first write/finish is awaited.
    void this.closed.catch(() => {});
  }
  async write(rgba: Uint8Array) {
    if (this.ending || this.cancelled || this.failure) throw this.failure ?? new Error("Video encoder is closed");
    if (this.busy) throw new Error("Concurrent video frame writes are not allowed");
    if (!ArrayBuffer.isView(rgba) || rgba.BYTES_PER_ELEMENT !== 1 || rgba.byteLength !== this.options.width * this.inputHeight * 4) throw new Error("Invalid RGBA frame size");
    this.busy = true;
    try {
      await this.ready;
      if (this.cancelled || this.failure) throw this.failure ?? new Error("Export was cancelled");
      await new Promise<void>((resolve, reject) => this.process.stdin.write(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), error => error ? reject(error) : resolve()));
      this.frames++;
    } finally { this.busy = false; }
  }
  async finish() {
    if (this.cancelled || this.ending || this.busy) throw new Error("Video encoder cannot finish in its current state");
    if (!this.frames) throw new Error("Cannot encode an empty video");
    this.ending = true;
    this.process.stdin.end();
    await this.closed;
  }
  async cancel() {
    if (!this.cancelled) {
      this.cancelled = true;
      this.process.stdin.destroy();
      await stopChild(this.process);
    }
    await this.closed.catch(() => {});
  }
}
