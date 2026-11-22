import { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatMinute, formatOffset, minutesPerDay, solarTwilight, solarYear, type ObservationPoint } from "./astronomy";

export function SolarYearButton({ point, date, offset }: {
  point: ObservationPoint | null;
  date: string;
  offset: number;
}) {
  const id = useId();
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!point) popup.current?.hidePopover();
  }, [point]);

  return <>
    <button className="solar-year-button" type="button" disabled={!point} popoverTarget={id}
      aria-haspopup="dialog">全年日出日落</button>
    <div ref={popup} id={id} popover="auto" role="dialog" aria-label="全年日出日落"
      className="solar-year-popup" onToggle={event => setOpen(event.newState === "open")}>
      {open && point && <SolarYearChart point={point} date={date} offset={offset}/>}
    </div>
  </>;
}

const curves = [{ key: "rise", color: "#ffa254" }, { key: "set", color: "#ff8582" }] as const;

function SolarYearChart({ point: [longitude, latitude], date, offset }: {
  point: ObservationPoint;
  date: string;
  offset: number;
}) {
  const year = Number(date.slice(0, 4));
  const days = useMemo(() => solarYear([longitude, latitude], year, offset), [longitude, latitude, year, offset]);
  const svg = useRef<SVGSVGElement>(null);
  const [{ width, height }, setSize] = useState({ width: 710, height: 280 });
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 64 && height > 40) setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [hover, setHover] = useState<number | null>(null);
  const activeIndex = Math.min(hover ?? days.findIndex(day => day.date === date), days.length - 1);
  const active = days[activeIndex];

  const chart = useMemo(() => {
    const plot = { left: 49, right: width - 14, top: 10, bottom: height - 24 };
    const rises = days.flatMap(day => day.rise.filter(minute => minute !== null));
    const sets = days.flatMap(day => day.set.filter(minute => minute !== null));
    const firstEvent = Math.min(...rises, ...sets);
    const lastEvent = Math.max(...rises, ...sets);
    const start = Number.isFinite(firstEvent) ? Math.max(0, Math.floor((firstEvent - 30) / 60) * 60) : 0;
    const end = Number.isFinite(lastEvent)
      ? Math.min(minutesPerDay, Math.ceil((lastEvent + 30) / 60) * 60)
      : minutesPerDay;
    const latestRise = Math.max(...rises);
    const earliestSet = Math.min(...sets);
    // Cut only whole hours in the shared daylight interval, leaving room around both curves.
    const cutStart = Math.ceil((latestRise + 30) / 60) * 60;
    const cutEnd = Math.floor((earliestSet - 30) / 60) * 60;
    const cut = rises.length > 0 && sets.length > 0 && cutEnd - cutStart >= 120;
    const gap = cut ? 17 : 0;
    const omitted = cut ? cutEnd - cutStart : 0;
    const scale = (plot.bottom - plot.top - gap) / (end - start - omitted);
    const x = (index: number) => plot.left + index * (plot.right - plot.left) / (days.length - 1);
    const y = (minute: number) => plot.top + (minute - start) * scale + (cut && minute >= cutEnd ? gap - omitted * scale : 0);
    const ticks = Array.from({ length: (end - start) / 60 + 1 }, (_, i) => start + i * 60)
      .filter(minute => !cut || minute <= cutStart || minute >= cutEnd);
    const paths = curves.flatMap(({ key, color }) => Array.from({ length: 1 + solarTwilight.length }, (_, band) => {
      let previous: number | null = null;
      const path = days.map((day, index) => {
        const minute = day[key][band];
        const join = previous !== null && minute !== null && Math.abs(previous - minute) < minutesPerDay / 2;
        previous = minute;
        return minute === null ? "" : `${join ? "L" : "M"}${x(index).toFixed(2)},${y(minute).toFixed(2)}`;
      }).join(" ");
      return { id: `${key}-${band}`, color, band, path };
    }));
    const breakY = cut ? y(cutStart) : null;
    const monthGridSegments = breakY === null
      ? [[plot.top, plot.bottom]]
      : [[plot.top, breakY], [breakY + gap, plot.bottom]];
    return { plot, x, y, ticks, paths, hourLabelStep: Math.ceil(14 / (60 * scale)),
      monthGridSegments, breakY: breakY === null ? null : breakY + gap / 2 };
  }, [days, width, height]);

  const { plot } = chart;
  const time = (minute: number | null) => minute === null ? "—" : formatMinute(minute);
  return <>
    <header className="solar-year-heading">
      <strong>{year} 年日出日落</strong>
      <span>{latitude.toFixed(4)}°, {longitude.toFixed(4)}° · {formatOffset(offset)}</span>
    </header>
    <svg ref={svg} className="solar-year-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="横轴为日期，纵轴为观测时间"
      onPointerLeave={() => setHover(null)}>
      {chart.ticks.map(minute => <g key={minute}>
        <line x1={plot.left} x2={plot.right} y1={chart.y(minute)} y2={chart.y(minute)}/>
        {minute / 60 % chart.hourLabelStep === 0 &&
          <text x={plot.left - 7} y={chart.y(minute)} textAnchor="end" dominantBaseline="middle">{formatMinute(minute)}</text>}
      </g>)}
      {days.map(({ date }, index) => date.endsWith("-01") &&
        <g key={date}>
          {chart.monthGridSegments.map(([top, bottom]) =>
            <line key={top} x1={chart.x(index)} x2={chart.x(index)} y1={top} y2={bottom}/>)}
          <text x={chart.x(index)} y={height - 4} textAnchor="middle">{Number(date.slice(5, 7))}月</text>
        </g>)}
      {chart.breakY !== null && <line className="solar-year-break" x1={plot.left} x2={plot.left}
        y1={chart.breakY - 7} y2={chart.breakY + 7}/>}
      {chart.paths.map(({ id, color, band, path }) => <path key={id} d={path} stroke={color}
        strokeWidth={band === 0 ? 2 : 1} opacity={band === 0 ? 1 : .42 - band * .06}
        strokeDasharray={band ? "3 3" : undefined} fill="none"/>)}
      {active && <g>
        <line className="solar-year-cursor" x1={chart.x(activeIndex)} x2={chart.x(activeIndex)} y1={plot.top} y2={plot.bottom}/>
        {curves.map(({ key, color }) => {
          const minute = active[key][0];
          return minute === null ? null : <circle key={key} cx={chart.x(activeIndex)} cy={chart.y(minute)} r={3.5} fill={color}/>;
        })}
      </g>}
      <rect x={plot.left} y={plot.top} width={plot.right - plot.left} height={height - plot.top} fill="transparent"
        onPointerMove={event => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const fraction = (event.clientX - bounds.left) / bounds.width;
          setHover(Math.max(0, Math.min(days.length - 1, Math.round(fraction * (days.length - 1)))));
        }}/>
    </svg>
    {active && <div className="solar-year-readout">
      <time dateTime={active.date}>{active.date}</time>
      <span style={{ color: curves[0].color }}>日出 {time(active.rise[0])}</span>
      <span style={{ color: curves[1].color }}>日落 {time(active.set[0])}</span>
      <small>{solarTwilight.map(({ label }, band) => <span key={label}>
        {label} {time(active.rise[band + 1])} / {time(active.set[band + 1])}
      </span>)}</small>
    </div>}
  </>;
}
