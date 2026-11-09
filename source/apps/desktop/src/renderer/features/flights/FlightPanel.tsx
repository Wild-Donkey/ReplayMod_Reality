import { useCallback, useEffect, useRef, useState } from "react";
import type { PointDataset } from "../../../../../../packages/data/src";
import { screenDatasetFlight } from "../map/flightScreening";
import { detectFlight, type FlightDetectionResult } from "../map/flightDetection";
import {
  createAirportDatabase,
  fetchAirportNameZh,
  fetchOnlineAirportLayer,
  loadLocalAirportLayers,
  type AirportDatabase,
} from "../map/airports";
import {
  airportLabel,
  findConfirmedFlight,
  FLIGHT_ROUTE_STYLE_VERSION,
  flightArcPaths,
  formatDuration,
  inferFlights,
  preferAirportChineseName,
  type FlightRouteSegment,
  type FlightEndpoint,
  type InferredFlight,
  type AirportConfidence,
} from "../map/flights";
import type { MapLanguage } from "../../../shared/settings";
import type { ConfirmedFlightRecord, FlightScreeningCache } from "../../../shared/confirmedFlight";

const MAX_AIRPORT_KM = 40;

interface ResolvedConfirmedEndpoint {
  /** 端点坐标：机场真实坐标（快照或按代码查库），无机场数据时才是地面锚点。 */
  readonly coordinate: readonly [number, number];
  /** 机场身份代码，用于多个航班共享同一机场时去重。 */
  readonly code: string | null;
  /** true 表示没有任何机场数据、退回了漂移的地面锚点。 */
  readonly fromAnchor: boolean;
}

/**
 * 已确认记录的端点一律落到机场真实坐标：优先确认时的机场坐标快照，其次按
 * IATA/ICAO 从机场库精确取坐标；两者都没有（旧记录且库中缺失）才回退地面
 * 锚点，并标记 fromAnchor——锚点会漂移几十公里，不能当作机场点展示。
 */
const resolveConfirmedEndpoint = (
  endpoint: ConfirmedFlightRecord["departure"],
  database: AirportDatabase,
): ResolvedConfirmedEndpoint => {
  const { airportLongitude, airportLatitude } = endpoint;
  const code = endpoint.iata || endpoint.icao;
  if (Number.isFinite(airportLongitude) && Number.isFinite(airportLatitude)) {
    return { coordinate: [airportLongitude as number, airportLatitude as number], code, fromAnchor: false };
  }
  if (code) {
    const airport = database.byCode(code);
    if (airport) return { coordinate: [airport.longitude, airport.latitude], code, fromAnchor: false };
  }
  return { coordinate: [endpoint.coordinate[0], endpoint.coordinate[1]], code, fromAnchor: true };
};

interface Props {
  dataset: PointDataset | null;
  apiKey: string;
  active: boolean;
  mapLanguage: MapLanguage;
  /** auto 语言下用于判断系统是否中文。 */
  systemLanguageIsZh: boolean;
  onFlightRoutesChange?: (routes: readonly (readonly [number, number])[][]) => void;
  onFlightRouteSegmentsChange?: (segments: readonly FlightRouteSegment[]) => void;
  /** 已确认航班涉及的机场（按机场数据去重），供地图绘制端点光点。 */
  onFlightAirportsChange?: (airports: readonly (readonly [number, number])[]) => void;
}

interface ScreeningState {
  detection: FlightDetectionResult;
  flights: InferredFlight[];
}

const confidenceText: Record<AirportConfidence, string> = {
  high: "高可信",
  medium: "待确认",
  none: "未匹配机场",
};

