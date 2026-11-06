export interface ConfirmedFlightEndpoint {
  readonly timestamp: number;
  /** 地面锚点坐标；未匹配机场时它就是航线端点。 */
  readonly coordinate: readonly [number, number];
  readonly iata: string | null;
  readonly icao: string | null;
  readonly name: string | null;
  /** 确认时的机场坐标快照；有机场时航线端点取机场，旧记录缺省回退到 coordinate。 */
  readonly airportLongitude?: number | null;
  readonly airportLatitude?: number | null;
}

export interface ConfirmedFlightRecord {
  readonly id: string;
  readonly confirmedAt: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly departure: ConfirmedFlightEndpoint;
  readonly arrival: ConfirmedFlightEndpoint;
  readonly pointCount: number;
  readonly maxHeightAboveGround: number;
  readonly distanceKm: number;
}

export interface ConfirmedFlightsFile {
  readonly format: "replaymod.confirmed-flights";
  readonly version: 1;
  readonly updatedAt: string;
  readonly flights: readonly ConfirmedFlightRecord[];
  readonly screening?: FlightScreeningCache;
}

export interface FlightScreeningCache {
  readonly datasetStartTime: number;
  readonly pointCount: number;
  readonly throughTimestamp: number;
  readonly throughDay: string;
  readonly updatedAt: string;
  readonly groundElevations: readonly number[];
  /** 已完成时间水位线之前的候选航班，供真正增量合并。 */
  readonly candidates?: readonly unknown[];
  /** 历史候选航班已合并到的时间；可落后于高程采样水位线。 */
  readonly candidateThroughTimestamp?: number;
}
