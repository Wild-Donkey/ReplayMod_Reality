import type { ReplayScene } from "../../render-engine/ReplayScene";
import { useReplayVisual } from "../../render-engine/useReplayVisual";
import { densityBinColor, type DensityBins, type TimelineDensity } from "../../render-engine/TimelineDensity";
import { useHDRState } from "../../shared/displayHDR";
import { presentHDR } from "../../shared/hdr";
import { createPortal } from "react-dom";
import { timelineWheelRange } from "./gestures";
import { pixelDensity, type TimelineMetricsSettings } from "./metrics";
import { MetricChart } from "./MetricChart";
import { useCachedState } from "../../shared/cache";
import {
  type PointerEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PointDataset, TimeBounds } from "../../../../../../packages/data/src";

const MIN_VISIBLE_SPAN = 1;
const PAN_SPEED_PER_SECOND = 0.55;
const PAN_ACCELERATION = 11;
const PAN_DECELERATION = 8;
const PAN_STOP_THRESHOLD = 0.001;
const TARGET_TICK_SPACING = 105;

type TickUnit = "minute" | "hour" | "day" | "month" | "year";

interface TickScale {
  readonly unit: TickUnit;
  readonly step: number;
  readonly approximateMilliseconds: number;
}

const TICK_SCALES: readonly TickScale[] = [
  { unit: "minute", step: 1, approximateMilliseconds: 60_000 },
  { unit: "minute", step: 2, approximateMilliseconds: 120_000 },
  { unit: "minute", step: 5, approximateMilliseconds: 300_000 },
  { unit: "minute", step: 10, approximateMilliseconds: 600_000 },
  { unit: "minute", step: 15, approximateMilliseconds: 900_000 },
  { unit: "minute", step: 30, approximateMilliseconds: 1_800_000 },
  { unit: "hour", step: 1, approximateMilliseconds: 3_600_000 },
  { unit: "hour", step: 2, approximateMilliseconds: 7_200_000 },
  { unit: "hour", step: 3, approximateMilliseconds: 10_800_000 },
  { unit: "hour", step: 6, approximateMilliseconds: 21_600_000 },
  { unit: "hour", step: 12, approximateMilliseconds: 43_200_000 },
  { unit: "day", step: 1, approximateMilliseconds: 86_400_000 },
  { unit: "day", step: 2, approximateMilliseconds: 172_800_000 },
  { unit: "day", step: 7, approximateMilliseconds: 604_800_000 },
  { unit: "day", step: 14, approximateMilliseconds: 1_209_600_000 },
  { unit: "month", step: 1, approximateMilliseconds: 2_629_746_000 },
  { unit: "month", step: 2, approximateMilliseconds: 5_259_492_000 },
  { unit: "month", step: 3, approximateMilliseconds: 7_889_238_000 },
  { unit: "month", step: 6, approximateMilliseconds: 15_778_476_000 },
  { unit: "year", step: 1, approximateMilliseconds: 31_556_952_000 },
  { unit: "year", step: 2, approximateMilliseconds: 63_113_904_000 },
  { unit: "year", step: 5, approximateMilliseconds: 157_784_760_000 },
];

const isEditableTarget = (target: EventTarget | null) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement ||
  (target instanceof HTMLElement && target.isContentEditable);

const clampRange = (
  start: number,
  span: number,
  bounds: TimeBounds,
): TimeBounds => {
  const fullSpan = Math.max(bounds[1] - bounds[0], 1);
  const normalizedSpan = Math.min(Math.max(span, MIN_VISIBLE_SPAN), fullSpan);
  const maxStart = bounds[1] - normalizedSpan;
  const normalizedStart = Math.min(Math.max(start, bounds[0]), maxStart);

  return [normalizedStart, normalizedStart + normalizedSpan];
};

const formatTimelineDate = (timestamp: number, span: number) => {
  const date = new Date(timestamp);

  if (span > 1000 * 60 * 60 * 24 * 180) {
    return date.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
    });
  }

  if (span > 1000 * 60 * 60 * 24 * 2) {
    return date.toLocaleDateString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
    });
  }

  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

const chooseTickScale = (span: number, width: number) => {
  const desiredTickCount = Math.max(
    2,
    Math.floor(width / TARGET_TICK_SPACING),
  );
  const desiredInterval = span / desiredTickCount;

  return (
    TICK_SCALES.find(
      (scale) => scale.approximateMilliseconds >= desiredInterval,
    ) ?? TICK_SCALES[TICK_SCALES.length - 1]
  );
};

