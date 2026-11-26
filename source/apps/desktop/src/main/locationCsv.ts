import { createReadStream } from "node:fs";
import path from "node:path";
import { compose } from "node:stream";
import { parse } from "csv-parse";
import type { CoordinateBounds, PointDataset, TimeBounds } from "../../../../packages/data/src";
import type { NumericColumn } from "../../../../packages/data/src/points";

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
  const pointCount = footprintPoints.length + photoPoints.length;

  if (pointCount === 0) {
    throw new Error("CSV 中没有找到有效的 longitude / latitude 坐标。");
  }

  const bounds: CoordinateBounds = [west, south, east, north];
  const timeBounds: TimeBounds = [startTime, endTime];
  footprintPoints.sort((left, right) => left.timestamp - right.timestamp);
  photoPoints.sort((left, right) => left.timestamp - right.timestamp);

  const { coordinates: footprintCoordinates, timestamps: footprintTimestamps } = pointColumns(footprintPoints);
  const { coordinates: photoCoordinates, timestamps: photoTimestamps } = pointColumns(photoPoints);
  const hasBoth = footprintPoints.length > 0 && photoPoints.length > 0;
  const timelineCoordinates = hasBoth ? new Float64Array(pointCount * 2)
    : photoPoints.length ? photoCoordinates : footprintCoordinates;
  const timelineTimestamps = hasBoth ? new Float64Array(pointCount)
    : photoPoints.length ? photoTimestamps : footprintTimestamps;
  const timelineAltitudes = new Float64Array(pointCount);
  // Merge the two sorted streams. A tie keeps footprint points first, as in
  // the previous stable sort of their concatenation.
  let footprint = 0;
  let photo = 0;
  for (let index = 0; index < pointCount; index++) {
    const nextFootprint = footprintPoints[footprint];
    const nextPhoto = photoPoints[photo];
    const point = nextFootprint && (!nextPhoto || nextFootprint.timestamp <= nextPhoto.timestamp)
      ? footprintPoints[footprint++] : photoPoints[photo++];
    if (hasBoth) {
      timelineCoordinates[index * 2] = point.longitude;
      timelineCoordinates[index * 2 + 1] = point.latitude;
      timelineTimestamps[index] = point.timestamp;
    }
    timelineAltitudes[index] = point.altitude;
  }

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

function pointColumns(points: readonly TimedCoordinate[]) {
  const coordinates = new Float64Array(points.length * 2);
  const timestamps = new Float64Array(points.length);
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    coordinates[index * 2] = point.longitude;
    coordinates[index * 2 + 1] = point.latitude;
    timestamps[index] = point.timestamp;
  }
  return { coordinates, timestamps };
}

export function restorePointColumns(dataset: PointDataset): PointDataset {
  const converted = new Map<NumericColumn, Float64Array>();
  const column = (source: NumericColumn) => {
    if (source instanceof Float64Array) return source;
    const previous = converted.get(source);
    if (previous) return previous;
    const values = Float64Array.from(source);
    converted.set(source, values);
    return values;
  };
  return {
    ...dataset,
    footprintCoordinates: column(dataset.footprintCoordinates),
    footprintTimestamps: column(dataset.footprintTimestamps),
    photoCoordinates: column(dataset.photoCoordinates),
    photoTimestamps: column(dataset.photoTimestamps),
    timelineCoordinates: column(dataset.timelineCoordinates),
    timelineTimestamps: column(dataset.timelineTimestamps),
    timelineAltitudes: column(dataset.timelineAltitudes),
  };
}
