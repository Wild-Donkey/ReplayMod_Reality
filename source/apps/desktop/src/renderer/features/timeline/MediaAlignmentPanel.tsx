import { useEffect, useRef, useState } from "react";
import type { PointDataset } from "../../../../../../packages/data/src";
import type { MediaSource } from "../../../../../../packages/media/src";
import type { MediaAlignmentResult, MotionGpsProgress, MotionGpsResult } from "../../../shared/mediaAlignment";
import { alignedMediaStart, normalizeAlignmentSeconds, validAlignmentOffset } from "../../../shared/mediaAlignment";
import { formatMediaTime } from "../../shared/mediaTimeDisplay";
import { motionInputPoints } from "./processedTrajectory";

const signed = (value: number) => value > 0 ? `+${value}` : String(value);
function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("No handler registered")) return "桌面进程还在运行旧版本，请完全退出应用后重新启动。";
  return message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

export function MediaAlignmentPanel({source, dataset, active, onPreviewOffsetChange, onAligned, onProcessed}: {
  source: MediaSource; dataset: PointDataset | null; active: boolean;
  onPreviewOffsetChange: (offsetSeconds: number) => void;
  onAligned: (source: MediaSource) => void; onProcessed: (result: MotionGpsResult | null) => void;
}) {
  const [offset, setOffset] = useState("0");
  const [sliderBase, setSliderBase] = useState(0);
  const [fineOffset, setFineOffset] = useState(0);
  const [saving, setSaving] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [gpsProgress, setGpsProgress] = useState<MotionGpsProgress | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [gpsError, setGpsError] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<MediaAlignmentResult | null>(null);
  const [gpsResult, setGpsResult] = useState<MotionGpsResult | null>(null);
  const requestedOffset = useRef<number | null>(0);
  const optimizationOffset = useRef<number | null>(null);
  const mounted = useRef(true);
  const onProcessedRef = useRef(onProcessed);
  onProcessedRef.current = onProcessed;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const bridge = window.replaymod;
  const start = source.creationTimeSeconds;
  const value = Number(offset);
  const valid = offset.trim() !== "" && validAlignmentOffset(value);
  const previewStart = start === undefined ? undefined : alignedMediaStart(start, valid ? value : 0);
  const canEdit = Boolean(bridge) && !saving && start !== undefined;
  const canApply = canEdit && valid && value !== 0;

  const editOffset = (input: string) => {
    optimizationOffset.current = null;
    setOffset(input); setFineOffset(0);
    const number = Number(input);
    requestedOffset.current = input.trim() && validAlignmentOffset(number) ? number : null;
    onPreviewOffsetChange(requestedOffset.current ?? 0);
    setGpsResult(null); setGpsError(""); onProcessedRef.current(null);
    setSliderBase(Number.isFinite(number) ? normalizeAlignmentSeconds(Math.max(-86400, Math.min(86400, number))) : 0);
  };
  const moveSlider = (delta: number) => {
    const next = normalizeAlignmentSeconds(Math.max(-86400, Math.min(86400, sliderBase + delta)));
    if (next === requestedOffset.current) return;
    optimizationOffset.current = null;
    requestedOffset.current = next;
    setOffset(String(next)); setFineOffset(normalizeAlignmentSeconds(next - sliderBase));
    onPreviewOffsetChange(next);
    setGpsResult(null); setGpsError(""); onProcessedRef.current(null);
  };

  useEffect(() => {
    setGpsError("");
    setGpsProgress(null);
    if (refresh === 0 || optimizationOffset.current !== value || !active || saving || !bridge || !dataset || start === undefined || previewStart === undefined || !valid) {
      setProcessing(false);
      return;
    }
    const id = crypto.randomUUID();
    const onCompleted = onProcessedRef.current;
    let posted = false;
    setProcessing(true);
    const unsubscribeProgress = bridge.onMediaGpsProgress?.(update => {
      if (update.id === id && requestedOffset.current === value) setGpsProgress(update);
    });
    const unsubscribe = bridge.onMediaGpsResult(update => {
      if (update.id !== id || requestedOffset.current !== value) return;
      setProcessing(false);
      if ("error" in update) setGpsError(update.error);
      else {
        setGpsResult(update.result);
        onCompleted(update.result);
      }
    });
    const timer = window.setTimeout(() => {
      if (requestedOffset.current !== value) return;
      try {
        const points = motionInputPoints(dataset, previewStart, source.durationSeconds ?? 0);
        bridge.postMediaGps(id, {sourcePath: source.sourcePath, creationTimeSeconds: start, offsetSeconds: value, points, precision: "preview"});
        posted = true;
      } catch (error) {
        setGpsError(errorText(error));
        setProcessing(false);
      }
    }, 120);
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
      unsubscribeProgress?.();
      if (posted) bridge.postMediaGps(id, null);
    };
  }, [active, saving, bridge, dataset, start, previewStart, valid, value, source.durationSeconds, source.sourcePath, refresh]);

  const apply = async () => {
    if (!bridge || start === undefined || !canApply) return;
    setSaving(true); setError("");
    try {
      const saved = await bridge.alignMediaTime({sourcePath: source.sourcePath, creationTimeSeconds: start, offsetSeconds: value});
      if (!mounted.current) return;
      onAligned(saved.source); setResult(saved); editOffset("0"); setGpsResult(null);
    } catch (error) {
      if (mounted.current) setError(errorText(error));
    } finally { if (mounted.current) setSaving(false); }
  };

  return <section className="library-section" aria-label="视频时间对齐">
    <h2 className="section-label">时间对齐</h2>
    <div className="media-alignment">
    <p className="alignment-hint">{start === undefined ? "视频缺少拍摄时间。" : `当前拍摄时间 ${formatMediaTime(start * 1000, true)}`}</p>
    <label htmlFor="media-time-offset">时间偏移（秒）</label>
    <div className="alignment-controls">
      <input id="media-time-offset" type="number" step="0.001" min="-86400" max="86400" value={offset} disabled={!canEdit}
        onChange={event => editOffset(event.target.value)} />
      <button type="button" disabled={!canApply} onClick={() => void apply()}>{saving ? "写入中…" : "微调"}</button>
    </div>
    <input id="media-fine-offset" className="alignment-slider" type="range" min="-30" max="30" step="0.01" value={fineOffset} disabled={!canEdit}
      aria-label="调整时间偏移" aria-valuetext={`${signed(fineOffset)} 秒`} onChange={event => moveSlider(Number(event.target.value))} />
    <div className="alignment-slider-ticks" aria-hidden="true"><span>−30</span><span>0</span><span>+30</span></div>
    {start !== undefined && <p className="alignment-hint">正数推后，负数提前。点击「微调」保存对齐。</p>}
    {offset.trim() !== "" && !valid && <p className="alignment-hint">请输入一天以内的偏移，最多三位小数。</p>}
    <button type="button" disabled={!canEdit || !dataset || !valid || processing} onClick={() => { optimizationOffset.current = value; setRefresh(version => version + 1); }}>{processing ? "正在优化 GPS 与插值…" : "优化 GPS 与插值"}</button>
    {processing && gpsProgress && <progress aria-label="轨迹拟合窗口进度" value={gpsProgress.completed} max={gpsProgress.total} />}
    {!processing && !gpsError && gpsResult && gpsResult.videoStartSeconds === previewStart && <p role="status">
      {`轨迹拟合 ${gpsResult.fittedWindows} 窗 · 姿态约束 ${gpsResult.attitudeConstraints} 个`}
      {` · 长间隔 ${gpsResult.bridgedIntervals ?? 0} 段。`}{gpsResult.reason}
    </p>}
    {gpsError && <p className="alignment-hint" role="status">{gpsError}</p>}
    {result && <div className="alignment-result" role="status">
      <strong>已将视频时间调整 {signed(result.offsetSeconds)} 秒</strong>
      {result.backupPath && <details><summary>原视频备份</summary><span className="alignment-backup">{result.backupPath}</span></details>}
    </div>}
    {error && <p className="data-error" role="alert">{error}</p>}
    </div>
  </section>;
}
