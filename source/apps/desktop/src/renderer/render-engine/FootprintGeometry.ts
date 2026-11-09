export const FOOTPRINT_BREAK_DURATION = 5 * 60 * 1000;
export type FootprintPath = [number, number][];

// Backend-independent geometry contract: recording gaps split paths, and a
// single symmetric smoothing pass never moves their endpoints.
export function compileFootprintPaths(
  coordinates: readonly number[],
  timestamps: readonly number[],
): FootprintPath[] {
  const paths: FootprintPath[] = [];
  let path: FootprintPath = [];
  const flush = () => { if (path.length > 1) paths.push(path); path = []; };
  const count = Math.min(timestamps.length, Math.floor(coordinates.length / 2));
  for (let i = 0; i < count; i++) {
    let longitude = coordinates[i * 2];
    const latitude = coordinates[i * 2 + 1];
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || !Number.isFinite(timestamps[i])) { flush(); continue; }
    const gap = i ? timestamps[i] - timestamps[i - 1] : 0;
    if (gap > FOOTPRINT_BREAK_DURATION || gap < 0) flush();
    if (path.length) {
      const previous = path[path.length - 1][0];
      longitude = previous + ((longitude - previous + 540) % 360 + 360) % 360 - 180;
    }
    path.push([longitude, latitude]);
  }
  flush();
  return paths.map(points => points.map((point, index) => {
    if (!index || index === points.length - 1) return point;
    return [
      points[index - 1][0] * 0.25 + point[0] * 0.5 + points[index + 1][0] * 0.25,
      points[index - 1][1] * 0.25 + point[1] * 0.5 + points[index + 1][1] * 0.25,
    ];
  }));
}
