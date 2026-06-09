export type CoordinateBounds = readonly [
  west: number,
  south: number,
  east: number,
  north: number,
];

export interface PointDataset {
  readonly sourceName: string;
  readonly footprintCoordinates: readonly number[];
  readonly photoCoordinates: readonly number[];
  readonly pointCount: number;
  readonly footprintPointCount: number;
  readonly photoPointCount: number;
  readonly skippedRowCount: number;
  readonly bounds: CoordinateBounds;
}
