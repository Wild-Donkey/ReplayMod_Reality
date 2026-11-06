import type { MapCoordinate } from "../../../../../../packages/data/src";
import type { FlightDetectionResult, FlightTrip } from "./flightDetection";
import type { MapLanguage } from "../../../shared/settings";
import type { ConfirmedFlightEndpoint, ConfirmedFlightRecord } from "../../../shared/confirmedFlight";

export const FLIGHT_ROUTE_STYLE_VERSION = 5;

/**
 * 由飞行点区段推断起降机场并汇总航行列表（纯逻辑，不依赖 DOM/网络）。
 *
 * 机场不是用飞行中的点去找，而是取区段两侧的“接地锚点”：起飞前最后一个
 * 可判定的地面点、落地后第一个可判定的地面点，再在限定半径内匹配最近机
 * 场。数据起止处的区段没有外侧地面点时，退回首/末飞行点。匹配不到机场不
 * 臆造，只保留坐标并标记为未知。
 */

export interface FlightAirport {
  readonly iata: string;
  readonly icao: string;
  readonly name: string;
  /** 中文名（构建时预填中国机场，其余按需随用随拉），可能为空。 */
  readonly nameZh?: string;
  readonly municipality: string;
  readonly country: string;
  readonly latitude: number;
  readonly longitude: number;
  /** 锚点到机场的大圆距离（千米）。 */
  readonly distanceKm: number;
}

export type AirportConfidence = "high" | "medium" | "none";
export interface FlightEndpoint {
  readonly timestamp: number;
  readonly coordinate: MapCoordinate;
  readonly airport: FlightAirport | null;
  /** high：≤ 近距阈值；medium：仍在搜索半径内；none：未匹配到机场。 */
  readonly confidence: AirportConfidence;
}

export interface InferredFlight {
  readonly ordinal: number;
  readonly departure: FlightEndpoint;
  readonly arrival: FlightEndpoint;
  readonly startTime: number;
  readonly endTime: number;
  readonly durationMs: number;
  readonly pointCount: number;
  readonly maxHeightAboveGround: number;
  /** 起降锚点之间的大圆距离（千米）。 */
  readonly legDistanceKm: number;
}

export interface InferFlightsOptions {
  /** 机场搜索半径（千米），超出则判定未知。 */
  readonly maxAirportKm?: number;
  /** 该距离以内视为高可信。 */
  readonly highConfidenceKm?: number;
  /** 趟内飞行点少于该值视为孤立噪声，不生成航行。 */
  readonly minPoints?: number;
  readonly minDurationMs?: number;
  readonly minDisplacementKm?: number;
  readonly minMotionConsistency?: number;
}

export type AirportResolver = (coordinate: MapCoordinate) => FlightAirport | null;

const EARTH_RADIUS_KM = 6371;
export function haversineKm(a: MapCoordinate, b: MapCoordinate): number {
  const toRad = (value: number) => value * Math.PI / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

const DEFAULT_MAX_AIRPORT_KM = 40;
const DEFAULT_HIGH_CONFIDENCE_KM = 8;
const DEFAULT_MIN_POINTS = 2;
const DEFAULT_MIN_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_MIN_DISPLACEMENT_KM = 20;
const DEFAULT_MIN_MOTION_CONSISTENCY = .6;

type Sample = FlightDetectionResult["samples"][number];

function groundAnchorBefore(samples: readonly Sample[], trip: FlightTrip): Sample {
  for (let index = trip.startIndex - 1; index >= 0; index -= 1) {
    const sample = samples[index];
    if (sample.resolvable && !sample.flying) return sample;
  }
  return samples[trip.startIndex];
}

function groundAnchorAfter(samples: readonly Sample[], trip: FlightTrip): Sample {
  for (let index = trip.endIndex + 1; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample.resolvable && !sample.flying) return sample;
  }
  return samples[trip.endIndex];
}

function endpoint(
  sample: Sample,
  resolveAirport: AirportResolver,
  maxAirportKm: number,
  highConfidenceKm: number,
): FlightEndpoint {
  const airport = resolveAirport(sample.coordinate);
  const confidence: AirportConfidence = !airport
    ? "none"
    : airport.distanceKm <= highConfidenceKm ? "high" : "medium";
  return {
    timestamp: sample.timestamp,
    coordinate: sample.coordinate,
    airport: airport && airport.distanceKm <= maxAirportKm ? airport : null,
    confidence: airport && airport.distanceKm <= maxAirportKm ? confidence : "none",
  };
}

