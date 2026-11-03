import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OrientationSample } from "./types";

const execFileAsync = promisify(execFile);

export const extractDjiOrientation = async (
  inputPath: string,
  exiftoolPath = "exiftool",
): Promise<OrientationSample[]> => {
  const { stdout } = await execFileAsync(exiftoolPath, [
    "-ee", "-j", "-G3:1", "-n", "-api", "LargeFileSupport=1",
    "-Quaternion1", "-Quaternion2", "-Quaternion3", "-Quaternion4",
    "-SampleTime", "-SampleDuration", inputPath,
  ], { maxBuffer: 64 * 1024 * 1024 });
  const document = (JSON.parse(stdout) as Record<string, unknown>[])[0];
  const grouped = new Map<number, Record<string, number>>();

  for (const [key, value] of Object.entries(document)) {
    const match = /^Doc(\d+):[^:]+:(Quaternion[1-4]|SampleTime|SampleDuration)$/.exec(key);
    if (!match) continue;
    const numericValue = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numericValue)) continue;
    const index = Number(match[1]);
    grouped.set(index, { ...grouped.get(index), [match[2]]: numericValue });
  }

  let fallbackTime = 0;
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, values]) => {
      const timeSeconds = values.SampleTime ?? fallbackTime;
      fallbackTime = timeSeconds + (values.SampleDuration ?? 0);
      return {
        timeSeconds,
        quaternion: [
          values.Quaternion1,
          values.Quaternion2,
          values.Quaternion3,
          values.Quaternion4,
        ] as const,
      };
    })
    .filter((sample) => sample.quaternion.every(Number.isFinite));
};
