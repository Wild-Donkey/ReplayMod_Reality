import path from "node:path";
import type { PointDataset } from "../../../../packages/data/src";
import { runNativeBinaryJob } from "./nativeBinaryJob";

const HEADER_BYTES = 80;
const POINT_BYTES = 32;
const MAX_OUTPUT_BYTES = HEADER_BYTES + 2_000_000 * POINT_BYTES;

export async function readNativeLocationCsv(executable: string, filename: string, photoFilename: string | null = null): Promise<PointDataset | null> {
  if (filename.includes("\n") || photoFilename?.includes("\n")) return null;
  const result = await runNativeBinaryJob(executable, "--import-location-csv", filename + "\n" + (photoFilename ?? "") + "\n", {
    maxBytes: MAX_OUTPUT_BYTES, unsupportedCode: 3,
  });
  if (!result) return null;
  if (result.length < HEADER_BYTES || result.toString("ascii", 0, 8) !== "RMRCSV02") {
    throw new Error("Invalid native CSV header");
  }
  const footprintPointCount = result.readDoubleLE(8), photoPointCount = result.readDoubleLE(16);
  const count = footprintPointCount + photoPointCount, skippedRowCount = result.readDoubleLE(24);
  if (!Number.isSafeInteger(footprintPointCount) || footprintPointCount < 0 ||
      !Number.isSafeInteger(photoPointCount) || photoPointCount < 0 ||
      count < 1 || HEADER_BYTES + count * POINT_BYTES !== result.length ||
      !Number.isSafeInteger(skippedRowCount) || skippedRowCount < 0) {
    throw new Error("Invalid native CSV length");
  }
  const readColumns = (length: number, start: number) => {
    const timestamps = new Float64Array(length), coordinates = new Float64Array(2 * length);
    for (let i = 0, offset = HEADER_BYTES + start * POINT_BYTES; i < length; i++, offset += POINT_BYTES) {
      timestamps[i] = result.readDoubleLE(offset);
      coordinates[2 * i] = result.readDoubleLE(offset + 8);
      coordinates[2 * i + 1] = result.readDoubleLE(offset + 16);
    }
    return { timestamps, coordinates };
  };
  const footprint = readColumns(footprintPointCount, 0);
  const photo = readColumns(photoPointCount, footprintPointCount);
  const mixed = footprintPointCount > 0 && photoPointCount > 0;
  const timelineCoordinates = mixed ? new Float64Array(2 * count) : (footprintPointCount ? footprint : photo).coordinates;
  const timelineTimestamps = mixed ? new Float64Array(count) : (footprintPointCount ? footprint : photo).timestamps;
  const timelineAltitudes = new Float64Array(count);
  let groundIndex = 0, photoIndex = 0;
  for (let i = 0; i < count; i++) {
    const takeGround = groundIndex < footprintPointCount &&
      (photoIndex >= photoPointCount || footprint.timestamps[groundIndex] <= photo.timestamps[photoIndex]);
    const index = takeGround ? groundIndex++ : photoIndex++;
    const series = takeGround ? footprint : photo;
    const row = takeGround ? index : footprintPointCount + index;
    if (mixed) {
      timelineTimestamps[i] = series.timestamps[index];
      timelineCoordinates[2 * i] = series.coordinates[2 * index];
      timelineCoordinates[2 * i + 1] = series.coordinates[2 * index + 1];
    }
    timelineAltitudes[i] = result.readDoubleLE(HEADER_BYTES + row * POINT_BYTES + 24);
  }
  return {
    sourceName: photoFilename ? `${path.basename(filename)} + ${path.basename(photoFilename)}` : path.basename(filename),
    footprintCoordinates: footprint.coordinates,
    footprintTimestamps: footprint.timestamps,
    photoCoordinates: photo.coordinates,
    photoTimestamps: photo.timestamps,
    timelineCoordinates,
    timelineTimestamps,
    timelineAltitudes,
    pointCount: count,
    footprintPointCount,
    photoPointCount,
    skippedRowCount,
    bounds: [32, 40, 48, 56].map(offset => result.readDoubleLE(offset)) as [number, number, number, number],
    timeBounds: [result.readDoubleLE(64), result.readDoubleLE(72)],
  };
}
