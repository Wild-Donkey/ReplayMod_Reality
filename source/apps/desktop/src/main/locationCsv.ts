import { createReadStream } from "node:fs";
import path from "node:path";
import { compose } from "node:stream";
import { parse } from "csv-parse";
import type { CoordinateBounds, PointDataset, TimeBounds } from "../../../../packages/data/src";

interface TimedCoordinate {
  readonly timestamp: number;
  readonly longitude: number;
  readonly latitude: number;
  readonly altitude: number;
}

const pointKey = (point: TimedCoordinate) =>
  `${point.timestamp}|${point.longitude.toFixed(6)}|${point.latitude.toFixed(6)}`;

export async function readLocationCsv(mainFilePath: string, photoFilePath: string | null): Promise<PointDataset> {
  const footprintPoints: TimedCoordinate[] = [];
  const photoPointsByKey = new Map<string, TimedCoordinate>();
  let skippedRowCount = 0;
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let startTime = Number.POSITIVE_INFINITY;
  let endTime = Number.NEGATIVE_INFINITY;

  const readFile = async (filePath: string, forcePhoto: boolean) => {
    const records = compose(createReadStream(filePath),
      parse({
        bom: true,
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }),
    );

    for await (const rawRecord of records) {
      const record = rawRecord as Record<string, string>;
      const longitude = Number(record.longitude);
      const latitude = Number(record.latitude);
      const stepType = Number(record.stepType);
      const timestamp = Number(record.dataTime) * 1000;
      const rawAccuracy = record.accuracy?.trim() ?? "";
      const accuracy = Number(rawAccuracy);

      if (
        !Number.isFinite(longitude) ||
        !Number.isFinite(latitude) ||
        longitude < -180 ||
        longitude > 180 ||
        latitude < -90 ||
        latitude > 90 ||
        record.dataTime.trim() === "" ||
        !Number.isFinite(timestamp)
      ) {
        skippedRowCount += 1;
        continue;
      }
      // accuracy 是水平定位误差（米）；大于 100 m 的点不进入显示与识别时间线。
      // 缺失、0 或负值是不同数据源的“未知”哨兵值，不因此删除。
      if (rawAccuracy !== "" && Number.isFinite(accuracy) && accuracy > 100) {
        skippedRowCount += 1;
        continue;
      }

      const rawAltitude =
        record.altitude ?? record.elevation ?? record.height ?? record.alt ?? "";
      const parsedAltitude = Number(rawAltitude);
      const point = {
        timestamp,
        longitude,
        latitude,
        altitude:
          rawAltitude.trim() !== "" && Number.isFinite(parsedAltitude)
            ? parsedAltitude
            : Number.NaN,
      };

      if (forcePhoto || stepType === 1) {
        photoPointsByKey.set(pointKey(point), point);
      } else {
        footprintPoints.push(point);
      }

      west = Math.min(west, longitude);
      south = Math.min(south, latitude);
      east = Math.max(east, longitude);
      north = Math.max(north, latitude);
      startTime = Math.min(startTime, timestamp);
      endTime = Math.max(endTime, timestamp);
    }
  };

  await readFile(mainFilePath, false);

  if (photoFilePath) {
    await readFile(photoFilePath, true);
  }

  const photoPoints = [...photoPointsByKey.values()];
  const timelinePoints = [...footprintPoints, ...photoPoints];

  const pointCount = footprintPoints.length + photoPoints.length;

  if (pointCount === 0) {
    throw new Error("CSV 中没有找到有效的 longitude / latitude 坐标。");
  }

  const bounds: CoordinateBounds = [west, south, east, north];
  const timeBounds: TimeBounds = [startTime, endTime];
  footprintPoints.sort((left, right) => left.timestamp - right.timestamp);
  photoPoints.sort((left, right) => left.timestamp - right.timestamp);
  timelinePoints.sort((left, right) => left.timestamp - right.timestamp);

  const footprintCoordinates = footprintPoints.flatMap((point) => [
    point.longitude,
    point.latitude,
  ]);
  const photoCoordinates = photoPoints.flatMap((point) => [
    point.longitude,
    point.latitude,
  ]);
  const footprintTimestamps = footprintPoints.map((point) => point.timestamp);
  const photoTimestamps = photoPoints.map((point) => point.timestamp);
  const timelineCoordinates = timelinePoints.flatMap((point) => [
    point.longitude,
    point.latitude,
  ]);
  const timelineTimestamps = timelinePoints.map((point) => point.timestamp);
  const timelineAltitudes = timelinePoints.map((point) => point.altitude);

  return {
    sourceName: photoFilePath
      ? `${path.basename(mainFilePath)} + ${path.basename(photoFilePath)}`
      : path.basename(mainFilePath),
    footprintCoordinates,
    photoCoordinates,
    footprintTimestamps,
    photoTimestamps,
    timelineCoordinates,
    timelineTimestamps,
    timelineAltitudes,
    pointCount,
    footprintPointCount: footprintPoints.length,
    photoPointCount: photoPoints.length,
    skippedRowCount,
    bounds,
    timeBounds,
  };
}
