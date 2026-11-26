import {createPublicBasemap, publicBasemapStyle} from "../map/PublicBasemap";
import {ROAD_OPACITY_SCALE} from "../map/basemapStyle";
import {drawMinimapTrail, MINIMAP_TRAIL_MILLISECONDS, type TrailPoint} from "./MinimapTrail";
import { drawCircularMinimap, MINIMAP_SIZE } from "./CircularMinimap";
import { createExportScene } from "../../render-engine/export/ReplaySceneExport";
import { ReplayCanvasCapture } from "../../render-engine/export/ReplayCanvasCapture";
import { compositeOverlayTop, compositeSourceDuration, OfflineFramePlan, type CompositeExportRequest } from "../../../shared/overlayExport";
import { videoTimeBounds } from "./VideoPreview";
import { renderOfflineFrames } from "../../render-engine/export/OfflineFramePump";
import { useCachedState, cachedMapRequest } from "../../shared/cache";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import maplibregl from "maplibre-gl";
import type { PointDataset, TimeBounds } from "../../../../../../packages/data/src";
import type { MediaSource } from "../../../../../../packages/media/src";
import { TrajectoryBuffer } from "../../render-engine/buffers/TrajectoryBuffer";
import { registerMapStyleChannels } from "../../render-engine/MapRenderChannels";
import type { ReplayScene } from "../../render-engine/ReplayScene";
import { committedAnnotationGeometry } from "../../render-engine/AnnotationGeometry";
import { waitForMapFrame } from "../../render-engine/MapFrameBarrier";
import { smoothedSpeed, hasProcessedCoverage } from "../timeline/metrics";
import { HEADING_HALF_WINDOW_MS, minimapHeading } from "./MinimapHeading";

const exportTrajectory = (dataset: PointDataset) => TrajectoryBuffer.fromPointDataset(dataset);

type FrameStage = "map-init" | "map-resource" | "roads" | "buildings" | "basemap" | "terrain" | "annotations";

class FrameRenderError extends Error {
  constructor(readonly stage: FrameStage, message: string) {
    super(message);
  }
}

interface ExportSettings {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  rateControl?: "quality" | "bitrate";
  crf?: number;
  showStats: boolean;
  showMap: boolean;
  followSource: boolean;
  encodingPreset?: keyof typeof encodingPresets;
  format?: "h264" | "hevc" | "transparent";
  encoder?: "auto" | "software";
}

const nearestBitrate = (bitrate: number | null | undefined) => {
  const mbps = (bitrate ?? 12_000_000) / 1_000_000;
  return [6, 12, 24, 48].reduce((best, value) => Math.abs(value - mbps) < Math.abs(best - mbps) ? value : best, 12);
};

