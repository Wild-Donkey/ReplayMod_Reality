import type { PointDataset } from "../../../../../../packages/data/src";
import type { SpeedCurveQuery, SpeedCurveReply } from "./speedCurveWorker";

type Request = {
  dataset: PointDataset;
  start: number;
  end: number;
  count: number;
  complete: (values?: Float64Array) => void;
};

export class SpeedCurveClient {
  private worker: Worker | undefined;
  private previousDataset: PointDataset | undefined;
  private running: Request | undefined;
  private queued: Request | undefined;
  private requestId = 0;

  constructor() {
    try {
      const worker = new Worker(new URL("./speedCurveWorker.ts", import.meta.url), { type: "module" });
      this.worker = worker;
      worker.onmessage = ({ data }: MessageEvent<SpeedCurveReply>) => {
        if (data.id !== this.requestId) return;
        const running = this.running;
        this.running = undefined;
        const next = this.queued;
        this.queued = undefined;
        if (next) this.request(next);
        else running?.complete("values" in data ? data.values : undefined);
      };
      worker.onerror = () => this.fail();
      worker.onmessageerror = () => this.fail();
    } catch {
      this.worker = undefined;
    }
  }

  request(request: Request) {
    if (!this.worker) { request.complete(); return; }
    if (this.running) { this.queued = request; return; }
    this.running = request;
    const { dataset, start, end, count } = request;
    const query: SpeedCurveQuery = { id: ++this.requestId, start, end, count };
    const transfer: ArrayBuffer[] = [];
    const copy = (samples: Pick<PointDataset, "footprintTimestamps" | "footprintCoordinates">) => {
      const footprintTimestamps = Float64Array.from(samples.footprintTimestamps);
      const footprintCoordinates = Float64Array.from(samples.footprintCoordinates);
      transfer.push(footprintTimestamps.buffer, footprintCoordinates.buffer);
      return { footprintTimestamps, footprintCoordinates };
    };
    try {
      if (dataset.footprintTimestamps !== this.previousDataset?.footprintTimestamps ||
          dataset.footprintCoordinates !== this.previousDataset?.footprintCoordinates) query.raw = copy(dataset);
      const processed = dataset.processedMotion;
      if (processed !== this.previousDataset?.processedMotion) {
        query.processed = processed ? { ...copy(processed), timeBounds: processed.timeBounds } : null;
      }
      this.worker.postMessage(query, transfer);
      this.previousDataset = dataset;
    } catch {
      this.fail();
    }
  }

  close() {
    this.worker?.terminate();
    this.worker = undefined;
    this.running = this.queued = undefined;
    this.previousDataset = undefined;
  }

  private fail() {
    const latest = this.queued ?? this.running;
    this.close();
    latest?.complete();
  }
}