export function FlightPanel({ dataset, apiKey, active, mapLanguage, systemLanguageIsZh, onFlightRoutesChange, onFlightRouteSegmentsChange, onFlightAirportsChange }: Props) {
  const [database, setDatabase] = useState<AirportDatabase>(() => {
    try {
      const layers = loadLocalAirportLayers();
      return createAirportDatabase(layers);
    } catch {
      return createAirportDatabase([]);
    }
  });
  const [state, setState] = useState<ScreeningState | null>(null);
  const [busy, setBusy] = useState(false);
  const [airportBusy, setAirportBusy] = useState(false);
  const [error, setError] = useState("");
  // 地图航线的唯一数据源是“已确认航班”记录；扫描候选只进列表面板。
  // null 表示尚未从主进程加载完成：此状态下绝不发布空航线，避免加载失败
  // 或新旧桥不一致时把既有航线误显示成“被清空”。
  const [confirmedRecords, setConfirmedRecords] = useState<readonly ConfirmedFlightRecord[] | null>(null);
  const [confirmingId, setConfirmingId] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [screeningProgress, setScreeningProgress] = useState<FlightScreeningCache | null>(null);
  const [dayProgress, setDayProgress] = useState<{day:string;completed:number;total:number} | null>(null);
  const detectionRef = useRef<FlightDetectionResult | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const airportControllerRef = useRef<AbortController | null>(null);
  // 运行时随用随拉到的中文名（ICAO → 名称）；triedRef 保证会话内每个 ICAO 只请求一次。
  const [zhOverrides, setZhOverrides] = useState<ReadonlyMap<string, string>>(new Map());
  const triedZhRef = useRef<Set<string>>(new Set());
  const autoAirportAttemptedRef = useRef(false);
  const candidateHistoryRef = useRef<InferredFlight[]>([]);
  const replaceFromRef = useRef(Number.NEGATIVE_INFINITY);

  const cachedCandidates = (value: readonly unknown[] | undefined): InferredFlight[] => (value ?? [])
    .filter((candidate): candidate is InferredFlight => Boolean(candidate)
      && typeof candidate === "object"
      && Number.isFinite((candidate as InferredFlight).startTime)
      && Number.isFinite((candidate as InferredFlight).endTime));

  const mergedFlights = (recent: readonly InferredFlight[]): InferredFlight[] => [
    ...candidateHistoryRef.current.filter(flight => flight.endTime < replaceFromRef.current),
    ...recent,
  ].sort((a,b) => a.startTime - b.startTime)
    .map((flight,index) => ({...flight,ordinal:index + 1}));

  const applyInference = useCallback((detection: FlightDetectionResult, db: AirportDatabase) => {
    const recent = inferFlights(detection, coordinate => db.nearest(coordinate, MAX_AIRPORT_KM), {
      maxAirportKm: MAX_AIRPORT_KM,
    });
    setState({ detection, flights: mergedFlights(recent) });
  }, []);

  // 地图航线只订阅已确认记录：加载、确认、删除、机场库更新与样式热更都由此统一
  // 发布；扫描流程不触碰它，因此重新识别期间航线既不清空也不重建。
  useEffect(() => {
    if (confirmedRecords === null) return;
    const legs: Array<{start: [number, number]; end: [number, number]}> = [];
    // 端点光点直接用机场数据：同一机场（IATA/ICAO）只出一个点；退回地面锚点的
    // 端点不产生光点——锚点会漂移几十公里，不能代表机场位置。
    const airportPoints = new Map<string, [number, number]>();
    for (const record of confirmedRecords) {
      const departure = resolveConfirmedEndpoint(record.departure, database);
      const arrival = resolveConfirmedEndpoint(record.arrival, database);
      legs.push({
        start: [departure.coordinate[0], departure.coordinate[1]],
        end: [arrival.coordinate[0], arrival.coordinate[1]],
      });
      for (const resolved of [departure, arrival]) {
        if (resolved.fromAnchor) continue;
        const [longitude, latitude] = resolved.coordinate;
        const key = resolved.code
          || `${longitude.toFixed(4)},${latitude.toFixed(4)}`;
        if (!airportPoints.has(key)) airportPoints.set(key, [longitude, latitude]);
      }
    }
    const paths = flightArcPaths(legs);
    onFlightRoutesChange?.(paths);
    onFlightRouteSegmentsChange?.(confirmedRecords.map((record, index) => ({
      startTime: record.startTime,
      endTime: record.endTime,
      path: paths[index],
    })));
    onFlightAirportsChange?.([...airportPoints.values()]);
  }, [confirmedRecords, database, onFlightRoutesChange, onFlightRouteSegmentsChange, onFlightAirportsChange, FLIGHT_ROUTE_STYLE_VERSION]);

  const runScreening = useCallback(async (db: AirportDatabase, full = false) => {
    if (!dataset || !apiKey) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setDayProgress(null);
    setError("");
    // 地图只显示已确认航线，扫描期间保持不动，不清空也不重建。
    try {
      let cache: FlightScreeningCache | null = null;
      if (!full) {
        try {
          cache = await window.replaymod?.loadFlightScreeningCache() ?? null;
        } catch (cacheError) {
          // 旧主进程尚未注册进度 IPC 时允许继续识别；重启后自动恢复持久化。
          if (!(cacheError instanceof Error) || !cacheError.message.includes("No handler registered")) throw cacheError;
        }
        const compatibleWatermark = cache && cache.datasetStartTime === dataset.timelineTimestamps[0]
          && dataset.timelineTimestamps.includes(cache.throughTimestamp);
        if (!compatibleWatermark) {
          setError("没有可用的识别时间水位线，请使用“全量重新识别”。");
          return;
        }
      }
      if (cache) setScreeningProgress(cache);
      candidateHistoryRef.current = cachedCandidates(cache?.candidates);
      const run = await screenDatasetFlight(dataset, apiKey, controller.signal, undefined, {
        cache,
        onCheckpoint: async checkpoint => {
          setScreeningProgress(checkpoint);
          try {
            await window.replaymod?.saveFlightScreeningCache(checkpoint);
          } catch (checkpointError) {
            if (!(checkpointError instanceof Error) || !checkpointError.message.includes("No handler registered")) throw checkpointError;
          }
        },
        onDayProgress: setDayProgress,
      });
      if (controller.signal.aborted) return;
      replaceFromRef.current = run.replaceFromTimestamp;
      const recent = inferFlights(run.detection, coordinate => db.nearest(coordinate, MAX_AIRPORT_KM), {
        maxAirportKm: MAX_AIRPORT_KM,
      });
      const flights = mergedFlights(recent);
      const completedCache: FlightScreeningCache = {
        ...run.cache,
        candidates:flights,
        candidateThroughTimestamp:run.cache.throughTimestamp,
      };
      try {
        await window.replaymod?.saveFlightScreeningCache(completedCache);
      } catch (checkpointError) {
        if (!(checkpointError instanceof Error) || !checkpointError.message.includes("No handler registered")) throw checkpointError;
      }
      setScreeningProgress(completedCache);
      candidateHistoryRef.current = flights;
      detectionRef.current = run.detection;
      setState({detection:run.detection,flights});
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : "飞行点识别失败。");
      }
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        setDayProgress(null);
      }
    }
  }, [dataset, apiKey, applyInference]);

  useEffect(() => () => {
    controllerRef.current?.abort();
    airportControllerRef.current?.abort();
  }, []);

  // 已确认记录是地图航线的唯一数据源。地图常驻后台渲染，因此挂载即加载、
  // 随数据集切换重载，不要求先进入航班页；加载失败绝不静默成“零条”。
  useEffect(() => {
    if (!dataset) {
      setConfirmedRecords([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const bridge = window.replaymod;
      if (!bridge || typeof bridge.loadConfirmedFlights !== "function") {
        if (!cancelled) setError("航班服务需要重启：请完全退出应用后重新打开，已确认航班不会丢失。");
        return;
      }
      try {
        const records = await bridge.loadConfirmedFlights();
        if (!cancelled) setConfirmedRecords(records);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setError(message.includes("No handler registered")
          ? "航班服务需要重启：请完全退出应用后重新打开，已确认航班不会丢失。"
          : (message || "已确认航班加载失败。"));
      }
    })();
    return () => { cancelled = true; };
  }, [dataset]);

  // 进入航班页时只把已保存的候选恢复到列表；绝不自动发起任何识别，
  // 增量/全量识别只能由用户点按钮触发。
  useEffect(() => {
    if (!active) return;
    void window.replaymod?.loadFlightScreeningCache().then(cache => {
      if (!cache) return;
      const flights = cachedCandidates(cache.candidates)
        .sort((a,b) => a.startTime - b.startTime)
        .map((flight,index) => ({...flight,ordinal:index + 1}));
      candidateHistoryRef.current = flights;
      setScreeningProgress(cache);
      if (flights.length > 0) {
        const detection = detectFlight([],[],[],[]);
        setState({detection,flights});
      }
    }).catch(() => {});
    // cachedCandidates 为组件内纯函数，刻意不列入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, dataset]);

  // 随用随拉：只对航行列表里实际显示、当前语言想要中文、且内置数据缺少中文名
  // 的机场，逐个按 ICAO 拉取（一次一个，绝不批量）。失败静默回退英文。
  useEffect(() => {
    if (!state) return;
    const pending: string[] = [];
    for (const flight of state.flights) {
      for (const endpoint of [flight.departure, flight.arrival]) {
        const airport = endpoint.airport;
        if (!airport || airport.nameZh || !airport.icao) continue;
        if (!preferAirportChineseName(mapLanguage, airport.country, systemLanguageIsZh)) continue;
        if (!triedZhRef.current.has(airport.icao)) {
          triedZhRef.current.add(airport.icao);
          pending.push(airport.icao);
        }
      }
    }
    if (pending.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const icao of pending) {
        try {
          const name = await fetchAirportNameZh(icao);
          if (!cancelled && name) {
            setZhOverrides(previous => new Map(previous).set(icao, name));
          }
        } catch {
          // 离线或查询失败：保留英文显示，不打断列表。
        }
      }
    })();
    return () => { cancelled = true; };
  }, [state, mapLanguage, systemLanguageIsZh]);

  const endpointLabel = (endpoint: FlightEndpoint): string => {
    const airport = endpoint.airport;
    if (!airport) return airportLabel(null);
    const wantChinese = preferAirportChineseName(mapLanguage, airport.country, systemLanguageIsZh);
    const nameZh = zhOverrides.get(airport.icao) ?? airport.nameZh;
    return airportLabel(nameZh ? { ...airport, nameZh } : airport, wantChinese);
  };

  const updateAirportLibrary = async () => {
    airportControllerRef.current?.abort();
    const controller = new AbortController();
    airportControllerRef.current = controller;
    setAirportBusy(true);
    setError("");
    try {
      const online = await fetchOnlineAirportLayer(controller.signal, false);
      if (controller.signal.aborted) return;
      // 只替换 online 层；内置与本地层始终共存。
      const retained = database.layers.filter(layer => layer.source !== "online");
      const next = createAirportDatabase([...retained, online]);
      setDatabase(next);
      if (detectionRef.current) applyInference(detectionRef.current, next);
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : "在线机场库更新失败，仍使用本地机场表。");
      }
    } finally {
      if (!controller.signal.aborted) setAirportBusy(false);
    }
  };

  // 进入航行页时自动补齐在线机场库；一次会话失败后不反复请求，仍可手动重试。
  useEffect(() => {
    if (!active || airportBusy || autoAirportAttemptedRef.current
      || database.layers.some(layer => layer.source === "online")) return;
    autoAirportAttemptedRef.current = true;
    void updateAirportLibrary();
    // updateAirportLibrary 依赖当前机场库，只在首次进入时执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const localLayer = database.layers.find(layer => layer.source === "local");

  const flightId = (flight: InferredFlight) => [
    flight.startTime,
    flight.endTime,
    flight.departure.coordinate.map(value => value.toFixed(5)).join(","),
    flight.arrival.coordinate.map(value => value.toFixed(5)).join(","),
  ].join(":");

  const upsertConfirmedRecord = (record: ConfirmedFlightRecord) => {
    setConfirmedRecords(previous =>
      [...(previous ?? []).filter(item => item.id !== record.id), record]
        .sort((a, b) => a.startTime - b.startTime));
  };

  const confirmFlight = async (flight: InferredFlight) => {
    if (confirmingId) return;
    const id = flightId(flight);
    const route = `${endpointLabel(flight.departure)} → ${endpointLabel(flight.arrival)}`;
    if (!window.confirm(`确认这趟航班？\n${route}\n${new Date(flight.startTime).toLocaleString("zh-CN")}`)) return;
    const endpoint = (value: FlightEndpoint) => ({
      timestamp: value.timestamp,
      coordinate: value.coordinate,
      iata: value.airport?.iata || null,
      icao: value.airport?.icao || null,
      name: value.airport ? endpointLabel(value) : null,
      // 把机场坐标快照进记录，已确认航线自此自包含，不随机场库版本变化。
      airportLongitude: value.airport?.longitude ?? null,
      airportLatitude: value.airport?.latitude ?? null,
    });
    const record: ConfirmedFlightRecord = {
      id,
      confirmedAt: new Date().toISOString(),
      startTime: flight.startTime,
      endTime: flight.endTime,
      departure: endpoint(flight.departure),
      arrival: endpoint(flight.arrival),
      pointCount: flight.pointCount,
      maxHeightAboveGround: flight.maxHeightAboveGround,
      distanceKm: flight.legDistanceKm,
    };
    // 同一趟物理航班可能因重扫漂移而以旧 id 存在；确认时顺手清掉旧记录，避免重复。
    const stale = findConfirmedFlight(flight, confirmedRecords ?? []);
    setConfirmingId(id);
    setError("");
    try {
      const target = await window.replaymod?.confirmFlight(record);
      if (!target) throw new Error("桌面存储服务不可用。");
      upsertConfirmedRecord(record);
      if (stale && stale.id !== record.id) {
        await window.replaymod?.deleteConfirmedFlight(stale.id);
        setConfirmedRecords(previous => (previous ?? []).filter(item => item.id !== stale.id));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "航班保存失败。");
    } finally {
      setConfirmingId("");
    }
  };

  const deleteConfirmedFlight = async (recordId: string, flight: InferredFlight) => {
    if (!window.confirm(`删除这条已确认航班？\n${endpointLabel(flight.departure)} → ${endpointLabel(flight.arrival)}`)) return;
    setDeletingId(recordId);
    setError("");
    try {
      await window.replaymod?.deleteConfirmedFlight(recordId);
      setConfirmedRecords(previous => (previous ?? []).filter(record => record.id !== recordId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "航班删除失败。");
    } finally {
      setDeletingId("");
    }
  };

  let body;
  if (!dataset) {
    body = <div className="empty-list">尚未载入轨迹数据。</div>;
  } else if (!apiKey) {
    body = <div className="empty-list">未配置 MapTiler 密钥，无法读取地形高程。</div>;
  } else if (busy && !state) {
    body = <div className="empty-list">正在采样地面高程并识别飞行点…</div>;
  } else if (!state) {
    body = <div className="empty-list">尚未识别。</div>;
  } else {
    const { detection, flights } = state;
    body = <>
      <div className="flight-summary">
        <strong>{flights.length} 趟航班</strong>
        {detection.totalCount > 0 ? <span>
          飞行点 {detection.flyingCount.toLocaleString("zh-CN")} / 可判定 {detection.resolvableCount.toLocaleString("zh-CN")}
          {Number.isFinite(detection.peakHeightAboveGround) ? ` · 最高离地 ${Math.round(detection.peakHeightAboveGround)} m` : ""}
        </span> : <span>已载入上次保存的识别结果</span>}
      </div>
      {screeningProgress && <div className="flight-source-note">已识别至 {screeningProgress.throughDay}，共 {screeningProgress.pointCount.toLocaleString("zh-CN")} 个点。</div>}
      {flights.length === 0
        ? <div className="empty-list">未发现符合位移、时长与运动连续性条件的航班。</div>
        : <ol className="flight-list">
          {flights.map(flight => {
            const id = flightId(flight);
            // 重新识别会让锚点坐标与时间边界漂移，已确认状态按物理航班容错匹配，
            // 不依赖逐字符 id。
            const matchedRecord = findConfirmedFlight(flight, confirmedRecords ?? []);
            const confirmed = Boolean(matchedRecord);
            return <li key={flight.ordinal} className={`flight-item${confirmed ? " flight-item-confirmed" : ""}`}>
            {confirmed && matchedRecord && <button className="flight-delete" type="button" aria-label="删除已确认航班"
              title="删除已确认航班" disabled={deletingId === matchedRecord.id}
              onClick={() => void deleteConfirmedFlight(matchedRecord.id, flight)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></svg>
            </button>}
            <div className="flight-route">
              <span className="flight-ordinal">{flight.ordinal}</span>
              <span className="flight-city">{endpointLabel(flight.departure)}</span>
              <span className="flight-arrow">→</span>
              <span className="flight-city">{endpointLabel(flight.arrival)}</span>
            </div>
            <div className="flight-meta">
              <span>{new Date(flight.startTime).toLocaleString("zh-CN")}</span>
              <span>{formatDuration(flight.durationMs)}</span>
              <span>{Math.round(flight.legDistanceKm).toLocaleString("zh-CN")} km</span>
            </div>
            {confirmed
              ? <div className="flight-confidence">{new Date(flight.departure.timestamp).toLocaleString("zh-CN")} 起飞 → {new Date(flight.arrival.timestamp).toLocaleString("zh-CN")} 降落</div>
              : <div className="flight-confidence">
                <span className={`confidence-dot confidence-${flight.departure.confidence}`} />
                起：{confidenceText[flight.departure.confidence]}
                <span className={`confidence-dot confidence-${flight.arrival.confidence}`} />
                降：{confidenceText[flight.arrival.confidence]}
              </div>}
            {!confirmed && <button className="flight-confirm" type="button" disabled={Boolean(confirmingId)}
              onClick={() => void confirmFlight(flight)}>
              {confirmingId === id ? "正在保存…" : "确认为航班"}
            </button>}
          </li>;
          })}
        </ol>}
    </>;
  }

  return <section className="library-section flight-panel">
    <h2 className="section-label">航行列表</h2>
    <p className="flight-hint">100 米只用于筛选候选点；系统结合多个巡航高点、P90 高度、持续时间、位移和运动连续性排除海拔尖峰与低空误判。</p>
    <div className="flight-library">
      <span>{database.layers.map(layer => `${layer.label} ${layer.airports.length.toLocaleString("zh-CN")}`).join(" · ")}</span>
    </div>
    <div className="flight-actions">
      <button className="primary-action" type="button" disabled={!dataset || !apiKey || busy}
        onClick={() => void runScreening(database, false)}>
        {busy ? "正在识别…" : "增量识别"}
      </button>
      <button type="button" disabled={!dataset || !apiKey || busy}
        onClick={() => void runScreening(database, true)}>
        全量重新识别
      </button>
    </div>
    {busy && dayProgress && <div className="flight-day-progress" role="status">
      <span>{dayProgress.day}</span>
      <strong>{dayProgress.completed.toLocaleString("zh-CN")} / {dayProgress.total.toLocaleString("zh-CN")} 天</strong>
      <progress value={dayProgress.completed} max={Math.max(1,dayProgress.total)} />
    </div>}
    {airportBusy && <div className="flight-source-note">正在自动更新在线机场库…</div>}
    {localLayer && <div className="flight-source-note">已叠加本地全量总表。</div>}
    {error && <div className="data-error">{error}</div>}
    {body}
  </section>;
}