export function inferFlights(
  detection: FlightDetectionResult,
  resolveAirport: AirportResolver,
  options: InferFlightsOptions = {},
): InferredFlight[] {
  const maxAirportKm = options.maxAirportKm ?? DEFAULT_MAX_AIRPORT_KM;
  const highConfidenceKm = options.highConfidenceKm ?? DEFAULT_HIGH_CONFIDENCE_KM;
  const minPoints = options.minPoints ?? DEFAULT_MIN_POINTS;
  const minDurationMs = options.minDurationMs ?? DEFAULT_MIN_DURATION_MS;
  const minDisplacementKm = options.minDisplacementKm ?? DEFAULT_MIN_DISPLACEMENT_KM;
  const minMotionConsistency = options.minMotionConsistency ?? DEFAULT_MIN_MOTION_CONSISTENCY;
  const flights: InferredFlight[] = [];
  let ordinal = 0;
  // 高度只负责产生候选点，不再设置巡航硬门槛；航班是否成立由持续时间、
  // 位移、运动连续性和机场证据共同判断，兼容起飞后立即失去 GPS 的记录。
  for (const trip of detection.trips) {
    if (trip.flyingPointCount < minPoints) continue;
    const departureSample = groundAnchorBefore(detection.samples, trip);
    const arrivalSample = groundAnchorAfter(detection.samples, trip);
    const departure = endpoint(departureSample, resolveAirport, maxAirportKm, highConfidenceKm);
    const arrival = endpoint(arrivalSample, resolveAirport, maxAirportKm, highConfidenceKm);
    const airportEvidence = departure.airport !== null || arrival.airport !== null;
    if (trip.endTime - trip.startTime < minDurationMs) continue;
    if (trip.displacementKm < minDisplacementKm && !airportEvidence) continue;
    if (trip.motionConsistency < minMotionConsistency) continue;
    ordinal += 1;
    flights.push({
      ordinal,
      departure,
      arrival,
      startTime: trip.startTime,
      endTime: trip.endTime,
      durationMs: Math.max(0, trip.endTime - trip.startTime),
      pointCount: trip.flyingPointCount,
      maxHeightAboveGround: trip.maxHeightAboveGround,
      legDistanceKm: haversineKm(departureSample.coordinate, arrivalSample.coordinate),
    });
  }
  // 手机在整段航班中完全无定位时，不会产生任何飞行点。若时间线上
  // 相邻两点分别位于不同机场 8 km 内，且无点间隙对应的速度符合航空运动，
  // 则补成一条“缺测航班”。双端高可信机场约束可避免把普通长时间断点当航班。
  for (let index = 1; index < detection.samples.length; index += 1) {
    const before = detection.samples[index - 1];
    const after = detection.samples[index];
    const gapMs = after.timestamp - before.timestamp;
    if (gapMs < 30 * 60_000 || gapMs > 8 * 3600_000) continue;
    if (!(before.resolvable && !before.flying && after.resolvable && !after.flying)) continue;
    const departure = endpoint(before, resolveAirport, maxAirportKm, highConfidenceKm);
    const arrival = endpoint(after, resolveAirport, maxAirportKm, highConfidenceKm);
    if (departure.confidence !== "high" || arrival.confidence !== "high") continue;
    if (!departure.airport || !arrival.airport) continue;
    const departureCode = departure.airport.icao || departure.airport.iata;
    const arrivalCode = arrival.airport.icao || arrival.airport.iata;
    if (!departureCode || departureCode === arrivalCode) continue;
    const legDistanceKm = haversineKm(before.coordinate, after.coordinate);
    const impliedSpeedKmh = legDistanceKm / (gapMs / 3_600_000);
    if (legDistanceKm < 100 || impliedSpeedKmh < 80 || impliedSpeedKmh > 1200) continue;
    if (flights.some(flight => before.timestamp <= flight.endTime && after.timestamp >= flight.startTime)) continue;
    flights.push({
      ordinal: 0,
      departure,
      arrival,
      startTime: before.timestamp,
      endTime: after.timestamp,
      durationMs: gapMs,
      pointCount: 0,
      maxHeightAboveGround: 0,
      legDistanceKm,
    });
  }
  return flights.sort((a,b) => a.startTime - b.startTime)
    .map((flight,index) => ({...flight,ordinal:index + 1}));
}

const endpointMapCoordinate = (endpoint: FlightEndpoint): MapCoordinate => endpoint.airport
  ? [endpoint.airport.longitude, endpoint.airport.latitude]
  : endpoint.coordinate;

/**
 * 在 Web Mercator 平面上生成椭圆弧：起降点固定为椭圆长轴的两个端点，
 * 短轴长度由 minorAxisRatio（短半轴 / 长半轴）决定。弧形是航线图的视觉
 * 编码，有意不沿用 GPS 采样点复现飞机的具体航迹。
 *
 * 用椭圆而不是圆/二次贝塞尔：同一条航线飞 N 次时，每趟按固定比例等差
 * 增大短半轴，弧束可以无限外扩成同簇嵌套椭圆，不存在曲率封顶。
 */
