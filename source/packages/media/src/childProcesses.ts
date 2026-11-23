import { execFile, type ChildProcess, type ExecFileOptions } from "node:child_process";
import { setTimeout, clearTimeout } from "node:timers";
import { promisify } from "node:util";

const exec = promisify(execFile);
const children = new Map<ChildProcess, Promise<void>>();
const stopping = new WeakMap<ChildProcess, Promise<void>>();
let shuttingDown = false;

export function assertCanStartChild() {
  if (shuttingDown) throw new Error("应用正在退出。");
}

export function trackChild<T extends ChildProcess>(child: T): T {
  const closed = new Promise<void>(resolve => child.once("close", () => {
    children.delete(child);
    resolve();
  }));
  children.set(child, closed);
  return child;
}

export function runChild(file: string, args: string[], options: ExecFileOptions) {
  assertCanStartChild();
  const result = exec(file, args, {windowsHide: true, ...options, encoding: "utf8"});
  trackChild(result.child);
  return result;
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid && child.exitCode === null && child.signalCode === null) child.kill(signal);
}

export function stopChild(child: ChildProcess): Promise<void> {
  const closed = children.get(child);
  if (!closed) return Promise.resolve();
  const existing = stopping.get(child);
  if (existing) return existing;
  const deadline = setTimeout(() => signalChild(child, "SIGKILL"), 1500);
  const stopped = closed.finally(() => clearTimeout(deadline));
  stopping.set(child, stopped);
  signalChild(child, "SIGTERM");
  return stopped;
}

export function stopChildren() {
  shuttingDown = true;
  return Promise.all([...children.keys()].map(stopChild));
}

export function killChildren() {
  for (const child of children.keys()) signalChild(child, "SIGKILL");
}
