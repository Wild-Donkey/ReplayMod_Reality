import {
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PointDataset, TimeBounds } from "../../../../packages/data/src";

const MIN_VISIBLE_SPAN = 60_000;
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

const lowerBound = (values: readonly number[], target: number) => {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if (values[middle] < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
};

const drawPointTrack = (
  context: CanvasRenderingContext2D,
  timestamps: readonly number[],
  start: number,
  end: number,
  width: number,
  centerY: number,
  color: string,
  pointWidth: number,
) => {
  const span = Math.max(end - start, 1);
  const firstVisibleIndex = lowerBound(timestamps, start);
  const lastVisibleIndex = lowerBound(timestamps, end);
  const pixelWidth = Math.max(1, Math.ceil(width));
  const occupiedPixels = new Uint8Array(pixelWidth);
  context.fillStyle = color;

  for (
    let index = firstVisibleIndex;
    index < timestamps.length && index <= lastVisibleIndex;
    index += 1
  ) {
    const timestamp = timestamps[index];

    if (timestamp > end) {
      break;
    }

    const x = Math.min(
      pixelWidth - 1,
      Math.max(0, Math.floor(((timestamp - start) / span) * width)),
    );
    occupiedPixels[x] = 1;
  }

  for (let x = 0; x < occupiedPixels.length; x += 1) {
    if (occupiedPixels[x] === 1) {
      context.fillRect(x, centerY - 8, pointWidth, 16);
    }
  }
};

interface TimelineCanvasProps {
  dataset: PointDataset | null;
  viewRange: TimeBounds | null;
  currentTime: number | null;
  onCurrentTimeChange: (timestamp: number) => void;
}

function TimelineCanvas({
  dataset,
  viewRange,
  currentTime,
  onCurrentTimeChange,
}: TimelineCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

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
    const trackHeight = (size.height - rulerHeight) / 2;

    context.fillStyle = "rgb(255 255 255 / 4%)";
    context.fillRect(0, rulerHeight, size.width, trackHeight);
    context.fillStyle = "rgb(255 255 255 / 7%)";
    context.fillRect(0, rulerHeight + trackHeight, size.width, trackHeight);

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

    drawPointTrack(
      context,
      dataset.footprintTimestamps,
      start,
      end,
      size.width,
      rulerHeight + trackHeight / 2,
      "rgb(185 245 197 / 38%)",
      1,
    );
    drawPointTrack(
      context,
      dataset.photoTimestamps,
      start,
      end,
      size.width,
      rulerHeight + trackHeight + trackHeight / 2,
      "rgb(255 227 110 / 92%)",
      2,
    );

    if (currentTime !== null && currentTime >= start && currentTime <= end) {
      const x = ((currentTime - start) / span) * size.width;
      context.strokeStyle = "#ff3434";
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, size.height);
      context.stroke();
      context.fillStyle = "#ff3434";
      context.beginPath();
      context.moveTo(x - 5, 0);
      context.lineTo(x + 5, 0);
      context.lineTo(x, 7);
      context.closePath();
      context.fill();
    }
  }, [currentTime, dataset, size, viewRange]);

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
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          updateCurrentTime(event);
        }
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    >
      <canvas ref={canvasRef} className="timeline-canvas" />
    </div>
  );
}

interface TimelineProps {
  dataset: PointDataset | null;
  currentTime: number | null;
  onCurrentTimeChange: (timestamp: number) => void;
}

export function Timeline({
  dataset,
  currentTime,
  onCurrentTimeChange,
}: TimelineProps) {
  const timelineRef = useRef<HTMLElement>(null);
  const pressedPanKeysRef = useRef(new Set<"q" | "e">());
  const panVelocityRef = useRef(0);
  const panFrameRef = useRef<number | null>(null);
  const lastPanFrameTimeRef = useRef<number | null>(null);
  const [viewRange, setViewRange] = useState<TimeBounds | null>(null);

  useEffect(() => {
    setViewRange(dataset?.timeBounds ?? null);
  }, [dataset]);

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
      if (!event.ctrlKey || !dataset || !viewRange) {
        return;
      }

      event.preventDefault();
      const bounds = timeline.getBoundingClientRect();
      const pointerRatio = Math.min(
        Math.max((event.clientX - bounds.left) / bounds.width, 0),
        1,
      );
      const currentSpan = viewRange[1] - viewRange[0];
      const zoomFactor = Math.exp(event.deltaY * 0.002);
      const nextSpan = currentSpan * zoomFactor;
      const anchorTime = viewRange[0] + currentSpan * pointerRatio;
      const nextStart = anchorTime - nextSpan * pointerRatio;

      setViewRange(clampRange(nextStart, nextSpan, dataset.timeBounds));
    };

    timeline.addEventListener("wheel", handleWheel, { passive: false });
    return () => timeline.removeEventListener("wheel", handleWheel);
  }, [dataset, viewRange]);

  return (
    <section ref={timelineRef} className="timeline">
      <header className="timeline-toolbar">
        <div className="playback-controls">
          <button type="button" aria-label="上一帧">
            |&lt;
          </button>
          <button className="play-button" type="button" aria-label="播放">
            &gt;
          </button>
          <button type="button" aria-label="下一帧">
            &gt;|
          </button>
        </div>
        <span className="timecode">{currentTimeLabel}</span>
        <span className="timeline-title">{visibleRangeLabel}</span>
        <div className="timeline-options">
          <span>Ctrl+滚轮缩放 · Q/E 移动</span>
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
        <div className="track-labels">
          <span>
            <i className="footprint-swatch" />
            足迹
          </span>
          <span>
            <i className="photo-swatch" />
            照片
          </span>
        </div>
        <TimelineCanvas
          dataset={dataset}
          viewRange={viewRange}
          currentTime={currentTime}
          onCurrentTimeChange={onCurrentTimeChange}
        />
      </div>
    </section>
  );
}
