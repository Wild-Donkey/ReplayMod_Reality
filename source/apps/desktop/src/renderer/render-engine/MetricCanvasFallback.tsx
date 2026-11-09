import { useLayoutEffect, useRef } from "react";
import { metricArea, metricSegments, type ReplayMetricSeries } from "./MetricSeries";

export function MetricCanvasFallback({series}: {series: ReplayMetricSeries}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const {width, height} = canvas.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      const context = canvas.getContext("2d");
      if (!context) return;
      const [r, g, b, alpha] = series.color ?? [115, 200, 255, 255];
      const {positions} = metricSegments(series);
      const x = (value: number) => value * canvas.width;
      const y = (value: number) => value * canvas.height;
      if (series.areaOpacity) {
        const triangles = metricArea(series).attributes.getPolygon.value;
        context.beginPath();
        for (let index = 0; index < triangles.length; index += 9) {
          context.moveTo(x(triangles[index]), y(triangles[index + 1]));
          context.lineTo(x(triangles[index + 3]), y(triangles[index + 4]));
          context.lineTo(x(triangles[index + 6]), y(triangles[index + 7]));
          context.closePath();
        }
        context.fillStyle = `rgb(${r} ${g} ${b} / ${alpha / 255 * series.areaOpacity})`;
        context.fill();
      }
      context.beginPath();
      for (let index = 0; index < positions.length; index += 6) {
        if (index === 0 || positions[index] !== positions[index - 3] || positions[index + 1] !== positions[index - 2]) {
          context.moveTo(x(positions[index]), y(positions[index + 1]));
        }
        context.lineTo(x(positions[index + 3]), y(positions[index + 4]));
      }
      context.strokeStyle = `rgb(${r} ${g} ${b} / ${alpha / 255})`;
      context.lineWidth = (series.lineWidth ?? 1.5) * dpr;
      context.lineJoin = "round";
      context.stroke();
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [series]);
  return <canvas ref={ref} className="metric-canvas-fallback" aria-hidden="true" />;
}
