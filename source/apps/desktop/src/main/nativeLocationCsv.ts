import { spawn } from "node:child_process";
import path from "node:path";
import { assertCanStartChild, trackChild } from "../../../../packages/media/src/childProcesses";
import type { PointDataset } from "../../../../packages/data/src";

const HEADER_BYTES = 72;
const POINT_BYTES = 32;
const MAX_OUTPUT_BYTES = HEADER_BYTES + 2_000_000 * POINT_BYTES;

export async function readNativeLocationCsv(executable: string, filename: string): Promise<PointDataset | null> {
  if (filename.includes("\n")) return null;
  assertCanStartChild();
  const child = trackChild(spawn(executable, ["--import-location-csv"], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    timeout: 60_000,
    killSignal: "SIGKILL",
  }));
  const result = await new Promise<Buffer | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let oversized = false;
    child.on("error", reject);
    child.stdout.on("error", reject);
    child.stdin.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= MAX_OUTPUT_BYTES) chunks.push(chunk);
      else if (!oversized) {
        oversized = true;
        child.kill("SIGKILL");
      }
    });
    child.once("close", (code, signal) => {
      if (oversized) reject(new Error("Native CSV output exceeded the protocol limit"));
      else if (code === 3 && bytes === 0) resolve(null);
      else if (code === 0) resolve(Buffer.concat(chunks, bytes));
      else reject(new Error(`Native CSV import exited (${signal ?? code})`));
    });
    child.stdin.end(filename + "\n", "utf8");
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