export function stylizedFlightArc(
  start: MapCoordinate,
  end: MapCoordinate,
  segmentCount = 48,
  minorAxisRatio = .26,
): MapCoordinate[] {
  const project = ([longitude, latitude]: MapCoordinate) => {
    const clampedLatitude = Math.max(-85, Math.min(85, latitude));
    return [
      longitude / 360,
      Math.log(Math.tan(Math.PI / 4 + clampedLatitude * Math.PI / 360)) / (2 * Math.PI),
    ] as const;
  };
  const unproject = (x: number, y: number): MapCoordinate => [
    x * 360,
    (2 * Math.atan(Math.exp(y * 2 * Math.PI)) - Math.PI / 2) * 180 / Math.PI,
  ];
  const a = project(start);
  const b = project(end);
  let dx = b[0] - a[0];
  if (dx > .5) dx -= 1;
  if (dx < -.5) dx += 1;
  const dy = b[1] - a[1];
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-8) return [start, end];
  // 弦方向单位向量与其左侧法向；弧永远相对飞行方向向左弯，
  // 反向航班的法向相反，自然落在连线另一侧。
  const ux = dx / distance;
  const uy = dy / distance;
  const nx = -uy;
  const ny = ux;
  const midX = a[0] + dx / 2;
  const midY = a[1] + dy / 2;
  const count = Math.max(2, Math.floor(segmentCount));
  // 二次贝塞尔（几何上即抛物线）：控制点沿左法向外移 ratio·distance。
  // t=0.5 的拱高 = ratio·distance/2，与旧半椭圆完全一致，弧束分档间距不变；
  // 但起点切线指向「前方偏弯曲侧」，与弦夹角 atan(2·ratio)（ratio=.26 时约 27°），
  // 不再像椭圆长轴顶点那样以 90° 横向甩出——起飞朝向前方、顺势弯出。
  const bulge = distance * Math.max(0, minorAxisRatio);
  const controlX = midX + bulge * nx;
  const controlY = midY + bulge * ny;
  const endX = a[0] + dx;
  const endY = a[1] + dy;
  return Array.from({length: count + 1}, (_, index) => {
    const t = index / count;
    const oneMinusT = 1 - t;
    const w0 = oneMinusT * oneMinusT;
    const w1 = 2 * oneMinusT * t;
    const w2 = t * t;
    const x = w0 * a[0] + w1 * controlX + w2 * endX;
    const y = w0 * a[1] + w1 * controlY + w2 * endY;
    return unproject(x, y);
  });
}

/** 一个航线航段的起降端点（机场坐标或地面锚点，由调用方决定）。 */
export interface FlightLeg {
  readonly start: MapCoordinate;
  readonly end: MapCoordinate;
}

/** 已确认航班在时间轴上的时段及其唯一风格化航线。 */
export interface FlightRouteSegment {
  readonly startTime: number;
  readonly endTime: number;
  readonly path: readonly MapCoordinate[];
}

/** 第 0 条弧的短半轴比例（相对弦长的一半）。 */
const FLIGHT_ARC_BASE_MINOR_RATIO = .26;
/** 同方向每多飞一趟，短半轴按长半轴的该比例等差外扩，重复多少次都能成束排开。 */
const FLIGHT_ARC_LANE_STEP = .045;

/**
 * 按起降端点对生成航线椭圆弧束：同方向的重复航段等差增大短半轴，返程由
 * “向左弯”自然分到另一侧。不关心端点来自候选航班还是已确认记录。
 */
export function flightArcPaths(legs: readonly FlightLeg[]): MapCoordinate[][] {
  const laneByAirportPair = new Map<string, number>();
  return legs.map(({start, end}) => {
    const startKey = `${start[0].toFixed(4)},${start[1].toFixed(4)}`;
    const endKey = `${end[0].toFixed(4)},${end[1].toFixed(4)}`;
    const pairKey = `${startKey}|${endKey}`;
    const lane = laneByAirportPair.get(pairKey) ?? 0;
    laneByAirportPair.set(pairKey, lane + 1);
    return stylizedFlightArc(
      start,
      end,
      48,
      FLIGHT_ARC_BASE_MINOR_RATIO + lane * FLIGHT_ARC_LANE_STEP,
    );
  });
}

/** 每趟候选航班只取起降端点，不参考中间的实际飞行点。 */
export function flightRoutePaths(flights: readonly InferredFlight[]): MapCoordinate[][] {
  return flightArcPaths(flights.map(flight => ({
    start: endpointMapCoordinate(flight.departure),
    end: endpointMapCoordinate(flight.arrival),
  })));
}

