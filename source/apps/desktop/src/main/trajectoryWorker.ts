import { parentPort } from "node:worker_threads";
import { extractDjiOrientation } from "../../../../packages/media/src/dji";
import { stopChildren } from "../../../../packages/media/src/childProcesses";
import { fitMotionTrajectory } from "../../../../packages/media/src/trajectory-fit";
import type { MotionGpsRequest, MotionGpsResult } from "../shared/mediaAlignment";

export interface TrajectoryWorkerInput {
  sourcePath: string;
  revision: string;
  exiftool: string;
  points: MotionGpsRequest["points"];
  start: number;
  end: number;
}
export type TrajectoryWorkerOutput = {result: MotionGpsResult} | {error: string};

const port = parentPort;
let orientation: {revision: string; samples: Awaited<ReturnType<typeof extractDjiOrientation>>} | undefined;
let shuttingDown = false;
port?.on("message", async (input: TrajectoryWorkerInput | {shutdown: true}) => {
  if (shuttingDown) return;
  if ("shutdown" in input) {
    shuttingDown = true;
    try { await stopChildren(); }
    finally { port.close(); }
    return;
  }
  try {
    let samples = orientation?.revision === input.revision ? orientation.samples : undefined;
    if (!samples) {
      samples = await extractDjiOrientation(input.sourcePath, input.exiftool).catch(() => undefined);
      if (shuttingDown) return;
      if (samples) orientation = {revision: input.revision, samples};
    }
    const result = fitMotionTrajectory(samples ?? [], input.points, input.start, input.end);
    port.postMessage({result} satisfies TrajectoryWorkerOutput);
  } catch (error) {
    port.postMessage({error: error instanceof Error ? error.message : String(error)} satisfies TrajectoryWorkerOutput);
  }
});
