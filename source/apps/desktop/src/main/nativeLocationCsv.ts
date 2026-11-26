import path from "node:path";
import type { PointDataset } from "../../../../packages/data/src";
import { runNativeBinaryJob } from "./nativeBinaryJob";

const HEADER_BYTES = 72;
const POINT_BYTES = 32;
const MAX_OUTPUT_BYTES = HEADER_BYTES + 2_000_000 * POINT_BYTES;

export async function readNativeLocationCsv(executable: string, filename: string): Promise<PointDataset | null> {
  if (filename.includes("\n")) return null;
  const result = await runNativeBinaryJob(executable, "--import-location-csv", filename + "\n", {
    maxBytes: MAX_OUTPUT_BYTES, unsupportedCode: 3,
  });
  if (!result) return null;
  if (result.length < HEADER_BYTES || result.toString("ascii", 0, 8) !== "RMRCSV01") {
    throw new Error("Invalid native CSV header");
  }
  const count = result.readDoubleLE(8), skippedRowCount = result.readDoubleLE(16);
  if (!Number.isSafeInteger(count) || count < 1 || HEADER_BYTES + count * POINT_BYTES !== result.length ||
      !Number.isSafeInteger(skippedRowCount) || skippedRowCount < 0) {
    throw new Error("Invalid native CSV length");
  }
  const timestamps = new Array<number>(count), coordinates = new Array<number>(2 * count);
  const altitudes = new Array<number>(count);
  for (let i = 0, offset = HEADER_BYTES; i < count; i++, offset += POINT_BYTES) {
    timestamps[i] = result.readDoubleLE(offset);
    coordinates[2 * i] = result.readDoubleLE(offset + 8);
    coordinates[2 * i + 1] = result.readDoubleLE(offset + 16);
    altitudes[i] = result.readDoubleLE(offset + 24);
  }
  return {
    sourceName: path.basename(filename),
    footprintCoordinates: coordinates,
    footprintTimestamps: timestamps,
    photoCoordinates: [],
    photoTimestamps: [],
    timelineCoordinates: coordinates,
    timelineTimestamps: timestamps,
    timelineAltitudes: altitudes,
    pointCount: count,
    footprintPointCount: count,
    photoPointCount: 0,
    skippedRowCount,
    bounds: [24, 32, 40, 48].map(offset => result.readDoubleLE(offset)) as [number, number, number, number],
    timeBounds: [result.readDoubleLE(56), result.readDoubleLE(64)],
  };
}