const floorTick = (timestamp: number, scale: TickScale) => {
  const date = new Date(timestamp);

  if (scale.unit === "minute") {
    date.setSeconds(0, 0);
    date.setMinutes(
      Math.floor(date.getMinutes() / scale.step) * scale.step,
    );
  } else if (scale.unit === "hour") {
    date.setMinutes(0, 0, 0);
    date.setHours(Math.floor(date.getHours() / scale.step) * scale.step);
  } else if (scale.unit === "day") {
    const localDayIndex = Math.floor(
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) /
        86_400_000,
    );
    const alignedDayIndex =
      Math.floor(localDayIndex / scale.step) * scale.step;
    const alignedDate = new Date(alignedDayIndex * 86_400_000);
    date.setFullYear(
      alignedDate.getUTCFullYear(),
      alignedDate.getUTCMonth(),
      alignedDate.getUTCDate(),
    );
    date.setHours(0, 0, 0, 0);
  } else if (scale.unit === "month") {
    date.setHours(0, 0, 0, 0);
    date.setDate(1);
    date.setMonth(Math.floor(date.getMonth() / scale.step) * scale.step);
  } else {
    date.setHours(0, 0, 0, 0);
    date.setMonth(0, 1);
    date.setFullYear(
      Math.floor(date.getFullYear() / scale.step) * scale.step,
    );
  }

  return date.getTime();
};

const advanceTick = (timestamp: number, scale: TickScale) => {
  const date = new Date(timestamp);

  if (scale.unit === "minute") {
    date.setMinutes(date.getMinutes() + scale.step);
  } else if (scale.unit === "hour") {
    date.setHours(date.getHours() + scale.step);
  } else if (scale.unit === "day") {
    date.setDate(date.getDate() + scale.step);
  } else if (scale.unit === "month") {
    date.setMonth(date.getMonth() + scale.step);
  } else {
    date.setFullYear(date.getFullYear() + scale.step);
  }

  return date.getTime();
};

const formatTickLabel = (timestamp: number, scale: TickScale) => {
  const date = new Date(timestamp);

  if (scale.unit === "year") {
    return `${date.getFullYear()}`;
  }

  if (scale.unit === "month") {
    return date.toLocaleDateString("zh-CN", {
      year: "2-digit",
      month: "2-digit",
    });
  }

  if (scale.unit === "day") {
    return date.toLocaleDateString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
    });
  }

  if (scale.unit === "hour") {
    return date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

function DensityStrip({ bins, kind }: {bins: DensityBins; kind: keyof TimelineDensity}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(bins.counts.length * ratio);
    canvas.height = Math.round(2 * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    bins.counts.forEach((count, x) => {
      context.fillStyle = `rgb(${densityBinColor(count, bins.peak, kind).join(",")})`;
      context.fillRect(x, 0, 1, 2);
    });
    const hdr = presentHDR(canvas);
    return () => hdr.dispose();
  }, [bins, kind]);
  return <div className="timeline-density-fallback"><canvas ref={ref} /></div>;
}

interface TimelineCanvasProps {
  scene: ReplayScene;
  dataset: PointDataset | null;
  viewRange: TimeBounds | null;
  currentTime: number | null;
  onCurrentTimeChange: (timestamp: number) => void;
  onHoverTimeChange?: (timestamp: number | null) => void;
  selectionRange: TimeBounds | null;
  metrics: TimelineMetricsSettings;
  axisContainer: RefObject<HTMLDivElement | null>;
}

