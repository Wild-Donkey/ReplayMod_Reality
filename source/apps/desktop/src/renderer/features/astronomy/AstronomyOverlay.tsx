import { useLayoutEffect, useRef } from "react";
import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";
import { daylightDisplayZones, skyObjects, twilightBands, type AstronomyMapState } from "./astronomy";

import { setAstronomyWaterMaskEnabled } from "../map/water";
import { lightPollutionMeterGrid, lightPollutionSource, lightPollutionZoneCode, lightPollutionZoneGray, type LightPollutionMeter } from "./lightPollution";

const daylightLayerId = "astronomy-daylight";
const radians = Math.PI / 180;
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
  // Close the illuminated contours at the viewport edge even in a fully daytime view.
  altitudes.fill(-Infinity);
  for (let row = 1; row <= rows + 1; row++) {
    for (let i = row * stride + 1; i <= row * stride + columns + 1; i++) {
      altitudes[i] = vectors[i * 3] * sun[0] + vectors[i * 3 + 1] * sun[1] + vectors[i * 3 + 2] * sun[2];
    }
  }
  const x = (i: number) => Math.min(columns, Math.max(0, i % stride - 1)) * dx;
  const y = (i: number) => Math.min(rows, Math.max(0, Math.floor(i / stride) - 1)) * dy;

  return twilightBands.slice(0, -1).map(band => {
    const threshold = Math.sin(band.minAltitude * radians);
    const vertices = new Map<number, ContourVertex>();
    const crossing = (a: number, b: number) => {
      const above = altitudes[a] >= threshold;
      if (above === (altitudes[b] >= threshold)) return null;
      const distance = Math.abs(a - b);
      const key = Math.min(a, b) * 3 + (distance === 1 ? 0 : distance === stride ? 1 : 2);
      if (!vertices.has(key)) {
        const high = above ? a : b;
        const low = above ? b : a;
        const t = (altitudes[high] - threshold) / (altitudes[high] - altitudes[low]);
        vertices.set(key, { x: x(high) + t * (x(low) - x(high)), y: y(high) + t * (y(low) - y(high)), neighbours: [] });
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
        const above = altitudes[a] >= threshold;
        if (above === (altitudes[b] >= threshold) && above === (altitudes[c] >= threshold) &&
            above === (altitudes[d] >= threshold)) continue;
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
    return path;
  });
}

function waterPath(map: MapLibreMap, sources: ReadonlySet<string>) {
  const path = new Path2D();
  const bounds = map.getBounds();
  for (const source of sources) {
    for (const { geometry } of map.querySourceFeatures(source, {sourceLayer: "water"})) {
      const polygons = geometry.type === "Polygon" ? [geometry.coordinates]
        : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
      for (const polygon of polygons) {
        let west = Infinity;
        let east = -Infinity;
        for (const [longitude] of polygon[0] ?? []) {
          west = Math.min(west, longitude);
          east = Math.max(east, longitude);
        }
        for (let wrap = Math.ceil((bounds.getWest() - east) / 360); wrap <= Math.floor((bounds.getEast() - west) / 360); wrap++) {
          for (const ring of polygon) {
            ring.forEach(([longitude, latitude], index) => {
              const {x, y} = map.project([longitude + wrap * 360, latitude]);
              if (index === 0) path.moveTo(x, y);
              else path.lineTo(x, y);
            });
            path.closePath();
          }
        }
      }
    }
  }
  return path;
}

function createDaylightLayer(map: MapLibreMap, getSun: () => AstronomyMapState["sun"], getExposure: () => number, meter: LightPollutionMeter): CustomLayerInterface {
  const mask = document.createElement("canvas");
  const context = mask.getContext("2d")!;
  let program: WebGLProgram;
  let texture: WebGLTexture;
  const meterCanvas = document.createElement("canvas");
  meterCanvas.width = lightPollutionMeterGrid.width;
  meterCanvas.height = lightPollutionMeterGrid.height;
  const meterContext = meterCanvas.getContext("2d", {willReadFrequently: true})!;
  let daylightPass: WebGLUniformLocation | null;
  let waterGray: WebGLUniformLocation | null;
  let daylightGray: WebGLUniformLocation | null;
  let landGray: WebGLUniformLocation | null;
  let paths: Path2D[] = [];
  let water: Path2D | null = null;
  let previousExposure = 0;
  const waterSources = new Set(map.getStyle().layers.flatMap(layer =>
    layer.type === "fill" && layer["source-layer"] === "water" ? [layer.source] : []
  ));
  let grid: ReturnType<typeof sampleViewport> | null = null;
  let previousSun: AstronomyMapState["sun"] | undefined;
  let cameraChanged = true;
  const invalidateCamera = () => { cameraChanged = true; water = null; };
  const updateWater = (event: {sourceId?: string}) => {
    if (event.sourceId && waterSources.has(event.sourceId)) water = null;
  };

  return {
    id: daylightLayerId,
    type: "custom",
    renderingMode: "2d",
    onAdd: (_, gl) => {
      const vertex = gl.createShader(gl.VERTEX_SHADER)!;
      gl.shaderSource(vertex, `#version 300 es
        out vec2 uv;
        void main() {
          uv = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
          gl_Position = vec4(uv * vec2(2., -2.) + vec2(-1., 1.), 0., 1.);
        }`);
      const fragment = gl.createShader(gl.FRAGMENT_SHADER)!;
      gl.shaderSource(fragment, `#version 300 es
        precision mediump float;
        uniform sampler2D mask;
        uniform bool daylightPass;
        uniform float waterGray;
        uniform float landGray;
        uniform float daylightGray;
        in vec2 uv;
        out vec4 color;
        void main() {
          vec4 sampleColor = texture(mask, uv);
          if (daylightPass) {
            float land = max(0., sampleColor.g - sampleColor.b) * sampleColor.a;
            float water = max(0., sampleColor.r - sampleColor.b) * sampleColor.a;
            color = vec4(vec3(landGray * land + waterGray * water), land + water);
          } else {
            color = vec4(vec3(daylightGray) * sampleColor.a, sampleColor.a);
          }
        }`);
      gl.compileShader(vertex);
      gl.compileShader(fragment);
      program = gl.createProgram()!;
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      daylightPass = gl.getUniformLocation(program, "daylightPass");
      landGray = gl.getUniformLocation(program, "landGray");
      waterGray = gl.getUniformLocation(program, "waterGray");
      daylightGray = gl.getUniformLocation(program, "daylightGray");
      texture = gl.createTexture()!;
      cameraChanged = true;
      map.on("move", invalidateCamera);
      map.on("resize", invalidateCamera);
      map.on("sourcedata", updateWater);
    },
    render: gl => {
      const { clientWidth: width, clientHeight: height } = map.getContainer();
      if (!width || !height) return;
      const sun = getSun();
      const exposure = getExposure();
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      if (cameraChanged || !grid || mask.width !== width || mask.height !== height || sun !== previousSun || exposure !== previousExposure || !water) {
        if (cameraChanged || !grid || mask.width !== width || mask.height !== height) {
          grid = sampleViewport(map, width, height);
          cameraChanged = false;
          previousSun = undefined;
        }
        if (mask.width !== width) mask.width = width;
        if (mask.height !== height) mask.height = height;
        context.clearRect(0, 0, width, height);
        const refreshMeter = sun !== previousSun || !water;
        if (sun !== previousSun) paths = twilightPaths(grid, sun);
        water ??= waterPath(map, waterSources);
        if (refreshMeter) {
          meterContext.setTransform(meterCanvas.width / width, 0, 0, meterCanvas.height / height, 0, 0);
          meterContext.fillStyle = "#000";
          meterContext.fillRect(0, 0, width, height);
          for (let index = paths.length - 1; index >= 0; index--) {
            const zone = index === 0 ? daylightDisplayZones.land : twilightBands[index].zone;
            meterContext.fillStyle = `rgb(${lightPollutionZoneCode(zone)}, 0, 0)`;
            meterContext.fill(paths[index], "evenodd");
          }
          meterContext.save();
          meterContext.clip(paths[0], "evenodd");
          meterContext.fillStyle = `rgb(${lightPollutionZoneCode(daylightDisplayZones.water)}, 0, 0)`;
          meterContext.fill(water);
          meterContext.restore();
          const pixels = meterContext.getImageData(0, 0, meterCanvas.width, meterCanvas.height).data;
          // Antialiasing at a border can produce a value between two class codes.
          for (let i = 0; i < pixels.length; i += 4) pixels[i] = Math.round(pixels[i] / 16) * 16;
          meter.ambient = pixels;
          meter.refresh?.();
        }
        const peak = lightPollutionZoneGray("7b", exposure);
        paths.forEach((path, index) => {
          const gray = lightPollutionZoneGray(twilightBands[index].zone, exposure);
          const previous = lightPollutionZoneGray(twilightBands[index + 1].zone, exposure);
          context.fillStyle = index === 0 ? "#0f0" : "#fff";
          context.globalAlpha = (gray - previous) / (peak - previous);
          context.fill(path, "evenodd");
        });
        context.save();
        context.clip(paths[0], "evenodd");
        context.globalAlpha = 1;
        context.fillStyle = "#f00";
        context.fill(water);
        context.restore();
        previousSun = sun;
        previousExposure = exposure;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
      }
      // Compare daylight with the pollution brightness already drawn underneath.
      gl.uniform1i(daylightPass, 0);
      gl.uniform1f(daylightGray, lightPollutionZoneGray("7b", exposure));
      gl.blendEquation(WebGL2RenderingContext.MAX);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.blendEquation(gl.FUNC_ADD);
      // Daylight wins the max pass, then uses the same reduced grades as the exposure meter.
      gl.uniform1i(daylightPass, 1);
      gl.uniform1f(landGray, lightPollutionZoneGray(daylightDisplayZones.land, exposure));
      gl.uniform1f(waterGray, lightPollutionZoneGray(daylightDisplayZones.water, exposure));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    onRemove: (_, gl) => {
      map.off("move", invalidateCamera);
      map.off("resize", invalidateCamera);
      map.off("sourcedata", updateWater);
      delete meter.ambient;
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
    },
  };
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

export function AstronomyOverlay({ map, state, exposure, meter }: { map: MapLibreMap; state: AstronomyMapState; exposure: number; meter: LightPollutionMeter }) {
  const overlay = useRef<HTMLCanvasElement>(null);
  const latest = useRef(state);
  const latestExposure = useRef(exposure);
  const repaint = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const canvas = overlay.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const viewport = document.querySelector<HTMLElement>(".map-interaction-area");
    let frame = 0;

    const draw = () => {
      frame = 0;
      const { clientWidth: width, clientHeight: height } = map.getContainer();
      if (!width || !height) return;
      const pixelRatio = window.devicePixelRatio;
      const pixelWidth = Math.round(width * pixelRatio);
      const pixelHeight = Math.round(height * pixelRatio);
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);
      drawDirections(context, map, latest.current, viewport);
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const addDaylight = () => {
      if (!map.getLayer(lightPollutionSource) || map.getLayer(daylightLayerId)) return;
      const layers = map.getLayersOrder();
      map.addLayer(createDaylightLayer(map, () => latest.current.sun, () => latestExposure.current, meter),
        layers[layers.indexOf(lightPollutionSource) + 1]);
      setAstronomyWaterMaskEnabled(map, true);
    };
    map.on("styledata", addDaylight);
    addDaylight();
    repaint.current = schedule;
    schedule();
    const resizeObserver = new ResizeObserver(schedule);
    if (viewport) resizeObserver.observe(viewport);
    map.on("move", schedule);
    map.on("resize", schedule);
    return () => {
      repaint.current = null;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      map.off("move", schedule);
      map.off("resize", schedule);
      map.off("styledata", addDaylight);
      setAstronomyWaterMaskEnabled(map, false);
      if (!map.getStyle()) return;
      if (map.getLayer(daylightLayerId)) map.removeLayer(daylightLayerId);

    };
  }, [map, meter]);

  useLayoutEffect(() => {
    latest.current = state;
    latestExposure.current = exposure;
    repaint.current?.();
    map.triggerRepaint();
  }, [map, state, exposure]);

  return <canvas className="astronomy-map-overlay" ref={overlay} aria-hidden="true"/>;
}
