export type NetworkPoint = [number, number];

// Keep only the convex boundary: interior vertices cannot increase a network's
// longest direction, and tile duplicates do not need to be retained.
export function networkHull(points: NetworkPoint[]): NetworkPoint[] {
  const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const unique = sorted.filter((point, i) => !i || point[0] !== sorted[i - 1][0] || point[1] !== sorted[i - 1][1]);
  if (unique.length < 3) return unique;
  const cross = (a: NetworkPoint, b: NetworkPoint, c: NetworkPoint) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = (vertices: NetworkPoint[]) => {
    const result: NetworkPoint[] = [];
    for (const point of vertices) {
      while (result.length > 1 && cross(result[result.length - 2], result[result.length - 1], point) <= 0) result.pop();
      result.push(point);
    }
    return result.slice(0, -1);
  };
  return [...half(unique), ...half(unique.slice().reverse())];
}

export function networkFillsViewport(points: NetworkPoint[], width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  const thresholdSquared = (width * width + height * height) / 4;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[i][0] - points[j][0], dy = points[i][1] - points[j][1];
      if (dx * dx + dy * dy >= thresholdSquared) return true;
    }
  }
  return false;
}
