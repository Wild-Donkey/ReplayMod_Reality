import type { OfflineFramePlan } from "../../../shared/overlayExport";
import type { ReplayClock } from "../ReplayClock";

export interface OfflineFrameWork {
  readonly segment: number;
  readonly index: number;
  readonly frame: number;
  readonly timestamp: number;
  readonly progress: number;
}
export async function renderOfflineFrames<Pixels>(plan: OfflineFramePlan, clock: ReplayClock, signal: AbortSignal, tasks: {
  render(frame: OfflineFrameWork): Promise<Pixels>;
  encode(frame: OfflineFrameWork, pixels: Pixels): Promise<void>;
  finishSegment(segment: number): Promise<void>;
  progress?(progress: number): void;
}) {
  const active = () => { if (signal.aborted) throw signal.reason ?? new Error("Export was cancelled"); };
  for (let segment = 0; segment < plan.segmentCount; segment++) {
    let pending: Promise<void> | undefined;
    for (let index = 0; index < plan.segmentFrames(segment); index++) {
      active();
      const work = {segment, index, ...plan.frame(segment, index)};
      clock.step(work.timestamp, work.frame);
      const pixels = await tasks.render(work);
      active();
      if (pending) await pending;
      active();
      // Keep one encoder write in flight while producing the next frame.
      pending = tasks.encode(work, pixels).then(() => {
        active();
        tasks.progress?.(work.progress);
      });
      void pending.catch(() => {});
    }
    if (pending) await pending;
    active();
    await tasks.finishSegment(segment);
  }
  active();
}