function TimelineCanvas({
  scene,
  dataset,
  viewRange,
  currentTime,
  onCurrentTimeChange,
  onHoverTimeChange,
  selectionRange,
  metrics,
  axisContainer,
}: TimelineCanvasProps) {
  const [stripHover, setStripHover] = useState<{ x: number; y: number; label: string; count: number; peak: number; start: number; end: number } | null>(null);
  const speedMetrics = useMemo(() => ({ ...metrics, mode: "speed" as const }), [metrics]);
  useEffect(() => {
    setStripHover(null);
    onHoverTimeChange?.(null);
    return () => onHoverTimeChange?.(null);
  }, [dataset, viewRange, onHoverTimeChange]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const hdrActive = useHDRState().active;
  const engineDensity = useReplayVisual(scene, "timeline-density");
  const density = useMemo(() => {
    if (!dataset || !viewRange || size.width === 0) return null;
    const [start, end] = viewRange;
    return {
      footprint: pixelDensity(dataset.footprintTimestamps, start, end, size.width),
      photo: pixelDensity(dataset.photoTimestamps, start, end, size.width),
    };
  }, [dataset, viewRange, size.width]);
  useEffect(() => {
    if (density && !hdrActive) return scene.registerTimelineDensity(density);
  }, [scene, density, hdrActive]);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const resizeObserver = new ResizeObserver(([entry]) => {
      setSize({
        width: Math.max(1, Math.floor(entry.contentRect.width)),
        height: Math.max(1, Math.floor(entry.contentRect.height)),
      });
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas || size.width === 0 || size.height === 0) {
      return;
    }

    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * pixelRatio);
    canvas.height = Math.floor(size.height * pixelRatio);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    const context = canvas.getContext("2d");

    if (!context) {
      return;
    }

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, size.width, size.height);

    const rulerHeight = 18;
    const trackHeight = Math.max(1, size.height - rulerHeight - 5);

    context.fillStyle = "rgb(255 255 255 / 4%)";
    context.fillRect(0, rulerHeight, size.width, trackHeight);


    if (!dataset || !viewRange) {
      context.fillStyle = "#777";
      context.font = '12px "Microsoft YaHei UI", sans-serif';
      context.textAlign = "center";
      context.fillText(
        "载入数据后显示时间分布",
        size.width / 2,
        size.height / 2 + 4,
      );
      return;
    }

    const [start, end] = viewRange;
    const span = end - start;
    const tickScale = chooseTickScale(span, size.width);
    let tick = floorTick(start, tickScale);

    if (tick < start) {
      tick = advanceTick(tick, tickScale);
    }

    context.strokeStyle = "rgb(255 255 255 / 13%)";
    context.lineWidth = 1;
    context.fillStyle = "#888";
    context.font = '10px Consolas, "Microsoft YaHei UI", monospace';

    while (tick <= end) {
      const x = ((tick - start) / span) * size.width;
      context.beginPath();
      context.moveTo(Math.round(x) + 0.5, rulerHeight);
      context.lineTo(Math.round(x) + 0.5, size.height);
      context.stroke();
      context.textAlign = "center";
      context.fillText(formatTickLabel(tick, tickScale), x, 13);

      const nextTick = advanceTick(tick, tickScale);

      if (nextTick <= tick) {
        break;
      }

      tick = nextTick;
    }



  }, [dataset, size, viewRange, metrics]);

  const selectionStyle = selectionRange && viewRange
    ? {
        left: `${Math.max(0, (selectionRange[0] - viewRange[0]) / (viewRange[1] - viewRange[0]) * 100)}%`,
        right: `${Math.max(0, (viewRange[1] - selectionRange[1]) / (viewRange[1] - viewRange[0]) * 100)}%`,
      }
    : null;

  const playheadPosition =
    currentTime !== null &&
    viewRange &&
    currentTime >= viewRange[0] &&
    currentTime <= viewRange[1]
      ? ((currentTime - viewRange[0]) / (viewRange[1] - viewRange[0])) * 100
      : null;

  const updateCurrentTime = (event: PointerEvent<HTMLDivElement>) => {
    if (!dataset || !viewRange) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(
      Math.max((event.clientX - bounds.left) / bounds.width, 0),
      1,
    );
    onCurrentTimeChange(
      viewRange[0] + (viewRange[1] - viewRange[0]) * ratio,
    );
  };

  return (
    <div
      ref={containerRef}
      className="timeline-canvas-shell"

      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        updateCurrentTime(event);
      }}
      onPointerLeave={() => { setStripHover(null); onHoverTimeChange?.(null); }}
      onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (dataset && viewRange) {
          const ratio = Math.min(Math.max((event.clientX - bounds.left) / Math.max(1, bounds.width), 0), 1);
          onHoverTimeChange?.(viewRange[0] + ratio * (viewRange[1] - viewRange[0]));
        }
        const y = event.clientY - bounds.top;
        if (density && viewRange && y >= bounds.height - 5 && y < bounds.height - 1) {
          const photo = y >= bounds.height - 3;
          const {counts, peak} = photo ? density.photo : density.footprint;
          const x = Math.max(0, Math.min(counts.length - 1, Math.floor((event.clientX - bounds.left) / bounds.width * counts.length)));
          const span = viewRange[1] - viewRange[0];
          setStripHover({ x: event.clientX, y: bounds.top, label: photo ? "照片密度" : "足迹密度", count: counts[x], peak, start: viewRange[0] + x / counts.length * span, end: viewRange[0] + (x + 1) / counts.length * span });
        } else setStripHover(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          updateCurrentTime(event);
        }
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    >
      <canvas ref={canvasRef} className="timeline-canvas" />
      <div style={{ position: "absolute", top: 18, bottom: 5, left: 0, right: 0, minHeight: 0, minWidth: 0 }}><MetricChart scene={scene} dataset={dataset} viewRange={viewRange} metrics={speedMetrics} axisContainer={axisContainer} /></div>
      {density && <div className="timeline-density-strips" aria-hidden="true">
        {(!engineDensity || hdrActive) && <>
          <DensityStrip bins={density.footprint} kind="footprint" />
          <DensityStrip bins={density.photo} kind="photo" />
        </>}
      </div>}
      {stripHover && createPortal(<div role="tooltip" style={{ position: "fixed", left: Math.max(8, Math.min(window.innerWidth - 330, stripHover.x + 12)), top: Math.max(8, stripHover.y - 68), zIndex: 10000, pointerEvents: "none", padding: "7px 10px", background: "#18202af5", color: "#edf4ff", border: "1px solid #566575", borderRadius: 4, fontSize: 11, lineHeight: "18px" }}>
        <div>{stripHover.label}：{stripHover.count} 点/像素 · 当前峰值 {stripHover.peak} 点/像素</div>
        <div>{new Date(stripHover.start).toLocaleString("zh-CN", { hour12: false })} – {new Date(stripHover.end).toLocaleString("zh-CN", { hour12: false })}</div>
      </div>, document.body)}
      {selectionStyle && <div className="timeline-selection" style={selectionStyle} />}
      {playheadPosition !== null && (
        <div
          className="timeline-playhead"
          style={{ left: `${playheadPosition}%` }}
        />
      )}
    </div>
  );
}

