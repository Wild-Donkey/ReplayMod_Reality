import {createPublicBasemap, publicBasemapStyle} from "../map/PublicBasemap";
import {ROAD_OPACITY_SCALE} from "../map/basemapStyle";
import {drawMinimapTrail, MINIMAP_TRAIL_MILLISECONDS, type TrailPoint} from "./MinimapTrail";
import { drawCircularMinimap, MINIMAP_SIZE } from "./CircularMinimap";
import { createExportScene } from "../../render-engine/export/ReplaySceneExport";
import { ReplayCanvasCapture } from "../../render-engine/export/ReplayCanvasCapture";
import { OfflineFramePlan } from "../../../shared/overlayExport";
import { renderOfflineFrames } from "../../render-engine/export/OfflineFramePump";
import { useCachedState, cachedMapRequest } from "../../shared/cache";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import maplibregl from "maplibre-gl";
import type { PointDataset, TimeBounds } from "../../../../../../packages/data/src";
import { TrajectoryBuffer } from "../../render-engine/buffers/TrajectoryBuffer";
import { registerMapStyleChannels } from "../../render-engine/MapRenderChannels";
import type { ReplayScene } from "../../render-engine/ReplayScene";
import { committedAnnotationGeometry } from "../../render-engine/AnnotationGeometry";
import { waitForMapFrame } from "../../render-engine/MapFrameBarrier";
import { smoothedSpeed, hasProcessedCoverage } from "../timeline/metrics";
import { HEADING_HALF_WINDOW_MS, minimapHeading } from "./MinimapHeading";

const exportTrajectory = (dataset: PointDataset) => TrajectoryBuffer.fromPointDataset(dataset);

interface ExportSettings {
  width: number;
  height: number;
  fps: number;
  segmentMinutes: number;
  bitrate: number;
  showStats: boolean;
  showMap: boolean;
}

const lowerBound = (values: readonly number[], target: number) => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
};

const sample = (dataset: PointDataset, timestamp: number) => {
  const trajectory = exportTrajectory(dataset);
  const shared = trajectory.sample(timestamp);
  if (dataset.timelineTimestamps.length === 1) {
    return {
      longitude: dataset.timelineCoordinates[0],
      latitude: dataset.timelineCoordinates[1],
      speed: 0,
      altitude: dataset.timelineAltitudes[0],
      grade: Number.NaN,
      bearing: 0,
    };
  }
  const index = Math.min(
    Math.max(lowerBound(dataset.timelineTimestamps, timestamp), 1),
    dataset.timelineTimestamps.length - 1,
  );
  const before = index - 1;
  const t0 = dataset.timelineTimestamps[before];
  const t1 = dataset.timelineTimestamps[index];
  const ratio = Math.min(Math.max((timestamp - t0) / Math.max(t1 - t0, 1), 0), 1);
  const lon0 = dataset.timelineCoordinates[before * 2];
  const lat0 = dataset.timelineCoordinates[before * 2 + 1];
  const lon1 = dataset.timelineCoordinates[index * 2];
  const lat1 = dataset.timelineCoordinates[index * 2 + 1];
  const latitudeRadians = ((lat0 + lat1) / 2) * Math.PI / 180;
  const dx = (((lon1 - lon0 + 540) % 360) - 180) * 111_320 * Math.cos(latitudeRadians);
  const dy = (lat1 - lat0) * 110_540;
  const seconds = Math.max((t1 - t0) / 1000, 0.001);
  const altitude0 = dataset.timelineAltitudes[before];
  const altitude1 = dataset.timelineAltitudes[index];
  const hasAltitude = Number.isFinite(altitude0) && Number.isFinite(altitude1);
  const headingBounds: [number, number] = [dataset.timelineTimestamps[0], dataset.timelineTimestamps.at(-1)!];
  const processed = dataset.processedMotion;
  if (processed && timestamp >= processed.timeBounds[0] && timestamp <= processed.timeBounds[1]) {
    headingBounds[0] = Math.max(processed.timeBounds[0], processed.footprintTimestamps[0]);
    headingBounds[1] = Math.min(processed.timeBounds[1], processed.footprintTimestamps.at(-1)!);
  }
  for (let i = before; i > 0 && timestamp - dataset.timelineTimestamps[i] < HEADING_HALF_WINDOW_MS; i--) {
    if (dataset.timelineTimestamps[i] - dataset.timelineTimestamps[i - 1] > 10_000) {
      headingBounds[0] = Math.max(headingBounds[0], dataset.timelineTimestamps[i]);
      break;
    }
  }
  for (let i = index; i + 1 < trajectory.length && dataset.timelineTimestamps[i] - timestamp < HEADING_HALF_WINDOW_MS; i++) {
    if (dataset.timelineTimestamps[i + 1] - dataset.timelineTimestamps[i] > 10_000) {
      headingBounds[1] = Math.min(headingBounds[1], dataset.timelineTimestamps[i]);
      break;
    }
  }
  const altitude = hasAltitude ? altitude0 + (altitude1 - altitude0) * ratio : Number.NaN;
  return {
    longitude: shared?.position[0] ?? lon0,
    latitude: shared?.position[1] ?? lat0,
    speed: smoothedSpeed(dataset, timestamp) ?? Math.hypot(dx, dy) / seconds * 3.6,
    altitude,
    grade: hasAltitude && Math.hypot(dx, dy) > Math.min(1, seconds) ? (altitude1 - altitude0) / Math.hypot(dx, dy) * 100 : Number.NaN,
    bearing: minimapHeading(trajectory, timestamp, headingBounds, shared?.heading ?? 0),
  };
};

