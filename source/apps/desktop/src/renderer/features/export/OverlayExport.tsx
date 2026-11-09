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
import { ReplayClock } from "../../render-engine/ReplayClock";
import { registerMapStyleChannels } from "../../render-engine/MapRenderChannels";
import type { ReplayScene } from "../../render-engine/ReplayScene";
import { committedAnnotationGeometry } from "../../render-engine/AnnotationGeometry";
import { waitForMapFrame } from "../../render-engine/MapFrameBarrier";
import { compileFootprintPaths } from "../../render-engine/FootprintGeometry";

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
  const shared = exportTrajectory(dataset).sample(timestamp);
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
  const altitude = hasAltitude ? altitude0 + (altitude1 - altitude0) * ratio : Number.NaN;
  return {
    longitude: shared?.position[0] ?? lon0,
    latitude: shared?.position[1] ?? lat0,
    speed: Math.hypot(dx, dy) / seconds * 3.6,
    altitude,
    grade: hasAltitude && Math.hypot(dx, dy) > 1 ? (altitude1 - altitude0) / Math.hypot(dx, dy) * 100 : Number.NaN,
    bearing: shared?.heading ?? Math.atan2(dx, dy) * 180 / Math.PI,
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

  if (settings.showMap) {
  const mapX = 60;
  const mapY = 720;
  const mapSize = 410;
  if (navigationCanvas) context.drawImage(navigationCanvas, mapX, mapY, mapSize, 302);
  if (annotationCanvas) context.drawImage(annotationCanvas, mapX, mapY, mapSize, 302);
  const markerX = mapX + mapSize / 2;
  const markerY = mapY + 151;
  context.fillStyle = "#ff3b30";
  context.strokeStyle = "white"; context.lineWidth = 3;
  context.beginPath(); context.moveTo(markerX, markerY - 14); context.lineTo(markerX + 10, markerY + 11); context.lineTo(markerX, markerY + 6); context.lineTo(markerX - 10, markerY + 11); context.closePath(); context.fill(); context.stroke();
  context.shadowBlur = 5;
  context.font = "700 22px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  const directions = [{ label: "N", bearing: 0 }, { label: "E", bearing: 90 }, { label: "S", bearing: 180 }, { label: "W", bearing: 270 }];
  for (const direction of directions) {
    const angle = (direction.bearing - value.bearing) * Math.PI / 180 - Math.PI / 2;
    const x = markerX + Math.cos(angle) * 180;
    const y = markerY + Math.sin(angle) * 126;
    context.fillStyle = direction.label === "N" ? "#ff4a40" : "white";
    context.fillText(direction.label, x, y);
  }
  context.textAlign = "start";
  context.textBaseline = "alphabetic";
  context.shadowBlur = 0;
  }
};

