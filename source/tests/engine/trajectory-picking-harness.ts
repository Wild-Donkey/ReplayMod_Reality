import { checkVisibleReplayLayers, checkElevationVisualHandoff, checkAnnotationVisualHandoff, checkFootprintVisualHandoff } from "./visible-render-harness";
import { WebMercatorViewport } from "@deck.gl/core";
import { ReplayScene } from "../../apps/desktop/src/renderer/render-engine/ReplayScene";
import { TrajectoryBuffer } from "../../apps/desktop/src/renderer/render-engine/buffers/TrajectoryBuffer";
import { DeckRenderBackend } from "../../apps/desktop/src/renderer/render-engine/backends/DeckRenderBackend";
import { createDeckLayerRegistry } from "../../apps/desktop/src/renderer/render-engine/backends/DeckLayerRegistry";
import type { PointDataset } from "../../packages/data/src";

(globalThis as any).runTrajectoryPickingCheck = async () => {
  const parent = document.createElement("div");
  Object.assign(parent.style, {position: "absolute", left: "31px", top: "47px", width: "320px", height: "360px"});
  document.body.append(parent);
  const coordinates = [0, 0, 179.9, 0], timestamps = [1000, 2000], altitudes = [0, 10];
  for (let i = 2; i < 180000; i++) { coordinates.push(10 + (i % 1000) / 1000, 10 + Math.floor(i / 1000) / 1000); timestamps.push(2000 + i); altitudes.push(10); }
  const dataset: PointDataset = {sourceName: "gpu-check", footprintCoordinates: coordinates, footprintTimestamps: timestamps, photoCoordinates: [], photoTimestamps: [], timelineCoordinates: coordinates, timelineTimestamps: timestamps, timelineAltitudes: altitudes, pointCount: timestamps.length, footprintPointCount: timestamps.length, photoPointCount: 0, skippedRowCount: 0, bounds: [0, 0, 180, 11], timeBounds: [1000, timestamps.at(-1)!]};
  const scene = new ReplayScene();
  scene.setTrajectory(TrajectoryBuffer.fromPointDataset(dataset));
  scene.setMapViewState({longitude: 0, latitude: 0, zoom: 8, bearing: 0, pitch: 0});
  const backend = new DeckRenderBackend(parent, scene.current), registry = createDeckLayerRegistry();
  const draw = () => backend.render(scene.current, registry.build(scene.current, scene.clock.current));
  const pause = () => new Promise(resolve => requestAnimationFrame(resolve));
  try {
    backend.setViews([{id: "map", kind: "map", x: 0, y: 0, width: 320, height: 240}, {id: "timeline", kind: "orthographic", x: 0, y: 260, width: 320, height: 80}]);
    draw();
    let center = backend.pick({viewId: "map", x: 160, y: 120, radius: 12});
    const deadline = performance.now() + 15000;
    while (!center && performance.now() < deadline) { await pause(); draw(); center = backend.pick({viewId: "map", x: 160, y: 120, radius: 12}); }
    if (!center) throw new Error("GPU trajectory picking did not initialize or missed the center point");
    const nearby = backend.pick({viewId: "map", x: 168, y: 120, radius: 12});
    const empty = backend.pick({viewId: "map", x: 200, y: 160, radius: 12});
    const wrongView = backend.pick({viewId: "timeline", x: 160, y: 120});
    const canvas = parent.querySelector("canvas")!;
    const capture = document.createElement("canvas"); capture.width = canvas.width; capture.height = canvas.height;
    const context = capture.getContext("2d")!; context.drawImage(canvas, 0, 0);
    const visualAlpha = context.getImageData(0, 0, capture.width, capture.height).data.filter((_, index) => index % 4 === 3).reduce((sum, alpha) => sum + alpha, 0);
    scene.setVisibility({...scene.current.visibility, trajectory: false}); draw();
    const hidden = backend.pick({viewId: "map", x: 160, y: 120});
    scene.setVisibility({...scene.current.visibility, trajectory: true}); draw();
    const restored = backend.pick({viewId: "map", x: 160, y: 120});
    scene.setMapViewState({...scene.current.mapViewState, longitude: -179.9}); draw();
    const viewport = new WebMercatorViewport({width: 320, height: 240, ...scene.current.mapViewState});
    const [x, y] = viewport.project([-180.1, 0]);
    const wrapped = backend.pick({viewId: "map", x, y, radius: 12});
    scene.setMapViewState({...scene.current.mapViewState, longitude: 0});
    scene.setAnnotationGeometry({type: "FeatureCollection", features: [{type: "Feature", id: "route", properties: {id: "route"}, geometry: {type: "LineString", coordinates: [[-0.1, 0, 900], [0.1, 0, 900]]}}, {type: "Feature", id: "draft", properties: {id: "draft"}, geometry: {type: "Point", coordinates: [0, 0]}}]});
    draw(); await pause(); draw(); await pause();
    const annotation = backend.pick({viewId: "map", target: "annotation", x: 160, y: 120, radius: 5});
    const trajectoryOnly = backend.pick({viewId: "map", target: "trajectory", x: 160, y: 120, radius: 12});
    scene.setVisibility({...scene.current.visibility, annotations: false}); draw();
    const hiddenAnnotation = backend.pick({viewId: "map", target: "annotation", x: 160, y: 120, radius: 5});
    scene.setVisibility({...scene.current.visibility, annotations: true});
    const releaseMetric = scene.registerMetricSeries("timeline", {id: "test-speed", space: "timeline", x: new Float64Array([1000, 2000]), values: new Float64Array([0, 10]), xDomain: [1000, 2000], yDomain: [0, 10]});
    draw(); await pause(); draw(); await pause();
    const metric = backend.pick({viewId: "timeline", target: "metric", x: 160, y: 300, radius: 5});
    releaseMetric(); draw();
    const clearedMetric = backend.pick({viewId: "timeline", target: "metric", x: 160, y: 300});
    context.clearRect(0, 0, capture.width, capture.height); context.drawImage(canvas, 0, 0);
    const visualAlphaAfter = context.getImageData(0, 0, capture.width, capture.height).data.filter((_, index) => index % 4 === 3).reduce((sum, alpha) => sum + alpha, 0);
    scene.setTrajectory(null); draw();
    const cleared = backend.pick({viewId: "map", x, y});
    return {center, nearby, empty, wrongView, hidden, restored, wrapped, cleared, visualAlpha, annotation, trajectoryOnly, hiddenAnnotation, metric, clearedMetric, visualAlphaAfter, count: dataset.pointCount, dpr: devicePixelRatio};
  } finally { backend.destroy(); parent.remove(); }
};

(globalThis as any).runVisibleReplayCheck = checkVisibleReplayLayers;

(globalThis as any).runElevationHandoffCheck = checkElevationVisualHandoff;
(globalThis as any).runAnnotationHandoffCheck = checkAnnotationVisualHandoff;

(globalThis as any).runFootprintHandoffCheck = checkFootprintVisualHandoff;
