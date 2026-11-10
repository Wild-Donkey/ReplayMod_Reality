import { useLayoutEffect, useRef } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { skyObjects, twilightBands, type AstronomyMapState } from "./astronomy";

const radians = Math.PI / 180;
const twilightContours = twilightBands.slice(0, -1).map((band, index) => ({
  threshold: Math.sin(band.minAltitude * radians),
  opacity: (twilightBands[index + 1].opacity - band.opacity) / (1 - band.opacity),
}));

function sampleViewport(map: MapLibreMap, width: number, height: number) {
  const columns = Math.ceil(width / 8);
  const rows = Math.ceil(height / 8);
  const dx = width / columns;
  const dy = height / rows;
  const stride = columns + 3;
  const vectors = new Float64Array(stride * (rows + 3) * 3);
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const { lng, lat } = map.unproject([column * dx, row * dy]);
      const longitude = lng * radians;
      const latitude = lat * radians;
      const index = ((row + 1) * stride + column + 1) * 3;
      vectors[index] = Math.cos(latitude) * Math.cos(longitude);
      vectors[index + 1] = Math.cos(latitude) * Math.sin(longitude);
      vectors[index + 2] = Math.sin(latitude);
    }
  }
  return { columns, rows, dx, dy, stride, vectors, altitudes: new Float64Array(vectors.length / 3) };
}

type ContourVertex = { x: number; y: number; neighbours: number[] };

function twilightPaths(grid: ReturnType<typeof sampleViewport>, sun: AstronomyMapState["sun"]) {
  const { columns, rows, dx, dy, stride, vectors, altitudes } = grid;
  // A bright outer ring closes contours at the viewport edge, including when the entire map is dark.
  altitudes.fill(Infinity);
  for (let row = 1; row <= rows + 1; row++) {
    for (let i = row * stride + 1; i <= row * stride + columns + 1; i++) {
      altitudes[i] = vectors[i * 3] * sun[0] + vectors[i * 3 + 1] * sun[1] + vectors[i * 3 + 2] * sun[2];
    }
  }
  const x = (i: number) => Math.min(columns, Math.max(0, i % stride - 1)) * dx;
  const y = (i: number) => Math.min(rows, Math.max(0, Math.floor(i / stride) - 1)) * dy;

  return twilightContours.map(({ threshold, opacity }) => {
    const vertices = new Map<number, ContourVertex>();
    const crossing = (a: number, b: number) => {
      const below = altitudes[a] < threshold;
      if (below === (altitudes[b] < threshold)) return null;
      const distance = Math.abs(a - b);
      const key = Math.min(a, b) * 3 + (distance === 1 ? 0 : distance === stride ? 1 : 2);
      if (!vertices.has(key)) {
        const low = below ? a : b;
        const high = below ? b : a;
        const t = (threshold - altitudes[low]) / (altitudes[high] - altitudes[low]);
        vertices.set(key, { x: x(low) + t * (x(high) - x(low)), y: y(low) + t * (y(high) - y(low)), neighbours: [] });
      }
      return key;
    };
    const addTriangle = (a: number, b: number, c: number) => {
      const edges = [crossing(a, b), crossing(b, c), crossing(c, a)].filter(edge => edge !== null);
      if (edges.length !== 2) return;
      const [first, second] = edges;
      vertices.get(first)!.neighbours.push(second);
      vertices.get(second)!.neighbours.push(first);
    };

    for (let row = 0; row <= rows + 1; row++) {
      for (let column = 0; column <= columns + 1; column++) {
        const a = row * stride + column;
        const b = a + 1, d = a + stride, c = d + 1;
        const below = altitudes[a] < threshold;
        if (below === (altitudes[b] < threshold) && below === (altitudes[c] < threshold) &&
            below === (altitudes[d] < threshold)) continue;
        addTriangle(a, b, c);
        addTriangle(a, c, d);
      }
    }

    // Stitch the interpolated segments before filling so the rasterizer sees only the outer edges.
    const path = new Path2D();
    for (const [first, start] of vertices) {
      path.moveTo(start.x, start.y);
      vertices.delete(first);
      let next = start.neighbours[0];
      let vertex = vertices.get(next);
      while (vertex) {
        path.lineTo(vertex.x, vertex.y);
        vertices.delete(next);
        next = vertex.neighbours.find(neighbour => vertices.has(neighbour)) ?? first;
        vertex = vertices.get(next);
      }
      path.closePath();
    }
    return { path, opacity };
  });
}

