export const DIRECTION_CHEVRON_SIZE = 48;

export const directionChevronPath = (
  x: number,
  y: number,
  size: number,
  direction: "up" | "right" = "right",
) => {
  const half = size / 2;
  const wing = size * 0.42;
  if (direction === "up") {
    return `M ${x - wing} ${y + half} L ${x} ${y - half} L ${x + wing} ${y + half}`;
  }
  return `M ${x - half} ${y - wing} L ${x + half} ${y} L ${x - half} ${y + wing}`;
};

const normalizeLongitudeDelta = (longitude: number, reference: number) =>
  ((longitude - reference + 540) % 360) - 180;

export const directionBearing = (
  previous: readonly number[],
  next: readonly number[],
) => {
  const radians = (value: number) => value * Math.PI / 180;
  const longitudeDelta = radians(normalizeLongitudeDelta(next[0], previous[0]));
  const previousLatitude = radians(previous[1]);
  const nextLatitude = radians(next[1]);
  const y = Math.sin(longitudeDelta) * Math.cos(nextLatitude);
  const x = Math.cos(previousLatitude) * Math.sin(nextLatitude)
    - Math.sin(previousLatitude) * Math.cos(nextLatitude) * Math.cos(longitudeDelta);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};

export const directionAtCoordinate = (
  coordinates: readonly (readonly number[])[],
  coordinate: readonly number[],
) => {
  if (coordinates.length < 2) return 0;
  let nearest = 0;
  let nearestDistance = Infinity;
  coordinates.forEach((candidate, index) => {
    const longitude = normalizeLongitudeDelta(candidate[0], coordinate[0]);
    const latitude = candidate[1] - coordinate[1];
    const distance = longitude * longitude + latitude * latitude;
    if (distance < nearestDistance) { nearestDistance = distance; nearest = index; }
  });
  const previous = coordinates[Math.max(0, nearest - 1)];
  const next = coordinates[Math.min(coordinates.length - 1, nearest + 1)];
  return directionBearing(previous, next);
};

export const drawDirectionChevron = (
  context: CanvasRenderingContext2D,
  color = "white",
) => {
  const size = DIRECTION_CHEVRON_SIZE;
  context.clearRect(0, 0, size, size);
  context.beginPath();
  const path = new Path2D(directionChevronPath(size / 2, size / 2, 22, "up"));
  context.lineWidth = 7;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = color;
  context.stroke(path);
};