const drawOverlay = (
  context: CanvasRenderingContext2D,
  dataset: PointDataset,
  range: TimeBounds,
  timestamp: number,
  settings: ExportSettings,
  navigationCanvas: HTMLCanvasElement | null,
  value = sample(dataset, timestamp),
  annotationCanvas: HTMLCanvasElement | null = null,
) => {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  if (!hasProcessedCoverage(dataset, timestamp)) return;
  context.setTransform(settings.width / 1920, 0, 0, settings.height / 1080, 0, 0);
  const panel = (x: number, label: string, text: string) => {
    context.fillStyle = "rgba(255,255,255,.65)";
    context.shadowColor = "rgba(0,0,0,.9)";
    context.shadowBlur = 8;
    context.font = "24px sans-serif";
    context.fillText(label, x + 24, 920);
    context.fillStyle = "white";
    context.font = "600 50px sans-serif";
    context.fillText(text, x + 24, 985);
  };
  if (settings.showStats) {
    panel(500, "时间", new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false }));
    panel(760, "速度", `${value.speed.toFixed(1)} km/h`);
    panel(1020, "海拔", Number.isFinite(value.altitude) ? `${value.altitude.toFixed(0)} m` : "—");
    panel(1280, "坡度", Number.isFinite(value.grade) ? `${value.grade.toFixed(1)} %` : "—");
  }

  if (settings.showMap && navigationCanvas) drawCircularMinimap(context, navigationCanvas, annotationCanvas, value.bearing);
};

