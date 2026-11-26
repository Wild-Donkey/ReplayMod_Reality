import { smoothSpeedCurve, type MetricDataset } from "./metrics";

type RawSamples = Pick<MetricDataset, "footprintTimestamps" | "footprintCoordinates">;
export type SpeedCurveQuery = {
  id: number;
  start: number;
  end: number;
  count: number;
  raw?: RawSamples;
  processed?: MetricDataset["processedMotion"] | null;
};
export type SpeedCurveReply = { id: number; values: Float64Array<ArrayBuffer> } | { id: number; error: string };

let dataset: MetricDataset | undefined;
self.addEventListener("message", ({ data: request }: MessageEvent<SpeedCurveQuery>) => {
  try {
    if (request.raw || request.processed !== undefined) {
      const raw = request.raw ?? dataset;
      if (!raw) throw new Error("Missing trajectory samples");
      dataset = {
        footprintTimestamps: raw.footprintTimestamps,
        footprintCoordinates: raw.footprintCoordinates,
        processedMotion: request.processed === null ? undefined : request.processed ?? dataset?.processedMotion,
      };
    }
    if (!dataset) throw new Error("Missing trajectory samples");
    const curve = smoothSpeedCurve(dataset, request.start, request.end, request.count);
    const values = Float64Array.from(curve, ([, value]) => value ?? Number.NaN);
    self.postMessage({ id: request.id, values } satisfies SpeedCurveReply, { transfer: [values.buffer] });
  } catch (error) {
    self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies SpeedCurveReply);
  }
});