interface TimelineProps {
  scene: ReplayScene;
  playing: boolean;
  onTogglePlayback: () => void;
  onStepFrame: (direction: -1 | 1) => void;
  dataset: PointDataset | null;
  currentTime: number | null;
  onCurrentTimeChange: (timestamp: number) => void;
  onHoverTimeChange?: (timestamp: number | null) => void;
  focusRequest: TimelineFocusRequest | null;
  selectionRange: TimeBounds | null;
  metrics: TimelineMetricsSettings;
}

export interface TimelineFocusRequest {
  readonly timestamp: number;
  readonly sequence: number;
}

export function Timeline({
  scene,
  playing,
  onTogglePlayback,
  onStepFrame,
  dataset,
  currentTime,
  onCurrentTimeChange,
  onHoverTimeChange,
  focusRequest,
  selectionRange,
  metrics,
}: TimelineProps) {
  const engineMetric = useReplayVisual(scene, "timeline");
  const engineDensity = useReplayVisual(scene, "timeline-density");
  const timelineRef = useRef<HTMLElement>(null);
  const axisContainer = useRef<HTMLDivElement>(null);
  const pressedPanKeysRef = useRef(new Set<"q" | "e">());
  const panVelocityRef = useRef(0);
  const panFrameRef = useRef<number | null>(null);
  const lastPanFrameTimeRef = useRef<number | null>(null);
  const [viewRange, setViewRange] = useCachedState<TimeBounds | null>("timeline-view", null);

  useEffect(() => {
    if (!dataset) return;
    setViewRange(previous => previous && previous[0] >= dataset.timeBounds[0] && previous[1] <= dataset.timeBounds[1]
      ? previous : dataset.timeBounds);
  }, [dataset]);

  useEffect(() => {
    if (!dataset || !focusRequest) {
      return;
    }

    setViewRange((currentRange) => {
      const span = currentRange
        ? currentRange[1] - currentRange[0]
        : dataset.timeBounds[1] - dataset.timeBounds[0];

      return clampRange(
        focusRequest.timestamp - span / 2,
        span,
        dataset.timeBounds,
      );
    });
  }, [dataset, focusRequest]);

  useEffect(() => {
    const stopPanAnimation = () => {
      if (panFrameRef.current !== null) {
        cancelAnimationFrame(panFrameRef.current);
        panFrameRef.current = null;
      }

      lastPanFrameTimeRef.current = null;
      panVelocityRef.current = 0;
    };

    if (!dataset) {
      stopPanAnimation();
      pressedPanKeysRef.current.clear();
      return;
    }

    const runPanFrame = (frameTime: number) => {
      const previousFrameTime = lastPanFrameTimeRef.current ?? frameTime;
      const deltaSeconds = Math.min(
        Math.max((frameTime - previousFrameTime) / 1000, 0),
        0.05,
      );
      lastPanFrameTimeRef.current = frameTime;

      const keys = pressedPanKeysRef.current;
      const direction =
        (keys.has("e") ? 1 : 0) - (keys.has("q") ? 1 : 0);
      const targetVelocity = direction * PAN_SPEED_PER_SECOND;
      const response =
        direction === 0 ? PAN_DECELERATION : PAN_ACCELERATION;
      const interpolation = 1 - Math.exp(-response * deltaSeconds);
      panVelocityRef.current +=
        (targetVelocity - panVelocityRef.current) * interpolation;

      if (
        direction === 0 &&
        Math.abs(panVelocityRef.current) < PAN_STOP_THRESHOLD
      ) {
        stopPanAnimation();
        return;
      }

      setViewRange((currentRange) => {
        if (!currentRange) {
          return currentRange;
        }

        const span = currentRange[1] - currentRange[0];
        return clampRange(
          currentRange[0] +
            span * panVelocityRef.current * deltaSeconds,
          span,
          dataset.timeBounds,
        );
      });

      panFrameRef.current = requestAnimationFrame(runPanFrame);
    };

    const startPanAnimation = () => {
      if (panFrameRef.current === null) {
        lastPanFrameTimeRef.current = null;
        panFrameRef.current = requestAnimationFrame(runPanFrame);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        isEditableTarget(event.target) ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      ) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key !== "q" && key !== "e") {
        return;
      }

      event.preventDefault();
      const wasPressed = pressedPanKeysRef.current.has(key);
      pressedPanKeysRef.current.add(key);

      if (!wasPressed && Math.abs(panVelocityRef.current) < 0.04) {
        panVelocityRef.current = key === "q" ? -0.06 : 0.06;
      }

      startPanAnimation();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      if (key !== "q" && key !== "e") {
        return;
      }

      pressedPanKeysRef.current.delete(key);
      startPanAnimation();
    };

    const handleBlur = () => {
      pressedPanKeysRef.current.clear();
      startPanAnimation();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
      pressedPanKeysRef.current.clear();
      stopPanAnimation();
    };
  }, [dataset]);

  const visibleRangeLabel = useMemo(() => {
    if (!viewRange) {
      return "--";
    }

    const span = viewRange[1] - viewRange[0];
    return `${formatTimelineDate(viewRange[0], span)} - ${formatTimelineDate(viewRange[1], span)}`;
  }, [viewRange]);

  const currentTimeLabel = useMemo(() => {
    if (currentTime === null) {
      return "--";
    }

    return new Date(currentTime).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }, [currentTime]);

  useEffect(() => {
    const timeline = timelineRef.current;

    if (!timeline) {
      return;
    }

    const handleWheel = (event: globalThis.WheelEvent) => {
      if (!dataset || isEditableTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      const plot = timeline.querySelector(".timeline-canvas-shell") ?? timeline;
      const bounds = plot.getBoundingClientRect();
      const pointerRatio = (event.clientX - bounds.left) / Math.max(1, bounds.width);
      setViewRange(previous => previous
        ? timelineWheelRange(previous, dataset.timeBounds, event, bounds.width, bounds.height, pointerRatio)
        : previous);

    };

    timeline.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => timeline.removeEventListener("wheel", handleWheel, true);
  }, [dataset]);

  return (
    <section ref={timelineRef} className="timeline" data-replay-renderer={engineMetric ? "engine" : undefined} data-density-renderer={engineDensity ? "engine" : undefined}>
      <header className="timeline-toolbar">
        <div className="playback-controls">
          <button type="button" aria-label="上一帧" disabled={!dataset} onClick={() => onStepFrame(-1)}>
            |&lt;
          </button>
          <button className="play-button" type="button" aria-label={playing ? "暂停" : "播放"} disabled={!dataset} onClick={onTogglePlayback}>
            {playing ? "Ⅱ" : ">"}
          </button>
          <button type="button" aria-label="下一帧" disabled={!dataset} onClick={() => onStepFrame(1)}>
            &gt;|
          </button>
        </div>
        <span className="timecode">{currentTimeLabel}</span>
        <span className="timeline-title">{visibleRangeLabel}</span>
        <div className="timeline-options">
          <span>横滚移动 · 竖滚/双指缩放 · Q/E 移动</span>
          <button
            type="button"
            disabled={!dataset}
            onClick={() => setViewRange(dataset?.timeBounds ?? null)}
          >
            适配
          </button>
        </div>
      </header>
      <div className="timeline-body">
        <div ref={axisContainer} className="timeline-y-axis" style={{ position: "relative", marginTop: 18, marginBottom: 5, minWidth: 0 }} />
        <TimelineCanvas
          scene={scene}
          dataset={dataset}
          viewRange={viewRange}
          currentTime={currentTime}
          onCurrentTimeChange={onCurrentTimeChange}
          onHoverTimeChange={onHoverTimeChange}
          selectionRange={selectionRange}
          metrics={metrics}
          axisContainer={axisContainer}
        />
      </div>
    </section>
  );
}
