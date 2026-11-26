import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const REQUEST_TIMEOUT_MS = 2000;
const SHUTDOWN_TIMEOUT_MS = 1000;

export class NativeCore {
  private child?: ChildProcessWithoutNullStreams;
  private exited?: Promise<void>;
  private probe?: Promise<void>;
  private closing = false;
  private response?: { resolve: () => void; reject: (error: Error) => void; expected: string };
  private buffer = "";

  constructor(private readonly executable: string) {}

  ping(): Promise<void> {
    if (this.closing) return Promise.reject(new Error("Native core is closing"));
    return this.probe ??= this.probeCore().finally(() => { this.probe = undefined; });
  }

  private async probeCore() {
    try {
      if (!this.child) {
        this.start();
        await this.exchange("hello 1", "ready 1");
      }
      await this.exchange("ping", "pong");
    } catch (error) {
      this.forceClose();
      await this.exited;
      throw error;
    }
  }

  private start() {
    const child = spawn(this.executable, [], { windowsHide: true });
    this.child = child;
    this.buffer = "";
    this.exited = new Promise(resolve => {
      child.once("close", (code, signal) => {
        this.response?.reject(new Error(`Native core exited (${signal ?? code})`));
        this.child = undefined;
        resolve();
      });
    });
    const fail = (error: Error) => this.response?.reject(error);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stderr.resume();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (!this.response) { this.forceClose(); return; }
      this.buffer += chunk;
      if (this.buffer.length > 128) {
        fail(new Error("Native core response exceeded the protocol limit"));
      } else if (this.buffer.includes("\n")) {
        if (this.buffer.replace(/\r?\n$/, "") === this.response.expected) this.response.resolve();
        else fail(new Error(`Unexpected native core response: ${JSON.stringify(this.buffer)}`));
      }
    });
  }

  private exchange(command: string, expected: string) {
    const child = this.child;
    if (this.closing || !child) return Promise.reject(new Error("Native core is unavailable"));
    let timer: ReturnType<typeof setTimeout>;
    return new Promise<void>((resolve, reject) => {
      this.buffer = "";
      this.response = { resolve, reject, expected };
      timer = setTimeout(() => reject(new Error(`Native core timed out on ${command}`)), REQUEST_TIMEOUT_MS);
      child.stdin.write(command + "\n");
    }).finally(() => {
      clearTimeout(timer);
      this.response = undefined;
    });
  }

  async close() {
    this.closing = true;
    if (!this.child) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.forceClose(), SHUTDOWN_TIMEOUT_MS);
    try { await this.exited; }
    finally { clearTimeout(timer); }
  }

  forceClose() {
    this.child?.kill("SIGKILL");
  }
}
