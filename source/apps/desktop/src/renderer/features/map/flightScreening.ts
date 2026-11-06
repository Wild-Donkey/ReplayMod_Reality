import type { MapCoordinate, PointDataset } from "../../../../../../packages/data/src";
import { sampleGroundElevations } from "./elevation";
import {
  DEFAULT_FLIGHT_THRESHOLD_METERS,
  detectFlight,
  type FlightDetectionResult,
} from "./flightDetection";
import type { FlightScreeningCache } from "../../../shared/confirmedFlight";

export interface FlightScreeningOptions {
  readonly cache?: FlightScreeningCache | null;
  readonly onCheckpoint?: (cache: FlightScreeningCache) => Promise<void>;
  readonly onDayProgress?: (progress: { readonly day: string; readonly completed: number; readonly total: number }) => void;
}

export interface FlightScreeningRun {
  readonly detection: FlightDetectionResult;
  readonly cache: FlightScreeningCache;
  /** 旧候选航班在该时间之后由本次结果替换。 */
  readonly replaceFromTimestamp: number;
}

const localDay = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

/**
 * 对整条时间线执行“飞行点”筛查：采样每个打点正下方的 DEM 地面海拔，
 * 再按默认 100 m 离地阈值识别。显示层重构完成后可直接消费返回结果。
 *
 * 注意：打点 GPS 海拔多为 WGS84 椭球高，而 terrain-rgb-v2 为 EGM96 正
 * （大地水准面）高，二者基准可能存在系统性偏差；100 m 阈值已远大于常
 * 规建筑高度与该基准差，故按业务规则直接比较，不做基准换算。
 */
export async function screenDatasetFlight(
  dataset: PointDataset,
  apiKey: string,
  signal: AbortSignal,
  thresholdMeters: number = DEFAULT_FLIGHT_THRESHOLD_METERS,
  options: FlightScreeningOptions = {},
): Promise<FlightScreeningRun> {
  const coordinates: MapCoordinate[] = [];
  for (let index = 0; index < dataset.timelineTimestamps.length; index += 1) {
    coordinates.push([
      dataset.timelineCoordinates[index * 2],
      dataset.timelineCoordinates[index * 2 + 1],
    ]);
  }
  const count = dataset.timelineTimestamps.length;
  const cached = options.cache;
  const cachedWatermarkIndex = cached
    ? dataset.timelineTimestamps.findIndex(timestamp => timestamp === cached.throughTimestamp)
    : -1;
  const cacheMatches = cached && cached.datasetStartTime === dataset.timelineTimestamps[0]
    && cachedWatermarkIndex >= 0 && cached.groundElevations.length === cachedWatermarkIndex + 1;
  // 调用方带着缓存来却没严格匹配（数据集换过、水位失效或高程长度不一致），
  // 必须显式报错让用户改用“全量重新识别”，绝不静默退化为全量采样。
  if (cached && !cacheMatches) {
    throw new Error("识别缓存与当前轨迹数据不匹配，请使用“全量重新识别”。");
  }
  const groundElevations = new Float64Array(count);
  let startIndex = 0;
  if (cacheMatches) {
    groundElevations.set(cached.groundElevations);
    startIndex = cachedWatermarkIndex + 1;
  }
  const days: Array<{day:string;start:number;end:number}> = [];
  for (let cursor = 0; cursor < count;) {
    const day = localDay(dataset.timelineTimestamps[cursor]);
    let end = cursor + 1;
    while (end < count && localDay(dataset.timelineTimestamps[end]) === day) end += 1;
    days.push({day,start:cursor,end});
    cursor = end;
  }
  let completedDays = days.filter(day => day.end <= startIndex).length;
  options.onDayProgress?.({
    day: completedDays > 0 ? days[completedDays - 1].day : days[0]?.day ?? "",
    completed: completedDays,
    total: days.length,
  });
  for (const range of days) {
    if (range.end <= startIndex) continue;
    signal.throwIfAborted();
    const day = range.day;
    const endIndex = range.end;
    const sampled = await sampleGroundElevations(
      coordinates.slice(startIndex, endIndex),
      apiKey,
      signal,
    );
    groundElevations.set(sampled, startIndex);
    const checkpoint: FlightScreeningCache = {
      datasetStartTime: dataset.timelineTimestamps[0],
      pointCount: endIndex,
      throughTimestamp: dataset.timelineTimestamps[endIndex - 1],
      throughDay: day,
      updatedAt: new Date().toISOString(),
      groundElevations: Array.from(groundElevations.slice(0, endIndex)),
      candidates: cached?.candidates,
      candidateThroughTimestamp: cached?.candidateThroughTimestamp,
    };
    await options.onCheckpoint?.(checkpoint);
    startIndex = endIndex;
    completedDays += 1;
    options.onDayProgress?.({day,completed:completedDays,total:days.length});
  }
  signal.throwIfAborted();
  const watermark = cacheMatches && cached.candidates
    ? cached.candidateThroughTimestamp ?? cached.throughTimestamp
    : Number.NEGATIVE_INFINITY;
  const replaceFromTimestamp = Number.isFinite(watermark) ? watermark - 8 * 3600_000 : Number.NEGATIVE_INFINITY;
  let analysisStartIndex = 0;
  if (Number.isFinite(replaceFromTimestamp)) {
    analysisStartIndex = dataset.timelineTimestamps.findIndex(timestamp => timestamp >= replaceFromTimestamp);
    if (analysisStartIndex < 0) analysisStartIndex = count;
  }
  const detection = detectFlight(
    dataset.timelineCoordinates.slice(analysisStartIndex * 2),
    dataset.timelineTimestamps.slice(analysisStartIndex),
    dataset.timelineAltitudes.slice(analysisStartIndex),
    groundElevations.slice(analysisStartIndex),
    thresholdMeters,
  );
  const finalIndex = Math.max(0,count - 1);
  const finalCache: FlightScreeningCache = count === 0 ? {
    datasetStartTime: Number.NaN, pointCount: 0, throughTimestamp: Number.NaN,
    throughDay: "", updatedAt: new Date().toISOString(), groundElevations: [], candidates: cached?.candidates,
    candidateThroughTimestamp: cached?.candidateThroughTimestamp,
  } : {
    datasetStartTime: dataset.timelineTimestamps[0],
    pointCount: count,
    throughTimestamp: dataset.timelineTimestamps[finalIndex],
    throughDay: localDay(dataset.timelineTimestamps[finalIndex]),
    updatedAt: new Date().toISOString(),
    groundElevations: Array.from(groundElevations),
    candidates: cached?.candidates,
    candidateThroughTimestamp: cached?.candidateThroughTimestamp,
  };
  return {detection,cache:finalCache,replaceFromTimestamp};
}