/**
 * 已确认航班的身份不能建立在精确 id 上：重新识别时地形采样与飞行掩码会轻微
 * 漂移，同一趟物理航班的地面锚点可能挪动数公里、起止边界可能相差十几分钟，
 * 逐字符 id 会因此失配（表现为“已确认又变回未确认”）。
 */
/** 重扫后同一锚点允许的最大漂移（千米）；机场两两距离远大于此，不会串航班。 */
const CONFIRMED_MATCH_MAX_ENDPOINT_KM = 10;
/** 时间窗重叠比例下限（交集 / 两侧较短时长）。 */
const CONFIRMED_MATCH_MIN_OVERLAP = .7;

const candidateEndpointMatches = (candidate: FlightEndpoint, saved: ConfirmedFlightEndpoint): boolean => {
  const candidateIata = candidate.airport?.iata;
  // 两侧都识别出机场时，以 IATA 为准（机场坐标快照与锚点本身可能相差几十公里）。
  if (candidateIata && saved.iata) return candidateIata === saved.iata;
  return haversineKm(candidate.coordinate, [saved.coordinate[0], saved.coordinate[1]])
    <= CONFIRMED_MATCH_MAX_ENDPOINT_KM;
};

/**
 * 在已确认记录中找出候选航班对应的同一趟物理航班。判据为时间窗高度重叠，
 * 且两个端点要么 IATA 相同、要么锚点距离在漂移容限内。多条命中时取重叠最大、
 * 端点总漂移最小者。
 */
export function findConfirmedFlight(
  candidate: InferredFlight,
  records: readonly ConfirmedFlightRecord[],
): ConfirmedFlightRecord | undefined {
  const candidateDuration = candidate.endTime - candidate.startTime;
  let best: {score: number; drift: number; record: ConfirmedFlightRecord} | undefined;
  for (const record of records) {
    const overlap = Math.min(candidate.endTime, record.endTime)
      - Math.max(candidate.startTime, record.startTime);
    if (overlap <= 0) continue;
    const score = overlap / Math.min(candidateDuration, record.endTime - record.startTime);
    if (score < CONFIRMED_MATCH_MIN_OVERLAP) continue;
    if (!candidateEndpointMatches(candidate.departure, record.departure)
      || !candidateEndpointMatches(candidate.arrival, record.arrival)) continue;
    const drift = haversineKm(candidate.departure.coordinate,
      [record.departure.coordinate[0], record.departure.coordinate[1]])
      + haversineKm(candidate.arrival.coordinate,
        [record.arrival.coordinate[0], record.arrival.coordinate[1]]);
    if (!best || score > best.score || (score === best.score && drift < best.drift)) {
      best = {score, drift, record};
    }
  }
  return best?.record;
}

/**
 * 某机场在当前地图语言设置下是否应显示中文名，语义与底图语言对齐：
 * - zh：所有机场都要中文；
 * - en：一律英文；
 * - local：机场当地语言——中国（CN）机场当地语言即中文，其余回退英文；
 * - auto：跟随系统语言——系统中文时等同 zh，否则等同 local。
 */
export function preferAirportChineseName(
  language: MapLanguage,
  country: string,
  systemLanguageIsZh: boolean,
): boolean {
  if (language === "zh") return true;
  if (language === "en") return false;
  if (language === "local") return country === "CN";
  return systemLanguageIsZh || country === "CN";
}

/** 机场显示名：需要中文且有中文名时用中文，否则用英文名，统一前缀 IATA/ICAO 代码。 */
export function airportLabel(airport: FlightAirport | null, wantChinese = true): string {
  if (!airport) return "未知机场";
  const code = airport.iata || airport.icao;
  const prefix = code ? `${code} ` : "";
  if (wantChinese && airport.nameZh) return `${prefix}${airport.nameZh}`;
  const place = [airport.municipality, airport.country].filter(Boolean).join("，");
  return [`${prefix}${airport.name}`, place].filter(Boolean).join(" · ");
}

export function formatDuration(durationMs: number): string {
  const minutes = Math.round(durationMs / 60000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours <= 0) return `${rest} 分钟`;
  return rest > 0 ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

/** 纯文本航行列表，便于状态栏提示或复制；时间与坐标不在此格式化。 */
export function formatFlightList(flights: readonly InferredFlight[]): string {
  if (flights.length === 0) return "未识别出航行。";
  return flights.map(flight =>
    `${flight.ordinal}. ${airportLabel(flight.departure.airport)} → ${airportLabel(flight.arrival.airport)}`
    + ` · ${formatDuration(flight.durationMs)} · ${Math.round(flight.legDistanceKm)} km`,
  ).join("\n");
}
