import { useMemo, type PointerEvent } from "react";
import {
  firstDate, formatMinute, formatOffset, lastDate, minutesPerDay, observationDateAfter,
  skyObjects, twilightBands, type AstronomyMapState, type ObservationDay,
} from "./astronomy";

export function AstronomyPanel({ state, onTimeChange }: {
  state: AstronomyMapState;
  onTimeChange: (minute: number) => void;
}) {
  return <section className="astronomy-panel">
    <p>点击地图选择观测点，拖动下方时间轴查看方位。</p>
    <h3>观测点</h3>
    <p>{state.point
      ? `${state.point[1].toFixed(4)}°, ${state.point[0].toFixed(4)}°`
      : "尚未选择"}</p>
    <h3>当前方位 <small>正北 0° · 顺时针</small></h3>
    <dl className="astronomy-readout">
      {skyObjects.map(({ id, label, color }) => {
        const direction = state.directions?.[id];
        return <div key={id}>
          <dt><i style={{ background: color }}/>{label}</dt>
          <dd>{direction ? `高度 ${direction.altitude.toFixed(1)}° · 方位 ${direction.azimuth.toFixed(1)}°` : "—"}</dd>
        </div>;
      })}
    </dl>
    <h3>当日升落</h3>
    <div className="astronomy-events">
      {state.events.map(({ label, color, value }) => <button
        key={label} type="button" disabled={!value} onClick={() => value && onTimeChange(Math.round(value.minute))}
      >
        <span><i style={{ background: color }}/>{label}</span><span>{value ? `${formatMinute(value.minute)} · ${value.azimuth.toFixed(1)}°` : "当日无事件"}</span>
      </button>)}
      {!state.point && <p>选点后显示日出、日落、月出和月落。</p>}
    </div>
    <p>升落按海平面理想地平线计算，山体和建筑遮挡未计入。</p>
    <h3>全球昼夜 <small>太阳高度</small></h3>
    <dl className="astronomy-readout">
      {twilightBands.map(({ label, minAltitude, opacity }) => <div key={label}>
        <dt><i style={{ background: `hsl(0 0% ${73 * (1 - opacity)}%)` }}/>{label}</dt>
        <dd>{minAltitude === -90 ? "低于 −18°" : `≥ ${minAltitude}°`}</dd>
      </div>)}
    </dl>
  </section>;
}

const hourTicks = [0, 4, 8, 12, 16, 20, 24];
const altitudeTicks = [90, 45, 0, -45, -90];
const offsets = Array.from({ length: 105 }, (_, i) => (i - 48) * 15);

export function AstronomyTimeline({
  day, date, minute, offset, onDateChange, onTimeChange, onOffsetChange, onNow,
}: {
  day: ObservationDay | null;
  date: string;
  minute: number;
  offset: number;
  onDateChange: (date: string) => void;
  onTimeChange: (minute: number) => void;
  onOffsetChange: (offset: number) => void;
  onNow: () => void;
}) {
  const curves = useMemo(() => day && skyObjects.map(({ id, color }) => ({
    id, color, points: day.samples.map((sample, i) => `${i * 5},${(90 - sample[id].altitude).toFixed(2)}`).join(" "),
  })), [day]);
  const scrub = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    onTimeChange(Math.round(fraction * minutesPerDay));
  };

  return <section className="astronomy-timeline" aria-label="24 小时天文时间轴">
    <header className="astronomy-controls">
      <button type="button" aria-label="前一天" disabled={date <= firstDate}
        onClick={() => onDateChange(observationDateAfter(date, -1))}>‹</button>
      <input type="date" aria-label="观测日期" value={date} min={firstDate} max={lastDate}
        onChange={event => event.target.validity.valid && event.target.value && onDateChange(event.target.value)}/>
      <button type="button" aria-label="后一天" disabled={date >= lastDate}
        onClick={() => onDateChange(observationDateAfter(date, 1))}>›</button>
      <select aria-label="观测时区（固定 UTC 偏移）" value={offset}
        onChange={event => onOffsetChange(Number(event.target.value))}>
        {(offsets.includes(offset) ? offsets : [...offsets, offset].sort((a, b) => a - b)).map(value =>
          <option key={value} value={value}>{formatOffset(value)}</option>)}
      </select>
      <button type="button" onClick={onNow}>现在</button>
      <output>{formatMinute(minute)}</output>
    </header>
    <div className="astronomy-chart">
      <div className="astronomy-altitude" aria-hidden="true">
        {altitudeTicks.map(value => <span key={value} style={{ top: `${(90 - value) / 1.8}%` }}>{value}°</span>)}
      </div>
      <svg viewBox={`0 0 ${minutesPerDay} 180`} preserveAspectRatio="none"
        aria-label="太阳、月亮和银心的高度角曲线"
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          scrub(event);
        }}
        onPointerMove={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) scrub(event);
        }}>
        {altitudeTicks.map(value => <line key={value} x1={0} x2={minutesPerDay} y1={90 - value} y2={90 - value}
          className={value === 0 ? "astronomy-horizon" : "astronomy-grid"}/>)}
        {hourTicks.map(hour => <line key={hour} x1={hour * 60} x2={hour * 60} y1={0} y2={180} className="astronomy-grid"/>)}
        {curves?.map(({ id, points, color }) => <polyline key={id} points={points} fill="none" stroke={color}/>)}
        {day?.events.map(({ label, color, value }) => value && <line key={label} x1={value.minute} x2={value.minute} y1={0} y2={180}
          className="astronomy-event-tick" stroke={color}/>)}
        <line x1={minute} x2={minute} y1={0} y2={180} className="astronomy-playhead"/>
      </svg>
      {!day && <p>选择地图上的观测点，查看 24 小时高度曲线。</p>}
    </div>
    <div className="astronomy-hours" aria-hidden="true">
      {hourTicks.map(hour => <span key={hour}>{formatMinute(hour * 60)}</span>)}
    </div>
    <input type="range" className="astronomy-time-range" aria-label="观测时刻" aria-valuetext={formatMinute(minute)}
      min={0} max={minutesPerDay} value={minute} onChange={event => onTimeChange(event.target.valueAsNumber)}/>
  </section>;
}
