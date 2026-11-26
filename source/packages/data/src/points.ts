export type CoordinateBounds = readonly [
  west: number,
  south: number,
  east: number,
  north: number,
];

export type TimeBounds = readonly [start: number, end: number];

export type NumericColumn = readonly number[] | Float64Array;

export interface PositionSamples {
  readonly footprintCoordinates: NumericColumn;
  readonly footprintTimestamps: NumericColumn;
}

export interface PointDataset extends PositionSamples {
  readonly sourceName: string;
  readonly photoCoordinates: NumericColumn;
  readonly photoTimestamps: NumericColumn;
  readonly timelineCoordinates: NumericColumn;
  readonly timelineTimestamps: NumericColumn;
  /** Elevation in metres, aligned with timelineTimestamps. NaN means unavailable. */
  readonly timelineAltitudes: NumericColumn;
  readonly pointCount: number;
  readonly footprintPointCount: number;
  readonly photoPointCount: number;
  readonly skippedRowCount: number;
  readonly bounds: CoordinateBounds;
  readonly timeBounds: TimeBounds;
  readonly processedMotion?: PositionSamples & {readonly timeBounds: TimeBounds};
}