const formatBytes = (bytes: number) => {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000).toFixed(1)} KB`;
};
const encodingPresets = {
  quality: {label: "高质量（较慢）", cpuUsed: 2},
  balanced: {label: "平衡", cpuUsed: 4},
  fast: {label: "快速", cpuUsed: 5},
} as const;
const crfPresets = [
  {value: 23, label: "高画质", h264: 18, hevc: 21, hardware: 82},
  {value: 30, label: "均衡", h264: 23, hevc: 26, hardware: 70},
  {value: 36, label: "较小体积", h264: 28, hevc: 31, hardware: 55},
];
const crfForFormat = (preset: typeof crfPresets[number], format: NonNullable<ExportSettings["format"]>) =>
  format === "transparent" ? preset.value : preset[format];

const lowerBound = (values: ArrayLike<number>, target: number) => {
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

export function OverlayExport({ dataset, range, apiKey, scene, source = null, mediaOffsetMs = 0, active = true, previewContainer = null, previewTime = null, prepareExportDataset }: { dataset: PointDataset; range: TimeBounds; apiKey: string; scene: ReplayScene; source?: MediaSource|null; mediaOffsetMs?: number; active?: boolean; previewContainer?: HTMLDivElement|null; previewTime?: number|null; prepareExportDataset?: (sampleRateHz: number, signal: AbortSignal) => Promise<PointDataset|undefined> }) {
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
  const [settings, setSettings] = useCachedState<ExportSettings>("export-settings", { width: 1920, height: 1080, fps: 30, bitrate: 12, showStats: true, showMap: true, followSource: false });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMapReady, setIsMapReady] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [activeEncoder, setActiveEncoder] = useState<string | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [sampleEstimate, setSampleEstimate] = useState<{dataset: PointDataset; range: TimeBounds; settings: ExportSettings; source: MediaSource | null; mediaOffsetMs: number; bytes: number} | null>(null);
  const [exportError, setExportError] = useState("");
  const previewRef = useRef({dataset, range, settings, progress, active, previewTime});
  previewRef.current = {dataset, range, settings, progress, active, previewTime};
  const format = settings.format ?? "h264";
  const composite = format !== "transparent";
  const platform = window.replaymod?.platform;
  const hardwareAvailable = composite && (platform === "darwin" || platform === "win32");
  const preferHardware = hardwareAvailable && settings.encoder !== "software";
  const sourceBounds = videoTimeBounds(source);
  const sourceDuration = source ? compositeSourceDuration(source) : null;
  const sourceStart = sourceBounds === null || sourceDuration === null ? null : sourceBounds[0] + mediaOffsetMs;
  const exportStart = composite && sourceStart !== null ? Math.max(range[0], sourceStart) : range[0];
  const exportEnd = composite && sourceStart !== null && sourceDuration !== null
    ? Math.min(range[1], sourceStart + sourceDuration * 1000) : range[1];
  const duration = composite && sourceStart === null ? 0 : Math.max(0, (exportEnd - exportStart) / 1000);
  const canStart = duration > 0 && (!settings.showMap || isMapReady);
  const sourceVideo = source?.tracks.find(track => track.kind === "video");
  const sourceSettings = sourceVideo?.width && sourceVideo.height ? {
    width: sourceVideo.width,
    height: sourceVideo.height,
    fps: Math.max(1, Math.min(120, Math.round(sourceVideo.frameRate ?? settings.fps))),
    bitrate: nearestBitrate(sourceVideo.bitrate),
  } : null;
  const useConstantQuality = settings.rateControl === "quality" || (settings.rateControl === undefined && !settings.followSource);
  const encodingPreset = settings.encodingPreset ?? (!composite && useConstantQuality ? "quality" : "balanced");
  const quality = crfPresets.find(preset => preset.value === settings.crf) ?? crfPresets[1];
  const crf = crfForFormat(quality, format);
  const targetBitrate = Math.round(settings.bitrate * 1_000_000);
  const currentSample = sampleEstimate?.dataset === dataset && sampleEstimate.range === range && sampleEstimate.settings === settings
    && sampleEstimate.source === source && sampleEstimate.mediaOffsetMs === mediaOffsetMs
    ? sampleEstimate.bytes : null;
  const audioBitrate = composite ? (source?.tracks.filter(track => track.kind === "audio").length ?? 0) * 192_000 : 0;
  const estimatedSize = useConstantQuality ? currentSample : duration * (targetBitrate + audioBitrate) / 8;
  const updateSettings = (next: Partial<ExportSettings>) => setSettings({...settings, ...next});
  const applyFollowSource = (checked: boolean) => updateSettings({
    followSource: checked,
    ...(checked && sourceSettings ? sourceSettings : {}),
    rateControl: useConstantQuality ? "quality" : "bitrate",
  });
  useEffect(() => cancelActiveExport, [dataset, range, settings, source, mediaOffsetMs, cancelActiveExport]);

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

  const waitNavigationFrame = async (map: maplibregl.Map, signal: AbortSignal, immediate = false) => {
    const layers = publicMapRef.current;
    if (!layers) throw new FrameRenderError("map-init", "地图尚未就绪。");
    try { await layers.ready; }
    catch { throw new FrameRenderError("map-resource", "底图资源初始化失败。"); }
    if (mapFailureRef.current) throw new FrameRenderError("map-resource", `地图资源加载失败：${mapFailureRef.current}`);
    await Promise.all([
      layers.roads.waitForFrame(signal, immediate).then(ready => {
        if (!ready) throw new FrameRenderError("roads", "道路图层未完成渲染。");
      }),
      layers.buildings.waitForFrame(signal, immediate).then(ready => {
        if (!ready) throw new FrameRenderError("buildings", "建筑图层未完成渲染。");
      }),
    ]);
    // The base terrain composite consumes the building mask rendered above.
    if (!await waitForMapFrame(map, signal, undefined, immediate)) throw new FrameRenderError("basemap", "底图未完成渲染。");
    try { await layers.terrain?.waitForFrame(); }
    catch { throw new FrameRenderError("terrain", "地形 GPU 帧未完成。"); }
    if (mapFailureRef.current) throw new FrameRenderError("map-resource", `地图资源加载失败：${mapFailureRef.current}`);
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
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        transformRequest: cachedMapRequest, container, interactive: false, attributionControl: false,
        canvasContextAttributes: { preserveDrawingBuffer: true },
        center: [0, 0], zoom: 15, fadeDuration: 0, bearingSnap: 0, pixelRatio: previewRef.current.settings.width / 1920,
        style: publicBasemapStyle(apiKey),
      });
    } catch (error) {
      container.replaceChildren();
      console.error("Minimap renderer initialization failed", error);
      mapFailureRef.current = "无法初始化小地图。可关闭「轨迹小地图」后导出。";
      return;
    }
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

  const exportOffline = async (estimate: boolean, controller: AbortController) => {
    const bridge = window.replaymod!;
    const exportDataset = prepareExportDataset ? await prepareExportDataset(settings.fps, controller.signal) : dataset;
    controller.signal.throwIfAborted();
    if (!exportDataset) throw new Error("导出前无法准备高精度轨迹。");
    const fullPlan = new OfflineFramePlan({
      width: settings.width, height: settings.height, fps: settings.fps,
      ...(useConstantQuality ? {bitrate: 0, crf} : {bitrate: targetBitrate}),
      cpuUsed: encodingPresets[encodingPreset].cpuUsed,
      start: exportStart, end: exportEnd,
    });
    const sampleDurationMs = Math.min(1000, exportEnd - exportStart);
    const sampleStart = exportStart + (exportEnd - exportStart - sampleDurationMs) / 2;
    const plan = estimate && sampleDurationMs < exportEnd - exportStart
      ? new OfflineFramePlan({...fullPlan.options, start: sampleStart, end: sampleStart + sampleDurationMs})
      : fullPlan;
    let request: CompositeExportRequest | undefined;
    if (format !== "transparent" && source && sourceStart !== null) {
      request = {
        sourcePath: source.sourcePath, offsetSeconds: (plan.options.start - sourceStart) / 1000, codec: format,
        preferHardware, hardwareQuality: useConstantQuality ? quality.hardware : undefined,
      };
    }
    const session = await (estimate ? bridge.beginExportEstimate(plan.options, request) : bridge.beginOfflineExport(plan.options, request));
    if (!session) { setProgress(null); return; }
    offlineSessionRef.current = session.id;
    const hardwareNames = {videotoolbox: "VideoToolbox", nvenc: "NVENC", qsv: "Quick Sync", amf: "AMF"};
    const selectedEncoder = request ? (session.hardware ? `${hardwareNames[session.hardware]} 硬件编码` : "软件编码") : null;
    setActiveEncoder(selectedEncoder);
    if (cancelExportRef.current) controller.abort();
    // A dedicated canvas creates its context with the readback hint on the
    // first call and leaves the interactive preview untouched during export.
    const canvas = document.createElement("canvas");
    canvas.width = settings.width;
    canvas.height = settings.height;
    const context = canvas.getContext("2d", {willReadFrequently: true});
    const exportScene = createExportScene(scene), navigationMap = navigationMapRef.current;
    const navigationPixelRatio = navigationMap?.getPixelRatio();
    let annotationCapture: ReplayCanvasCapture | undefined;
    let lastProgress = -Infinity;
    let sampleBytes: number | undefined;
    let frameIndex = -1;
    const overlayTop = request ? compositeOverlayTop(settings.height) : 0;
    const exportStarted = performance.now();
    let renderMs = 0, readbackMs = 0, writeMs = 0, finalizeMs = 0;
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
          frameIndex = work.frame;
          const started = performance.now();
          const value = sample(exportDataset, work.timestamp);
          let navigation = null, annotations = null;
          if (settings.showMap && hasProcessedCoverage(exportDataset, work.timestamp)) {
            const map = navigationMapRef.current;
            if (!map) throw new Error("地图尚未就绪。");
            updateNavigationMap(exportDataset, work.timestamp, value);
            const center = map.getCenter();
            exportScene.setMapViewState({longitude: center.lng, latitude: center.lat, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch()});
            [annotations] = await Promise.all([
              annotationCapture?.capture(work.timestamp, work.frame, exportScene.current.mapViewState, controller.signal) ?? null,
              waitNavigationFrame(map, controller.signal, true),
            ]);
            if (annotationCapture && !annotations) throw new FrameRenderError("annotations", "标注 GPU 帧未完成，导出已停止。");
            navigation = navigationCanvas(exportScene.current.visibility.trajectory);
          }
          drawOverlay(context, exportDataset, range, work.timestamp, settings, navigation, value, annotations);
          const readbackStarted = performance.now();
          renderMs += readbackStarted - started;
          const pixels = context.getImageData(0, overlayTop, settings.width, settings.height - overlayTop).data;
          readbackMs += performance.now() - readbackStarted;
          return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
        },
        encode: async (work, pixels) => {
          const started = performance.now();
          await bridge.writeOfflineExportFrame(session.id, work.segment, work.index, pixels);
          writeMs += performance.now() - started;
        },
        finishSegment: async segment => {
          const started = performance.now();
          const result = await bridge.finishOfflineExportSegment(session.id, segment);
          finalizeMs += performance.now() - started;
          sampleBytes = result.sampleBytes;
        },
        progress: value => {
          const now = performance.now();
          if (now - lastProgress >= 250 || value === 1) { setProgress(value); lastProgress = now; }
        },
      });
      const paths = await bridge.completeOfflineExport(session.id);
      if (estimate && sampleBytes !== undefined) {
        setSampleEstimate({dataset, range, settings, source, mediaOffsetMs, bytes: Math.round(sampleBytes * fullPlan.totalFrames / plan.totalFrames)});
      } else if (!estimate) {
        console.info(`[offline-export] complete frames=${plan.totalFrames} elapsed_ms=${Math.round(performance.now() - exportStarted)} render_ms=${Math.round(renderMs)} readback_ms=${Math.round(readbackMs)} write_ms=${Math.round(writeMs)} finalize_ms=${Math.round(finalizeMs)}`);
        setExportError(`已保存：${paths[0]}${selectedEncoder ? `（${selectedEncoder}）` : ""}`);
      }
    } catch (error) {
      if (!controller.signal.aborted && !cancelExportRef.current) {
        const stage = error instanceof FrameRenderError ? error.stage : "other";
        const seconds = (Math.max(0, frameIndex) / settings.fps).toFixed(3);
        console.error(`[offline-export] failed stage=${stage} frame=${frameIndex} seconds=${seconds}`);
        setExportError(error instanceof Error ? error.message : "离线导出失败。");
      }
    } finally {
      controller.abort();
      try { annotationCapture?.destroy(); } catch (error) { console.error("Export renderer cleanup failed", error); }
      await bridge.cancelOfflineExport(session.id).catch(() => {});
      if (navigationMapRef.current === navigationMap && navigationMap) {
        if (navigationPixelRatio !== undefined) navigationMap.setPixelRatio(navigationPixelRatio);
        bindNavigationScene(scene);
      }
      if (offlineSessionRef.current === session.id) offlineSessionRef.current = null;
      setProgress(null);
    }
  };

  const exportVideo = async (estimate = false) => {
    if (progress !== null || startingExportRef.current) return;
    startingExportRef.current = true;
    if (!estimate) setIsSettingsOpen(false);
    setEstimating(estimate);
    setActiveEncoder(null);
    previewFrameRef.current?.abort();
    cancelExportRef.current = false;
    const controller = new AbortController();
    frameWaitRef.current = controller;
    setExportError(""); setProgress(0);
    try {
      if (!canStart || !window.replaymod) throw new Error("无法开始导出，请检查视频、导出区间和地图状态。");
      await exportOffline(estimate, controller);
    } catch (error) {
      if (!cancelExportRef.current) setExportError(error instanceof Error ? error.message : "导出失败。");
      cancelActiveExport();
      setProgress(null);
    } finally {
      if (frameWaitRef.current === controller) frameWaitRef.current = null;
      startingExportRef.current = false;
      setEstimating(false);
    }
  };

  return <section className="overlay-export">
    {/* Keep fixed-size renderers outside hidden workspace pages. */}
    {createPortal(<div ref={navigationContainerRef} className="navigation-map-renderer" style={{width: MINIMAP_SIZE, height: MINIMAP_SIZE}} aria-hidden="true" />, document.body)}
    {previewContainer ? createPortal(<canvas ref={canvasRef} width={settings.width} height={settings.height} aria-label="仪表与小地图预览"/>,previewContainer) : <canvas ref={canvasRef} width={settings.width} height={settings.height} hidden/>}
    <button type="button" onClick={progress === null ? () => setIsSettingsOpen(true) : cancelActiveExport}>
      {progress === null ? "导出..." : `取消${estimating ? "估算" : "导出"} ${Math.round(progress * 100)}%`}
    </button>
    {duration > 0 && <span>{composite ? "合成视频" : "透明叠加"} {duration.toFixed(1)} 秒 · {settings.width}×{settings.height} / {settings.fps}fps · {estimatedSize !== null ? `预计 ${formatBytes(estimatedSize)}` : preferHardware ? "按画质压制" : `按画质压制 · CRF ${crf}`}</span>}
    <p role="status">{progress !== null ? activeEncoder : exportError}</p>
    {isSettingsOpen && createPortal(<div className="export-dialog-backdrop" role="presentation" onMouseDown={() => setIsSettingsOpen(false)}>
      <div className="export-dialog" role="dialog" aria-modal="true" aria-label="导出设置" onMouseDown={(event) => event.stopPropagation()}>
        <h2>导出设置</h2>
        <label>分辨率<select value={`${settings.width}x${settings.height}`} onChange={(event) => {
          const [width, height] = event.target.value.split("x").map(Number); updateSettings({ width, height, followSource: false });
        }}><option value="1280x720">HD 1280×720</option><option value="1920x1080">Full HD 1920×1080</option><option value="3840x2160">4K 3840×2160</option></select></label>
        <label>帧率<select value={settings.fps} onChange={(event) => updateSettings({ fps: Number(event.target.value), followSource: false })}>{[24, 30, 60].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>导出格式<select value={format} onChange={(event) => updateSettings({format: event.target.value as ExportSettings["format"]})}>
          <option value="h264">合成 MP4 · H.264</option>
          <option value="hevc">合成 MP4 · H.265</option>
          <option value="transparent">仅透明叠加 · WebM</option>
        </select></label>
        {hardwareAvailable && <label>编码器<select value={preferHardware ? "auto" : "software"} onChange={event => {
          updateSettings({encoder: event.target.value === "software" ? "software" : "auto"});
        }}><option value="auto">自动 · 优先硬件编码</option><option value="software">软件编码</option></select></label>}
        {composite && (sourceStart === null || duration === 0 || exportStart !== range[0] || exportEnd !== range[1]) &&
          <p role="status">{sourceStart === null ? "合成需要载入带时间对齐的原视频。" : duration === 0 ? "导出区间与原视频没有重叠。" : `将合成导出区间与原视频重叠的 ${duration.toFixed(1)} 秒。`}</p>}
        <label>{preferHardware ? "软件回退预设" : "压制预设"}<select value={encodingPreset} onChange={(event) => {
          const value = event.target.value as keyof typeof encodingPresets;
          updateSettings({ encodingPreset: value });
        }}>{Object.entries(encodingPresets).map(([value, {label}]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>压制模式<select value={useConstantQuality ? "quality" : "bitrate"} onChange={(event) => {
          const rateControl = event.target.value === "quality" ? "quality" : "bitrate";
          updateSettings({
            rateControl,
            ...(rateControl === "bitrate" && settings.followSource && sourceSettings ? {bitrate: sourceSettings.bitrate} : {}),
          });
        }}><option value="quality">{preferHardware ? "按画质" : "按画质（CRF）"}</option><option value="bitrate">按目标码率</option></select></label>
        {useConstantQuality
          ? <label>视频画质<select value={quality.value} onChange={(event) => updateSettings({ crf: Number(event.target.value) })}>
            {crfPresets.map(preset => <option key={preset.value} value={preset.value}>{preset.label}{preferHardware ? "" : ` · CRF ${crfForFormat(preset, format)}`}</option>)}
          </select></label>
          : <label>视频码率<select value={settings.bitrate} onChange={(event) => updateSettings({ bitrate: Number(event.target.value), followSource: false })}>{[6, 12, 24, 48].map((value) => <option key={value} value={value}>{value} Mbps</option>)}</select></label>}
        <label className="check-row"><input type="checkbox" disabled={!sourceSettings} checked={settings.followSource} onChange={(event) => applyFollowSource(event.target.checked)} />遵从原视频设置{sourceSettings ? `（${sourceSettings.width}×${sourceSettings.height} · ${sourceSettings.fps}fps）` : "（未载入视频）"}</label>
        <div className="export-estimate">
          预计文件大小：<strong>{estimatedSize === null ? "待估算" : `约 ${formatBytes(estimatedSize)}`}</strong>
          <small>{useConstantQuality ? "试压区间中部最多 1 秒，按帧数推算。画面变化大时误差也会更大。" : "按导出区间和目标码率估算。"}</small>
          {useConstantQuality && <button type="button" disabled={!estimating && (progress !== null || !canStart)}
            onClick={estimating ? cancelActiveExport : () => void exportVideo(true)}>
            {estimating ? `取消估算 ${Math.round((progress ?? 0) * 100)}%` : "试压估算"}
          </button>}
          {useConstantQuality && (estimating ? activeEncoder : exportError) && <small role="status">{estimating ? activeEncoder : exportError}</small>}
        </div>
        <label className="check-row"><input type="checkbox" checked={settings.showStats} onChange={(event) => updateSettings({ showStats: event.target.checked })} />时间 / 速度 / 海拔 / 坡度</label>
        <label className="check-row"><input type="checkbox" checked={settings.showMap} onChange={(event) => updateSettings({ showMap: event.target.checked })} />轨迹小地图</label>
        {settings.showMap && !isMapReady && <p role="status">{mapFailureRef.current ?? "正在加载道路地图…"}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={() => setIsSettingsOpen(false)}>关闭</button>
          <button type="button" disabled={progress !== null || !canStart} onClick={() => void exportVideo()}>导出</button>
        </div>
      </div>
    </div>, document.body)}
  </section>;
}
