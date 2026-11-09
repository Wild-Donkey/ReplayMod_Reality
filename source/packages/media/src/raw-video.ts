import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export async function findTransparentVideoEncoder(searchPath = process.env.PATH ?? ""): Promise<string | null> {
  const names = process.platform === "win32" ? ["ffmpeg.exe"] : ["ffmpeg"];
  const candidates = new Set(searchPath.split(path.delimiter).filter(Boolean).flatMap(directory => names.map(name => path.join(directory, name))));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const {stdout} = await exec(candidate, ["-hide_banner", "-encoders"], {maxBuffer: 4 * 1024 * 1024, timeout: 10000});
      if (/\blibvpx-vp9\s/.test(stdout)) return candidate;
    } catch { /* Try the next installed binary, including the bundled fallback. */ }
  }
  return null;
}

export interface RawVideoOptions {readonly encoder: string; readonly output: string; readonly width: number; readonly height: number; readonly fps: number; readonly bitrate: number}

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
  frames = 0;
  constructor(private readonly options: RawVideoOptions) {
    this.process = spawn(options.encoder, ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${options.width}x${options.height}`, "-framerate", String(options.fps), "-i", "pipe:0", "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-row-mt", "1", "-threads", "4", "-deadline", "good", "-cpu-used", "4", "-b:v", String(options.bitrate), "-f", "webm", options.output], {stdio: ["pipe", "pipe", "pipe"], windowsHide: true});
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
    if (!ArrayBuffer.isView(rgba) || rgba.BYTES_PER_ELEMENT !== 1 || rgba.byteLength !== this.options.width * this.options.height * 4) throw new Error("Invalid RGBA frame size");
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
      this.process.kill("SIGTERM");
    }
    await this.closed.catch(() => {});
  }
}
