import type { MapCoordinate, PointDataset } from "../../../../../../packages/data/src";

/**
 * 飞行点识别（与渲染、网络无关的纯逻辑）。
 *
 * 规则：打点（GPS）海拔比 DEM 地面海拔高出阈值（默认 100 m）即判定为
 * “飞起来”。建筑高度有意忽略——100 m 阈值远高于常规建筑，地面只取
 * 地形裸地高程。GPS 海拔或地面高程缺失（NaN）时该点不可判定，既不算
 * 飞行也不算地面，避免被误筛掉。
 */
export const DEFAULT_FLIGHT_THRESHOLD_METERS = 100;

/**
 * 相邻飞行点间隔不超过该时间（30 分钟）即归入同一趟飞行。巡航阶段手机
 * GPS 经常长时间无点（实测同一次航班可中断约 29 分钟），而两次航班之间
 * 至少以小时计，因此按时间间隙把飞行点聚类成一趟趟独立飞行，而不是把
 * 连续点串直接当航班。
 */
export const DEFAULT_TRIP_BRIDGE_GAP_MS = 30 * 60 * 1000;
export const DEFAULT_CRUISE_BRIDGE_GAP_MS = 90 * 60 * 1000;

export interface FlightSample {
  /** 时间线索引，与 PointDataset.timeline* 数组对齐。 */
  readonly index: number;
  readonly coordinate: MapCoordinate;
  readonly timestamp: number;
  /** 打点（GPS）海拔，NaN 表示原始数据缺失。 */
  readonly altitude: number;
  /** DEM 地面海拔，NaN 表示采样缺失。 */
  readonly groundElevation: number;
  /** altitude - groundElevation，任一缺失时为 NaN。 */
  readonly heightAboveGround: number;
  /** 两侧海拔均有效、可以判定。 */
  readonly resolvable: boolean;
  /** 可判定且离地高度严格大于阈值。 */
  readonly flying: boolean;
}

export interface FlightSegment {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly pointCount: number;
  readonly maxHeightAboveGround: number;
}

/**
 * 一趟独立飞行：飞行点按时间间隙聚类的结果（允许中间穿插不可判定点或
 * 短暂的低空点，如起飞爬升、进近下降穿过 100 m 阈值或巡航中 GPS 断档）。
 * 起止索引为该趟首、末飞行点，中间桥接进来的非飞行点不计入点数。
 */
export interface FlightTrip {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly flyingPointCount: number;
  /** 趟内飞行点的最大离地高度，用于区分真实巡航与地形/高架低空噪声。 */
  readonly maxHeightAboveGround: number;
  /** 趟内飞行点高度的 90 分位，避免单点 GPS 尖峰决定结果。 */
  readonly p90HeightAboveGround: number;
  /** 兼容旧缓存的高空点统计；仅供展示/诊断，不参与成航或分段判定。 */
  readonly cruisePointCount: number;
  /** 首末飞行点之间的大圆位移。 */
  readonly displacementKm: number;
  /** 相邻飞行点运动可能为真实航空运动的比例。 */
  readonly motionConsistency: number;
}

export interface FlightDetectionResult {
  readonly thresholdMeters: number;
  readonly totalCount: number;
  readonly resolvableCount: number;
  readonly flyingCount: number;
  /** 所有可判定点中的最大离地高度，没有可判定点时为 NaN。 */
  readonly peakHeightAboveGround: number;
  /** 与时间线逐点对齐的识别结果。 */
  readonly samples: readonly FlightSample[];
  readonly flyingIndexes: readonly number[];
  /** 连续飞行点合并出的原始区段，孤立高点也单独成段（未做时间桥接）。 */
  readonly segments: readonly FlightSegment[];
  /** 飞行点按时间间隙聚类出的一趟趟独立飞行（桥接巡航断档）。 */
  readonly trips: readonly FlightTrip[];
}

export function heightAboveGround(altitude: number, groundElevation: number): number {
  if (!Number.isFinite(altitude) || !Number.isFinite(groundElevation)) return Number.NaN;
  return altitude - groundElevation;
}

export function isFlyingHeight(heightAboveGround: number, thresholdMeters = DEFAULT_FLIGHT_THRESHOLD_METERS): boolean {
  return Number.isFinite(heightAboveGround)
    && Number.isFinite(thresholdMeters)
    && heightAboveGround > thresholdMeters;
}

/**
 * 依据打点海拔与同索引的地面海拔识别飞行点。
 *
 * @param coordinates 扁平 [lng, lat, ...] 时间线坐标，长度为 timestamps 的两倍
 * @param altitudes 打点 GPS 海拔，与 timestamps 对齐，NaN 表示缺失
 * @param groundElevations DEM 地面海拔，与 timestamps 对齐，NaN 表示缺失
 */
