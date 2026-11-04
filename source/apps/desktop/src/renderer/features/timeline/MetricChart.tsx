import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { init, use, type EChartsType } from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { PointDataset, TimeBounds } from "../../../../../../packages/data/src";
import { smoothSpeedCurve, metricCurve, continuousSpeed, continuousDensity, type TimelineMetricsSettings } from "./metrics";

use([LineChart, GridComponent, CanvasRenderer]);

export function MetricChart({ dataset, viewRange, metrics, axisContainer }: {
  dataset: PointDataset | null; viewRange: TimeBounds | null; metrics: TimelineMetricsSettings; axisContainer: RefObject<HTMLDivElement | null>;
}) {
  const [axisRange, setAxisRange] = useState<readonly [number, number] | null>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number; time: number; value: number | null } | null>(null);
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  useEffect(() => {
    if (!element.current) return;
    chart.current = init(element.current);
    const observer = new ResizeObserver(() => {
      chart.current?.resize();
      setWidth(chart.current?.getWidth() ?? 0);
    });
    observer.observe(element.current);
    return () => { observer.disconnect(); chart.current?.dispose(); chart.current = null; };
  }, []);
  useEffect(() => {
    setHover(null);
    const instance = chart.current;
    if (!instance) return;
    if (!dataset || !viewRange) { instance.clear(); setAxisRange(null); return; }
    const [start, end] = viewRange;
    const density = metrics.mode === "density";
    const color = density ? "#c99aff" : "#73c8ff";
    const unit = density ? "点/分钟" : "km/h";
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
    setAxisRange(range ? [range[0] - (flat ? 0.5 : 0), range[1] + (flat ? 0.5 : 0)] : null);
    instance.setOption({
      animation: false,
      grid: { left: 0, right: 0, top: 0, bottom: 0, containLabel: false },
      xAxis: { type: "time", min: start, max: end, show: false, boundaryGap: false },
      yAxis: {
        type: "value", scale: true, boundaryGap: [0, 0], min: range ? range[0] - (flat ? 0.5 : 0) : 0,
        max: range ? range[1] + (flat ? 0.5 : 0) : 1,
        splitNumber: 2, axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: { show: true, lineStyle: { color: "rgba(180,200,220,0.12)", type: "dashed" } },
      },
      series: [{
        name: density ? "时间密度" : "瞬时速度", type: "line", data,
        showSymbol: false, connectNulls: false, smooth: false, step: false,
        lineStyle: { color, width: 1.5 }, itemStyle: { color },
        areaStyle: { color, opacity: 0.1 }, emphasis: { disabled: true },
      }],
    }, { notMerge: true });
  }, [dataset, viewRange, metrics, width]);
  const density = metrics.mode === "density";
  return <>
    {axisContainer.current && axisRange && createPortal(<>
      {[1, 0.5, 0].map(fraction => {
        const value = axisRange[0] + fraction * (axisRange[1] - axisRange[0]);
        return <span key={fraction} style={{ position: "absolute", right: 6, top: `${(1 - fraction) * 100}%`, transform: fraction === 1 ? undefined : fraction === 0 ? "translateY(-100%)" : "translateY(-50%)", color: "#aebdcb", fontSize: 9, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{Number(value.toPrecision(3))} km/h</span>;
      })}
    </>, axisContainer.current)}
    <div ref={element}
      onPointerMove={event => {
        if (!dataset || !viewRange) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
        const time = viewRange[0] + ratio * (viewRange[1] - viewRange[0]);
        const value = density
          ? continuousDensity(dataset.footprintTimestamps, time, (metrics.densitySmoothingSeconds ?? 60) * 1000)
          : continuousSpeed(dataset, time);
        setHover({ x: event.clientX, y: rect.top, time, value });
      }}
      onPointerLeave={() => setHover(null)}
      style={{ position: "absolute", left: 0, right: 0, top: 0, height: "100%", overflow: "hidden", clipPath: "inset(0)" }} />
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
