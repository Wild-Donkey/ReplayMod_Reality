import { parentPort, workerData } from "node:worker_threads";
import { extractDjiOrientation } from "../../../../packages/media/src/dji";
import { stopChildren } from "../../../../packages/media/src/childProcesses";
import { fitMotionTrajectory } from "../../../../packages/media/src/trajectory-fit";
import type { MotionGpsRequest } from "../shared/mediaAlignment";
import { packMotionGpsResult, type PackedMotionGpsResult } from "../shared/motionGpsWire";
import { fitNativeTrajectory } from "./nativeTrajectoryFit";
import type { NativeJobProgress } from "./nativeBinaryJob";
import { shouldFitNatively, type TrajectoryBackendConfig } from "./trajectoryBackend";

export interface TrajectoryWorkerInput {
  sourcePath: string;
  revision: string;
  exiftool: string;
  points: MotionGpsRequest["points"];
  start: number;
  end: number;
}
export type TrajectoryWorkerOutput = {result: PackedMotionGpsResult} | {error: string} | {progress: NativeJobProgress};

const port = parentPort;
const backend = workerData as TrajectoryBackendConfig | undefined;
let orientation: {revision: string; samples: Awaited<ReturnType<typeof extractDjiOrientation>>} | undefined;
let shuttingDown = false;
let active: AbortController | undefined;
port?.on("message", async (input: TrajectoryWorkerInput | {shutdown: true} | {cancel: true}) => {
  if (shuttingDown) return;
  if ("cancel" in input) {
    active?.abort();
    return;
  }
  if ("shutdown" in input) {
    shuttingDown = true;
    active?.abort();
    try { await stopChildren(); }
    finally { port.close(); }
    return;
  }
  const controller = new AbortController();
  active = controller;
  try {
    let samples = orientation?.revision === input.revision ? orientation.samples : undefined;
    if (!samples) {
      samples = await extractDjiOrientation(input.sourcePath, input.exiftool).catch(() => undefined);
      if (shuttingDown) return;
      if (samples) orientation = {revision: input.revision, samples};
    }
    controller.signal.throwIfAborted();
    const rate = 10;
    const packed = backend && shouldFitNatively(backend.mode, input.end - input.start, rate, samples?.length ?? 0)
      ? await fitNativeTrajectory(backend.executable, samples ?? [], input.points, input.start, input.end, rate, controller.signal,
        progress => port.postMessage({progress} satisfies TrajectoryWorkerOutput)).catch(error => {
        if (controller.signal.aborted) throw error;
        console.warn("Native trajectory fit failed", error);
        return packMotionGpsResult(fitMotionTrajectory(samples ?? [], input.points, input.start, input.end));
      })
      : packMotionGpsResult(fitMotionTrajectory(samples ?? [], input.points, input.start, input.end));
    if (shuttingDown) return;
    controller.signal.throwIfAborted();
    port.postMessage({result: packed} satisfies TrajectoryWorkerOutput, [packed.pointData.buffer, packed.altitudePresent.buffer]);
  } catch (error) {
    if (!shuttingDown) port.postMessage({error: error instanceof Error ? error.message : String(error)} satisfies TrajectoryWorkerOutput);
  } finally {
    active = undefined;
  }
});
