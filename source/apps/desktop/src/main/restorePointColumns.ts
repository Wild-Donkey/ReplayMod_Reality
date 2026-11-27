import type { PointDataset } from "../../../../packages/data/src";
import type { NumericColumn } from "../../../../packages/data/src/points";

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
