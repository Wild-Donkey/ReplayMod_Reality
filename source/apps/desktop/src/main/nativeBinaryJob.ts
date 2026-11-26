import { spawn } from "node:child_process";
import { assertCanStartChild, trackChild } from "../../../../packages/media/src/childProcesses";

export function runNativeBinaryJob(executable: string, command: string, input: Buffer | string, options: {
  maxBytes: number;
  exactBytes?: number;
  unsupportedCode?: number;
  signal?: AbortSignal;
}): Promise<Buffer | null> {
  assertCanStartChild();
  options.signal?.throwIfAborted();
  const output = options.exactBytes === undefined ? undefined : Buffer.allocUnsafe(options.exactBytes);
  const child = trackChild(spawn(executable, [command], {
    stdio: ["pipe", "pipe", "ignore"], windowsHide: true, timeout: 60_000, killSignal: "SIGKILL",
    signal: options.signal,
  }));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let failure: Error | undefined;
    const fail = (error: Error) => {
      failure ??= error;
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    child.on("error", fail);
    child.stdout.on("error", fail);
    // A process can report an unsupported request and exit before reading the
    // rest of stdin. The exit status below still determines that outcome.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") fail(error);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      if (received + chunk.length > options.maxBytes) {
        fail(new Error(`Native job ${command} exceeded the protocol limit`));
        return;
      }
      if (output) chunk.copy(output, received);
      else chunks.push(chunk);
      received += chunk.length;
    });
    child.once("close", (code, signal) => {
      if (failure) reject(failure);
      else if (code === options.unsupportedCode && received === 0) resolve(null);
      else if (code === 0 && (output === undefined || received === output.length)) resolve(output ?? Buffer.concat(chunks, received));
      else reject(new Error(`Native job ${command} exited (${signal ?? code}, ${received} bytes)`));
    });
    child.stdin.end(input);
  });
}
