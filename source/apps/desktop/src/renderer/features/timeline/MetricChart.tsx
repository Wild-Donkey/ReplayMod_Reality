import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { PointDataset, TimeBounds } from "../../../../../../packages/data/src";
import { TrajectoryBuffer } from "../../render-engine/buffers/TrajectoryBuffer";
import type { ReplayMetricSeries } from "../../render-engine/MetricSeries";
import { MetricCanvasFallback } from "../../render-engine/MetricCanvasFallback";
import { useReplayVisual } from "../../render-engine/useReplayVisual";
import type { ReplayScene } from "../../render-engine/ReplayScene";
import { smoothSpeedCurve, metricCurve, continuousSpeed, continuousDensity, type TimelineMetricsSettings } from "./metrics";

export function MetricChart({ scene, dataset, viewRange, metrics, axisContainer }: {
  scene: ReplayScene; dataset: PointDataset | null; viewRange: TimeBounds | null; metrics: TimelineMetricsSettings; axisContainer: RefObject<HTMLDivElement | null>;
}) {
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number; time: number; value: number | null } | null>(null);
  const element = useRef<HTMLDivElement>(null);
  const engineVisual = useReplayVisual(scene, "timeline");
  const density = metrics.mode === "density";
  useEffect(() => {
    if (!element.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  const plot = useMemo(() => {
    if (!dataset || !viewRange) return null;
    const [start, end] = viewRange;
    if (end <= start) return null;
    // Four times the previous sampling density; smooth only the display values.
    const count = Math.max(2, Math.min(8192, Math.ceil(width * 2)));
    const data: [number, number | null][] = density ? [] : smoothSpeedCurve(dataset, start, end, count);
    if (density) {
      const values = metricCurve(dataset, "density", start, end, count, (metrics.densitySmoothingSeconds ?? 60) * 1000);
      values.forEach((value, i) => data.push([start + i / count * (end - start), Number.isFinite(value) ? value : null]));
    }
    let minimum = Infinity;
    let maximum = -Infinity;
    data.forEach(([, value]) => {
      if (value !== null) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
    });
    const range = minimum !== Infinity ? [density ? 0 : minimum, maximum] : null;
    const flat = range && range[0] === range[1];
    const yDomain: readonly [number, number] = range ? [range[0] - (flat ? 0.5 : 0), range[1] + (flat ? 0.5 : 0)] : [0, 1];
    const series: ReplayMetricSeries = {
      id: "timeline-metric", space: "timeline", sourceTrajectory: TrajectoryBuffer.fromPointDataset(dataset),
      color: density ? [201, 154, 255, 255] : [115, 200, 255, 255], lineWidth: 1.5, areaOpacity: 0.1,
      x: Float64Array.from(data, point => point[0]), values: Float64Array.from(data, point => point[1] ?? Number.NaN),
      xDomain: [start, end], yDomain,
    };
    return {series, axisRange: range ? yDomain : null};
  }, [dataset, viewRange, density, metrics.densitySmoothingSeconds, width]);
  useEffect(() => {
    setHover(null);
    if (plot) return scene.registerMetricSeries("timeline", plot.series);
  }, [plot, scene]);
  const axisRange = plot?.axisRange;
  return <>
    {axisContainer.current && axisRange && createPortal(<>
      {[1, 0.5, 0].map(fraction => {
        const value = axisRange[0] + fraction * (axisRange[1] - axisRange[0]);
        return <span key={fraction} style={{ position: "absolute", right: 6, top: `${(1 - fraction) * 100}%`, transform: fraction === 1 ? undefined : fraction === 0 ? "translateY(-100%)" : "translateY(-50%)", color: "#aebdcb", fontSize: 9, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{Number(value.toPrecision(3))} {density ? "点/分钟" : "km/h"}</span>;
      })}
    </>, axisContainer.current)}
    <div ref={element} className="timeline-metric-plot"
      onPointerMove={event => {
        if (!dataset || !viewRange) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
        const picked = scene.picking.pick({viewId: "timeline", target: "metric", x: event.clientX, y: event.clientY, radius: 5});
        const time = picked?.timestamp ?? viewRange[0] + ratio * (viewRange[1] - viewRange[0]);
        const value = density
          ? continuousDensity(dataset.footprintTimestamps, time, (metrics.densitySmoothingSeconds ?? 60) * 1000)
          : continuousSpeed(dataset, time);
        setHover({ x: event.clientX, y: rect.top, time, value });
      }}
      onPointerLeave={() => setHover(null)}
      style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {axisRange && <div className="timeline-metric-grid" aria-hidden="true" />}
      {!engineVisual && plot && <MetricCanvasFallback series={plot.series} />}
    </div>
    {hover && dataset && viewRange && <>
      <div style={{ position: "absolute", top: 0, height: "100%", left: `${(hover.time - viewRange[0]) / (viewRange[1] - viewRange[0]) * 100}%`, borderLeft: "1px dashed #d3dfeb", pointerEvents: "none", zIndex: 3 }} />
      {createPortal(<div role="tooltip" style={{
        position: "fixed", left: Math.max(8, Math.min(window.innerWidth - 280, hover.x + 12)),
        top: Math.max(8, hover.y - 66), zIndex: 10000, pointerEvents: "none",
        padding: "7px 10px", border: "1px solid #566575", borderRadius: 4,
        background: "#18202af5", color: "#edf4ff", fontSize: 11, lineHeight: "18px", fontVariantNumeric: "tabular-nums",
      }}>
        <div>{new Date(hover.time).toLocaleString("zh-CN", { hour12: false })}.{String(Math.floor(hover.time) % 1000).padStart(3, "0")}</div>
        <div>{density ? "时间密度" : "瞬时速度"}：{hover.value === null ? "无定位数据" : `${hover.value.toLocaleString("zh-CN", { maximumFractionDigits: 4 })} ${density ? "点/分钟" : "km/h"}`}</div>
      </div>, document.body)}
    </>}
  </>;
}
