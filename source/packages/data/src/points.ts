export type CoordinateBounds = readonly [
  west: number,
  south: number,
  east: number,
  north: number,
];

export type TimeBounds = readonly [start: number, end: number];

export interface PositionSamples {
  readonly footprintCoordinates: readonly number[];
  readonly footprintTimestamps: readonly number[];
}

export interface PointDataset extends PositionSamples {
  readonly sourceName: string;
  readonly photoCoordinates: readonly number[];
  readonly photoTimestamps: readonly number[];
  readonly timelineCoordinates: readonly number[];
  readonly timelineTimestamps: readonly number[];
  /** Elevation in metres, aligned with timelineTimestamps. NaN means unavailable. */
  readonly timelineAltitudes: readonly number[];
  readonly pointCount: number;
  readonly footprintPointCount: number;
  readonly photoPointCount: number;
  readonly skippedRowCount: number;
  readonly bounds: CoordinateBounds;
  readonly timeBounds: TimeBounds;
  readonly processedMotion?: PositionSamples & {readonly timeBounds: TimeBounds};
}