/**
 * 把飞行点按时间间隙聚类成一趟趟独立飞行。flyingIndexes 已按时间有序；
 * 与上一个飞行点的时间差不超过 bridgeGapMs 则归入同一趟（中间的不可判定
 * 点、短暂低空点都被桥接），否则另开一趟。
 */
interface TripBuilder {
  startIndex: number;
  endIndex: number;
  lastTimestamp: number;
  pointCount: number;
  maxHeight: number;
  indexes: number[];
}

const EARTH_RADIUS_KM = 6371;
const distanceKm = (a: MapCoordinate, b: MapCoordinate): number => {
  const rad = (value: number) => value * Math.PI / 180;
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const value = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(value));
};

const percentile = (values: readonly number[], ratio: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((sorted.length - 1) * ratio)];
};

export function clusterFlightTrips(
  samples: readonly FlightSample[],
  flyingIndexes: readonly number[],
  bridgeGapMs: number = DEFAULT_TRIP_BRIDGE_GAP_MS,
): FlightTrip[] {
  if (!(Number.isFinite(bridgeGapMs) && bridgeGapMs >= 0)) {
    throw new Error(`飞行趟次桥接间隙无效：${bridgeGapMs}`);
  }
  const builders: TripBuilder[] = [];
  let current: TripBuilder | null = null;
  for (const index of flyingIndexes) {
    const sample = samples[index];
    const gapMs = current ? sample.timestamp - current.lastTimestamp : Number.POSITIVE_INFINITY;
    let bridgeCruiseGap = false;
    if (current && bridgeGapMs === DEFAULT_TRIP_BRIDGE_GAP_MS
      && gapMs > bridgeGapMs && gapMs <= DEFAULT_CRUISE_BRIDGE_GAP_MS) {
      const previous = samples[current.endIndex];
      const speedKmh = distanceKm(previous.coordinate, sample.coordinate) / (gapMs / 3_600_000);
      const groundBetween = samples.slice(current.endIndex + 1, index)
        .filter(candidate => candidate.resolvable && !candidate.flying);
      const sustainedGround = groundBetween.length >= 2
        && groundBetween[groundBetween.length - 1].timestamp - groundBetween[0].timestamp >= 30 * 60 * 1000;
      // GPS 恢复后的首个点可能仍处于爬升阶段，甚至带有错误海拔；长断点
      // 是否属于同一程只看位移速度与其间是否存在持续接地证据。
      bridgeCruiseGap = speedKmh >= 80 && speedKmh <= 1300
        && !sustainedGround;
    }
    if (!current || (gapMs > bridgeGapMs && !bridgeCruiseGap)) {
      current = {
        startIndex: index,
        endIndex: index,
        lastTimestamp: sample.timestamp,
        pointCount: 0,
        maxHeight: Number.NaN,
        indexes: [],
      };
      builders.push(current);
    }
    current.endIndex = index;
    current.lastTimestamp = sample.timestamp;
    current.pointCount += 1;
    current.maxHeight = Number.isNaN(current.maxHeight)
      ? sample.heightAboveGround
      : Math.max(current.maxHeight, sample.heightAboveGround);
    current.indexes.push(index);
  }
  return builders.map(builder => {
    const heights = builder.indexes.map(index => samples[index].heightAboveGround);
    let plausibleEdges = 0;
    let measuredEdges = 0;
    for (let offset = 1; offset < builder.indexes.length; offset += 1) {
      const previous = samples[builder.indexes[offset - 1]];
      const next = samples[builder.indexes[offset]];
      const elapsedSeconds = (next.timestamp - previous.timestamp) / 1000;
      if (!(elapsedSeconds > 0)) continue;
      measuredEdges += 1;
      const speedKmh = distanceKm(previous.coordinate, next.coordinate) / elapsedSeconds * 3600;
      const verticalSpeed = Math.abs(next.heightAboveGround - previous.heightAboveGround) / elapsedSeconds;
      if (speedKmh <= 1300 && verticalSpeed <= 50) plausibleEdges += 1;
    }
    return {
      startIndex: builder.startIndex,
      endIndex: builder.endIndex,
      startTime: samples[builder.startIndex].timestamp,
      endTime: samples[builder.endIndex].timestamp,
      flyingPointCount: builder.pointCount,
      maxHeightAboveGround: builder.maxHeight,
      p90HeightAboveGround: percentile(heights, .9),
      cruisePointCount: heights.filter(height => height >= 2000).length,
      displacementKm: distanceKm(samples[builder.startIndex].coordinate, samples[builder.endIndex].coordinate),
      motionConsistency: measuredEdges === 0 ? 0 : plausibleEdges / measuredEdges,
    };
  });
}

