import type { OfflineFramePlan } from "../../../shared/overlayExport";
import type { ReplayClock } from "../ReplayClock";

export interface OfflineFrameWork {
  readonly segment: number;
  readonly index: number;
  readonly frame: number;
  readonly timestamp: number;
  readonly progress: number;
}
export async function renderOfflineFrames(plan: OfflineFramePlan, clock: ReplayClock, signal: AbortSignal, tasks: {
  render(frame: OfflineFrameWork): Promise<void>;
  encode(frame: OfflineFrameWork): Promise<void>;
  finishSegment(segment: number): Promise<void>;
  progress?(progress: number): void;
}) {
  const active = () => { if (signal.aborted) throw signal.reason ?? new Error("Export was cancelled"); };
  for (let segment = 0; segment < plan.segmentCount; segment++) {
    for (let index = 0; index < plan.segmentFrames(segment); index++) {
      active();
      const work = {segment, index, ...plan.frame(segment, index)};
      clock.step(work.timestamp, work.frame);
      await tasks.render(work);
      active();
      await tasks.encode(work);
      active();
      tasks.progress?.(work.progress);
    }
    active();
    await tasks.finishSegment(segment);
  }
  active();
}