export function OverlayExport({ dataset, range, apiKey, scene, active = true, previewContainer = null, previewTime = null }: { dataset: PointDataset; range: TimeBounds; apiKey: string; scene: ReplayScene; active?: boolean; previewContainer?: HTMLDivElement|null; previewTime?: number|null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const navigationContainerRef = useRef<HTMLDivElement>(null);
  const publicMapRef = useRef<ReturnType<typeof createPublicBasemap> | null>(null);
  const mapFailureRef = useRef<string | null>(null);
  const trailRef = useRef<TrailPoint[]>([]);
  const navigationSurfaceRef = useRef<HTMLCanvasElement | null>(null);
  const navigationMapRef = useRef<maplibregl.Map | null>(null);
  const navigationBindingRef = useRef<(() => void) | null>(null);
  const previewFrameRef = useRef<AbortController | null>(null);
  const cancelExportRef = useRef(false);
  const frameWaitRef = useRef<AbortController | null>(null);
  const offlineSessionRef = useRef<string | null>(null);
  const startingExportRef = useRef(false);
  const cancelActiveExport = useCallback(() => {
    cancelExportRef.current = true;
    frameWaitRef.current?.abort();
    const id = offlineSessionRef.current;
    if (id) { offlineSessionRef.current = null; void window.replaymod?.cancelOfflineExport(id).catch(() => {}); }
  }, []);
  const [settings, setSettings] = useCachedState<ExportSettings>("export-settings", { width: 1920, height: 1080, fps: 30, segmentMinutes: 10, bitrate: 12, showStats: true, showMap: true });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMapReady, setIsMapReady] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [exportError, setExportError] = useState("");
  const previewRef = useRef({dataset, range, settings, progress, active, previewTime});
  previewRef.current = {dataset, range, settings, progress, active, previewTime};
  const duration = useMemo(() => (range[1] - range[0]) / 1000, [range]);
  useEffect(() => cancelActiveExport, [dataset, range, settings, cancelActiveExport]);

  const updateNavigationMap = (dataset: PointDataset, timestamp: number, value: ReturnType<typeof sample>) => {
    const map = navigationMapRef.current;
    if (!map || !publicMapRef.current) return;
    let trailStart = Math.max(dataset.timelineTimestamps[0] ?? timestamp, timestamp - MINIMAP_TRAIL_MILLISECONDS);
    const processed = dataset.processedMotion;
    if (processed && timestamp >= processed.timeBounds[0] && timestamp <= processed.timeBounds[1]) {
      const times = processed.footprintTimestamps;
      let index = lowerBound(times, timestamp);
      if (times[index] !== timestamp) index--;
      while (index > 0 && times[index] > trailStart && times[index] - times[index - 1] <= 10_000) index--;
      trailStart = Math.max(trailStart, processed.timeBounds[0], times[Math.max(0, index)]);
    }
    const first = Math.max(0, lowerBound(dataset.timelineTimestamps, trailStart));
    const last = Math.min(dataset.timelineTimestamps.length, lowerBound(dataset.timelineTimestamps, timestamp));
    // Interpolate both ends so the tail advances continuously, including
    // between sparse GPS samples. Never include points ahead of the pointer.
    const start = sample(dataset, trailStart);
    const coordinates: number[] = [start.longitude, start.latitude];
    const timestamps: number[] = [trailStart];
    const step = Math.max(1, Math.ceil((last - first) / 500));
    for (let index = first; index < last; index += step) {
      if (dataset.timelineTimestamps[index] <= trailStart) continue;
      coordinates.push(dataset.timelineCoordinates[index * 2], dataset.timelineCoordinates[index * 2 + 1]);
      timestamps.push(dataset.timelineTimestamps[index]);
    }
    coordinates.push(value.longitude, value.latitude);
    timestamps.push(timestamp);
    map.jumpTo({ center: [value.longitude, value.latitude], bearing: value.bearing, zoom: 16.8 - Math.min(value.speed, 140) / 42 });
    trailRef.current = timestamps.map((time, index) => {
      const point = map.project([coordinates[index * 2], coordinates[index * 2 + 1]]);
      return {x: point.x, y: point.y, time};
    });
    map.triggerRepaint();
  };

  const navigationCanvas = (showTrajectory: boolean) => {
    const map = navigationMapRef.current;
    if (!map) return null;
    const canvas = navigationSurfaceRef.current ?? (navigationSurfaceRef.current = document.createElement("canvas"));
    const source = map.getCanvas();
    if (canvas.width !== source.width || canvas.height !== source.height) {canvas.width=source.width;canvas.height=source.height;}
    const context=canvas.getContext("2d")!;
    context.setTransform(1,0,0,1,0,0);context.clearRect(0,0,canvas.width,canvas.height);
    const publicMap=publicMapRef.current;
    const terrain=publicMap?.terrain?.canvas;
    if(terrain && terrain.style.display!=="none" && terrain.style.visibility!=="hidden") {
      context.globalAlpha=.58;context.drawImage(terrain,0,0,canvas.width,canvas.height);context.globalAlpha=1;
    }
    if(publicMap && publicMap.roads.container.style.visibility!=="hidden" && publicMap.roads.container.style.display!=="none") {
      context.globalCompositeOperation="screen";context.globalAlpha=ROAD_OPACITY_SCALE;
      context.drawImage(publicMap.roads.getCanvas(),0,0,canvas.width,canvas.height);
      context.globalCompositeOperation="source-over";context.globalAlpha=1;
    }
    context.drawImage(source,0,0);
    context.setTransform(canvas.width/MINIMAP_SIZE,0,0,canvas.height/MINIMAP_SIZE,0,0);
    if (showTrajectory) drawMinimapTrail(context,trailRef.current,MINIMAP_SIZE);
    return canvas;
  };

  const waitNavigationFrame = async (map: maplibregl.Map, signal: AbortSignal) => {
    const layers = publicMapRef.current;
    if (!layers) throw new Error("地图尚未就绪。");
    await layers.ready;
    if (mapFailureRef.current) throw new Error(`地图资源加载失败：${mapFailureRef.current}`);
    const rendered = await Promise.all([
      layers.roads.waitForFrame(signal),
      layers.buildings.waitForFrame(signal),
    ]);
    // The base terrain composite consumes the building mask rendered above.
    if (rendered.some(ready => !ready) || !await waitForMapFrame(map, signal)) throw new Error("地图资源或 GPU 帧未完成。");
    await layers.terrain?.waitForFrame();
    if (mapFailureRef.current) throw new Error(`地图资源加载失败：${mapFailureRef.current}`);
  };

  const requestPreview = async () => {
    const frame = previewRef.current;
    if (!frame.active || frame.progress !== null || startingExportRef.current || previewFrameRef.current) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!context) return;
    const timestamp = frame.previewTime ?? frame.range[0];
    const value = sample(frame.dataset, timestamp);
    const map = navigationMapRef.current;
    if (!frame.settings.showMap || !map || !publicMapRef.current || !hasProcessedCoverage(frame.dataset, timestamp)) {
      drawOverlay(context, frame.dataset, frame.range, timestamp, frame.settings, null, value);
      return;
    }
    // Keep one camera pose in flight. During fast scrubbing the next iteration
    // renders the newest requested time, without compositing mismatched layers.
    const controller = new AbortController();
    previewFrameRef.current = controller;
    try {
      const pixelRatio = frame.settings.width / 1920;
      if (map.getPixelRatio() !== pixelRatio) map.setPixelRatio(pixelRatio);
      updateNavigationMap(frame.dataset, timestamp, value);
      await waitNavigationFrame(map, controller.signal);
      const latest = previewRef.current;
      if (!controller.signal.aborted && !startingExportRef.current && latest.active && latest.progress === null
        && latest.dataset === frame.dataset && latest.settings === frame.settings && canvasRef.current === canvas) {
        drawOverlay(context, frame.dataset, frame.range, timestamp, frame.settings, navigationCanvas(scene.current.visibility.trajectory), value);
      }
    } catch {
      if (!controller.signal.aborted && !startingExportRef.current && previewRef.current === frame) {
        drawOverlay(context, frame.dataset, frame.range, timestamp, frame.settings, null, value);
      }
    } finally {
      if (previewFrameRef.current === controller) previewFrameRef.current = null;
      if (previewRef.current !== frame || canvasRef.current !== canvas) void requestPreview();
    }
  };
  const requestPreviewRef = useRef(requestPreview);
  requestPreviewRef.current = requestPreview;

  useEffect(() => {
    const container = navigationContainerRef.current;
    if (!container || !apiKey) return;
    const controller = new AbortController();
    mapFailureRef.current=null;
    const map = new maplibregl.Map({
      transformRequest: cachedMapRequest,
      container, interactive: false, attributionControl: false,
      canvasContextAttributes: { preserveDrawingBuffer: true },
      center: [0, 0], zoom: 15, fadeDuration: 0, bearingSnap: 0, pixelRatio: previewRef.current.settings.width / 1920,
      style: publicBasemapStyle(apiKey),
    });
    navigationMapRef.current = map;
    map.on("error",event=>{mapFailureRef.current=event.error?.message ?? "地图资源加载失败";});
    map.once("load", () => {
      const publicMap=createPublicBasemap(map,apiKey,controller.signal,{
        language:window.replaymod?.settings.mapLanguage ?? "auto",
        buildingCacheLimitMB:window.replaymod?.settings.buildingCacheLimitMB,
        boundaries:false,
        onRaw:raw=>raw?.setVisible(scene.current.visibility.elevation),
      });
      publicMapRef.current=publicMap;
      void publicMap.ready.catch(error=>{mapFailureRef.current=String(error);});
      map.addSource("export-annotations", {type: "geojson", data: committedAnnotationGeometry(scene.current.annotationGeometry)});
      map.addLayer({id: "export-annotation-routes", type: "line", source: "export-annotations", paint: {"line-color": ["get", "color"], "line-width": 2}});
      map.once("idle", () => {
        setIsMapReady(true);
      });
      void requestPreviewRef.current();
    });
    return () => { controller.abort(); previewFrameRef.current?.abort(); publicMapRef.current?.roads.dispose(); publicMapRef.current?.buildings.dispose(); publicMapRef.current=null; setIsMapReady(false); navigationMapRef.current = null; map.remove(); };
  }, [apiKey]);

  const bindNavigationScene = useCallback((renderScene: ReplayScene, engineAnnotations = false) => {
    navigationBindingRef.current?.();
    navigationBindingRef.current = null;
    const map = navigationMapRef.current;
    if (!map) return;
    const releaseChannels = registerMapStyleChannels(renderScene, map, "export/map", layer =>
      layer.id.startsWith("urban-transit-") ? "transit"
        : layer.id.startsWith("export-annotation-") ? engineAnnotations ? null : "annotations"
        : layer.type === "line" && /road|street|transport|bridge|tunnel|highway/i.test(layer.id) ? "roads" : null);
    const apply = () => {
      if (!map.getSource("export-annotations")) return;
      const publicMap=publicMapRef.current,visibility=renderScene.current.visibility;
      publicMap?.roads.setVisible(visibility.roads);
      publicMap?.buildings.setVisible(visibility.buildings);
      publicMap?.terrain?.setVisible(visibility.elevation);
      (map.getSource("export-annotations") as maplibregl.GeoJSONSource | undefined)?.setData(committedAnnotationGeometry(renderScene.current.annotationGeometry));
    };
    map.on("load", apply);
    let previous = renderScene.current;
    const unsubscribe = renderScene.subscribe(snapshot => {
      if (snapshot.annotationGeometry === previous.annotationGeometry && snapshot.visibility === previous.visibility) return;
      previous = snapshot;
      apply();
      if (!engineAnnotations) void requestPreviewRef.current();
    });
    apply();
    navigationBindingRef.current = () => { unsubscribe(); releaseChannels(); map.off("load", apply); };
  }, []);
  useEffect(() => {
    bindNavigationScene(scene);
    return () => { navigationBindingRef.current?.(); navigationBindingRef.current = null; };
  }, [scene, apiKey, bindNavigationScene]);

  useEffect(() => {
    if (!active || progress !== null) return;
    void requestPreviewRef.current();
  }, [dataset, range, settings, active, progress, previewTime, previewContainer, isMapReady]);

  const exportOffline = async () => {
    const bridge = window.replaymod!, canvas = canvasRef.current;
    if (!canvas) { setProgress(null); return; }
    const plan = new OfflineFramePlan({width: settings.width, height: settings.height, fps: settings.fps, bitrate: settings.bitrate * 1_000_000, start: range[0], end: range[1], segmentMilliseconds: settings.segmentMinutes * 60_000});
    const controller = new AbortController();
    frameWaitRef.current = controller;
    let session;
    try { session = await bridge.beginOfflineExport(plan.options); }
    catch (error) { if (frameWaitRef.current === controller) frameWaitRef.current = null; throw error; }
    if (!session) { if (frameWaitRef.current === controller) frameWaitRef.current = null; setProgress(null); return; }
    offlineSessionRef.current = session.id;
    if (cancelExportRef.current) controller.abort();
    const context = canvas.getContext("2d", {willReadFrequently: true});
    const exportScene = createExportScene(scene), navigationMap = navigationMapRef.current;
    const navigationPixelRatio = navigationMap?.getPixelRatio();
    let annotationCapture: ReplayCanvasCapture | undefined;
    let lastProgress = -Infinity;
    try {
      if (!context) throw new Error("无法创建导出画布。");
      if (controller.signal.aborted) throw new Error("导出已取消。");
      bindNavigationScene(exportScene, settings.showMap);
      if (settings.showMap) {
        const container = navigationContainerRef.current;
        if (!container || !navigationMap) throw new Error("导航地图尚未就绪。");
        const pixelRatio = settings.width / 1920;
        navigationMap.setPixelRatio(pixelRatio);
        annotationCapture = new ReplayCanvasCapture(container, exportScene, {width: MINIMAP_SIZE, height: MINIMAP_SIZE, metrics: false, pixelRatio});
        // The shared Layer graph owns annotations for this export. Keep the
        // legacy preview path available and restore it when the session ends.
        if (navigationMap.getLayer("export-annotation-routes")) navigationMap.setLayoutProperty("export-annotation-routes", "visibility", "none");
      }
      await renderOfflineFrames(plan, exportScene.clock, controller.signal, {
        render: async work => {
          const value = sample(dataset, work.timestamp);
          let navigation = null, annotations = null;
          if (settings.showMap && hasProcessedCoverage(dataset, work.timestamp)) {
            const map = navigationMapRef.current;
            if (!map) throw new Error("地图尚未就绪。");
            updateNavigationMap(dataset, work.timestamp, value);
            const center = map.getCenter();
            exportScene.setMapViewState({longitude: center.lng, latitude: center.lat, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch()});
            await waitNavigationFrame(map, controller.signal);
            annotations = annotationCapture ? await annotationCapture.capture(work.timestamp, work.frame, exportScene.current.mapViewState, controller.signal) : null;
            if (annotationCapture && !annotations) throw new Error("标注 GPU 帧未完成，导出已停止。");
            navigation = navigationCanvas(exportScene.current.visibility.trajectory);
          }
          drawOverlay(context, dataset, range, work.timestamp, settings, navigation, value, annotations);
        },
        encode: async work => {
          const pixels = context.getImageData(0, 0, settings.width, settings.height).data;
          await bridge.writeOfflineExportFrame(session.id, work.segment, work.index, new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
        },
        finishSegment: async segment => { await bridge.finishOfflineExportSegment(session.id, segment); },
        progress: value => {
          const now = performance.now();
          if (now - lastProgress >= 250 || value === 1) { setProgress(value); lastProgress = now; }
        },
      });
      const paths = await bridge.completeOfflineExport(session.id);
      setExportError(`已保存 ${paths.length} 段：${paths[0]}`);
    } catch (error) {
      if (!controller.signal.aborted && !cancelExportRef.current) setExportError(error instanceof Error ? error.message : "离线导出失败。");
    } finally {
      try { annotationCapture?.destroy(); } catch (error) { console.error("Export renderer cleanup failed", error); }
      await bridge.cancelOfflineExport(session.id).catch(() => {});
      if (navigationMapRef.current === navigationMap && navigationMap) {
        if (navigationPixelRatio !== undefined) navigationMap.setPixelRatio(navigationPixelRatio);
        bindNavigationScene(scene);
      }
      if (offlineSessionRef.current === session.id) offlineSessionRef.current = null;
      if (frameWaitRef.current === controller) frameWaitRef.current = null;
      setProgress(null);
    }
  };

  const exportVideo = async () => {
    if (progress !== null || startingExportRef.current) return;
    startingExportRef.current = true;
    previewFrameRef.current?.abort();
    cancelExportRef.current = false;
    setExportError(""); setProgress(0);
    try {
      if (!(range[1] > range[0])) throw new Error("请设置晚于入点的出点。");
      const bridge = window.replaymod;
      const offline = typeof bridge?.canExportOffline === "function" && await bridge.canExportOffline();
      if (cancelExportRef.current) { setProgress(null); return; }
      if (!offline) throw new Error("未找到支持透明 VP9 的 FFmpeg，无法逐帧导出。");
      await exportOffline();
    } catch (error) {
      if (!cancelExportRef.current) setExportError(error instanceof Error ? error.message : "导出失败。");
      cancelActiveExport();
      setProgress(null);
    } finally { startingExportRef.current = false; }
  };

  return <section className="overlay-export">
    {/* Keep fixed-size renderers outside hidden workspace pages. */}
    {createPortal(<div ref={navigationContainerRef} className="navigation-map-renderer" style={{width: MINIMAP_SIZE, height: MINIMAP_SIZE}} aria-hidden="true" />, document.body)}
    {previewContainer ? createPortal(<canvas ref={canvasRef} width={settings.width} height={settings.height} aria-label="仪表与小地图预览"/>,previewContainer) : <canvas ref={canvasRef} width={settings.width} height={settings.height} hidden/>}
    <button type="button" disabled={progress !== null} onClick={() => setIsSettingsOpen(true)}>导出设置…</button>
    <span>成片 {duration.toFixed(1)} 秒（1:1）· {settings.width}×{settings.height} / {settings.fps}fps</span>
    <p role="status">{exportError}</p>
    <button type="button" disabled={progress === null && settings.showMap && !isMapReady} onClick={progress === null ? exportVideo : cancelActiveExport}>
      {progress === null ? (settings.showMap && !isMapReady ? "正在加载道路地图…" : "导出透明 WebM") : `取消导出 ${Math.round(progress * 100)}%`}
    </button>
    {isSettingsOpen && createPortal(<div className="export-dialog-backdrop" role="presentation" onMouseDown={() => setIsSettingsOpen(false)}>
      <div className="export-dialog" role="dialog" aria-modal="true" aria-label="导出设置" onMouseDown={(event) => event.stopPropagation()}>
        <h2>导出设置</h2>
        <label>分辨率<select value={`${settings.width}x${settings.height}`} onChange={(event) => {
          const [width, height] = event.target.value.split("x").map(Number); setSettings({ ...settings, width, height });
        }}><option value="1280x720">HD 1280×720</option><option value="1920x1080">Full HD 1920×1080</option><option value="3840x2160">4K 3840×2160</option></select></label>
        <label>帧率<select value={settings.fps} onChange={(event) => setSettings({ ...settings, fps: Number(event.target.value) })}>{[24, 30, 60].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>分段时长<select value={settings.segmentMinutes} onChange={(event) => setSettings({ ...settings, segmentMinutes: Number(event.target.value) })}>{[1, 5, 10, 30].map((value) => <option key={value} value={value}>{value} 分钟 / 段</option>)}</select></label>
        <label>视频码率<select value={settings.bitrate} onChange={(event) => setSettings({ ...settings, bitrate: Number(event.target.value) })}>{[6, 12, 24, 48].map((value) => <option key={value} value={value}>{value} Mbps</option>)}</select></label>
        <label className="check-row"><input type="checkbox" checked={settings.showStats} onChange={(event) => setSettings({ ...settings, showStats: event.target.checked })} />时间 / 速度 / 海拔 / 坡度</label>
        <label className="check-row"><input type="checkbox" checked={settings.showMap} onChange={(event) => setSettings({ ...settings, showMap: event.target.checked })} />轨迹小地图</label>
        <div className="dialog-actions"><button type="button" onClick={() => setIsSettingsOpen(false)}>完成</button></div>
      </div>
    </div>, document.body)}
  </section>;
}