export function detectFlight(
  coordinates: readonly number[],
  timestamps: readonly number[],
  altitudes: readonly number[],
  groundElevations: ArrayLike<number>,
  thresholdMeters: number = DEFAULT_FLIGHT_THRESHOLD_METERS,
  bridgeGapMs: number = DEFAULT_TRIP_BRIDGE_GAP_MS,
): FlightDetectionResult {
  const count = timestamps.length;
  if (coordinates.length !== count * 2) {
    throw new Error(`飞行识别坐标数量不匹配：${coordinates.length / 2} 个坐标对应 ${count} 个时间戳`);
  }
  if (altitudes.length !== count) {
    throw new Error(`飞行识别海拔数量不匹配：${altitudes.length} 个海拔对应 ${count} 个时间戳`);
  }
  if (groundElevations.length !== count) {
    throw new Error(`飞行识别地面高程数量不匹配：${groundElevations.length} 个地面高程对应 ${count} 个时间戳`);
  }
  if (!Number.isFinite(thresholdMeters) || thresholdMeters < 0) {
    throw new Error(`飞行高度阈值无效：${thresholdMeters}`);
  }

  const samples: FlightSample[] = new Array(count);
  const flyingIndexes: number[] = [];
  const segments: FlightSegment[] = [];
  let resolvableCount = 0;
  let peakHeightAboveGround = Number.NaN;
  let segmentStart = -1;
  let segmentMax = Number.NaN;

  const closeSegment = (endIndex: number) => {
    if (segmentStart < 0) return;
    segments.push({
      startIndex: segmentStart,
      endIndex,
      startTime: timestamps[segmentStart],
      endTime: timestamps[endIndex],
      pointCount: endIndex - segmentStart + 1,
      maxHeightAboveGround: segmentMax,
    });
    segmentStart = -1;
    segmentMax = Number.NaN;
  };

  for (let index = 0; index < count; index += 1) {
    const altitude = altitudes[index];
    const groundElevation = groundElevations[index];
    const height = heightAboveGround(altitude, groundElevation);
    const resolvable = Number.isFinite(height);
    const flying = isFlyingHeight(height, thresholdMeters);
    if (resolvable) {
      resolvableCount += 1;
      peakHeightAboveGround = Number.isNaN(peakHeightAboveGround) ? height : Math.max(peakHeightAboveGround, height);
    }
    samples[index] = {
      index,
      coordinate: [coordinates[index * 2], coordinates[index * 2 + 1]],
      timestamp: timestamps[index],
      altitude,
      groundElevation,
      heightAboveGround: height,
      resolvable,
      flying,
    };
    if (flying) {
      flyingIndexes.push(index);
      const separatedByTime = index > 0 && timestamps[index] - timestamps[index - 1] > bridgeGapMs;
      if (separatedByTime) closeSegment(index - 1);
      if (segmentStart < 0) {
        segmentStart = index;
        segmentMax = height;
      } else {
        segmentMax = Math.max(segmentMax, height);
      }
    } else {
      closeSegment(index - 1);
    }
  }
  closeSegment(count - 1);
  const trips = clusterFlightTrips(samples, flyingIndexes, bridgeGapMs);

  return {
    thresholdMeters,
    totalCount: count,
    resolvableCount,
    flyingCount: flyingIndexes.length,
    peakHeightAboveGround,
    samples,
    flyingIndexes,
    segments,
    trips,
  };
}

/** 对 PointDataset 时间线执行识别，groundElevations 需与 timelineTimestamps 对齐。 */
export function detectTimelineFlight(
  dataset: PointDataset,
  groundElevations: ArrayLike<number>,
  thresholdMeters: number = DEFAULT_FLIGHT_THRESHOLD_METERS,
  bridgeGapMs: number = DEFAULT_TRIP_BRIDGE_GAP_MS,
): FlightDetectionResult {
  return detectFlight(
    dataset.timelineCoordinates,
    dataset.timelineTimestamps,
    dataset.timelineAltitudes,
    groundElevations,
    thresholdMeters,
    bridgeGapMs,
  );
}

/** 与时间线等长的飞行掩码，1 表示飞行点，供图层或时间线筛选直接取用。 */
export function flightMask(result: FlightDetectionResult): Uint8Array {
  const mask = new Uint8Array(result.totalCount);
  for (const index of result.flyingIndexes) mask[index] = 1;
  return mask;
}
