import { useEffect, useMemo, useState } from "react";
import type { TerrainProfilePoint } from "../map/elevation";

import { elevationProfileData } from "./ElevationProfileData";
import { MetricCanvasFallback } from "../../render-engine/MetricCanvasFallback";
import { useReplayVisibility } from "../../render-engine/useReplayVisibility";
import { useReplayVisual } from "../../render-engine/useReplayVisual";
import type { ReplayScene } from "../../render-engine/ReplayScene";
export { routeLengthKm } from "./ElevationProfileData";

interface Props {
  scene: ReplayScene;
  coordinates: TerrainProfilePoint[] | null | undefined;
  routeName: string;
  onHover: (coordinate: TerrainProfilePoint | null) => void;
}

export function ElevationProfile({ scene, coordinates, routeName, onHover }: Props) {
  const {annotations: annotationsVisible} = useReplayVisibility(scene);
  const engineVisual = useReplayVisual(scene, "elevation");
  const profile = useMemo(() => coordinates ? elevationProfileData(coordinates) : null, [coordinates]);
  useEffect(() => profile ? scene.registerMetricSeries("elevation", profile.series) : undefined, [profile, scene]);
  const [hover, setHover] = useState<{profile: NonNullable<typeof profile>; index: number} | null>(null);
  const hovered = hover?.profile === profile ? hover?.index ?? null : null;
  useEffect(() => {
    setHover(null);
    onHover(null);
    return () => onHover(null);
  }, [coordinates, onHover]);
  if (coordinates === undefined) return <section className="route-elevation"><header><strong>{routeName}</strong><span>正在读取地形海拔…</span></header></section>;
  if (!coordinates) return <section className="route-elevation"><header><strong>{routeName}</strong><span>暂时无法读取地形海拔</span></header></section>;
  if (!profile) return <section className="route-elevation"><header><strong>{routeName}</strong><span>没有可用的海拔变化数据</span></header></section>;
  const distances = profile.series.x, totalMetres = profile.series.xDomain[1];
  const total = profile.totalKm, minimum = profile.minimum, maximum = profile.maximum;
  const width = 1000, height = 150, left = 42, right = 12, top = 12, bottom = 24;
  const x = (index: number) => left + (width - left - right) * distances[index] / totalMetres;
  const move = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const viewX = (event.clientX - box.left) / box.width * width;
    const target = Math.max(0, Math.min(1, (viewX - left) / (width - left - right))) * totalMetres;
    let low = 0, high = distances.length - 1;
    while (low < high) { const middle = (low + high) >>> 1; if (distances[middle] < target) low = middle + 1; else high = middle; }
    const picked = scene.picking.pick({viewId: "elevation", target: "metric", x: event.clientX, y: event.clientY, radius: 5});
    const nearest = low > 0 && Math.abs(distances[low - 1] - target) < Math.abs(distances[low] - target) ? low - 1 : low;
    const index = picked?.sampleIndex ?? nearest;
    setHover({profile, index}); onHover(coordinates[index]);
  };
  const leave = () => { setHover(null); onHover(null); };
  return <section className="route-elevation" data-replay-renderer={engineVisual ? "engine" : undefined}>
    <header><strong>{routeName}</strong><span>{hovered === null ? `${total.toFixed(1)} km · ${Math.round(minimum)}–${Math.round(maximum)} m` : `${(distances[hovered] / 1000).toFixed(1)} km · ${Math.round(coordinates[hovered][2])} m`}</span></header>
    <div className="route-elevation-plot">
      {!engineVisual && annotationsVisible && <MetricCanvasFallback series={profile.series} />}
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" onPointerMove={move} onPointerLeave={leave} role="img" aria-label={`${routeName}的里程海拔图`}>
        <text x="4" y={top + 6}>{Math.round(maximum)} m</text><text x="4" y={height - bottom}>{Math.round(minimum)} m</text>
        <text x={left} y={height - 5}>0 km</text><text x={width - right} y={height - 5} textAnchor="end">{total.toFixed(1)} km</text>
        {hovered !== null && (
          <line x1={x(hovered)} x2={x(hovered)} y1={top} y2={height-bottom}/>
        )}
      </svg>
    </div>
  </section>;
}