export function OverlayExport({ dataset, range, apiKey, scene }: { dataset: PointDataset; range: TimeBounds; apiKey: string; scene: ReplayScene }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const navigationContainerRef = useRef<HTMLDivElement>(null);
  const navigationMapRef = useRef<maplibregl.Map | null>(null);
  const navigationBindingRef = useRef<(() => void) | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const captureStreamRef = useRef<MediaStream | null>(null);
  const cancelExportRef = useRef(false);
  const frameWaitRef = useRef<AbortController | null>(null);
  const exportClock = useRef(new ReplayClock());
  const offlineSessionRef = useRef<string | null>(null);
  const startingExportRef = useRef(false);
  const cancelActiveExport = useCallback(() => {
    cancelExportRef.current = true;
    frameWaitRef.current?.abort();
    const id = offlineSessionRef.current;
    if (id) { offlineSessionRef.current = null; void window.replaymod?.cancelOfflineExport(id).catch(() => {}); }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorder?.stream.getTracks().forEach(track => track.stop());
    captureStreamRef.current?.getTracks().forEach(track => track.stop());
    captureStreamRef.current = null;
  }, []);
  const [settings, setSettings] = useCachedState<ExportSettings>("export-settings", { width: 1920, height: 1080, fps: 30, segmentMinutes: 10, bitrate: 12, showStats: true, showMap: true });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMapReady, setIsMapReady] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [exportError, setExportError] = useState("");
  const duration = useMemo(() => (range[1] - range[0]) / 1000, [range]);
  useEffect(() => cancelActiveExport, [dataset, range, settings, cancelActiveExport]);

  const updateNavigationMap = (timestamp: number, value = sample(dataset, timestamp)) => {
    const map = navigationMapRef.current;
    if (!map?.isStyleLoaded()) return;
    const secondsVisible = Math.max(18, Math.min(90, 18 + value.speed * 0.6));
    const first = Math.max(0, lowerBound(dataset.timelineTimestamps, timestamp - secondsVisible * 1000));
    const last = Math.min(dataset.timelineTimestamps.length, lowerBound(dataset.timelineTimestamps, timestamp));
    const coordinates: number[] = [];
    const timestamps: number[] = [];
    const step = Math.max(1, Math.ceil((last - first) / 500));
    for (let index = first; index < last; index += step) {
      coordinates.push(dataset.timelineCoordinates[index * 2], dataset.timelineCoordinates[index * 2 + 1]);
      timestamps.push(dataset.timelineTimestamps[index]);
    }
    coordinates.push(value.longitude, value.latitude);
    timestamps.push(timestamp);
    (map.getSource("local-route") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: compileFootprintPaths(coordinates, timestamps) } });
    map.jumpTo({ center: [value.longitude, value.latitude], bearing: value.bearing, zoom: 16.8 - Math.min(value.speed, 140) / 42 });
    map.triggerRepaint();
  };

  useEffect(() => {
    const container = navigationContainerRef.current;
    if (!container || !apiKey) return;
    const map = new maplibregl.Map({
      transformRequest: cachedMapRequest,
      container, interactive: false, attributionControl: false,
      canvasContextAttributes: { preserveDrawingBuffer: true },
      center: [0, 0], zoom: 15,
      style: `https://api.maptiler.com/maps/streets-v2/style.json?key=${encodeURIComponent(apiKey)}`,
    });
    navigationMapRef.current = map;
    map.once("load", () => {
      for (const layer of map.getStyle().layers) {
        const isRoadLine = layer.type === "line" && /road|street|transport|bridge|tunnel|highway/i.test(layer.id);
        if (!isRoadLine) map.setLayoutProperty(layer.id, "visibility", "none");
      }
      map.addSource("local-route", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } } });
      map.addLayer({ id: "route-casing", type: "line", source: "local-route", paint: { "line-color": "rgba(0,0,0,.9)", "line-width": 9 } });
      map.addLayer({ id: "route", type: "line", source: "local-route", paint: { "line-color": "#ffd500", "line-width": 5 } });
      map.addSource("export-annotations", {type: "geojson", data: committedAnnotationGeometry(scene.current.annotationGeometry)});
      map.addLayer({id: "export-annotation-routes", type: "line", source: "export-annotations", paint: {"line-color": ["get", "color"], "line-width": 2}});
      updateNavigationMap(range[0]);
      map.once("idle", () => {
        setIsMapReady(true);
        const context = canvasRef.current?.getContext("2d");
        if (context) drawOverlay(context, dataset, range, range[0], settings, map.getCanvas());
      });
    });
    return () => { setIsMapReady(false); navigationMapRef.current = null; map.remove(); };
  }, [apiKey, dataset]);

  const bindNavigationScene = useCallback((renderScene: ReplayScene, engineAnnotations = false) => {
    navigationBindingRef.current?.();
    navigationBindingRef.current = null;
    const map = navigationMapRef.current;
    if (!map) return;
    const releaseChannels = registerMapStyleChannels(renderScene, map, "export/map", layer =>
      layer.id === "route" || layer.id === "route-casing" ? "trajectory"
        : layer.id.startsWith("export-annotation-") ? engineAnnotations ? null : "annotations"
        : layer.type === "line" && /road|street|transport|bridge|tunnel|highway/i.test(layer.id) ? "roads" : null);
    const apply = () => {
      if (!map.getSource("local-route")) return;
      (map.getSource("export-annotations") as maplibregl.GeoJSONSource | undefined)?.setData(committedAnnotationGeometry(renderScene.current.annotationGeometry));
    };
    map.on("load", apply);
    let previous = renderScene.current.annotationGeometry;
    const unsubscribe = renderScene.subscribe(snapshot => {
      if (snapshot.annotationGeometry === previous) return;
      previous = snapshot.annotationGeometry;
      apply();
    });
    apply();
    navigationBindingRef.current = () => { unsubscribe(); releaseChannels(); map.off("load", apply); };
  }, []);
  useEffect(() => {
    bindNavigationScene(scene);
    return () => { navigationBindingRef.current?.(); navigationBindingRef.current = null; };
  }, [scene, apiKey, dataset, bindNavigationScene]);

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    updateNavigationMap(range[0]);
    if (context) drawOverlay(context, dataset, range, range[0], settings, navigationMapRef.current?.getCanvas() ?? null);
  }, [dataset, range, settings]);

  const exportRealtime = async () => {
    const canvas = canvasRef.current;
    if (!canvas) { setProgress(null); return; }
    const mimeType = ["video/webm;codecs=vp9", "video/webm"].find(MediaRecorder.isTypeSupported);
    if (!mimeType) { setExportError("当前环境不支持 WebM 视频编码。"); setProgress(null); return; }
    if (!(range[1] > range[0])) { setExportError("请设置晚于入点的出点。"); return; }
    cancelExportRef.current = false;
    setExportError("");
    frameWaitRef.current?.abort();
    const frameController = new AbortController();
    frameWaitRef.current = frameController;
    setProgress(0);
    updateNavigationMap(range[0]);
    const initialMap = navigationMapRef.current;
    if (settings.showMap && initialMap && !await waitForMapFrame(initialMap, frameController.signal)) {
      if (!cancelExportRef.current) setExportError("地图首帧未及时完成，请重试。");
      setProgress(null);
      return;
    }
    if (frameController.signal.aborted) { setProgress(null); return; }
    const initialContext = canvas.getContext("2d");
    if (!initialContext) { setExportError("无法创建导出画布。"); setProgress(null); return; }
    drawOverlay(initialContext, dataset, range, range[0], settings, initialMap?.getCanvas() ?? null);
    // Submit only completed compositions. Automatic capture can encode the
    // previous map canvas while its asynchronous renderer is still working.
    const stream = canvas.captureStream(0);
    captureStreamRef.current = stream;
    const videoTrack = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    // Let the capture source receive its first completed bitmap before the
    // encoder starts; otherwise Chromium can prepend an empty alpha frame.
    videoTrack.requestFrame();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (frameController.signal.aborted) { stream.getTracks().forEach(track => track.stop()); setProgress(null); return; }
    const segmentMilliseconds = settings.segmentMinutes * 60_000;
    const segmentCount = Math.max(1, Math.ceil((range[1] - range[0]) / segmentMilliseconds));

    const recordSegment = (segmentIndex: number) => {
      const segmentStart = range[0] + segmentIndex * segmentMilliseconds;
      const segmentEnd = Math.min(segmentStart + segmentMilliseconds, range[1]);
      const segmentDuration = Math.max((segmentEnd - segmentStart) / 1000, 0.001);
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: settings.bitrate * 1_000_000 });
      recorderRef.current = recorder;
      recorder.onerror = () => {
        cancelExportRef.current = true;
        frameController.abort();
        stream.getTracks().forEach(track => track.stop());
        recorderRef.current = null;
        setProgress(null);
        setExportError("视频编码失败，导出已停止。请调整设置后重试。");
      };
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => {
        if (!cancelExportRef.current && chunks.length) {
          const url = URL.createObjectURL(new Blob(chunks, { type: mimeType }));
          const link = document.createElement("a");
          link.href = url;
          link.download = `轨迹叠加-${String(segmentIndex + 1).padStart(3, "0")}-共${segmentCount}段.webm`;
          link.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
        }
        if (!cancelExportRef.current && segmentIndex + 1 < segmentCount) {
          recordSegment(segmentIndex + 1);
        } else {
          stream.getTracks().forEach((track) => track.stop());
          recorderRef.current = null;
          setProgress(null);
        }
      };
      const startedAt = performance.now();
      let lastProgressUpdate = 0;
      let lastFrame = -1;
      recorder.start(1000);
      const frame = async (now: number) => {
        if (recorder.state !== "recording") return;
        const elapsed = Math.floor(((now - startedAt) / 1000) * settings.fps) / settings.fps;
        const frameIndex = Math.round(elapsed * settings.fps);
        if (frameIndex === lastFrame) { requestAnimationFrame(frame); return; }
        lastFrame = frameIndex;
        const segmentRatio = Math.min(elapsed / segmentDuration, 1);
        const timestamp = segmentStart + (segmentEnd - segmentStart) * segmentRatio;
        exportClock.current.step(timestamp, Math.round(elapsed * settings.fps));
        const frameTime = exportClock.current.current.time!;
        const context = canvas.getContext("2d");
        updateNavigationMap(frameTime);
        const map = navigationMapRef.current;
        if (settings.showMap && map) {
          const rendered = await waitForMapFrame(map, frameController.signal);
          if (!rendered || cancelExportRef.current || recorder.state !== "recording") {
            if (!cancelExportRef.current && !rendered) {
              setExportError("地图帧未及时完成，导出已停止。请重试。");
              cancelExportRef.current = true;
            }
            if (recorder.state === "recording") recorder.stop();
            return;
          }
        }
        if (context) drawOverlay(context, dataset, range, frameTime, settings, navigationMapRef.current?.getCanvas() ?? null);
        videoTrack.requestFrame();
        if (now - lastProgressUpdate >= 250 || segmentRatio >= 1) {
          setProgress((timestamp - range[0]) / Math.max(range[1] - range[0], 1));
          lastProgressUpdate = now;
        }
        if (segmentRatio >= 1) requestAnimationFrame(() => { if (recorder.state === "recording") recorder.stop(); });
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    };
    recordSegment(0);
  };

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
        annotationCapture = new ReplayCanvasCapture(container, exportScene, {width: 410, height: 302, metrics: false, pixelRatio});
        // The shared Layer graph owns annotations for this export. Keep the
        // legacy preview path available and restore it when the session ends.
        if (navigationMap.getLayer("export-annotation-routes")) navigationMap.setLayoutProperty("export-annotation-routes", "visibility", "none");
      }
      await renderOfflineFrames(plan, exportScene.clock, controller.signal, {
        render: async work => {
          const value = sample(dataset, work.timestamp);
          const map = settings.showMap ? navigationMapRef.current : null;
          if (map) { updateNavigationMap(work.timestamp, value); const center = map.getCenter(); exportScene.setMapViewState({longitude: center.lng, latitude: center.lat, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch()}); }
          if (settings.showMap && (!map || !await waitForMapFrame(map, controller.signal))) throw new Error("地图帧未及时完成，导出已停止。");
          const annotations = annotationCapture ? await annotationCapture.capture(work.timestamp, work.frame, exportScene.current.mapViewState, controller.signal) : null;
          if (annotationCapture && !annotations) throw new Error("标注 GPU 帧未完成，导出已停止。");
          drawOverlay(context, dataset, range, work.timestamp, settings, map?.getCanvas() ?? null, value, annotations);
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
    cancelExportRef.current = false;
    setExportError(""); setProgress(0);
    try {
      if (!(range[1] > range[0])) throw new Error("请设置晚于入点的出点。");
      const bridge = window.replaymod;
      const offline = typeof bridge?.canExportOffline === "function" && await bridge.canExportOffline();
      if (cancelExportRef.current) { setProgress(null); return; }
      if (offline) await exportOffline();
      else await exportRealtime();
    } catch (error) {
      if (!cancelExportRef.current) setExportError(error instanceof Error ? error.message : "导出失败。");
      cancelActiveExport();
      setProgress(null);
    } finally { startingExportRef.current = false; }
  };

  return <section className="overlay-export">
    <div ref={navigationContainerRef} className="navigation-map-renderer" aria-hidden="true" />
    <canvas ref={canvasRef} width={settings.width} height={settings.height} />
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