function drawDirections(
  context: CanvasRenderingContext2D, map: MapLibreMap, state: AstronomyMapState, viewport: HTMLElement | null,
) {
  const { point, directions, events } = state;
  if (!point || !directions) return;
  const [longitude, latitude] = point;
  const wrappedLongitude = longitude + 360 * Math.round((map.getCenter().lng - longitude) / 360);
  const origin = map.project([wrappedLongitude, latitude]);
  const mapRect = map.getContainer().getBoundingClientRect();
  const visible = viewport?.getBoundingClientRect() ?? mapRect;
  const left = visible.left - mapRect.left;
  const right = visible.right - mapRect.left;
  const top = visible.top - mapRect.top;
  const bottom = visible.bottom - mapRect.top;
  if (origin.x < left || origin.x > right || origin.y < top || origin.y > bottom) return;

  // Project a short local tangent so compass rays follow the map's bearing and pitch.
  const step = Math.min(0.01, 2 ** -map.getZoom());
  const northStep = latitude > 84.9 ? -step : step;
  const north = map.project([wrappedLongitude, latitude + northStep]).sub(origin).mult(step / northStep);
  const east = map.project([wrappedLongitude + step / Math.cos(latitude * radians), latitude]).sub(origin);

  const ray = (azimuth: number, color: string) => {
    const angle = azimuth * radians;
    const dx = Math.sin(angle) * east.x + Math.cos(angle) * north.x;
    const dy = Math.sin(angle) * east.y + Math.cos(angle) * north.y;
    if (!(Math.hypot(dx, dy) > 0)) return;
    const xLimit = dx === 0 ? Infinity : ((dx > 0 ? right : left) - origin.x) / dx;
    const yLimit = dy === 0 ? Infinity : ((dy > 0 ? bottom : top) - origin.y) / dy;
    const limit = Math.min(xLimit, yLimit);
    context.strokeStyle = color;
    context.beginPath();
    context.moveTo(origin.x, origin.y);
    context.lineTo(origin.x + dx * limit, origin.y + dy * limit);
    context.stroke();
  };

  context.lineWidth = 1.5;
  context.globalAlpha = 0.82;
  for (const { color, value } of events) {
    if (value) ray(value.azimuth, color);
  }
  context.globalAlpha = 1;
  for (const { id, color } of skyObjects) ray(directions[id].azimuth, color);

  context.beginPath();
  context.arc(origin.x, origin.y, 4, 0, 2 * Math.PI);
  context.strokeStyle = "#121212";
  context.fillStyle = "#fff";
  context.fill();
  context.stroke();
}

export function AstronomyOverlay({ map, state }: { map: MapLibreMap; state: AstronomyMapState }) {
  const overlay = useRef<HTMLCanvasElement>(null);
  const latest = useRef(state);
  const repaint = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const canvas = overlay.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const viewport = document.querySelector<HTMLElement>(".map-interaction-area");
    let frame = 0;
    let grid: ReturnType<typeof sampleViewport> | null = null;
    let paths: ReturnType<typeof twilightPaths> = [];
    let previousSun: AstronomyMapState["sun"] | undefined;

    const draw = () => {
      frame = 0;
      const { clientWidth: width, clientHeight: height } = map.getContainer();
      if (!width || !height) return;
      const pixelRatio = window.devicePixelRatio;
      const pixelWidth = Math.round(width * pixelRatio);
      const pixelHeight = Math.round(height * pixelRatio);
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

      const { sun } = latest.current;
      if (!grid) {
        grid = sampleViewport(map, width, height);
        previousSun = undefined;
      }
      if (sun !== previousSun) {
        paths = twilightPaths(grid, sun);
        previousSun = sun;
      }
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = "#000";
      for (const { path, opacity } of paths) {
        context.globalAlpha = opacity;
        context.fill(path, "evenodd");
      }
      context.globalAlpha = 1;
      drawDirections(context, map, latest.current, viewport);
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const cameraChanged = () => {
      grid = null;
      schedule();
    };
    repaint.current = schedule;
    const resizeObserver = new ResizeObserver(schedule);
    if (viewport) resizeObserver.observe(viewport);
    map.on("move", cameraChanged);
    map.on("resize", cameraChanged);
    return () => {
      repaint.current = null;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      map.off("move", cameraChanged);
      map.off("resize", cameraChanged);
    };
  }, [map]);

  useLayoutEffect(() => {
    latest.current = state;
    repaint.current?.();
  }, [map, state]);

  return <canvas className="astronomy-map-overlay" ref={overlay} aria-hidden="true"/>;
}
