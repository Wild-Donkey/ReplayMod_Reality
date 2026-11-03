import { useCachedState, cachedMapRequest } from "../../shared/cache";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import maplibregl from "maplibre-gl";
import type { PointDataset, TimeBounds } from "../../../../../../packages/data/src";

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
  const dx = (lon1 - lon0) * 111_320 * Math.cos(latitudeRadians);
  const dy = (lat1 - lat0) * 110_540;
  const seconds = Math.max((t1 - t0) / 1000, 0.001);
  const altitude0 = dataset.timelineAltitudes[before];
  const altitude1 = dataset.timelineAltitudes[index];
  const hasAltitude = Number.isFinite(altitude0) && Number.isFinite(altitude1);
  const altitude = hasAltitude ? altitude0 + (altitude1 - altitude0) * ratio : Number.NaN;
  return {
    longitude: lon0 + (lon1 - lon0) * ratio,
    latitude: lat0 + (lat1 - lat0) * ratio,
    speed: Math.hypot(dx, dy) / seconds * 3.6,
    altitude,
    grade: hasAltitude && Math.hypot(dx, dy) > 1 ? (altitude1 - altitude0) / Math.hypot(dx, dy) * 100 : Number.NaN,
    bearing: Math.atan2(dx, dy) * 180 / Math.PI,
  };
};

const drawOverlay = (
  context: CanvasRenderingContext2D,
  dataset: PointDataset,
  range: TimeBounds,
  timestamp: number,
  settings: ExportSettings,
  navigationCanvas: HTMLCanvasElement | null,
) => {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  context.setTransform(settings.width / 1920, 0, 0, settings.height / 1080, 0, 0);
  const value = sample(dataset, timestamp);
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

export function OverlayExport({ dataset, range, apiKey }: { dataset: PointDataset; range: TimeBounds; apiKey: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const navigationContainerRef = useRef<HTMLDivElement>(null);
  const navigationMapRef = useRef<maplibregl.Map | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const cancelExportRef = useRef(false);
  const [settings, setSettings] = useCachedState<ExportSettings>("export-settings", { width: 1920, height: 1080, fps: 30, segmentMinutes: 10, bitrate: 12, showStats: true, showMap: true });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMapReady, setIsMapReady] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const duration = useMemo(() => (range[1] - range[0]) / 1000, [range]);

  const updateNavigationMap = (timestamp: number) => {
    const map = navigationMapRef.current;
    if (!map?.isStyleLoaded()) return;
    const value = sample(dataset, timestamp);
    const secondsVisible = Math.max(18, Math.min(90, 18 + value.speed * 0.6));
    const first = Math.max(0, lowerBound(dataset.timelineTimestamps, timestamp - secondsVisible * 1000));
    const last = Math.min(dataset.timelineTimestamps.length, lowerBound(dataset.timelineTimestamps, timestamp));
    const coordinates: [number, number][] = [];
    const step = Math.max(1, Math.ceil((last - first) / 500));
    for (let index = first; index < last; index += step) coordinates.push([dataset.timelineCoordinates[index * 2], dataset.timelineCoordinates[index * 2 + 1]]);
    coordinates.push([value.longitude, value.latitude]);
    (map.getSource("local-route") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } });
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
      updateNavigationMap(range[0]);
      map.once("idle", () => {
        setIsMapReady(true);
        const context = canvasRef.current?.getContext("2d");
        if (context) drawOverlay(context, dataset, range, range[0], settings, map.getCanvas());
      });
    });
    return () => { setIsMapReady(false); navigationMapRef.current = null; map.remove(); };
  }, [apiKey, dataset]);

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    updateNavigationMap(range[0]);
    if (context) drawOverlay(context, dataset, range, range[0], settings, navigationMapRef.current?.getCanvas() ?? null);
  }, [dataset, range, settings]);

  const exportVideo = () => {
    const canvas = canvasRef.current;
    if (!canvas || progress !== null) return;
    const mimeType = ["video/webm;codecs=vp9", "video/webm"].find(MediaRecorder.isTypeSupported);
    if (!mimeType) { window.alert("当前环境不支持 WebM 视频编码。"); return; }
    const stream = canvas.captureStream(settings.fps);
    const segmentMilliseconds = settings.segmentMinutes * 60_000;
    const segmentCount = Math.max(1, Math.ceil((range[1] - range[0]) / segmentMilliseconds));
    cancelExportRef.current = false;
    setProgress(0);

    const recordSegment = (segmentIndex: number) => {
      const segmentStart = range[0] + segmentIndex * segmentMilliseconds;
      const segmentEnd = Math.min(segmentStart + segmentMilliseconds, range[1]);
      const segmentDuration = Math.max((segmentEnd - segmentStart) / 1000, 0.001);
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: settings.bitrate * 1_000_000 });
      recorderRef.current = recorder;
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
      recorder.start(1000);
      const frame = (now: number) => {
        if (recorder.state !== "recording") return;
        const elapsed = Math.floor(((now - startedAt) / 1000) * settings.fps) / settings.fps;
        const segmentRatio = Math.min(elapsed / segmentDuration, 1);
        const timestamp = segmentStart + (segmentEnd - segmentStart) * segmentRatio;
        const context = canvas.getContext("2d");
        updateNavigationMap(timestamp);
        if (context) drawOverlay(context, dataset, range, timestamp, settings, navigationMapRef.current?.getCanvas() ?? null);
        if (now - lastProgressUpdate >= 250 || segmentRatio >= 1) {
          setProgress((timestamp - range[0]) / Math.max(range[1] - range[0], 1));
          lastProgressUpdate = now;
        }
        if (segmentRatio >= 1) recorder.stop(); else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    };
    recordSegment(0);
  };

  return <section className="overlay-export">
    <div ref={navigationContainerRef} className="navigation-map-renderer" aria-hidden="true" />
    <canvas ref={canvasRef} width={settings.width} height={settings.height} />
    <button type="button" disabled={progress !== null} onClick={() => setIsSettingsOpen(true)}>导出设置…</button>
    <span>成片 {duration.toFixed(1)} 秒（1:1）· {settings.width}×{settings.height} / {settings.fps}fps</span>
    <button type="button" disabled={progress === null && settings.showMap && !isMapReady} onClick={progress === null ? exportVideo : () => { cancelExportRef.current = true; recorderRef.current?.stop(); }}>
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
