import { useState } from "react";
import type { TerrainProfilePoint } from "../map/elevation";

export const routeLengthKm = (coordinates: readonly (readonly number[])[]) => {
  const radians = (value: number) => value * Math.PI / 180;
  let metres = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1], current = coordinates[index];
    const latitude = radians(current[1] - previous[1]);
    const longitude = radians(current[0] - previous[0]);
    const value = Math.sin(latitude / 2) ** 2
      + Math.cos(radians(previous[1])) * Math.cos(radians(current[1])) * Math.sin(longitude / 2) ** 2;
    metres += 2 * 6371000 * Math.asin(Math.sqrt(value));
  }
  return metres / 1000;
};

interface Props {
  coordinates: TerrainProfilePoint[] | null | undefined;
  routeName: string;
  onHover: (coordinate: TerrainProfilePoint | null) => void;
}

export function ElevationProfile({ coordinates, routeName, onHover }: Props) {
  const [hovered, setHovered] = useState<number | null>(null);
  if (coordinates === undefined) return <section className="route-elevation"><header><strong>{routeName}</strong><span>正在读取地形海拔…</span></header></section>;
  if (!coordinates) return <section className="route-elevation"><header><strong>{routeName}</strong><span>暂时无法读取地形海拔</span></header></section>;
  const elevations = coordinates.map(coordinate => coordinate[2]);
  if (elevations.length < 2 || Math.max(...elevations) - Math.min(...elevations) < 0.1) return <section className="route-elevation"><header><strong>{routeName}</strong><span>没有可用的海拔变化数据</span></header></section>;
  const distances = [0];
  for (let index = 1; index < coordinates.length; index += 1) distances.push(distances[index - 1] + routeLengthKm([coordinates[index - 1], coordinates[index]]));
  const total = distances.at(-1) ?? 0, minimum = Math.min(...elevations), maximum = Math.max(...elevations);
  const width = 1000, height = 150, left = 42, right = 12, top = 12, bottom = 24;
  const x = (index: number) => left + (width - left - right) * distances[index] / total;
  const y = (index: number) => height - bottom - (height - top - bottom) * (coordinates[index][2] - minimum) / (maximum - minimum);
  const points = coordinates.map((_, index) => `${x(index)},${y(index)}`).join(" ");
  const move = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const target = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * total;
    let low = 0, high = distances.length - 1;
    while (low < high) { const middle = (low + high) >>> 1; if (distances[middle] < target) low = middle + 1; else high = middle; }
    const index = low > 0 && Math.abs(distances[low - 1] - target) < Math.abs(distances[low] - target) ? low - 1 : low;
    setHovered(index); onHover(coordinates[index]);
  };
  const leave = () => { setHovered(null); onHover(null); };
  return <section className="route-elevation">
    <header><strong>{routeName}</strong><span>{hovered === null ? `${total.toFixed(1)} km · ${Math.round(minimum)}–${Math.round(maximum)} m` : `${distances[hovered].toFixed(1)} km · ${Math.round(coordinates[hovered][2])} m`}</span></header>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" onPointerMove={move} onPointerLeave={leave} role="img" aria-label={`${routeName}的里程海拔图`}>
      <text x="4" y={top + 6}>{Math.round(maximum)} m</text><text x="4" y={height - bottom}>{Math.round(minimum)} m</text>
      <text x={left} y={height - 5}>0 km</text><text x={width - right} y={height - 5} textAnchor="end">{total.toFixed(1)} km</text>
      <polyline points={points}/>
      {hovered !== null && <><line x1={x(hovered)} x2={x(hovered)} y1={top} y2={height-bottom}/><circle cx={x(hovered)} cy={y(hovered)} r="4"/></>}
    </svg>
  </section>;
}
